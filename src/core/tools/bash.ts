import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import type { AgentTool } from "../../agent/index.js";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.js";
import { theme } from "../../modes/interactive/theme/theme.js";
import { Container, Text, truncateToWidth } from "../../tui/index.js";
import { waitForChildProcess } from "../../utils/child-process.js";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.js";
import {
	type BackgroundTaskInfo,
	killBackgroundTask,
	spawnBackgroundTask,
	subscribeBackgroundTaskData,
} from "../background-tasks.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { getDefaultBashTimeoutSeconds, getMaxBashTimeoutSeconds, resolveBashTimeoutSeconds } from "./bash-timeouts.js";
import { getTextOutput, invalidArgText, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateTail } from "./truncate.js";

/**
 * Generate a unique temp file path for bash output.
 */
function getTempFilePath(): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `pi-bash-${id}.log`);
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(
		Type.Number({
			description: `Timeout in seconds. Defaults to ${getDefaultBashTimeoutSeconds()}s; values greater than ${getMaxBashTimeoutSeconds()}s are clamped.`,
		}),
	),
	description: Type.Optional(
		Type.String({
			description:
				'Short, concise description of what this command does in active voice (e.g. "List files in current directory", "Run unit tests"). Used for telemetry and the background task list.',
		}),
	),
	run_in_background: Type.Optional(
		Type.Boolean({
			description:
				"Set to true to run this command in the background. Returns immediately with a task id; you'll be notified when it completes. Read the output later by tailing the reported output file.",
		}),
	),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
	/** Set if this call moved to the background (explicitly or via auto-background). */
	backgroundTask?: BackgroundTaskInfo;
	/** Set when a foreground run hit its timeout. */
	timedOutSeconds?: number;
}

/**
 * Detect a leading bare `sleep N` (with N >= 2) that should not run in the
 * foreground. Allows fractional sleeps (`sleep 0.5`) since those are typically
 * intentional pacing, not polling.
 *
 * Mirrors claude-code's detectBlockedSleepPattern.
 */
export function detectBlockedSleepPattern(command: string): string | null {
	const trimmed = command.trim();
	if (!trimmed) return null;
	const firstSegment = trimmed.split(/[;&|]/)[0]?.trim() ?? "";
	const m = /^sleep\s+(\d+)\s*$/.exec(firstSegment);
	if (!m) return null;
	const secs = Number.parseInt(m[1] ?? "", 10);
	if (!Number.isFinite(secs) || secs < 2) return null;
	const rest = trimmed.slice(firstSegment.length).replace(/^[;&|\s]+/, "");
	return rest ? `sleep ${secs} followed by: ${rest}` : `standalone sleep ${secs}`;
}

const DISALLOWED_AUTO_BACKGROUND_COMMANDS = new Set(["sleep"]);

function isAutoBackgroundAllowed(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return true;
	const firstWord = trimmed.split(/\s+/)[0] ?? "";
	return !DISALLOWED_AUTO_BACKGROUND_COMMANDS.has(firstWord);
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return {
		exec: (command, cwd, { onData, signal, timeout, env }) => {
			return new Promise((resolve, reject) => {
				const { shell, args } = getShellConfig(options?.shellPath);
				if (!existsSync(cwd)) {
					reject(new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`));
					return;
				}
				const child = spawn(shell, [...args, command], {
					cwd,
					detached: true,
					env: env ?? getShellEnv(),
					stdio: ["ignore", "pipe", "pipe"],
				});
				if (child.pid) trackDetachedChildPid(child.pid);
				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;
				// Set timeout if provided.
				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, timeout * 1000);
				}
				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// Handle abort signal by killing the entire process tree.
				const onAbort = () => {
					if (child.pid) killProcessTree(child.pid);
				};
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				waitForChildProcess(child)
					.then((code) => {
						if (child.pid) untrackDetachedChildPid(child.pid);
						if (timeoutHandle) clearTimeout(timeoutHandle);
						if (signal) signal.removeEventListener("abort", onAbort);
						if (signal?.aborted) {
							reject(new Error("aborted"));
							return;
						}
						if (timedOut) {
							reject(new Error(`timeout:${timeout}`));
							return;
						}
						resolve({ exitCode: code });
					})
					.catch((err) => {
						if (child.pid) untrackDetachedChildPid(child.pid);
						if (timeoutHandle) clearTimeout(timeoutHandle);
						if (signal) signal.removeEventListener("abort", onAbort);
						reject(err);
					});
			});
		},
	};
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(command: string, cwd: string, spawnHook?: BashSpawnHook): BashSpawnContext {
	const baseContext: BashSpawnContext = { command, cwd, env: { ...getShellEnv() } };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
	/**
	 * Disable background-task support. When true, `run_in_background: true` and
	 * the auto-background-on-timeout path both fall back to running in the
	 * foreground (or rejecting on timeout, in the auto-background case).
	 *
	 * Useful for environments where the bash backend is remote and cannot
	 * outlive the parent process (e.g. SSH sessions).
	 */
	disableBackgroundTasks?: boolean;
}

const BASH_PREVIEW_LINES = 5;

type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatBashCall(args: { command?: string; timeout?: number } | undefined): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix;
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = component.state;
	component.clear();

	const output = getTextOutput(result as any, showImages).trim();

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint =
							theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
							` ${keyHint("app.tools.expand", "to expand")})`;
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

interface AutoBackgroundInput {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	shellPath?: string;
	description?: string;
	timeoutSeconds: number;
	signal?: AbortSignal;
	onUpdate?: (partial: { content: { type: "text"; text: string }[]; details: BashToolDetails | undefined }) => void;
}

interface AutoBackgroundResult {
	content: { type: "text"; text: string }[];
	details: BashToolDetails | undefined;
}

async function runWithAutoBackground(input: AutoBackgroundInput): Promise<AutoBackgroundResult> {
	const { command, cwd, env, shellPath, description, timeoutSeconds, signal, onUpdate } = input;

	const handle = spawnBackgroundTask({
		command,
		cwd,
		env,
		shellPath,
		description,
		kind: "auto-timeout",
	});
	const { taskId, outputPath } = handle.info;

	const chunks: Buffer[] = [];
	let chunksBytes = 0;
	const maxChunksBytes = DEFAULT_MAX_BYTES * 2;
	const decoder = new TextDecoder();

	const emitPartial = () => {
		if (!onUpdate) return;
		const fullBuffer = Buffer.concat(chunks);
		const fullText = decoder.decode(fullBuffer, { stream: false });
		const truncation = truncateTail(fullText);
		onUpdate({
			content: [{ type: "text", text: truncation.content || "" }],
			details: {
				truncation: truncation.truncated ? truncation : undefined,
				fullOutputPath: outputPath,
			},
		});
	};

	if (onUpdate) {
		onUpdate({ content: [], details: undefined });
	}

	const unsubscribeData = subscribeBackgroundTaskData(taskId, (data) => {
		chunks.push(data);
		chunksBytes += data.length;
		while (chunksBytes > maxChunksBytes && chunks.length > 1) {
			const removed = chunks.shift()!;
			chunksBytes -= removed.length;
		}
		emitPartial();
	});

	let abortHandler: (() => void) | undefined;
	if (signal) {
		if (signal.aborted) {
			killBackgroundTask(taskId);
		} else {
			abortHandler = () => {
				killBackgroundTask(taskId);
			};
			signal.addEventListener("abort", abortHandler, { once: true });
		}
	}

	let timeoutTimer: NodeJS.Timeout | undefined;
	const timeoutPromise = new Promise<"timeout">((resolve) => {
		timeoutTimer = setTimeout(() => resolve("timeout"), timeoutSeconds * 1000);
		timeoutTimer.unref?.();
	});

	const completionPromise: Promise<BackgroundTaskInfo> = handle.completion;
	const raceResult = await Promise.race([completionPromise, timeoutPromise]);

	unsubscribeData?.();
	if (timeoutTimer) clearTimeout(timeoutTimer);
	if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);

	// Auto-background: ran past the foreground budget. Leave it running.
	if (raceResult === "timeout") {
		const text = [
			`Command exceeded the ${timeoutSeconds}-second foreground timeout and was moved to the background with ID: ${taskId}.`,
			`It is still running — you will be notified when it completes. Output is being written to: ${outputPath}.`,
		].join(" ");
		return {
			content: [{ type: "text", text }],
			details: {
				backgroundTask: handle.info,
				timedOutSeconds: timeoutSeconds,
			},
		};
	}

	// Completed (or killed via abort). Build the synchronous result from chunks.
	const final = raceResult;
	const fullBuffer = Buffer.concat(chunks);
	const fullOutput = decoder.decode(fullBuffer, { stream: false });
	const truncation = truncateTail(fullOutput);

	let outputText = truncation.content || "(no output)";
	let details: BashToolDetails | undefined;
	if (truncation.truncated) {
		details = { truncation, fullOutputPath: outputPath };
		const startLine = truncation.totalLines - truncation.outputLines + 1;
		const endLine = truncation.totalLines;
		if (truncation.lastLinePartial) {
			const lastLineSize = formatSize(Buffer.byteLength(fullOutput.split("\n").pop() || "", "utf-8"));
			outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${outputPath}]`;
		} else if (truncation.truncatedBy === "lines") {
			outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${outputPath}]`;
		} else {
			outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${outputPath}]`;
		}
	}

	if (final.status === "killed") {
		const message = signal?.aborted ? "Command aborted" : "Command was killed";
		const combined = outputText && outputText !== "(no output)" ? `${outputText}\n\n${message}` : message;
		throw new Error(combined);
	}

	if (final.status === "failed") {
		// Surface the spawn-time error (e.g. ENOENT for a missing shell) so the
		// model sees the same diagnostic the foreground path would have produced.
		if (final.errorMessage) {
			throw new Error(final.errorMessage);
		}
		const codeLine = final.exitCode !== undefined ? `Command exited with code ${final.exitCode}` : "Command failed";
		const combined = outputText && outputText !== "(no output)" ? `${outputText}\n\n${codeLine}` : codeLine;
		throw new Error(combined);
	}

	return { content: [{ type: "text", text: outputText }], details };
}

function buildBashDescription(): string {
	const def = getDefaultBashTimeoutSeconds();
	const max = getMaxBashTimeoutSeconds();
	return [
		"Execute a bash command in the current working directory. Returns stdout and stderr.",
		`Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file.`,
		`Commands without an explicit timeout default to ${def}s; the maximum is ${max}s. Long-running commands that would otherwise hang the agent are killed at the timeout.`,
		"For commands you don't need the result of right away (servers, builds, watchers, polling), pass `run_in_background: true`. The call returns immediately with a task id and an output file path; you'll be notified via a follow-up message when the command exits. Do not poll with `sleep`; do not use trailing `&`.",
		"Bare leading `sleep N` (with N >= 2) is rejected. Use `run_in_background` for waits, or keep pacing sleeps to under 2 seconds.",
	].join(" ");
}

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;
	const backgroundDisabled = options?.disableBackgroundTasks === true;
	return {
		name: "bash",
		label: "bash",
		description: buildBashDescription(),
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		parameters: bashSchema,
		async execute(_toolCallId, params: BashToolInput, signal?: AbortSignal, onUpdate?, _ctx?) {
			const { command, timeout, description, run_in_background } = params;

			// Block bare leading `sleep N` (N >= 2) unless explicitly backgrounded.
			if (!run_in_background && !backgroundDisabled) {
				const blocked = detectBlockedSleepPattern(command);
				if (blocked) {
					throw new Error(
						`Blocked: ${blocked}. Run blocking commands in the background with run_in_background: true — you'll get a completion notification when done. If you genuinely need a delay (rate limiting, deliberate pacing), keep it under 2 seconds.`,
					);
				}
			}

			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);
			const effectiveTimeout = resolveBashTimeoutSeconds(timeout);

			// Explicit background path: spawn into the registry, return immediately.
			if (run_in_background === true && !backgroundDisabled) {
				const { info } = spawnBackgroundTask({
					command: spawnContext.command,
					cwd: spawnContext.cwd,
					env: spawnContext.env,
					shellPath: options?.shellPath,
					description,
					kind: "explicit",
				});
				const text = [
					`Command running in background with ID: ${info.taskId}.`,
					`Output is being written to: ${info.outputPath}.`,
					"You will be notified when it completes — do not poll. To stop it, kill the process via the registry or by PID.",
				].join(" ");
				return {
					content: [{ type: "text", text }],
					details: { backgroundTask: info },
				};
			}

			// Auto-background path: when no custom operations override is in play,
			// run via the registry primitive so a foreground command that would
			// otherwise time out can be transitioned into a background task instead
			// of being killed. This path mirrors claude-code's
			// `tengu_bash_command_timeout_backgrounded` behavior.
			const useAutoBackground =
				!backgroundDisabled && options?.operations === undefined && isAutoBackgroundAllowed(command);
			if (useAutoBackground) {
				return runWithAutoBackground({
					command: spawnContext.command,
					cwd: spawnContext.cwd,
					env: spawnContext.env,
					shellPath: options?.shellPath,
					description,
					timeoutSeconds: effectiveTimeout,
					signal,
					onUpdate,
				});
			}

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}
			return new Promise((resolve, reject) => {
				let tempFilePath: string | undefined;
				let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
				let totalBytes = 0;
				const chunks: Buffer[] = [];
				let chunksBytes = 0;
				const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

				const ensureTempFile = () => {
					if (tempFilePath) return;
					tempFilePath = getTempFilePath();
					tempFileStream = createWriteStream(tempFilePath);
					for (const chunk of chunks) tempFileStream.write(chunk);
				};

				const handleData = (data: Buffer) => {
					totalBytes += data.length;
					// Start writing to a temp file once output exceeds the in-memory threshold.
					if (totalBytes > DEFAULT_MAX_BYTES) {
						ensureTempFile();
					}
					// Write to temp file if we have one.
					if (tempFileStream) tempFileStream.write(data);
					// Keep a rolling buffer of recent output for tail truncation.
					chunks.push(data);
					chunksBytes += data.length;
					// Trim old chunks if the rolling buffer grows too large.
					while (chunksBytes > maxChunksBytes && chunks.length > 1) {
						const removed = chunks.shift()!;
						chunksBytes -= removed.length;
					}
					// Stream partial output using the rolling tail buffer.
					if (onUpdate) {
						const fullBuffer = Buffer.concat(chunks);
						const fullText = fullBuffer.toString("utf-8");
						const truncation = truncateTail(fullText);
						if (truncation.truncated) {
							ensureTempFile();
						}
						onUpdate({
							content: [{ type: "text", text: truncation.content || "" }],
							details: {
								truncation: truncation.truncated ? truncation : undefined,
								fullOutputPath: tempFilePath,
							},
						});
					}
				};

				ops.exec(spawnContext.command, spawnContext.cwd, {
					onData: handleData,
					signal,
					timeout: effectiveTimeout,
					env: spawnContext.env,
				})
					.then(({ exitCode }) => {
						// Combine the rolling buffer chunks.
						const fullBuffer = Buffer.concat(chunks);
						const fullOutput = fullBuffer.toString("utf-8");
						// Apply tail truncation for the final display payload.
						const truncation = truncateTail(fullOutput);
						if (truncation.truncated) {
							ensureTempFile();
						}
						// Close temp file stream before building the final result.
						if (tempFileStream) tempFileStream.end();
						let outputText = truncation.content || "(no output)";
						let details: BashToolDetails | undefined;
						if (truncation.truncated) {
							// Build truncation details and an actionable notice.
							details = { truncation, fullOutputPath: tempFilePath };
							const startLine = truncation.totalLines - truncation.outputLines + 1;
							const endLine = truncation.totalLines;
							if (truncation.lastLinePartial) {
								// Edge case: the last line alone is larger than the byte limit.
								const lastLineSize = formatSize(Buffer.byteLength(fullOutput.split("\n").pop() || "", "utf-8"));
								outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${tempFilePath}]`;
							} else if (truncation.truncatedBy === "lines") {
								outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${tempFilePath}]`;
							} else {
								outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${tempFilePath}]`;
							}
						}
						if (exitCode !== 0 && exitCode !== null) {
							outputText += `\n\nCommand exited with code ${exitCode}`;
							reject(new Error(outputText));
						} else {
							resolve({ content: [{ type: "text", text: outputText }], details });
						}
					})
					.catch((err: Error) => {
						// Close temp file stream and include buffered output in the error message.
						if (tempFileStream) tempFileStream.end();
						const fullBuffer = Buffer.concat(chunks);
						let output = fullBuffer.toString("utf-8");
						if (err.message === "aborted") {
							if (output) output += "\n\n";
							output += "Command aborted";
							reject(new Error(output));
						} else if (err.message.startsWith("timeout:")) {
							const timeoutSecs = err.message.split(":")[1];
							if (output) output += "\n\n";
							output += `Command timed out after ${timeoutSecs} seconds.`;
							if (!backgroundDisabled && isAutoBackgroundAllowed(command)) {
								output +=
									" Re-run with run_in_background: true if it needs to keep going — you'll get a completion notification.";
							}
							reject(new Error(output));
						} else {
							reject(err);
						}
					});
			});
		},
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBashCall(args));
			return text;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.showImages,
				state.startedAt,
				state.endedAt,
			);
			component.invalidate();
			return component;
		},
	};
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	return wrapToolDefinition(createBashToolDefinition(cwd, options));
}
