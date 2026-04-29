import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.js";
import { AnchorStateManager } from "../src/core/tools/anchor-state-manager.js";
import { createBashTool, createLocalBashOperations } from "../src/core/tools/bash.js";
import { ANCHOR_DELIMITER, formatLineWithHash, stripHashes } from "../src/core/tools/line-hashing.js";
import {
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "../src/index.js";
import * as shellModule from "../src/utils/shell.js";

// Compute the hash-anchored reference for a given 1-indexed line in `content`.
// Mirrors what the read tool surfaces and what the edit tool expects.
function anchorFor(absolutePath: string, content: string, oneIndexedLine: number): string {
	const lines = content.split(/\r?\n/);
	const anchors = AnchorStateManager.reconcile(absolutePath, lines);
	return formatLineWithHash(lines[oneIndexedLine - 1], anchors[oneIndexedLine - 1]);
}

const readTool = createReadTool(process.cwd());
const writeTool = createWriteTool(process.cwd());
const editTool = createEditTool(process.cwd());
const bashTool = createBashTool(process.cwd());
const grepTool = createGrepTool(process.cwd());
const findTool = createFindTool(process.cwd());
const lsTool = createLsTool(process.cwd());

// Helper to extract text from content blocks
function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

describe("Coding Agent Tools", () => {
	let testDir: string;

	beforeEach(() => {
		// Create a unique temporary directory for each test
		testDir = join(tmpdir(), `coding-agent-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		AnchorStateManager.reset();
	});

	afterEach(() => {
		// Clean up test directory
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("read tool", () => {
		it("should read file contents that fit within limits, decorated with hash anchors", async () => {
			const testFile = join(testDir, "test.txt");
			const content = "Hello, world!\nLine 2\nLine 3";
			writeFileSync(testFile, content);

			const result = await readTool.execute("test-call-1", { path: testFile });
			const output = getTextOutput(result);

			// Each line is prefixed with `<Anchor>§` so the model can address it later.
			const anchorPrefix = new RegExp(`^[A-Z][a-zA-Z]*${ANCHOR_DELIMITER}`);
			for (const line of output.split("\n")) {
				expect(line).toMatch(anchorPrefix);
			}
			// Stripping anchors yields the original file contents byte for byte.
			expect(stripHashes(output)).toBe(content);
			// No truncation message since file fits within limits.
			expect(output).not.toContain("Use offset=");
			expect(result.details).toBeUndefined();
		});

		it("should handle non-existent files", async () => {
			const testFile = join(testDir, "nonexistent.txt");

			await expect(readTool.execute("test-call-2", { path: testFile })).rejects.toThrow(/ENOENT|not found/i);
		});

		it("should truncate files exceeding line limit", async () => {
			const testFile = join(testDir, "large.txt");
			const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-3", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 2000");
			expect(output).not.toContain("Line 2001");
			expect(output).toContain("[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]");
		});

		it("should truncate when byte limit exceeded", async () => {
			const testFile = join(testDir, "large-bytes.txt");
			// Create file that exceeds 50KB byte limit but has fewer than 2000 lines
			const lines = Array.from({ length: 500 }, (_, i) => `Line ${i + 1}: ${"x".repeat(200)}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-4", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1:");
			// Should show byte limit message
			expect(output).toMatch(/\[Showing lines 1-\d+ of 500 \(.* limit\)\. Use offset=\d+ to continue\.\]/);
		});

		it("should handle offset parameter", async () => {
			const testFile = join(testDir, "offset-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-5", { path: testFile, offset: 51 });
			const output = getTextOutput(result);

			expect(output).not.toContain("Line 50");
			expect(output).toContain("Line 51");
			expect(output).toContain("Line 100");
			// No truncation message since file fits within limits
			expect(output).not.toContain("Use offset=");
		});

		it("should handle limit parameter", async () => {
			const testFile = join(testDir, "limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-6", { path: testFile, limit: 10 });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 10");
			expect(output).not.toContain("Line 11");
			expect(output).toContain("[90 more lines in file. Use offset=11 to continue.]");
		});

		it("should handle offset + limit together", async () => {
			const testFile = join(testDir, "offset-limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-7", {
				path: testFile,
				offset: 41,
				limit: 20,
			});
			const output = getTextOutput(result);

			expect(output).not.toContain("Line 40");
			expect(output).toContain("Line 41");
			expect(output).toContain("Line 60");
			expect(output).not.toContain("Line 61");
			expect(output).toContain("[40 more lines in file. Use offset=61 to continue.]");
		});

		it("should show error when offset is beyond file length", async () => {
			const testFile = join(testDir, "short.txt");
			writeFileSync(testFile, "Line 1\nLine 2\nLine 3");

			await expect(readTool.execute("test-call-8", { path: testFile, offset: 100 })).rejects.toThrow(
				/Offset 100 is beyond end of file \(3 lines total\)/,
			);
		});

		it("should include truncation details when truncated", async () => {
			const testFile = join(testDir, "large-file.txt");
			const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-9", { path: testFile });

			expect(result.details).toBeDefined();
			expect(result.details?.truncation).toBeDefined();
			expect(result.details?.truncation?.truncated).toBe(true);
			expect(result.details?.truncation?.truncatedBy).toBe("lines");
			expect(result.details?.truncation?.totalLines).toBe(2500);
			expect(result.details?.truncation?.outputLines).toBe(2000);
		});

		it("should detect image MIME type from file magic (not extension)", async () => {
			const png1x1Base64 =
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
			const pngBuffer = Buffer.from(png1x1Base64, "base64");

			const testFile = join(testDir, "image.txt");
			writeFileSync(testFile, pngBuffer);

			const result = await readTool.execute("test-call-img-1", { path: testFile });

			expect(result.content[0]?.type).toBe("text");
			expect(getTextOutput(result)).toContain("Read image file [image/png]");

			const imageBlock = result.content.find(
				(c): c is { type: "image"; mimeType: string; data: string } => c.type === "image",
			);
			expect(imageBlock).toBeDefined();
			expect(imageBlock?.mimeType).toBe("image/png");
			expect(typeof imageBlock?.data).toBe("string");
			expect((imageBlock?.data ?? "").length).toBeGreaterThan(0);
		});

		it("should treat files with image extension but non-image content as text", async () => {
			const testFile = join(testDir, "not-an-image.png");
			writeFileSync(testFile, "definitely not a png");

			const result = await readTool.execute("test-call-img-2", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("definitely not a png");
			expect(result.content.some((c: any) => c.type === "image")).toBe(false);
		});
	});

	describe("write tool", () => {
		it("should write file contents", async () => {
			const testFile = join(testDir, "write-test.txt");
			const content = "Test content";

			const result = await writeTool.execute("test-call-3", { path: testFile, content });

			expect(getTextOutput(result)).toContain("Successfully wrote");
			expect(getTextOutput(result)).toContain(testFile);
			expect(result.details).toBeUndefined();
		});

		it("should create parent directories", async () => {
			const testFile = join(testDir, "nested", "dir", "test.txt");
			const content = "Nested content";

			const result = await writeTool.execute("test-call-4", { path: testFile, content });

			expect(getTextOutput(result)).toContain("Successfully wrote");
		});
	});

	describe("edit tool", () => {
		it("should replace a single anchored line", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const original = "Hello, world!\n";
			writeFileSync(testFile, original);

			const anchor = anchorFor(testFile, original, 1);
			const result = await editTool.execute("test-call-5", {
				files: [
					{
						path: testFile,
						edits: [{ edit_type: "replace", anchor, end_anchor: anchor, text: "Hello, testing!" }],
					},
				],
			});

			expect(getTextOutput(result)).toContain("Applied 1 edit(s)");
			expect(result.details).toBeDefined();
			expect(typeof result.details.diff).toBe("string");
			expect(result.details.diff).toContain("testing");
			expect(readFileSync(testFile, "utf-8")).toBe("Hello, testing!\n");
		});

		it("should fail if the anchor word is not in the file", async () => {
			const testFile = join(testDir, "edit-test.txt");
			writeFileSync(testFile, "Hello, world!\n");

			const bogus = `Bogus${ANCHOR_DELIMITER}Hello, world!`;
			await expect(
				editTool.execute("test-call-6", {
					files: [
						{
							path: testFile,
							edits: [{ edit_type: "replace", anchor: bogus, end_anchor: bogus, text: "x" }],
						},
					],
				}),
			).rejects.toThrow(/anchor "Bogus" not found/);
		});

		it("should fail when the anchored line content does not match the file", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const original = "alpha\n";
			writeFileSync(testFile, original);
			const anchor = anchorFor(testFile, original, 1);
			// Mangle the content portion of the anchor so it no longer matches the file.
			const [word] = anchor.split(ANCHOR_DELIMITER);
			const tampered = `${word}${ANCHOR_DELIMITER}stale-content`;

			await expect(
				editTool.execute("test-call-7", {
					files: [
						{
							path: testFile,
							edits: [{ edit_type: "replace", anchor: tampered, end_anchor: tampered, text: "x" }],
						},
					],
				}),
			).rejects.toThrow(/code line you provided does not match/);
		});

		it("should replace multiple disjoint regions in one call", async () => {
			const testFile = join(testDir, "edit-multi.txt");
			const original = "alpha\nbeta\ngamma\ndelta\n";
			writeFileSync(testFile, original);

			const alpha = anchorFor(testFile, original, 1);
			const gamma = anchorFor(testFile, original, 3);
			const result = await editTool.execute("test-call-8", {
				files: [
					{
						path: testFile,
						edits: [
							{ edit_type: "replace", anchor: alpha, end_anchor: alpha, text: "ALPHA" },
							{ edit_type: "replace", anchor: gamma, end_anchor: gamma, text: "GAMMA" },
						],
					},
				],
			});

			expect(getTextOutput(result)).toContain("Applied 2 edit(s)");
			expect(readFileSync(testFile, "utf-8")).toBe("ALPHA\nbeta\nGAMMA\ndelta\n");
			expect(result.details?.diff).toContain("ALPHA");
			expect(result.details?.diff).toContain("GAMMA");
		});

		it("should collapse large unchanged gaps in multi-edit diffs", async () => {
			const testFile = join(testDir, "edit-multi-large-gap.txt");
			const lines = Array.from({ length: 600 }, (_, i) => `line ${String(i + 1).padStart(3, "0")}`);
			const original = `${lines.join("\n")}\n`;
			writeFileSync(testFile, original);

			const a100 = anchorFor(testFile, original, 100);
			const a300 = anchorFor(testFile, original, 300);
			const a500 = anchorFor(testFile, original, 500);
			const result = await editTool.execute("test-call-8b", {
				files: [
					{
						path: testFile,
						edits: [
							{ edit_type: "replace", anchor: a100, end_anchor: a100, text: "LINE 100" },
							{ edit_type: "replace", anchor: a300, end_anchor: a300, text: "LINE 300" },
							{ edit_type: "replace", anchor: a500, end_anchor: a500, text: "LINE 500" },
						],
					},
				],
			});

			const diff = result.details?.diff ?? "";
			expect(diff).toContain("LINE 100");
			expect(diff).toContain("LINE 300");
			expect(diff).toContain("LINE 500");
			expect(diff).toContain("...");
			expect(diff).not.toContain("line 250");
		});

		it("should resolve all anchors against the file as it was at call start (not incrementally)", async () => {
			const testFile = join(testDir, "edit-multi-original.txt");
			const original = "foo\nbar\nbaz\n";
			writeFileSync(testFile, original);

			const foo = anchorFor(testFile, original, 1);
			const bar = anchorFor(testFile, original, 2);
			await editTool.execute("test-call-9", {
				files: [
					{
						path: testFile,
						edits: [
							{ edit_type: "replace", anchor: foo, end_anchor: foo, text: "foo bar" },
							{ edit_type: "replace", anchor: bar, end_anchor: bar, text: "BAR" },
						],
					},
				],
			});

			expect(readFileSync(testFile, "utf-8")).toBe("foo bar\nBAR\nbaz\n");
		});

		it("should fail when edits[] is empty for a file", async () => {
			const testFile = join(testDir, "edit-empty-edits.txt");
			writeFileSync(testFile, "hello\nworld\n");

			await expect(
				editTool.execute("test-call-11", {
					files: [{ path: testFile, edits: [] }],
				}),
			).rejects.toThrow(/No edits provided/);
		});

		it("should fail when files[] is empty", async () => {
			await expect(editTool.execute("test-call-11b", { files: [] })).rejects.toThrow(
				/files must contain at least one entry/,
			);
		});

		it("should fail when multi-edit regions overlap", async () => {
			const testFile = join(testDir, "edit-overlap.txt");
			const original = "one\ntwo\nthree\n";
			writeFileSync(testFile, original);

			const one = anchorFor(testFile, original, 1);
			const two = anchorFor(testFile, original, 2);
			const three = anchorFor(testFile, original, 3);
			await expect(
				editTool.execute("test-call-12", {
					files: [
						{
							path: testFile,
							edits: [
								{ edit_type: "replace", anchor: one, end_anchor: two, text: "ONE\nTWO" },
								{ edit_type: "replace", anchor: two, end_anchor: three, text: "TWO\nTHREE" },
							],
						},
					],
				}),
			).rejects.toThrow(/overlap/);
		});

		it("should not partially apply edits when one edit fails", async () => {
			const testFile = join(testDir, "edit-no-partial.txt");
			const originalContent = "alpha\nbeta\ngamma\n";
			writeFileSync(testFile, originalContent);

			const alpha = anchorFor(testFile, originalContent, 1);
			const missing = `Missing${ANCHOR_DELIMITER}does-not-exist`;
			await expect(
				editTool.execute("test-call-13", {
					files: [
						{
							path: testFile,
							edits: [
								{ edit_type: "replace", anchor: alpha, end_anchor: alpha, text: "ALPHA" },
								{ edit_type: "replace", anchor: missing, end_anchor: missing, text: "MISSING" },
							],
						},
					],
				}),
			).rejects.toThrow(/anchor "Missing" not found/);

			expect(readFileSync(testFile, "utf-8")).toBe(originalContent);
		});

		it("should support insert_after to add a line below an anchor", async () => {
			const testFile = join(testDir, "edit-insert-after.txt");
			const original = "alpha\ngamma\n";
			writeFileSync(testFile, original);

			const alpha = anchorFor(testFile, original, 1);
			await editTool.execute("test-call-insert-after", {
				files: [
					{
						path: testFile,
						edits: [{ edit_type: "insert_after", anchor: alpha, text: "beta" }],
					},
				],
			});

			expect(readFileSync(testFile, "utf-8")).toBe("alpha\nbeta\ngamma\n");
		});

		it("should support insert_before to add a line above an anchor", async () => {
			const testFile = join(testDir, "edit-insert-before.txt");
			const original = "beta\ngamma\n";
			writeFileSync(testFile, original);

			const beta = anchorFor(testFile, original, 1);
			await editTool.execute("test-call-insert-before", {
				files: [
					{
						path: testFile,
						edits: [{ edit_type: "insert_before", anchor: beta, text: "alpha" }],
					},
				],
			});

			expect(readFileSync(testFile, "utf-8")).toBe("alpha\nbeta\ngamma\n");
		});

		it("should batch edits across multiple files in a single call", async () => {
			const fileA = join(testDir, "a.txt");
			const fileB = join(testDir, "b.txt");
			const origA = "alpha\n";
			const origB = "beta\n";
			writeFileSync(fileA, origA);
			writeFileSync(fileB, origB);

			const aAnchor = anchorFor(fileA, origA, 1);
			const bAnchor = anchorFor(fileB, origB, 1);
			const result = await editTool.execute("test-call-multifile", {
				files: [
					{
						path: fileA,
						edits: [{ edit_type: "replace", anchor: aAnchor, end_anchor: aAnchor, text: "ALPHA" }],
					},
					{
						path: fileB,
						edits: [{ edit_type: "replace", anchor: bAnchor, end_anchor: bAnchor, text: "BETA" }],
					},
				],
			});

			expect(getTextOutput(result)).toContain("Applied 2 edit(s) across 2 file(s)");
			expect(readFileSync(fileA, "utf-8")).toBe("ALPHA\n");
			expect(readFileSync(fileB, "utf-8")).toBe("BETA\n");
			expect(result.details?.files).toHaveLength(2);
		});
	});

	describe("bash tool", () => {
		it("should execute simple commands", async () => {
			const result = await bashTool.execute("test-call-8", { command: "echo 'test output'" });

			expect(getTextOutput(result)).toContain("test output");
			expect(result.details).toBeUndefined();
		});

		it("should handle command errors", async () => {
			await expect(bashTool.execute("test-call-9", { command: "exit 1" })).rejects.toThrow(
				/(Command failed|code 1)/,
			);
		});

		it("should respect timeout", async () => {
			await expect(bashTool.execute("test-call-10", { command: "sleep 5", timeout: 1 })).rejects.toThrow(
				/timed out/i,
			);
		});

		it("should throw error when cwd does not exist", async () => {
			const nonexistentCwd = "/this/directory/definitely/does/not/exist/12345";

			const bashToolWithBadCwd = createBashTool(nonexistentCwd);

			await expect(bashToolWithBadCwd.execute("test-call-11", { command: "echo test" })).rejects.toThrow(
				/Working directory does not exist/,
			);
		});

		it("should handle process spawn errors", async () => {
			vi.spyOn(shellModule, "getShellConfig").mockReturnValueOnce({
				shell: "/nonexistent-shell-path-xyz123",
				args: ["-c"],
			});

			const bashWithBadShell = createBashTool(testDir);

			await expect(bashWithBadShell.execute("test-call-12", { command: "echo test" })).rejects.toThrow(/ENOENT/);
		});

		it("should pass shellPath through to shell resolution", async () => {
			const getShellConfigSpy = vi.spyOn(shellModule, "getShellConfig");
			const bashWithCustomShell = createBashTool(testDir, {
				shellPath: "/custom/bash",
				operations: {
					exec: async () => ({ exitCode: 0 }),
				},
			});

			await bashWithCustomShell.execute("test-call-12b", { command: "echo test" });

			expect(getShellConfigSpy).not.toHaveBeenCalled();

			const ops = createLocalBashOperations({ shellPath: "/custom/bash" });
			await expect(
				ops.exec("echo test", testDir, {
					onData: () => {},
				}),
			).rejects.toThrow("Custom shell path not found: /custom/bash");
			expect(getShellConfigSpy).toHaveBeenCalledWith("/custom/bash");
		});

		it("should prepend command prefix when configured", async () => {
			const bashWithPrefix = createBashTool(testDir, {
				commandPrefix: "export TEST_VAR=hello",
			});

			const result = await bashWithPrefix.execute("test-prefix-1", { command: "echo $TEST_VAR" });
			expect(getTextOutput(result).trim()).toBe("hello");
		});

		it("should include output from both prefix and command", async () => {
			const bashWithPrefix = createBashTool(testDir, {
				commandPrefix: "echo prefix-output",
			});

			const result = await bashWithPrefix.execute("test-prefix-2", { command: "echo command-output" });
			expect(getTextOutput(result).trim()).toBe("prefix-output\ncommand-output");
		});

		it("should work without command prefix", async () => {
			const bashWithoutPrefix = createBashTool(testDir, {});

			const result = await bashWithoutPrefix.execute("test-prefix-3", { command: "echo no-prefix" });
			expect(getTextOutput(result).trim()).toBe("no-prefix");
		});

		it("should expose local bash operations for extension reuse", async () => {
			const ops = createLocalBashOperations();
			const chunks: Buffer[] = [];

			const result = await ops.exec("echo $TEST_LOCAL_BASH_OPS", testDir, {
				onData: (data) => chunks.push(data),
				env: { ...process.env, TEST_LOCAL_BASH_OPS: "from-local-ops" },
			});

			expect(result.exitCode).toBe(0);
			expect(Buffer.concat(chunks).toString("utf-8").trim()).toBe("from-local-ops");
		});

		it("should preserve executeBash sanitization when using local bash operations", async () => {
			const result = await executeBashWithOperations(
				"printf '\\033[31mred\\033[0m\\r\\n'",
				process.cwd(),
				createLocalBashOperations(),
			);

			expect(result.exitCode).toBe(0);
			expect(result.output).toBe("red\n");
		});

		it("should persist full output when truncation happens by line count only", async () => {
			const bash = createBashTool(testDir);
			const result = await bash.execute("test-call-line-truncation", { command: "seq 3000" });
			const output = getTextOutput(result);
			const fullOutputPath = result.details?.fullOutputPath;

			expect(result.details?.truncation?.truncated).toBe(true);
			expect(result.details?.truncation?.truncatedBy).toBe("lines");
			expect(fullOutputPath).toBeDefined();
			expect(output).toMatch(/\[Showing lines \d+-\d+ of \d+\. Full output: /);
			expect(output).not.toContain("Full output: undefined");

			for (let i = 0; i < 20 && (!fullOutputPath || !existsSync(fullOutputPath)); i++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			expect(fullOutputPath).toBeDefined();
			expect(existsSync(fullOutputPath!)).toBe(true);
			const fullOutput = readFileSync(fullOutputPath!, "utf-8");
			expect(fullOutput).toContain("1\n2\n3");
			expect(fullOutput).toContain("2998\n2999\n3000");
		});

		it("executeBash should persist full output when truncation happens by line count only", async () => {
			const result = await executeBashWithOperations("seq 3000", process.cwd(), createLocalBashOperations());
			const fullOutputPath = result.fullOutputPath;

			expect(result.truncated).toBe(true);
			expect(fullOutputPath).toBeDefined();

			for (let i = 0; i < 20 && (!fullOutputPath || !existsSync(fullOutputPath)); i++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			expect(fullOutputPath).toBeDefined();
			expect(existsSync(fullOutputPath!)).toBe(true);
			const fullOutput = readFileSync(fullOutputPath!, "utf-8");
			expect(fullOutput).toContain("1\n2\n3");
			expect(fullOutput).toContain("2998\n2999\n3000");
		});
	});

	describe("grep tool", () => {
		it("should include filename when searching a single file", async () => {
			const testFile = join(testDir, "example.txt");
			writeFileSync(testFile, "first line\nmatch line\nlast line");

			const result = await grepTool.execute("test-call-11", {
				pattern: "match",
				path: testFile,
			});

			const output = getTextOutput(result);
			expect(output).toContain("example.txt:2: match line");
		});

		it("should respect global limit and include context lines", async () => {
			const testFile = join(testDir, "context.txt");
			const content = ["before", "match one", "after", "middle", "match two", "after two"].join("\n");
			writeFileSync(testFile, content);

			const result = await grepTool.execute("test-call-12", {
				pattern: "match",
				path: testFile,
				limit: 1,
				context: 1,
			});

			const output = getTextOutput(result);
			expect(output).toContain("context.txt-1- before");
			expect(output).toContain("context.txt:2: match one");
			expect(output).toContain("context.txt-3- after");
			expect(output).toContain("[1 matches limit reached. Use limit=2 for more, or refine pattern]");
			// Ensure second match is not present
			expect(output).not.toContain("match two");
		});
	});

	describe("find tool", () => {
		it("should include hidden files that are not gitignored", async () => {
			const hiddenDir = join(testDir, ".secret");
			mkdirSync(hiddenDir);
			writeFileSync(join(hiddenDir, "hidden.txt"), "hidden");
			writeFileSync(join(testDir, "visible.txt"), "visible");

			const result = await findTool.execute("test-call-13", {
				pattern: "**/*.txt",
				path: testDir,
			});

			const outputLines = getTextOutput(result)
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);

			expect(outputLines).toContain("visible.txt");
			expect(outputLines).toContain(".secret/hidden.txt");
		});

		it("should respect .gitignore", async () => {
			writeFileSync(join(testDir, ".gitignore"), "ignored.txt\n");
			writeFileSync(join(testDir, "ignored.txt"), "ignored");
			writeFileSync(join(testDir, "kept.txt"), "kept");

			const result = await findTool.execute("test-call-14", {
				pattern: "**/*.txt",
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("kept.txt");
			expect(output).not.toContain("ignored.txt");
		});

		it("should surface fd glob parse errors", async () => {
			await expect(
				findTool.execute("test-call-15", {
					pattern: "[",
					path: testDir,
				}),
			).rejects.toThrow(/error parsing glob|fd exited with code 1|fd error/i);
		});
	});

	describe("ls tool", () => {
		it("should list dotfiles and directories", async () => {
			writeFileSync(join(testDir, ".hidden-file"), "secret");
			mkdirSync(join(testDir, ".hidden-dir"));

			const result = await lsTool.execute("test-call-15", { path: testDir });
			const output = getTextOutput(result);

			expect(output).toContain(".hidden-file");
			expect(output).toContain(".hidden-dir/");
		});
	});
});

// Note: the legacy `edit tool fuzzy matching` describe block was removed
// because the hash-anchored protocol references lines by exact content (after
// CRLF/BOM normalisation). Smart-quote / NFKC / dash / NBSP fuzzy matching no
// longer applies; the model receives the canonical line content from the read
// tool and echoes it back verbatim.

describe("edit tool CRLF / BOM handling", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-crlf-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		AnchorStateManager.reset();
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("should resolve anchors against CRLF file content (LF-normalised internally)", async () => {
		const testFile = join(testDir, "crlf-test.txt");
		writeFileSync(testFile, "line one\r\nline two\r\nline three\r\n");

		// AnchorStateManager always reconciles against LF-split lines, so the
		// test builds the anchor from the LF-normalised form too.
		const lfContent = "line one\nline two\nline three\n";
		const anchor = anchorFor(testFile, lfContent, 2);
		const result = await editTool.execute("test-crlf-1", {
			files: [
				{
					path: testFile,
					edits: [{ edit_type: "replace", anchor, end_anchor: anchor, text: "replaced line" }],
				},
			],
		});

		expect(getTextOutput(result)).toContain("Applied 1 edit(s)");
	});

	it("should preserve CRLF line endings after edit", async () => {
		const testFile = join(testDir, "crlf-preserve.txt");
		writeFileSync(testFile, "first\r\nsecond\r\nthird\r\n");

		const lf = "first\nsecond\nthird\n";
		const anchor = anchorFor(testFile, lf, 2);
		await editTool.execute("test-crlf-2", {
			files: [
				{
					path: testFile,
					edits: [{ edit_type: "replace", anchor, end_anchor: anchor, text: "REPLACED" }],
				},
			],
		});

		expect(readFileSync(testFile, "utf-8")).toBe("first\r\nREPLACED\r\nthird\r\n");
	});

	it("should preserve LF line endings for LF files", async () => {
		const testFile = join(testDir, "lf-preserve.txt");
		const original = "first\nsecond\nthird\n";
		writeFileSync(testFile, original);

		const anchor = anchorFor(testFile, original, 2);
		await editTool.execute("test-lf-1", {
			files: [
				{
					path: testFile,
					edits: [{ edit_type: "replace", anchor, end_anchor: anchor, text: "REPLACED" }],
				},
			],
		});

		expect(readFileSync(testFile, "utf-8")).toBe("first\nREPLACED\nthird\n");
	});

	it("should preserve UTF-8 BOM after edit", async () => {
		const testFile = join(testDir, "bom-test.txt");
		writeFileSync(testFile, "\uFEFFfirst\r\nsecond\r\nthird\r\n");

		// BOM is stripped before reconciling, so anchors are computed against the
		// LF-normalised BOM-less form.
		const lf = "first\nsecond\nthird\n";
		const anchor = anchorFor(testFile, lf, 2);
		await editTool.execute("test-bom", {
			files: [
				{
					path: testFile,
					edits: [{ edit_type: "replace", anchor, end_anchor: anchor, text: "REPLACED" }],
				},
			],
		});

		expect(readFileSync(testFile, "utf-8")).toBe("\uFEFFfirst\r\nREPLACED\r\nthird\r\n");
	});

	it("should preserve CRLF and BOM across a multi-edit batch", async () => {
		const testFile = join(testDir, "bom-crlf-multi.txt");
		writeFileSync(testFile, "\uFEFFfirst\r\nsecond\r\nthird\r\nfourth\r\n");

		const lf = "first\nsecond\nthird\nfourth\n";
		const aSecond = anchorFor(testFile, lf, 2);
		const aFourth = anchorFor(testFile, lf, 4);
		await editTool.execute("test-crlf-multi", {
			files: [
				{
					path: testFile,
					edits: [
						{ edit_type: "replace", anchor: aSecond, end_anchor: aSecond, text: "SECOND" },
						{ edit_type: "replace", anchor: aFourth, end_anchor: aFourth, text: "FOURTH" },
					],
				},
			],
		});

		expect(readFileSync(testFile, "utf-8")).toBe("\uFEFFfirst\r\nSECOND\r\nthird\r\nFOURTH\r\n");
	});
});
