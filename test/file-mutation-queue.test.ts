import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnchorStateManager } from "../src/core/tools/anchor-state-manager.js";
import { createEditTool } from "../src/core/tools/edit.js";
import { withFileMutationQueue } from "../src/core/tools/file-mutation-queue.js";
import { formatLineWithHash } from "../src/core/tools/line-hashing.js";
import { createWriteTool } from "../src/core/tools/write.js";

function anchorFor(absolutePath: string, content: string, oneIndexedLine: number): string {
	const lines = content.split(/\r?\n/);
	const anchors = AnchorStateManager.reconcile(absolutePath, lines);
	return formatLineWithHash(lines[oneIndexedLine - 1], anchors[oneIndexedLine - 1]);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-file-mutation-queue-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("withFileMutationQueue", () => {
	it("serializes operations for the same file", async () => {
		const order: string[] = [];
		const path = "/tmp/file-mutation-queue-same";

		const first = withFileMutationQueue(path, async () => {
			order.push("first:start");
			await delay(30);
			order.push("first:end");
		});
		const second = withFileMutationQueue(path, async () => {
			order.push("second:start");
			order.push("second:end");
		});

		await Promise.all([first, second]);
		expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
	});

	it("allows different files to proceed in parallel", async () => {
		const order: string[] = [];

		await Promise.all([
			withFileMutationQueue("/tmp/file-mutation-queue-a", async () => {
				order.push("a:start");
				await delay(30);
				order.push("a:end");
			}),
			withFileMutationQueue("/tmp/file-mutation-queue-b", async () => {
				order.push("b:start");
				await delay(30);
				order.push("b:end");
			}),
		]);

		expect(order.indexOf("a:start")).toBeLessThan(order.indexOf("a:end"));
		expect(order.indexOf("b:start")).toBeLessThan(order.indexOf("b:end"));
		expect(order.indexOf("b:start")).toBeLessThan(order.indexOf("a:end"));
	});

	it("uses the same queue for symlink aliases", async () => {
		const dir = await createTempDir();
		const targetPath = join(dir, "target.txt");
		const symlinkPath = join(dir, "alias.txt");
		await writeFile(targetPath, "hello\n", "utf8");
		await symlink(targetPath, symlinkPath);

		const order: string[] = [];
		await Promise.all([
			withFileMutationQueue(targetPath, async () => {
				order.push("target:start");
				await delay(30);
				order.push("target:end");
			}),
			withFileMutationQueue(symlinkPath, async () => {
				order.push("alias:start");
				order.push("alias:end");
			}),
		]);

		expect(order).toEqual(["target:start", "target:end", "alias:start", "alias:end"]);
	});
});

describe("built-in edit and write tools", () => {
	beforeEach(() => {
		AnchorStateManager.reset();
	});

	it("serializes parallel edits on the same file (both apply)", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "parallel-edit.txt");
		const original = "alpha\nbeta\ngamma\n";
		await writeFile(filePath, original, "utf8");

		// Compute both anchors against the original file before either edit runs.
		// The two edits target different lines, so when the second edit re-reads
		// the file (after the first has applied) its anchor word is preserved by
		// AnchorStateManager (the unchanged line keeps its anchor) and the line
		// content still matches.
		const alpha = anchorFor(filePath, original, 1);
		const beta = anchorFor(filePath, original, 2);

		const editTool = createEditTool(dir, {
			operations: {
				access,
				readFile: async (path) => {
					const buffer = await readFile(path);
					await delay(30);
					return buffer;
				},
				writeFile: async (path, content) => {
					await delay(30);
					await writeFile(path, content, "utf8");
				},
			},
		});

		await Promise.all([
			editTool.execute("call-1", {
				files: [
					{
						path: filePath,
						edits: [{ edit_type: "replace", anchor: alpha, end_anchor: alpha, text: "ALPHA" }],
					},
				],
			}),
			editTool.execute("call-2", {
				files: [
					{
						path: filePath,
						edits: [{ edit_type: "replace", anchor: beta, end_anchor: beta, text: "BETA" }],
					},
				],
			}),
		]);

		const content = await readFile(filePath, "utf8");
		expect(content).toBe("ALPHA\nBETA\ngamma\n");
	});

	it("shares the queue between edit and write", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "mixed.txt");
		const original = "original\n";
		await writeFile(filePath, original, "utf8");

		const anchor = anchorFor(filePath, original, 1);

		const editTool = createEditTool(dir, {
			operations: {
				access,
				readFile: async (path) => {
					const buffer = await readFile(path);
					await delay(30);
					return buffer;
				},
				writeFile: async (path, content) => {
					await delay(30);
					await writeFile(path, content, "utf8");
				},
			},
		});
		const writeTool = createWriteTool(dir, {
			operations: {
				mkdir: async () => {},
				writeFile: async (path, content) => {
					await delay(10);
					await writeFile(path, content, "utf8");
				},
			},
		});

		const editPromise = editTool.execute("call-1", {
			files: [
				{
					path: filePath,
					edits: [{ edit_type: "replace", anchor, end_anchor: anchor, text: "edited" }],
				},
			],
		});
		await delay(5);
		const writePromise = writeTool.execute("call-2", {
			path: filePath,
			content: "replacement\n",
		});

		await Promise.all([editPromise, writePromise]);

		const content = await readFile(filePath, "utf8");
		expect(content).toBe("replacement\n");
	});
});
