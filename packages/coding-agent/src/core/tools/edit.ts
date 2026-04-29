import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Box, Container, Spacer, Text } from "@mariozechner/pi-tui";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { renderDiff } from "../../modes/interactive/components/diff.js";
import type { ToolDefinition } from "../extensions/types.js";
import { AnchorStateManager } from "./anchor-state-manager.js";
import { detectLineEnding, generateDiffString, normalizeToLF, restoreLineEndings, stripBom } from "./edit-diff.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { getDelimiter, splitAnchor, stripHashes } from "./line-hashing.js";
import { resolveToCwd } from "./path-utils.js";
import { invalidArgText, shortenPath } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const editEntrySchema = Type.Object(
	{
		edit_type: Type.Optional(
			Type.Union([Type.Literal("replace"), Type.Literal("insert_after"), Type.Literal("insert_before")], {
				description:
					"replace (default): replace inclusive [anchor, end_anchor]. insert_after / insert_before: insert text relative to anchor.",
			}),
		),
		anchor: Type.String({
			description: `Start-of-edit anchor. Format: "Word${getDelimiter()}<exact line content>". Anchors come from the most recent read of this file.`,
		}),
		end_anchor: Type.Optional(
			Type.String({
				description: `Inclusive end anchor (required for edit_type=replace). Format: "Word${getDelimiter()}<exact line content>".`,
			}),
		),
		text: Type.String({ description: "Replacement text. Use \\n for newlines." }),
	},
	{ additionalProperties: false },
);

const fileEditSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)." }),
		edits: Type.Array(editEntrySchema, { description: "One or more edits to apply to this file." }),
	},
	{ additionalProperties: false },
);

const editSchema = Type.Object(
	{
		files: Type.Array(fileEditSchema, {
			description: "Files to edit. Batch all non-overlapping edits across files into a single call.",
		}),
	},
	{ additionalProperties: false },
);

export type EditToolInput = Static<typeof editSchema>;
export type EditEntry = Static<typeof editEntrySchema>;
export type FileEdit = Static<typeof fileEditSchema>;

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface FileEditResult {
	path: string;
	diff?: string;
	error?: string;
	appliedCount: number;
	failedCount: number;
	firstChangedLine?: number;
}

export interface EditToolDetails {
	/** Combined unified diff across all touched files. */
	diff: string;
	/** Per-file results. */
	files: FileEditResult[];
	/** Line number of the first change in the first edited file (for editor navigation). */
	firstChangedLine?: number;
}

// ---------------------------------------------------------------------------
// Pluggable IO (parity with previous tool)
// ---------------------------------------------------------------------------

export interface EditOperations {
	readFile: (absolutePath: string) => Promise<Buffer>;
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
	operations?: EditOperations;
}

// ---------------------------------------------------------------------------
// Argument coercion (legacy + stringified shapes)
// ---------------------------------------------------------------------------

type LegacyEditInput = {
	files?: unknown;
	path?: unknown;
	edits?: unknown;
	oldText?: unknown;
	newText?: unknown;
};

function coerceEditsArray(value: unknown): EditEntry[] | undefined {
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			return Array.isArray(parsed) ? (parsed as EditEntry[]) : undefined;
		} catch {
			return undefined;
		}
	}
	return Array.isArray(value) ? (value as EditEntry[]) : undefined;
}

export function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") return input as EditToolInput;
	const args = input as LegacyEditInput;

	// Preferred shape: { files: [...] }
	if (args.files !== undefined) {
		let files: unknown = args.files;
		if (typeof files === "string") {
			try {
				files = JSON.parse(files);
			} catch {
				/* leave as-is, validation will fail */
			}
		}
		if (Array.isArray(files)) {
			const normalized = files.map((entry: any) => {
				const edits = coerceEditsArray(entry?.edits) ?? entry?.edits;
				return { ...entry, edits };
			});
			return { files: normalized as FileEdit[] };
		}
		return { files: [] };
	}

	// Legacy single-file shape: { path, edits: [...] }
	if (typeof args.path === "string") {
		const edits = coerceEditsArray(args.edits) ?? [];
		return { files: [{ path: args.path, edits } as FileEdit] };
	}

	// Legacy oldText/newText (no anchors): refuse softly by surfacing a clear error
	// downstream; we still return a typed object so schema validation can run.
	return { files: [] };
}

// ---------------------------------------------------------------------------
// Resolve & apply
// ---------------------------------------------------------------------------

interface ResolvedEntry {
	startIdx: number;
	endIdx: number;
	edit: EditEntry;
}

interface FailedEntry {
	edit: EditEntry;
	error: string;
}

const ANCHOR_NAME_RE = /^[A-Z][a-zA-Z]*$/;

function resolveAnchor(
	type: "anchor" | "end_anchor",
	rawAnchor: string | undefined,
	anchors: string[],
	lines: string[],
): { index: number; error?: string } {
	const value = rawAnchor || "";
	if (!value.trim()) return { index: -1, error: `${type} is missing.` };

	const { anchor: anchorName, content: providedContent } = splitAnchor(value);

	if (!ANCHOR_NAME_RE.test(anchorName)) {
		return {
			index: -1,
			error: `${type} is missing or incorrectly formatted. It must start with a capital-letter word followed by "${getDelimiter()}" (e.g. "Apple${getDelimiter()}").`,
		};
	}

	const index = anchors.indexOf(anchorName);
	if (index === -1) {
		return {
			index: -1,
			error: `${type} "${anchorName}" not found in the file. Re-read the file to obtain fresh anchors.`,
		};
	}

	if (providedContent.includes("\n") || providedContent.includes("\r")) {
		return {
			index: -1,
			error: `${type} "${anchorName}" exists, but the provided code line contains a newline. Anchors must reference a single line of the form Anchor${getDelimiter()}<line text>.`,
		};
	}

	const actualContent = lines[index];
	if (providedContent !== actualContent) {
		return {
			index: -1,
			error: `${type} "${anchorName}" exists, but the code line you provided does not match the file. Expected: "${actualContent}", Provided: "${providedContent}".`,
		};
	}

	return { index };
}

function resolveEdits(
	edits: EditEntry[],
	lines: string[],
	anchors: string[],
): { resolved: ResolvedEntry[]; failed: FailedEntry[] } {
	const resolved: ResolvedEntry[] = [];
	const failed: FailedEntry[] = [];

	for (const edit of edits) {
		const editType = edit.edit_type ?? "replace";
		const diagnostics: string[] = [];

		const start = resolveAnchor("anchor", edit.anchor, anchors, lines);
		if (start.error) diagnostics.push(start.error);

		let endIdx = start.index;
		if (editType === "replace") {
			const end = resolveAnchor("end_anchor", edit.end_anchor, anchors, lines);
			if (end.error) diagnostics.push(end.error);
			endIdx = end.index;
		}

		if (start.index !== -1 && endIdx !== -1 && endIdx < start.index) {
			diagnostics.push("Range error: anchor must precede or equal end_anchor.");
		}

		if (diagnostics.length > 0) {
			failed.push({ edit, error: diagnostics.join(" ") });
		} else {
			resolved.push({ startIdx: start.index, endIdx, edit });
		}
	}

	return { resolved, failed };
}

function checkOverlap(resolved: ResolvedEntry[]): string | undefined {
	const sorted = [...resolved].map((r, i) => ({ r, i })).sort((a, b) => a.r.startIdx - b.r.startIdx);
	for (let i = 1; i < sorted.length; i++) {
		const prev = sorted[i - 1];
		const cur = sorted[i];
		if (prev.r.endIdx >= cur.r.startIdx) {
			return `Edits overlap (anchor "${prev.r.edit.anchor}" and "${cur.r.edit.anchor}"). Merge them into a single edit or target disjoint regions.`;
		}
	}
	return undefined;
}

function applyEdits(lines: string[], resolved: ResolvedEntry[]): string[] {
	// Apply from bottom-up so earlier indices remain valid.
	const sorted = [...resolved].sort((a, b) => b.startIdx - a.startIdx);
	const out = [...lines];
	for (const { startIdx, endIdx, edit } of sorted) {
		const editType = edit.edit_type ?? "replace";
		const cleanText = stripHashes(edit.text || "");
		const replacement = cleanText === "" ? [] : cleanText.split(/\r?\n/);

		if (editType === "insert_after") {
			out.splice(startIdx + 1, 0, ...replacement);
		} else if (editType === "insert_before") {
			out.splice(startIdx, 0, ...replacement);
		} else {
			out.splice(startIdx, endIdx - startIdx + 1, ...replacement);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Per-file processing
// ---------------------------------------------------------------------------

interface ProcessedFile extends FileEditResult {
	absolutePath: string;
	finalContent?: string;
	originalContent?: string;
	bom: string;
	lineEnding: "\r\n" | "\n";
}

async function processFile(
	fileEdit: FileEdit,
	cwd: string,
	ops: EditOperations,
	signal: AbortSignal | undefined,
): Promise<ProcessedFile> {
	const { path: relPath, edits } = fileEdit;
	const absolutePath = resolveToCwd(relPath, cwd);
	const result: ProcessedFile = {
		path: relPath,
		absolutePath,
		appliedCount: 0,
		failedCount: 0,
		bom: "",
		lineEnding: "\n",
	};

	try {
		await ops.access(absolutePath);
	} catch {
		result.error = `File not found: ${relPath}`;
		return result;
	}
	if (signal?.aborted) throw new Error("Operation aborted");

	if (!Array.isArray(edits) || edits.length === 0) {
		result.error = `No edits provided for ${relPath}.`;
		return result;
	}

	for (let i = 0; i < edits.length; i++) {
		const e = edits[i];
		const isReplace = (e.edit_type ?? "replace") === "replace";
		if (!e.anchor || (isReplace && !e.end_anchor) || typeof e.text !== "string") {
			result.error = `edits[${i}] for ${relPath} is missing a required field (anchor, end_anchor for replace, or text).`;
			return result;
		}
	}

	const buffer = await ops.readFile(absolutePath);
	const rawContent = buffer.toString("utf-8");
	const { bom, text } = stripBom(rawContent);
	const originalEnding = detectLineEnding(text);
	const normalized = normalizeToLF(text);
	const lines = normalized.split("\n");
	const anchors = AnchorStateManager.reconcile(absolutePath, lines);

	const { resolved, failed } = resolveEdits(edits, lines, anchors);
	result.failedCount = failed.length;

	if (resolved.length === 0) {
		result.error = failed.map((f) => `Edit (anchor: "${f.edit.anchor}") failed: ${f.error}`).join("\n");
		return result;
	}

	const overlap = checkOverlap(resolved);
	if (overlap) {
		result.error = overlap;
		return result;
	}

	// Atomic per file: if any edit failed to resolve, abandon the whole file.
	if (failed.length > 0) {
		result.error = failed.map((f) => `Edit (anchor: "${f.edit.anchor}") failed: ${f.error}`).join("\n");
		return result;
	}

	const newLines = applyEdits(lines, resolved);
	const newContent = newLines.join("\n");

	if (newContent === normalized) {
		result.error = `No changes made to ${relPath}. The replacements produced identical content.`;
		return result;
	}

	const diffResult = generateDiffString(normalized, newContent);
	result.diff = diffResult.diff;
	result.firstChangedLine = diffResult.firstChangedLine;
	result.appliedCount = resolved.length;
	result.originalContent = normalized;
	result.finalContent = newContent;
	result.bom = bom;
	result.lineEnding = originalEnding;

	return result;
}

// ---------------------------------------------------------------------------
// Render helpers (TUI)
// ---------------------------------------------------------------------------

type EditPreview = { diff: string; firstChangedLine?: number; perFile: FileEditResult[] } | { error: string };

type EditRenderState = { callComponent?: EditCallRenderComponent };

type EditCallRenderComponent = Box & {
	preview?: EditPreview;
	previewArgsKey?: string;
	previewPending?: boolean;
	settledError?: boolean;
};

function createEditCallRenderComponent(): EditCallRenderComponent {
	return Object.assign(new Box(1, 1, (text: string) => text), {
		preview: undefined as EditPreview | undefined,
		previewArgsKey: undefined as string | undefined,
		previewPending: false,
		settledError: false,
	});
}

function getEditCallRenderComponent(state: EditRenderState, lastComponent: unknown): EditCallRenderComponent {
	if (lastComponent instanceof Box) {
		const c = lastComponent as EditCallRenderComponent;
		state.callComponent = c;
		return c;
	}
	if (state.callComponent) return state.callComponent;
	const c = createEditCallRenderComponent();
	state.callComponent = c;
	return c;
}

function describeFiles(files: FileEdit[] | undefined): { label: string; count: number } {
	if (!Array.isArray(files) || files.length === 0) return { label: "...", count: 0 };
	if (files.length === 1) return { label: files[0]?.path ?? "...", count: 1 };
	return { label: `${files.length} files`, count: files.length };
}

function formatEditCall(
	args: Partial<EditToolInput> | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const invalidArg = invalidArgText(theme);
	const files = args?.files;
	if (!Array.isArray(files)) {
		return `${theme.fg("toolTitle", theme.bold("edit"))} ${invalidArg}`;
	}
	const { label, count } = describeFiles(files as FileEdit[]);
	const display =
		count === 1
			? theme.fg("accent", shortenPath(label))
			: count === 0
				? theme.fg("toolOutput", "...")
				: theme.fg("accent", label);
	return `${theme.fg("toolTitle", theme.bold("edit"))} ${display}`;
}

function getEditHeaderBg(
	preview: EditPreview | undefined,
	settledError: boolean | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): (text: string) => string {
	if (preview) {
		if ("error" in preview) return (t) => theme.bg("toolErrorBg", t);
		return (t) => theme.bg("toolSuccessBg", t);
	}
	if (settledError) return (t) => theme.bg("toolErrorBg", t);
	return (t) => theme.bg("toolPendingBg", t);
}

function buildEditCallComponent(
	component: EditCallRenderComponent,
	args: Partial<EditToolInput> | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): EditCallRenderComponent {
	component.setBgFn(getEditHeaderBg(component.preview, component.settledError, theme));
	component.clear();
	component.addChild(new Text(formatEditCall(args, theme), 0, 0));

	if (!component.preview) return component;

	if ("error" in component.preview) {
		component.addChild(new Spacer(1));
		component.addChild(new Text(theme.fg("error", component.preview.error), 0, 0));
		return component;
	}

	component.addChild(new Spacer(1));
	for (const f of component.preview.perFile) {
		if (f.diff && !f.error) {
			component.addChild(new Text(theme.fg("accent", f.path), 0, 0));
			component.addChild(new Text(renderDiff(f.diff, { filePath: f.path }), 0, 0));
		} else if (f.error) {
			component.addChild(new Text(theme.fg("error", `${f.path}: ${f.error}`), 0, 0));
		}
		component.addChild(new Spacer(1));
	}
	return component;
}

function previewsEqual(a: EditPreview | undefined, b: EditPreview): boolean {
	if (!a) return false;
	if ("error" in a || "error" in b) {
		return "error" in a && "error" in b && a.error === b.error;
	}
	if (a.diff !== b.diff || a.firstChangedLine !== b.firstChangedLine) return false;
	if (a.perFile.length !== b.perFile.length) return false;
	for (let i = 0; i < a.perFile.length; i++) {
		if (a.perFile[i].diff !== b.perFile[i].diff || a.perFile[i].error !== b.perFile[i].error) return false;
	}
	return true;
}

function setEditPreview(
	component: EditCallRenderComponent,
	preview: EditPreview,
	argsKey: string | undefined,
): boolean {
	const changed = !previewsEqual(component.preview, preview) || component.previewArgsKey !== argsKey;
	component.preview = preview;
	component.previewArgsKey = argsKey;
	component.previewPending = false;
	return changed;
}

/**
 * Public helper to compute the preview details (diff + per-file results) for a
 * planned edit invocation, without writing anything to disk. Used by the TUI
 * preview path and exposed for tests.
 */
export async function computeEditsPreview(
	input: EditToolInput | unknown,
	cwd: string,
	options?: EditToolOptions,
): Promise<{ diff: string; firstChangedLine?: number; files: FileEditResult[] } | { error: string }> {
	const prepared = prepareEditArguments(input);
	const preview = await computePreview(prepared, cwd, options?.operations ?? defaultEditOperations);
	if ("error" in preview) return preview;
	return { diff: preview.diff, firstChangedLine: preview.firstChangedLine, files: preview.perFile };
}

async function computePreview(input: EditToolInput, cwd: string, ops: EditOperations): Promise<EditPreview> {
	try {
		const perFile: FileEditResult[] = [];
		const diffParts: string[] = [];
		let firstChangedLine: number | undefined;
		for (const fe of input.files ?? []) {
			const res = await processFile(fe, cwd, ops, undefined);
			perFile.push({
				path: res.path,
				diff: res.diff,
				error: res.error,
				appliedCount: res.appliedCount,
				failedCount: res.failedCount,
				firstChangedLine: res.firstChangedLine,
			});
			if (res.diff) {
				diffParts.push(`*** Update File: ${res.path}\n${res.diff}`);
				if (firstChangedLine === undefined && res.firstChangedLine !== undefined) {
					firstChangedLine = res.firstChangedLine;
				}
			}
		}
		return { diff: diffParts.join("\n\n"), firstChangedLine, perFile };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
	const ops = options?.operations ?? defaultEditOperations;
	const delimiter = getDelimiter();

	return {
		name: "edit",
		label: "edit",
		description: `Edit one or more files using hash-anchored line references obtained from a recent read.

EDIT TYPES:
- replace (default): Replace inclusive [anchor, end_anchor]. end_anchor is required.
- insert_after: Insert text immediately after the line referenced by anchor.
- insert_before: Insert text immediately before the line referenced by anchor.

ANCHOR RULES:
- An anchor has the form "Word${delimiter}<exact line content>". The Word is opaque and file-scoped.
- Always read a file first to obtain its current anchors. Anchors change when lines change.
- For replace, the range is inclusive: ensure end_anchor points exactly to the last line you want overwritten (e.g., a closing bracket).

BATCHING:
- Batch all non-overlapping edits across all files into a single tool call.
- Edits are matched against the file as it was when the call started; do not assume earlier edits in the same call shifted line numbers.`,
		promptSnippet: "Edit one or more files via hash-anchored line references (multi-file batched).",
		promptGuidelines: [
			"Always read a file first to obtain its hash anchors before editing it.",
			"Batch non-overlapping edits across files into a single edit call (the files[] parameter accepts multiple entries).",
			"For replace edits, end_anchor is inclusive — make sure it points to the last line of the construct (e.g. closing brace).",
			"Use insert_after / insert_before when you only need to add lines around a single anchor; do not set end_anchor in that case.",
		],
		parameters: editSchema,
		renderShell: "self",
		prepareArguments: prepareEditArguments,

		async execute(_toolCallId, rawInput: EditToolInput, signal?: AbortSignal) {
			if (signal?.aborted) throw new Error("Operation aborted");

			// Defensive coercion: callers that bypass the runtime (e.g. tests, RPC
			// shims) may pass legacy single-file shapes. Run prepareArguments here so
			// the tool accepts both.
			const input = prepareEditArguments(rawInput);

			if (!Array.isArray(input.files) || input.files.length === 0) {
				throw new Error("Edit tool input is invalid. files must contain at least one entry.");
			}

			// Process+write per file under each file's mutation queue. Different files
			// run in parallel; reads and writes targeting the same file are serialised
			// (the queue keys are resolved through realpath so symlink aliases share a
			// queue too).
			const perFileResults: ProcessedFile[] = await Promise.all(
				input.files.map((fe) => {
					const absolutePath = resolveToCwd(fe.path, cwd);
					return withFileMutationQueue(absolutePath, async () => {
						const r = await processFile(fe, cwd, ops, signal);
						if (r.finalContent !== undefined && !r.error) {
							if (signal?.aborted) throw new Error("Operation aborted");
							const final = r.bom + restoreLineEndings(r.finalContent, r.lineEnding);
							await ops.writeFile(r.absolutePath, final);
						}
						return r;
					});
				}),
			);

			const summaryFiles: FileEditResult[] = perFileResults.map((r) => ({
				path: r.path,
				diff: r.diff,
				error: r.error,
				appliedCount: r.appliedCount,
				failedCount: r.failedCount,
				firstChangedLine: r.firstChangedLine,
			}));

			const successCount = summaryFiles.filter((f) => f.appliedCount > 0).length;
			const totalApplied = summaryFiles.reduce((acc, f) => acc + f.appliedCount, 0);
			const totalFailed = summaryFiles.reduce((acc, f) => acc + f.failedCount, 0);

			const sections: string[] = [];
			for (const r of perFileResults) {
				if (r.finalContent !== undefined && r.diff) {
					// Reconcile anchors against the final content so subsequent reads / edit
					// calls in the same task see stable anchors.
					AnchorStateManager.reconcile(r.absolutePath, r.finalContent.split("\n"));
					const lineChanges = `(${r.appliedCount} edit(s))`;
					sections.push(`*** Update File: ${r.path} ${lineChanges}\n${r.diff}${r.error ? `\n\n${r.error}` : ""}`);
				} else if (r.error) {
					sections.push(`*** Failed: ${r.path}\n${r.error}`);
				}
			}

			const header =
				totalApplied > 0
					? `Applied ${totalApplied} edit(s) across ${successCount} file(s).${
							totalFailed > 0 ? ` ${totalFailed} edit(s) failed.` : ""
						}`
					: `No edits applied.${totalFailed > 0 ? ` ${totalFailed} edit(s) failed.` : ""}`;

			const text = [header, ...sections].join("\n\n");
			const combinedDiff = summaryFiles
				.filter((f) => f.diff)
				.map((f) => `*** Update File: ${f.path}\n${f.diff}`)
				.join("\n\n");
			const firstChangedLine = summaryFiles.find((f) => f.firstChangedLine !== undefined)?.firstChangedLine;

			if (totalApplied === 0) {
				const err = sections.join("\n\n") || header;
				throw new Error(err);
			}

			return {
				content: [{ type: "text" as const, text }],
				details: { diff: combinedDiff, files: summaryFiles, firstChangedLine },
			};
		},

		renderCall(args, theme, context) {
			const component = getEditCallRenderComponent(context.state, context.lastComponent);
			const argsKey = args ? JSON.stringify(args) : undefined;

			if (component.previewArgsKey !== argsKey) {
				component.preview = undefined;
				component.previewArgsKey = argsKey;
				component.previewPending = false;
				component.settledError = false;
			}

			if (
				context.argsComplete &&
				args &&
				Array.isArray((args as EditToolInput).files) &&
				!component.preview &&
				!component.previewPending
			) {
				component.previewPending = true;
				const requestKey = argsKey;
				void computePreview(args as EditToolInput, context.cwd, ops).then((preview) => {
					if (component.previewArgsKey === requestKey) {
						setEditPreview(component, preview, requestKey);
						context.invalidate();
					}
				});
			}

			return buildEditCallComponent(component, args as Partial<EditToolInput> | undefined, theme);
		},

		renderResult(result, _options, theme, context) {
			const callComponent = context.state.callComponent;
			const typedDetails = (result as { details?: EditToolDetails }).details;
			let changed = false;
			if (callComponent && typedDetails && Array.isArray(typedDetails.files)) {
				changed =
					setEditPreview(
						callComponent,
						{
							diff: typedDetails.diff,
							firstChangedLine: typedDetails.firstChangedLine,
							perFile: typedDetails.files,
						},
						context.args ? JSON.stringify(context.args) : undefined,
					) || changed;
			}
			if (callComponent && callComponent.settledError !== context.isError) {
				callComponent.settledError = context.isError;
				changed = true;
			}
			if (changed) context.invalidate();

			const container = context.lastComponent instanceof Container ? context.lastComponent : new Container();
			container.clear();
			if (context.isError) {
				const errorText = (result.content as Array<{ type: string; text?: string }>)
					.filter((c) => c.type === "text")
					.map((c) => c.text || "")
					.join("\n");
				if (errorText) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("error", errorText), 1, 0));
				}
			}
			return container;
		},
	};
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}
