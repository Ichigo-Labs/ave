/**
 * Default and maximum timeouts for bash command execution.
 *
 * Mirrors claude-code's `getDefaultBashTimeoutMs` / `getMaxBashTimeoutMs` so the
 * model never gets stuck on a hung command and so that ave-defined tools share
 * one source of truth. Values are exposed in seconds since `bash`'s schema
 * accepts seconds.
 */

const DEFAULT_TIMEOUT_SECONDS = 120; // 2 minutes
const MAX_TIMEOUT_SECONDS = 600; // 10 minutes

type EnvLike = Record<string, string | undefined>;

function parsePositiveSeconds(raw: string | undefined): number | undefined {
	if (!raw) return undefined;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Default bash timeout in seconds. Overridable via `BASH_DEFAULT_TIMEOUT_SECONDS`.
 */
export function getDefaultBashTimeoutSeconds(env: EnvLike = process.env): number {
	return parsePositiveSeconds(env.BASH_DEFAULT_TIMEOUT_SECONDS) ?? DEFAULT_TIMEOUT_SECONDS;
}

/**
 * Maximum bash timeout in seconds. Overridable via `BASH_MAX_TIMEOUT_SECONDS`.
 * Always at least the configured default.
 */
export function getMaxBashTimeoutSeconds(env: EnvLike = process.env): number {
	const fromEnv = parsePositiveSeconds(env.BASH_MAX_TIMEOUT_SECONDS);
	const def = getDefaultBashTimeoutSeconds(env);
	return Math.max(fromEnv ?? MAX_TIMEOUT_SECONDS, def);
}

/**
 * Resolve the effective timeout for a tool call:
 * - Use the caller-provided timeout if present, clamped to the configured max.
 * - Otherwise apply the default.
 */
export function resolveBashTimeoutSeconds(requested: number | undefined, env: EnvLike = process.env): number {
	const def = getDefaultBashTimeoutSeconds(env);
	const max = getMaxBashTimeoutSeconds(env);
	if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
		return def;
	}
	return Math.min(requested, max);
}
