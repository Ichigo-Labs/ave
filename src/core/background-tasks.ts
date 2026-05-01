/**
 * Background task registry for long-running bash commands.
 *
 * Mirrors the patterns from claude-code's LocalShellTask + TaskOutput pair:
 * - Each backgrounded command writes its merged stdout/stderr to a temp file
 *   under `pi-bash-bg-<id>.log` so the model can tail it later.
 * - The registry tracks running tasks, fires lifecycle events, and supports
 *   killing individual tasks or all tasks (used by the existing
 *   killTrackedDetachedChildren shutdown path).
 * - A stall watchdog tails the output file and emits a one-shot `stalled`
 *   event when output stops growing AND the last line looks like an
 *   interactive prompt (e.g. `(y/n)`, `Press Enter`).
 *
 * The registry is process-global on purpose: the bash tool emits events here,
 * and the host (typically AgentSession) subscribes once and forwards them to
 * the agent's followUp queue. Tasks live until they exit or the process dies.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../utils/shell.js";

/** Status of a backgrounded task. */
export type BackgroundTaskStatus = "running" | "completed" | "failed" | "killed";

/** Reason the task was started in the background. */
export type BackgroundTaskKind =
	| "explicit" // model passed run_in_background: true
	| "auto-timeout"; // foreground bash hit its timeout and was transitioned

export interface BackgroundTaskInfo {
	taskId: string;
	command: string;
	description: string;
	outputPath: string;
	kind: BackgroundTaskKind;
	startedAt: number;
	endedAt?: number;
	status: BackgroundTaskStatus;
	exitCode?: number;
	pid?: number;
	/** Spawn-time error message (e.g. ENOENT for a missing shell). */
	errorMessage?: string;
}

/** Lifecycle events fired by the registry. */
export type BackgroundTaskEvent =
	| { type: "started"; task: BackgroundTaskInfo }
	| { type: "completed"; task: BackgroundTaskInfo }
	| { type: "failed"; task: BackgroundTaskInfo }
	| { type: "killed"; task: BackgroundTaskInfo }
	| { type: "stalled"; task: BackgroundTaskInfo; tail: string };

export type BackgroundTaskEventListener = (event: BackgroundTaskEvent) => void;

interface BackgroundTaskInternal extends BackgroundTaskInfo {
	pid: number;
	stream: WriteStream;
	cancelStallWatchdog: () => void;
	resultPromise: Promise<BackgroundTaskInfo>;
	killedExplicitly: boolean;
	dataSubscribers: Set<(data: Buffer) => void>;
}

const tasks = new Map<string, BackgroundTaskInternal>();
const listeners = new Set<BackgroundTaskEventListener>();

const STALL_CHECK_INTERVAL_MS = 5_000;
const STALL_THRESHOLD_MS = 45_000;
const STALL_TAIL_BYTES = 1024;

// Last-line patterns that suggest a process is blocked on interactive input.
// Matches claude-code's PROMPT_PATTERNS in LocalShellTask.tsx.
const PROMPT_PATTERNS: RegExp[] = [
	/\(y\/n\)/i,
	/\[y\/n\]/i,
	/\(yes\/no\)/i,
	/\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i,
	/Press (any key|Enter)/i,
	/Continue\?/i,
	/Overwrite\?/i,
];

/** Returns true if the last non-empty line in `tail` looks like an interactive prompt. */
export function looksLikePrompt(tail: string): boolean {
	const lastLine = tail.trimEnd().split("\n").pop() ?? "";
	return PROMPT_PATTERNS.some((p) => p.test(lastLine));
}

function emit(event: BackgroundTaskEvent): void {
	for (const listener of listeners) {
		try {
			listener(event);
		} catch {
			// Listeners must not break the registry.
		}
	}
}

function snapshot(task: BackgroundTaskInternal): BackgroundTaskInfo {
	return {
		taskId: task.taskId,
		command: task.command,
		description: task.description,
		outputPath: task.outputPath,
		kind: task.kind,
		startedAt: task.startedAt,
		endedAt: task.endedAt,
		status: task.status,
		exitCode: task.exitCode,
		pid: task.pid,
		errorMessage: task.errorMessage,
	};
}

/** Subscribe to background task lifecycle events. Returns an unsubscribe fn. */
export function subscribeBackgroundTaskEvents(listener: BackgroundTaskEventListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * Subscribe to raw stdout/stderr chunks as they arrive for a single task.
 *
 * Used by the bash tool's auto-background-on-timeout path to stream output
 * to its caller while the task is still in the foreground budget.
 *
 * Returns an unsubscribe fn. Returns undefined if the task does not exist.
 */
export function subscribeBackgroundTaskData(
	taskId: string,
	listener: (data: Buffer) => void,
): (() => void) | undefined {
	const task = tasks.get(taskId);
	if (!task) return undefined;
	task.dataSubscribers.add(listener);
	return () => {
		task.dataSubscribers.delete(listener);
	};
}

/** Look up an active or recently-completed task by id. */
export function getBackgroundTask(taskId: string): BackgroundTaskInfo | undefined {
	const t = tasks.get(taskId);
	return t ? snapshot(t) : undefined;
}

/** Snapshot of every task currently tracked by the registry. */
export function listBackgroundTasks(): BackgroundTaskInfo[] {
	return Array.from(tasks.values()).map(snapshot);
}

/**
 * Kill a running background task.
 * @returns true if the task was found and asked to terminate.
 */
export function killBackgroundTask(taskId: string): boolean {
	const task = tasks.get(taskId);
	if (!task || task.status !== "running") return false;
	task.killedExplicitly = true;
	killProcessTree(task.pid);
	return true;
}

/** Kill every running background task. Used when the host process is shutting down. */
export function killAllBackgroundTasks(): void {
	for (const task of tasks.values()) {
		if (task.status === "running") {
			task.killedExplicitly = true;
			killProcessTree(task.pid);
		}
	}
}

function startStallWatchdog(taskId: string): () => void {
	let lastSize = 0;
	let lastGrowth = Date.now();
	let cancelled = false;
	let fired = false;

	const timer = setInterval(() => {
		const task = tasks.get(taskId);
		if (!task || task.status !== "running" || cancelled || fired) {
			return;
		}
		void stat(task.outputPath).then(
			async (s) => {
				if (s.size > lastSize) {
					lastSize = s.size;
					lastGrowth = Date.now();
					return;
				}
				if (Date.now() - lastGrowth < STALL_THRESHOLD_MS) return;
				const tail = await tailFile(task.outputPath, STALL_TAIL_BYTES);
				if (cancelled || fired) return;
				if (!looksLikePrompt(tail)) {
					// Not a prompt — keep watching, but reset the timer so we
					// don't reread the tail every 5s.
					lastGrowth = Date.now();
					return;
				}
				fired = true;
				clearInterval(timer);
				emit({ type: "stalled", task: snapshot(task), tail });
			},
			() => {
				// File may not exist yet — try again next tick.
			},
		);
	}, STALL_CHECK_INTERVAL_MS);
	timer.unref?.();

	return () => {
		cancelled = true;
		clearInterval(timer);
	};
}

async function tailFile(path: string, bytes: number): Promise<string> {
	try {
		const handle = await open(path, "r");
		try {
			const stats = await handle.stat();
			const start = Math.max(0, stats.size - bytes);
			const length = stats.size - start;
			if (length <= 0) return "";
			const buf = Buffer.alloc(length);
			await handle.read(buf, 0, length, start);
			return buf.toString("utf-8");
		} finally {
			await handle.close();
		}
	} catch {
		return "";
	}
}

export interface SpawnBackgroundTaskInput {
	command: string;
	description?: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	shellPath?: string;
	kind?: BackgroundTaskKind;
}

export interface BackgroundTaskHandle {
	info: BackgroundTaskInfo;
	/** Resolves with the final task info once the process exits. */
	completion: Promise<BackgroundTaskInfo>;
}

function newTaskId(): string {
	return randomBytes(6).toString("hex");
}

function buildOutputPath(taskId: string): string {
	return join(tmpdir(), `pi-bash-bg-${taskId}.log`);
}

/**
 * Spawn a detached shell command and register it as a background task.
 *
 * The child's merged stdout/stderr is streamed to `outputPath`. On exit (or
 * kill), the registry fires `completed` / `failed` / `killed` events.
 */
export function spawnBackgroundTask(input: SpawnBackgroundTaskInput): BackgroundTaskHandle {
	const { command, cwd, env, shellPath, description, kind = "explicit" } = input;
	if (!existsSync(cwd)) {
		throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
	}
	const taskId = newTaskId();
	const outputPath = buildOutputPath(taskId);
	const stream = createWriteStream(outputPath, { flags: "w" });

	const { shell, args } = getShellConfig(shellPath);
	const child = spawn(shell, [...args, command], {
		cwd,
		detached: true,
		env: env ?? getShellEnv(),
		stdio: ["ignore", "pipe", "pipe"],
	});

	const pid = child.pid ?? 0;
	if (pid) trackDetachedChildPid(pid);

	const startedAt = Date.now();
	const desc = description?.trim() || command;

	const internal: BackgroundTaskInternal = {
		taskId,
		command,
		description: desc,
		outputPath,
		kind,
		startedAt,
		status: "running",
		pid,
		stream,
		cancelStallWatchdog: () => {},
		// Set below.
		resultPromise: undefined as unknown as Promise<BackgroundTaskInfo>,
		killedExplicitly: false,
		dataSubscribers: new Set(),
	};
	tasks.set(taskId, internal);

	const onData = (data: Buffer) => {
		try {
			stream.write(data);
		} catch {
			// Output file may have been closed during shutdown; nothing to do.
		}
		for (const sub of internal.dataSubscribers) {
			try {
				sub(data);
			} catch {
				// Subscribers must not break the registry.
			}
		}
	};
	child.stdout?.on("data", onData);
	child.stderr?.on("data", onData);

	internal.cancelStallWatchdog = startStallWatchdog(taskId);

	const completion = new Promise<BackgroundTaskInfo>((resolve) => {
		const finalize = (status: BackgroundTaskStatus, exitCode: number | undefined) => {
			if (internal.status !== "running") return;
			internal.status = status;
			internal.exitCode = exitCode;
			internal.endedAt = Date.now();
			internal.cancelStallWatchdog();
			if (pid) untrackDetachedChildPid(pid);
			try {
				stream.end();
			} catch {
				// stream may already be closed.
			}
			const info = snapshot(internal);
			emit({
				type: status === "completed" ? "completed" : status === "killed" ? "killed" : "failed",
				task: info,
			});
			resolve(info);
		};

		child.once("error", (err) => {
			internal.errorMessage = err.message;
			try {
				stream.write(`\n${err.message}\n`);
			} catch {
				// stream may already be closed.
			}
			finalize("failed", undefined);
		});
		child.once("exit", (code, signal) => {
			if (internal.killedExplicitly || signal) {
				finalize("killed", code ?? undefined);
			} else if (code === 0) {
				finalize("completed", 0);
			} else {
				finalize("failed", code ?? undefined);
			}
		});
	});
	internal.resultPromise = completion;

	emit({ type: "started", task: snapshot(internal) });

	return { info: snapshot(internal), completion };
}

/**
 * Test-only: clear in-memory state. Does not kill running tasks.
 */
export function _resetBackgroundTaskRegistry(): void {
	tasks.clear();
	listeners.clear();
}
