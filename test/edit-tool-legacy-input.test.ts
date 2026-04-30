import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { AnchorStateManager } from "../src/core/tools/anchor-state-manager.js";
import { createEditToolDefinition } from "../src/core/tools/edit.js";
import { ANCHOR_DELIMITER, formatLineWithHash } from "../src/core/tools/line-hashing.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-edit-legacy-input-"));
	tempDirs.push(dir);
	return dir;
}

beforeEach(() => {
	AnchorStateManager.reset();
});

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Compute the hash-anchored reference for a given line in `content` (1-indexed)
 * by reconciling against the manager. Mirrors what the read tool emits.
 */
function anchorFor(absolutePath: string, content: string, oneIndexedLine: number): string {
	const lines = content.split(/\r?\n/);
	const anchors = AnchorStateManager.reconcile(absolutePath, lines);
	return formatLineWithHash(lines[oneIndexedLine - 1], anchors[oneIndexedLine - 1]);
}

describe("edit tool prepareArguments", () => {
	it("publishes the multi-file schema and hides legacy text-match fields", () => {
		const definition = createEditToolDefinition(process.cwd());
		expect(definition.parameters.properties).toHaveProperty("files");
		expect(definition.parameters.properties).not.toHaveProperty("oldText");
		expect(definition.parameters.properties).not.toHaveProperty("newText");
		expect(definition.parameters.properties).not.toHaveProperty("path");
	});

	it("folds the legacy single-file shape into files[]", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: [
				{
					edit_type: "replace",
					anchor: `Foo${ANCHOR_DELIMITER}before`,
					end_anchor: `Foo${ANCHOR_DELIMITER}before`,
					text: "after",
				},
			],
		});
		expect(prepared).toEqual({
			files: [
				{
					path: "file.txt",
					edits: [
						{
							edit_type: "replace",
							anchor: `Foo${ANCHOR_DELIMITER}before`,
							end_anchor: `Foo${ANCHOR_DELIMITER}before`,
							text: "after",
						},
					],
				},
			],
		});
	});

	it("passes through the new files[] shape unchanged when no coercion is needed", () => {
		const definition = createEditToolDefinition(process.cwd());
		const input = {
			files: [
				{
					path: "file.txt",
					edits: [
						{
							edit_type: "replace",
							anchor: `Foo${ANCHOR_DELIMITER}a`,
							end_anchor: `Foo${ANCHOR_DELIMITER}a`,
							text: "b",
						},
					],
				},
			],
		};
		const prepared = definition.prepareArguments!(input);
		expect(prepared).toEqual(input);
	});

	it("passes through non-object input unchanged", () => {
		const definition = createEditToolDefinition(process.cwd());
		expect(definition.prepareArguments!(null)).toBe(null);
		expect(definition.prepareArguments!(undefined)).toBe(undefined);
		expect(definition.prepareArguments!("garbage")).toBe("garbage");
	});

	it("prepared args execute correctly against a real file", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "legacy.txt");
		const original = "before\n";
		await writeFile(filePath, original, "utf8");

		// Compute the anchor for the only content line so the model-shaped call
		// matches what a real read would have produced.
		const anchor = anchorFor(filePath, "before\n", 1);

		const definition = createEditToolDefinition(dir);
		const prepared = definition.prepareArguments!({
			path: "legacy.txt",
			edits: [{ edit_type: "replace", anchor, end_anchor: anchor, text: "after" }],
		});

		const result = await definition.execute("tool-1", prepared, undefined, undefined, {} as ExtensionContext);
		const text = result.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		expect(text).toContain("Applied 1 edit(s)");
		expect(await readFile(filePath, "utf8")).toBe("after\n");
	});
});

describe("edit tool stringified shapes", () => {
	it("parses files[] from a JSON string", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			files: JSON.stringify([
				{
					path: "file.txt",
					edits: [
						{
							edit_type: "replace",
							anchor: `Foo${ANCHOR_DELIMITER}a`,
							end_anchor: `Foo${ANCHOR_DELIMITER}a`,
							text: "b",
						},
					],
				},
			]),
		});
		expect(prepared).toEqual({
			files: [
				{
					path: "file.txt",
					edits: [
						{
							edit_type: "replace",
							anchor: `Foo${ANCHOR_DELIMITER}a`,
							end_anchor: `Foo${ANCHOR_DELIMITER}a`,
							text: "b",
						},
					],
				},
			],
		});
	});

	it("parses a per-file edits string inside the new shape", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			files: [
				{
					path: "file.txt",
					edits: JSON.stringify([
						{
							edit_type: "replace",
							anchor: `Foo${ANCHOR_DELIMITER}a`,
							end_anchor: `Foo${ANCHOR_DELIMITER}a`,
							text: "b",
						},
					]),
				},
			],
		});
		expect(prepared).toEqual({
			files: [
				{
					path: "file.txt",
					edits: [
						{
							edit_type: "replace",
							anchor: `Foo${ANCHOR_DELIMITER}a`,
							end_anchor: `Foo${ANCHOR_DELIMITER}a`,
							text: "b",
						},
					],
				},
			],
		});
	});

	it("parses edits from a JSON string in the legacy single-file shape", () => {
		const definition = createEditToolDefinition(process.cwd());
		const edit = {
			edit_type: "replace" as const,
			anchor: `Foo${ANCHOR_DELIMITER}a`,
			end_anchor: `Foo${ANCHOR_DELIMITER}a`,
			text: "b",
		};
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: JSON.stringify([edit]),
		});
		expect(prepared).toEqual({ files: [{ path: "file.txt", edits: [edit] }] });
	});

	it("leaves a non-JSON edits string in place so validation fails downstream", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: "not json",
		});
		// In the legacy shape, an unparseable string falls through to an empty edit array.
		expect(prepared).toEqual({ files: [{ path: "file.txt", edits: [] }] });
	});
});
