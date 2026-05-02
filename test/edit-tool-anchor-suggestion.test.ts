import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { AnchorStateManager } from "../src/core/tools/anchor-state-manager.js";
import { createEditToolDefinition } from "../src/core/tools/edit.js";
import { ANCHOR_DELIMITER } from "../src/core/tools/line-hashing.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-edit-anchor-suggestion-"));
	tempDirs.push(dir);
	return dir;
}

beforeEach(() => {
	AnchorStateManager.reset();
});

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("edit tool anchor mismatch suggestion", () => {
	it("suggests the correct anchor when content matches a different line", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "run.sh");
		const original = '#!/bin/bash\nDIR=/tmp\n\ncd "$DIR"\n';
		await writeFile(filePath, original, "utf8");

		const lines = original.split("\n");
		const anchors = AnchorStateManager.reconcile(filePath, lines);
		// Anchor for the empty line (index 2) — model mistakenly attaches the
		// next line's content to this anchor.
		const wrongAnchorName = anchors[2];
		const cdLineContent = lines[3]; // cd "$DIR"

		const definition = createEditToolDefinition(dir);
		await expect(
			definition.execute(
				"tool-1",
				{
					files: [
						{
							path: "run.sh",
							edits: [
								{
									edit_type: "replace",
									anchor: `${wrongAnchorName}${ANCHOR_DELIMITER}${cdLineContent}`,
									end_anchor: `${wrongAnchorName}${ANCHOR_DELIMITER}${cdLineContent}`,
									text: 'cd "$DIR" || exit 1',
								},
							],
						},
					],
				},
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrowError(new RegExp(`Did you mean "${anchors[3]}${ANCHOR_DELIMITER}cd "\\$DIR"" \\(line 4\\)`));
	});
});
