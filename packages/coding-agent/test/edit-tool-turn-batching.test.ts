import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnchorStateManager } from "../src/core/tools/anchor-state-manager.js";
import { createEditTool } from "../src/core/tools/edit.js";
import { formatLineWithHash } from "../src/core/tools/line-hashing.js";
import {
	type EditTurnBatch,
	getEditTurnBatch,
	registerTurnToolCalls,
	resetTurnBatchRegistry,
} from "../src/core/tools/turn-batch-registry.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-edit-turn-batch-"));
	tempDirs.push(dir);
	return dir;
}

function anchorFor(absolutePath: string, content: string, oneIndexedLine: number): string {
	const lines = content.split(/\r?\n/);
	const anchors = AnchorStateManager.reconcile(absolutePath, lines);
	return formatLineWithHash(lines[oneIndexedLine - 1], anchors[oneIndexedLine - 1]);
}

beforeEach(() => {
	AnchorStateManager.reset();
	resetTurnBatchRegistry();
});

afterEach(async () => {
	resetTurnBatchRegistry();
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Helper that mimics what `agent-session.ts` does on every `beforeToolCall`:
 * announce the full set of tool calls in the current assistant turn so the
 * registry can build the per-turn edit batch.
 */
function announceTurn(toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>): void {
	// AgentToolCall has more fields than we need (e.g. timestamps). The registry
	// only reads id/name/arguments, so structurally these test stubs are fine.
	registerTurnToolCalls(toolCalls as unknown as Parameters<typeof registerTurnToolCalls>[0]);
}

describe("edit tool Layer 2 turn batching", () => {
	it("merges two sibling edit calls in the same turn into one batched run, and each call only sees its own files in its result", async () => {
		const dir = await createTempDir();
		const fileA = join(dir, "a.txt");
		const fileB = join(dir, "b.txt");
		const origA = "alpha\n";
		const origB = "beta\n";
		await writeFile(fileA, origA, "utf8");
		await writeFile(fileB, origB, "utf8");

		const aAnchor = anchorFor(fileA, origA, 1);
		const bAnchor = anchorFor(fileB, origB, 1);

		const editTool = createEditTool(dir);

		// The model emitted two edit tool calls in the same assistant message.
		// agent-session would announce both before dispatching either.
		const callA = {
			id: "call-A",
			name: "edit",
			arguments: {
				files: [
					{
						path: fileA,
						edits: [{ edit_type: "replace" as const, anchor: aAnchor, end_anchor: aAnchor, text: "ALPHA" }],
					},
				],
			},
		};
		const callB = {
			id: "call-B",
			name: "edit",
			arguments: {
				files: [
					{
						path: fileB,
						edits: [{ edit_type: "replace" as const, anchor: bAnchor, end_anchor: bAnchor, text: "BETA" }],
					},
				],
			},
		};
		announceTurn([callA, callB]);

		// Verify the registry actually saw both calls.
		const seen = getEditTurnBatch(callA.id);
		expect(seen).toBeDefined();
		expect(seen?.editCalls).toHaveLength(2);

		// Dispatch both in parallel (mimics parallel tool execution mode).
		const [resA, resB] = await Promise.all([
			editTool.execute(callA.id, callA.arguments),
			editTool.execute(callB.id, callB.arguments),
		]);

		expect(await readFile(fileA, "utf8")).toBe("ALPHA\n");
		expect(await readFile(fileB, "utf8")).toBe("BETA\n");

		// Each call's per-call result only references its own file.
		expect(resA.details?.files).toHaveLength(1);
		expect(resA.details?.files[0]?.path).toBe(fileA);
		expect(resB.details?.files).toHaveLength(1);
		expect(resB.details?.files[0]?.path).toBe(fileB);

		// Once both calls have consumed their results, the registry entry is gone.
		expect(getEditTurnBatch(callA.id)).toBeUndefined();
		expect(getEditTurnBatch(callB.id)).toBeUndefined();
	});

	it("uses single-flight: the first call kicks off the work, the second awaits the same promise (no second processFile run)", async () => {
		const dir = await createTempDir();
		const fileA = join(dir, "a.txt");
		const fileB = join(dir, "b.txt");
		const origA = "alpha\n";
		const origB = "beta\n";
		await writeFile(fileA, origA, "utf8");
		await writeFile(fileB, origB, "utf8");

		const aAnchor = anchorFor(fileA, origA, 1);
		const bAnchor = anchorFor(fileB, origB, 1);

		// Wrap readFile so we can count how many times the tool reads each file.
		// In a batched run, every file should be read exactly once even though
		// there are two sibling tool calls.
		const reads = new Map<string, number>();
		const editTool = createEditTool(dir, {
			operations: {
				access: async () => {},
				readFile: async (p) => {
					reads.set(p, (reads.get(p) ?? 0) + 1);
					return readFile(p);
				},
				writeFile: async (p, c) => writeFile(p, c, "utf8"),
			},
		});

		const callA = {
			id: "call-A",
			name: "edit",
			arguments: {
				files: [
					{
						path: fileA,
						edits: [{ edit_type: "replace" as const, anchor: aAnchor, end_anchor: aAnchor, text: "ALPHA" }],
					},
				],
			},
		};
		const callB = {
			id: "call-B",
			name: "edit",
			arguments: {
				files: [
					{
						path: fileB,
						edits: [{ edit_type: "replace" as const, anchor: bAnchor, end_anchor: bAnchor, text: "BETA" }],
					},
				],
			},
		};
		announceTurn([callA, callB]);

		await Promise.all([editTool.execute(callA.id, callA.arguments), editTool.execute(callB.id, callB.arguments)]);

		// Two unique files, each read exactly once even though there were two
		// tool calls.
		expect(reads.get(fileA)).toBe(1);
		expect(reads.get(fileB)).toBe(1);
	});

	it("merges two sibling edit calls that target the same file into one processFile pass (both edits land)", async () => {
		const dir = await createTempDir();
		const file = join(dir, "shared.txt");
		const original = "alpha\nbeta\ngamma\n";
		await writeFile(file, original, "utf8");

		const alpha = anchorFor(file, original, 1);
		const beta = anchorFor(file, original, 2);

		const reads = new Map<string, number>();
		const editTool = createEditTool(dir, {
			operations: {
				access: async () => {},
				readFile: async (p) => {
					reads.set(p, (reads.get(p) ?? 0) + 1);
					return readFile(p);
				},
				writeFile: async (p, c) => writeFile(p, c, "utf8"),
			},
		});

		const callA = {
			id: "call-A",
			name: "edit",
			arguments: {
				files: [
					{
						path: file,
						edits: [{ edit_type: "replace" as const, anchor: alpha, end_anchor: alpha, text: "ALPHA" }],
					},
				],
			},
		};
		const callB = {
			id: "call-B",
			name: "edit",
			arguments: {
				files: [
					{
						path: file,
						edits: [{ edit_type: "replace" as const, anchor: beta, end_anchor: beta, text: "BETA" }],
					},
				],
			},
		};
		announceTurn([callA, callB]);

		const [resA, resB] = await Promise.all([
			editTool.execute(callA.id, callA.arguments),
			editTool.execute(callB.id, callB.arguments),
		]);

		// Both edits applied because they were merged into one processFile pass
		// against the original file content (anchors all still resolve).
		expect(await readFile(file, "utf8")).toBe("ALPHA\nBETA\ngamma\n");
		// And the file was read only once for the whole batch.
		expect(reads.get(file)).toBe(1);

		// Each call's per-call result references the shared file (both calls
		// "see" it because both contributed edits to it).
		expect(resA.details?.files.map((f: { path: string }) => f.path)).toEqual([file]);
		expect(resB.details?.files.map((f: { path: string }) => f.path)).toEqual([file]);
	});

	it("does not batch with non-edit sibling tool calls", async () => {
		const dir = await createTempDir();
		const file = join(dir, "x.txt");
		const original = "x\n";
		await writeFile(file, original, "utf8");
		const anchor = anchorFor(file, original, 1);

		const editTool = createEditTool(dir);

		const editCall = {
			id: "edit-1",
			name: "edit",
			arguments: {
				files: [{ path: file, edits: [{ edit_type: "replace" as const, anchor, end_anchor: anchor, text: "X" }] }],
			},
		};
		const readCall = { id: "read-1", name: "read", arguments: { path: file } };
		announceTurn([editCall, readCall]);

		// The registry only batches edits, so the edit call's batch has size 1
		// (just itself) and falls through to the solo path.
		const batch = getEditTurnBatch(editCall.id) as EditTurnBatch | undefined;
		expect(batch?.editCalls).toHaveLength(1);

		const result = await editTool.execute(editCall.id, editCall.arguments);
		expect(await readFile(file, "utf8")).toBe("X\n");
		expect(result.details?.files[0]?.path).toBe(file);
	});

	it("when one sibling fails, the other still applies (per-file atomicity, not per-batch)", async () => {
		const dir = await createTempDir();
		const fileA = join(dir, "a.txt");
		const fileB = join(dir, "b.txt");
		const origA = "alpha\n";
		const origB = "beta\n";
		await writeFile(fileA, origA, "utf8");
		await writeFile(fileB, origB, "utf8");
		const aAnchor = anchorFor(fileA, origA, 1);

		const editTool = createEditTool(dir);

		const goodCall = {
			id: "call-good",
			name: "edit",
			arguments: {
				files: [
					{
						path: fileA,
						edits: [{ edit_type: "replace" as const, anchor: aAnchor, end_anchor: aAnchor, text: "ALPHA" }],
					},
				],
			},
		};
		const badCall = {
			id: "call-bad",
			name: "edit",
			arguments: {
				files: [
					{
						path: fileB,
						edits: [
							{
								edit_type: "replace" as const,
								anchor: "Bogus\u00a7nope",
								end_anchor: "Bogus\u00a7nope",
								text: "BETA",
							},
						],
					},
				],
			},
		};
		announceTurn([goodCall, badCall]);

		const [goodRes, badRes] = await Promise.allSettled([
			editTool.execute(goodCall.id, goodCall.arguments),
			editTool.execute(badCall.id, badCall.arguments),
		]);

		// The good call applied to its file.
		expect(goodRes.status).toBe("fulfilled");
		expect(await readFile(fileA, "utf8")).toBe("ALPHA\n");

		// The bad call was rejected (no edits applied for that call) and its
		// target file is untouched.
		expect(badRes.status).toBe("rejected");
		if (badRes.status === "rejected") {
			expect(String(badRes.reason)).toMatch(/anchor "Bogus" not found/);
		}
		expect(await readFile(fileB, "utf8")).toBe(origB);
	});
});
