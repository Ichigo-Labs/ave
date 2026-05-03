import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR, getAgentDir } from "../src/config.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type AnyMode = any;

function makeFakeMode(extra: Record<string, unknown> = {}): AnyMode {
	const fake: AnyMode = {
		sessionManager: { getSessionDir: () => "/unused-session-dir" },
		...extra,
	};
	// Bind prototype methods so internal `this.foo()` calls resolve.
	const proto: AnyMode = (InteractiveMode as any).prototype;
	fake.getInputHistoryPath = proto.getInputHistoryPath.bind(fake);
	fake.persistInputHistory = proto.persistInputHistory.bind(fake);
	fake.loadInputHistory = proto.loadInputHistory.bind(fake);
	return fake;
}

describe("InteractiveMode input history persistence", () => {
	let tmpAgentDir: string;
	let prevAgentDir: string | undefined;

	beforeEach(() => {
		tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ave-input-history-"));
		prevAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = tmpAgentDir;
	});

	afterEach(() => {
		if (prevAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = prevAgentDir;
		fs.rmSync(tmpAgentDir, { recursive: true, force: true });
	});

	test("getInputHistoryPath resolves to the agent dir and is cwd-independent", () => {
		const fake = makeFakeMode({
			sessionManager: { getSessionDir: () => "/should/not/be/used" },
		});
		const result: string | undefined = fake.getInputHistoryPath();
		expect(result).toBe(path.join(getAgentDir(), "input-history.jsonl"));
		expect(getAgentDir()).toBe(tmpAgentDir);
	});

	test("persistInputHistory appends entries to the global history file", () => {
		const fake = makeFakeMode();
		fake.persistInputHistory("first prompt");
		fake.persistInputHistory("second prompt");

		const filePath = path.join(tmpAgentDir, "input-history.jsonl");
		const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
		expect(lines.map((l) => JSON.parse(l))).toEqual(["first prompt", "second prompt"]);
	});

	test("loadInputHistory seeds editor with persisted entries from agent dir", () => {
		const filePath = path.join(tmpAgentDir, "input-history.jsonl");
		fs.writeFileSync(filePath, `${JSON.stringify("alpha")}\n${JSON.stringify("beta")}\n`);

		const seedHistory = vi.fn();
		const fake = makeFakeMode({ editor: { seedHistory } });
		fake.loadInputHistory();

		expect(seedHistory).toHaveBeenCalledTimes(1);
		expect(seedHistory).toHaveBeenCalledWith(["alpha", "beta"]);
	});

	test("history persisted from one cwd is visible from another cwd", () => {
		// Simulate first session in /foo
		const sessionA = makeFakeMode({
			sessionManager: { getSessionDir: () => "/foo/.session" },
		});
		sessionA.persistInputHistory("hello from foo");

		// Simulate later session in a different cwd /bar
		const seedHistory = vi.fn();
		const sessionB = makeFakeMode({
			sessionManager: { getSessionDir: () => "/bar/.session" },
			editor: { seedHistory },
		});
		sessionB.loadInputHistory();

		expect(seedHistory).toHaveBeenCalledWith(["hello from foo"]);
	});

	test("loadInputHistory is a no-op when the global file does not exist", () => {
		const seedHistory = vi.fn();
		const fake = makeFakeMode({ editor: { seedHistory } });
		fake.loadInputHistory();
		expect(seedHistory).not.toHaveBeenCalled();
	});

	test("loadInputHistory skips malformed lines", () => {
		const filePath = path.join(tmpAgentDir, "input-history.jsonl");
		fs.writeFileSync(filePath, `${JSON.stringify("good")}\nnot-json\n${JSON.stringify("also good")}\n`);

		const seedHistory = vi.fn();
		const fake = makeFakeMode({ editor: { seedHistory } });
		fake.loadInputHistory();
		expect(seedHistory).toHaveBeenCalledWith(["good", "also good"]);
	});
});
