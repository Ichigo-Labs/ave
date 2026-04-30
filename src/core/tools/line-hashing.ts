/**
 * Hash-anchored line protocol.
 *
 * Each line in a hashed file is rendered as `<Anchor>§<content>`, where the
 * anchor is an opaque, file-scoped identifier that survives edits the model
 * makes via the edit tool. Anchors are stable for unchanged lines (carried
 * across reads) and freshly minted for new lines.
 *
 * Ported from dirac/src/shared/utils/line-hashing.ts and
 * dirac/src/utils/line-hashing.ts.
 */

import { AnchorStateManager } from "./anchor-state-manager.js";

export const ANCHOR_DELIMITER = "§";

/** Returns the centralised delimiter that separates the anchor from the line content. */
export function getDelimiter(): string {
	return ANCHOR_DELIMITER;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip anchor prefixes from text (e.g., "AppleBanana§foo" → "foo").
 * Anchors are always alphabetic words starting with a capital letter.
 */
export function stripHashes(content: string): string {
	if (!content) return "";
	const re = new RegExp(`\\b[A-Z][a-zA-Z]*?${escapeRegExp(ANCHOR_DELIMITER)}`, "g");
	return content.replace(re, "");
}

/**
 * Extract the anchor word ID from a "Anchor§content" string.
 * If no delimiter is present, returns the entire reference.
 */
export function extractId(ref: string): string {
	if (!ref) return "";
	const idx = ref.indexOf(ANCHOR_DELIMITER);
	return idx === -1 ? ref : ref.substring(0, idx);
}

/**
 * Split an "Anchor§content" reference into its anchor and content parts.
 */
export function splitAnchor(rawAnchor: string): { anchor: string; content: string } {
	const idx = rawAnchor.indexOf(ANCHOR_DELIMITER);
	if (idx === -1) {
		return { anchor: rawAnchor.trim(), content: "" };
	}
	return {
		anchor: rawAnchor.substring(0, idx).trim(),
		content: rawAnchor.substring(idx + ANCHOR_DELIMITER.length),
	};
}

/** Format a single line as `<anchor>§<content>`. */
export function formatLineWithHash(content: string, anchor: string): string {
	return `${anchor}${ANCHOR_DELIMITER}${content}`;
}

/**
 * Hash every line of `content` using the stateful anchor manager so anchors
 * are stable across reads of the same file.
 */
export function hashLinesStateful(absolutePath: string, content: string, taskId?: string): string {
	if (!content) return "";
	const lines = content.split(/\r?\n/);
	const anchors = AnchorStateManager.reconcile(absolutePath, lines, taskId);
	return lines.map((line, i) => formatLineWithHash(line, anchors[i])).join("\n");
}
