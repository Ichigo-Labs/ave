/**
 * Tests for bash long-running command and background-task patterns:
 * - Default + max timeout resolution
 * - Bare leading `sleep N >= 2` blocker
 * - `run_in_background: true` returns immediately and fires completion events
 * - Stall watchdog detects interactive prompts on stalled tasks
 * - looksLikePrompt heuristic
 */

import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_resetBackgroundTaskRegistry,
	type BackgroundTaskEvent,
	getBackgroundTask,
	killAllBackgroundTasks,
	listBackgroundTasks,
	looksLikePrompt,
	subscribeBackgroundTaskEvents,
} from "../src/core/background-tasks.js";
import { detectBlockedSleepPattern } from "../src/core/tools/bash.js";
import {
	getDefaultBashTimeoutSeconds,
	getMaxBashTimeoutSeconds,
	resolveBashTimeoutSeconds,
} from "../src/core/tools/bash-timeouts.js";

const isWindows = process.platform === "win32";

function waitForEvent<T extends BackgroundTaskEvent["type"]>(
	type: T,
	timeoutMs = 5_000,
): Promise<Extract<BackgroundTaskEvent, { type: T }>> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => {
			unsubscribe();
			reject(new Error(`Timed out waiting for ${type} event`));
		}, timeoutMs);
		const unsubscribe = subscribeBackgroundTaskEvents((event) => {
			if (event.type === type) {
				clearTimeout(t);
				unsubscribe();
				resolve(event as Extract<BackgroundTaskEvent, { type: T }>);
			}
		});
	});
}

describe("bash timeout resolution", () => {
	it("falls back to the default when no timeout is provided", () => {
		const def = getDefaultBashTimeoutSeconds();
		expect(resolveBashTimeoutSeconds(undefined)).toBe(def);
	});

	it("clamps caller-provided timeouts to the configured max", () => {
		const max = getMaxBashTimeoutSeconds();
		expect(resolveBashTimeoutSeconds(max + 1000)).toBe(max);
	});

	it("respects caller-provided timeouts under the max", () => {
		expect(resolveBashTimeoutSeconds(5)).toBe(5);
	});

	it("env override changes the default", () => {
		const env = { BASH_DEFAULT_TIMEOUT_SECONDS: "30" };
		expect(getDefaultBashTimeoutSeconds(env)).toBe(30);
	});

	it("max is at least the default", () => {
		const env = { BASH_DEFAULT_TIMEOUT_SECONDS: "1000", BASH_MAX_TIMEOUT_SECONDS: "100" };
		expect(getMaxBashTimeoutSeconds(env)).toBeGreaterThanOrEqual(getDefaultBashTimeoutSeconds(env));
	});
});

describe("detectBlockedSleepPattern", () => {
	it("blocks bare leading `sleep N` with N >= 2", () => {
		expect(detectBlockedSleepPattern("sleep 2")).toBe("standalone sleep 2");
		expect(detectBlockedSleepPattern("sleep 30")).toBe("standalone sleep 30");
	});

	it("returns the rest of a chained command", () => {
		expect(detectBlockedSleepPattern("sleep 5 && echo hi")).toBe("sleep 5 followed by: echo hi");
		expect(detectBlockedSleepPattern("sleep 10; echo done")).toBe("sleep 10 followed by: echo done");
	});

	it("allows sub-2-second sleeps for pacing", () => {
		expect(detectBlockedSleepPattern("sleep 1")).toBeNull();
		expect(detectBlockedSleepPattern("sleep 0")).toBeNull();
	});

	it("allows fractional sleeps", () => {
		expect(detectBlockedSleepPattern("sleep 0.5")).toBeNull();
	});

	it("does not block when sleep is not the first segment", () => {
		expect(detectBlockedSleepPattern("echo hi && sleep 5")).toBeNull();
	});
});

describe("looksLikePrompt", () => {
	it("matches common interactive prompts", () => {
		expect(looksLikePrompt("Continue? ")).toBe(true);
		expect(looksLikePrompt("Are you sure you want to proceed? ")).toBe(true);
		expect(looksLikePrompt("Press Enter to continue")).toBe(true);
		expect(looksLikePrompt("(y/n)")).toBe(true);
	});

	it("does not match generic output", () => {
		expect(looksLikePrompt("compiling foo.ts")).toBe(false);
		expect(looksLikePrompt("done")).toBe(false);
	});
});

describe("background task registry", () => {
	beforeEach(() => {
		_resetBackgroundTaskRegistry();
	});

	afterEach(() => {
		killAllBackgroundTasks();
		_resetBackgroundTaskRegistry();
	});

	it.skipIf(isWindows)("spawns a task and reports completion", async () => {
		const completion = waitForEvent("completed");
		const { spawnBackgroundTask } = await import("../src/core/background-tasks.js");
		const handle = spawnBackgroundTask({
			command: "echo hello-world",
			cwd: process.cwd(),
		});
		expect(handle.info.status).toBe("running");
		expect(handle.info.taskId).toMatch(/^[0-9a-f]{12}$/);

		const event = await completion;
		expect(event.task.taskId).toBe(handle.info.taskId);
		expect(event.task.exitCode).toBe(0);
		expect(existsSync(event.task.outputPath)).toBe(true);
		const contents = readFileSync(event.task.outputPath, "utf-8");
		expect(contents).toContain("hello-world");

		// Registry retains the task entry so the model can read its output later.
		expect(getBackgroundTask(event.task.taskId)?.status).toBe("completed");
	});

	it.skipIf(isWindows)("kill marks the task as killed", async () => {
		const { spawnBackgroundTask, killBackgroundTask } = await import("../src/core/background-tasks.js");
		const completion = waitForEvent("killed");
		const handle = spawnBackgroundTask({
			command: "sleep 60",
			cwd: process.cwd(),
		});
		expect(killBackgroundTask(handle.info.taskId)).toBe(true);
		const event = await completion;
		expect(event.task.taskId).toBe(handle.info.taskId);
		expect(event.task.status).toBe("killed");
	});

	it.skipIf(isWindows)("listBackgroundTasks includes running and finished tasks", async () => {
		const completion = waitForEvent("completed");
		const { spawnBackgroundTask } = await import("../src/core/background-tasks.js");
		const handle = spawnBackgroundTask({ command: "true", cwd: process.cwd() });
		await completion;
		const all = listBackgroundTasks();
		expect(all.some((t) => t.taskId === handle.info.taskId)).toBe(true);
	});
});

describe("bash tool integration", () => {
	beforeEach(() => {
		_resetBackgroundTaskRegistry();
	});

	afterEach(() => {
		killAllBackgroundTasks();
		_resetBackgroundTaskRegistry();
	});

	it.skipIf(isWindows)("run_in_background returns immediately with a task id", async () => {
		const { createBashTool } = await import("../src/core/tools/bash.js");
		const tool = createBashTool(process.cwd());
		const completion = waitForEvent("completed");
		const result = await tool.execute("call-1", { command: "echo backgrounded", run_in_background: true } as any);
		expect(result.content[0]?.type).toBe("text");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toMatch(/Command running in background with ID:/);
		expect(text).toMatch(/Output is being written to:/);
		expect(text).toMatch(/notified when it completes/);

		const event = await completion;
		expect(event.task.exitCode).toBe(0);
	});

	it.skipIf(isWindows)("rejects bare leading sleep 5", async () => {
		const { createBashTool } = await import("../src/core/tools/bash.js");
		const tool = createBashTool(process.cwd());
		await expect(tool.execute("call-2", { command: "sleep 5" } as any)).rejects.toThrow(
			/Blocked: standalone sleep 5/,
		);
	});

	it.skipIf(isWindows)("allows sleep when run_in_background is true", async () => {
		const { createBashTool } = await import("../src/core/tools/bash.js");
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call-3", { command: "sleep 1", run_in_background: true } as any);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toMatch(/Command running in background with ID:/);
	});

	it.skipIf(isWindows)("auto-background path returns inline output for fast commands", async () => {
		const { createBashTool } = await import("../src/core/tools/bash.js");
		const tool = createBashTool(process.cwd());
		const result = await tool.execute("call-4", { command: "echo fast-path" } as any);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("fast-path");
	});

	it.skipIf(isWindows)(
		"auto-background path moves slow commands to the registry on timeout",
		async () => {
			const { createBashTool } = await import("../src/core/tools/bash.js");
			const tool = createBashTool(process.cwd());
			// 2-second budget, command sleeps 10s. Should return early.
			const promise = tool.execute("call-5", { command: "yes hello | head -n 1 && sleep 10", timeout: 2 } as any);
			const result = await promise;
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toMatch(/exceeded the .*foreground timeout/);
			expect(text).toMatch(/moved to the background with ID:/);
			// Clean up the still-running background task.
			killAllBackgroundTasks();
		},
		15_000,
	);
});
