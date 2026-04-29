/**
 * Protected Paths Extension
 *
 * Blocks write and edit operations to protected paths.
 * Useful for preventing accidental modifications to sensitive files.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const protectedPaths = [".env", ".git/", "node_modules/"];

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") {
			return undefined;
		}

		// `write` carries a single path; `edit` now batches multiple files under
		// `files: [{path, edits}]`. Collect every targeted path so we can flag any
		// protected entry.
		const paths: string[] = [];
		const input = event.input as { path?: unknown; files?: unknown };
		if (typeof input.path === "string") {
			paths.push(input.path);
		}
		if (Array.isArray(input.files)) {
			for (const fe of input.files) {
				if (fe && typeof fe.path === "string") paths.push(fe.path);
			}
		}

		const blocked = paths.find((p) => protectedPaths.some((proj) => p.includes(proj)));
		if (blocked) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Blocked write to protected path: ${blocked}`, "warning");
			}
			return { block: true, reason: `Path "${blocked}" is protected` };
		}

		return undefined;
	});
}
