import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, type Terminal, Text, TUI } from "@mariozechner/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AnchorStateManager } from "../src/core/tools/anchor-state-manager.js";
import {
	computeEditsPreview,
	createEditToolDefinition,
	type EditToolDetails,
	type EditToolInput,
} from "../src/core/tools/edit.js";
import { formatLineWithHash } from "../src/core/tools/line-hashing.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = true;
	writes: string[] = [];

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}

	get fullClearCount(): number {
		return this.writes.filter((write) => write.includes("\x1b[2J\x1b[H\x1b[3J")).length;
	}
}

async function waitForRender(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForRenderedText(
	getRender: () => string,
	expectedText: string,
	onRetry?: () => void,
	timeoutMs = 2000,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let lastRender = "";
	while (Date.now() < deadline) {
		onRetry?.();
		await waitForRender();
		lastRender = getRender();
		if (lastRender.includes(expectedText)) {
			return lastRender;
		}
	}
	throw new Error(`Timed out waiting for render to include "${expectedText}". Last render:\n${lastRender}`);
}

function buildLargeAnchoredEdits(
	absolutePath: string,
	content: string,
	targetOneIndexedLines: number[],
): EditToolInput {
	const lines = content.split(/\r?\n/);
	const anchors = AnchorStateManager.reconcile(absolutePath, lines);
	const edits = targetOneIndexedLines.map((lineNumber) => {
		const anchorRef = formatLineWithHash(lines[lineNumber - 1], anchors[lineNumber - 1]);
		return {
			edit_type: "replace" as const,
			anchor: anchorRef,
			end_anchor: anchorRef,
			text: `line ${lineNumber - 1} changed`,
		};
	});
	return { files: [{ path: absolutePath, edits }] };
}

describe("edit tool TUI rendering", () => {
	const tempDirs: string[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		AnchorStateManager.reset();
	});

	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("renders the large diff in the call preview and does not full-redraw when the result settles", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-redraw-"));
		tempDirs.push(dir);
		const filePath = join(dir, "large-edit.txt");
		await writeFile(
			filePath,
			`${Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n")}
`,
			"utf8",
		);
		const content = await readFile(filePath, "utf8");
		// Replace the lines after "line 49", "line 149", ... so the rendered diff
		// contains "line 50 changed", "line 950 changed" etc.
		const targets = [50, 150, 250, 350, 450, 550, 650, 750, 850, 950].map((n) => n + 1);
		const input = buildLargeAnchoredEdits(filePath, content, targets);
		const preview = await computeEditsPreview(input, process.cwd());
		if ("error" in preview) {
			throw new Error(preview.error);
		}

		const terminal = new FakeTerminal();
		const tui = new TUI(terminal);
		const root = new Container();
		for (let i = 0; i < 200; i++) {
			root.addChild(new Text(`history ${i}`, 0, 0));
		}

		const component = new ToolExecutionComponent(
			"edit",
			"tool-call-1",
			input,
			{},
			createEditToolDefinition(process.cwd()),
			tui,
			process.cwd(),
		);
		root.addChild(component);
		tui.addChild(root);
		tui.start();
		await waitForRender();

		component.setArgsComplete();
		tui.requestRender();
		await waitForRender();
		await waitForRender();

		const callOnlyRender = await waitForRenderedText(
			() => component.render(80).join("\n"),
			"line 50 changed",
			() => tui.requestRender(true),
		);
		expect(callOnlyRender).toContain("edit");
		expect(callOnlyRender).toContain("line 950 changed");

		const redrawsBeforeResult = tui.fullRedraws;
		const clearsBeforeResult = terminal.fullClearCount;
		const details: EditToolDetails = {
			diff: preview.diff,
			firstChangedLine: preview.firstChangedLine,
			files: preview.files,
		};
		component.updateResult(
			{
				content: [{ type: "text", text: `Applied ${targets.length} edit(s).` }],
				details,
				isError: false,
			},
			false,
		);
		tui.requestRender();
		await waitForRender();

		expect(tui.fullRedraws).toBe(redrawsBeforeResult);
		expect(terminal.fullClearCount).toBe(clearsBeforeResult);

		const settledRender = component.render(80).join("\n");
		expect(settledRender).toContain("line 50 changed");
		expect(settledRender).toContain("line 950 changed");
		expect(settledRender).not.toContain("Applied 10 edit(s).");
	});

	it("reconstructs the boxed preview from a settled result without argsComplete", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-replay-"));
		tempDirs.push(dir);
		const filePath = join(dir, "replay-edit.txt");
		await writeFile(
			filePath,
			`${Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")}
`,
			"utf8",
		);
		const content = await readFile(filePath, "utf8");
		const targets = [50, 150].map((n) => n + 1);
		const input = buildLargeAnchoredEdits(filePath, content, targets);
		const preview = await computeEditsPreview(input, process.cwd());
		if ("error" in preview) {
			throw new Error(preview.error);
		}
		await rm(filePath, { force: true });

		const terminal = new FakeTerminal();
		const tui = new TUI(terminal);
		const component = new ToolExecutionComponent(
			"edit",
			"tool-call-replay",
			input,
			{},
			createEditToolDefinition(process.cwd()),
			tui,
			process.cwd(),
		);
		tui.addChild(component);
		tui.start();
		await waitForRender();

		const details: EditToolDetails = {
			diff: preview.diff,
			firstChangedLine: preview.firstChangedLine,
			files: preview.files,
		};
		component.updateResult(
			{
				content: [{ type: "text", text: `Applied ${targets.length} edit(s).` }],
				details,
				isError: false,
			},
			false,
		);
		await waitForRender();
		await waitForRender();

		const rendered = component.render(80).join("\n");
		expect(rendered).toContain("line 50 changed");
		expect(rendered).toContain("line 150 changed");
	});

	it("shows a preflight error without rendering a diff when the edits do not apply", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-preflight-"));
		tempDirs.push(dir);
		const filePath = join(dir, "missing-edit.txt");
		await writeFile(filePath, "line 0\nline 1\n", "utf8");

		const terminal = new FakeTerminal();
		const tui = new TUI(terminal);
		const bogus = "Bogus\u00a7does-not-exist";
		const input: EditToolInput = {
			files: [
				{
					path: filePath,
					edits: [{ edit_type: "replace", anchor: bogus, end_anchor: bogus, text: "replacement" }],
				},
			],
		};
		const component = new ToolExecutionComponent(
			"edit",
			"tool-call-2",
			input,
			{},
			createEditToolDefinition(process.cwd()),
			tui,
			process.cwd(),
		);
		tui.addChild(component);
		tui.start();
		await waitForRender();

		component.setArgsComplete();
		tui.requestRender();
		await waitForRender();
		await waitForRender();

		const rendered = await waitForRenderedText(
			() => component.render(80).join("\n"),
			"not found",
			() => tui.requestRender(true),
		);
		expect(rendered).not.toContain("+1 ");
		expect(rendered).not.toContain("-1 ");
	});
});
