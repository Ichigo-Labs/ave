#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
import { APP_NAME } from "./config.js";
import { main } from "./main.js";

process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

// Undici's global dispatcher (with bodyTimeout: 0 / headersTimeout: 0 to
// tolerate long local-LLM stalls) is configured lazily from
// src/utils/ensure-undici.ts the first time a provider actually streams.
// Keeping it out of cli.ts shaves ~1.7s off cold startup on slow filesystems
// because the undici CJS tree (~114 files) is no longer parsed for non-HTTP
// invocations like `ave --version`, `ave --help`, or `ave --list-models`.

main(process.argv.slice(2));
