/**
 * Lazy undici global-dispatcher initializer.
 *
 * Background
 * ----------
 * ave disables undici's bodyTimeout/headersTimeout (default 300s) because
 * long local-LLM stalls (e.g. vLLM buffering a large tool call) exceed that
 * and abort the SSE stream with UND_ERR_BODY_TIMEOUT. Provider SDKs enforce
 * their own AbortController-based deadlines via retry.provider.timeoutMs, so
 * the undici-level timeouts are pure downside for us.
 *
 * Historically this was set at the very top of src/cli.ts, which forced
 * every `ave --version`, `ave --help`, `ave --list-models`, and even plain
 * `ave` launch to synchronously parse undici's CJS tree (~114 files, ~1.7s
 * on WSL /mnt/c) before main() could run. None of those code paths actually
 * make HTTP requests.
 *
 * Instead we defer the dispatcher setup to the first site that actually
 * needs HTTP. Subsequent calls are no-ops.
 */

let _initialized = false;

export async function ensureUndiciGlobalDispatcher(): Promise<void> {
	if (_initialized) return;
	_initialized = true;
	const { EnvHttpProxyAgent, setGlobalDispatcher } = await import("undici");
	setGlobalDispatcher(new EnvHttpProxyAgent({ bodyTimeout: 0, headersTimeout: 0 }));
}
