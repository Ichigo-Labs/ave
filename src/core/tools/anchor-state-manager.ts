/**
 * AnchorStateManager
 *
 * Tracks per-file anchor words so that reads of a file produce the same
 * anchors for unchanged lines across calls (allowing the model to refer to
 * lines via stable anchors when it issues edit_file calls).
 *
 * Ported from dirac/src/utils/AnchorStateManager.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as diff from "diff";

interface TrackedDocument {
	hashes: Uint32Array;
	anchors: string[];
	usedWords: Set<string>;
	availablePool?: string[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_TRACKED_LINES = 50000;
const MAX_TRACKED_FILES = 1024;
const MAX_TRACKED_TASKS = 50;

const storage = new Map<string, Map<string, TrackedDocument>>();
let dictionary: string[] = [];

function computeHashes(lines: string[]): Uint32Array {
	const hashes = new Uint32Array(lines.length);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		let h = 2166136261;
		for (let j = 0; j < line.length; j++) {
			h = Math.imul(h ^ line.charCodeAt(j), 16777619);
		}
		hashes[i] = h >>> 0;
	}
	return hashes;
}

function getDictionary(): string[] {
	if (dictionary.length === 0) {
		// Resolution paths, in order:
		//   1. Next to the compiled module (dist/core/tools/.hash_anchors), used
		//      by the unbundled dist build and by tsx-driven dev runs.
		//   2. Bundled layout: ave.js lives in dist/bin/, so the asset sits at
		//      ../core/tools/.hash_anchors relative to the bundle.
		//   3. Source tree fallback for tests that import the .ts directly.
		const candidates = [
			path.join(HERE, ".hash_anchors"),
			path.join(HERE, "..", "core", "tools", ".hash_anchors"),
			path.join(HERE, "..", "..", "..", "src", "core", "tools", ".hash_anchors"),
		];
		for (const candidate of candidates) {
			try {
				dictionary = fs.readFileSync(candidate, "utf8").split(/\r?\n/).filter(Boolean);
				if (dictionary.length > 0) break;
			} catch {
				// Try next candidate.
			}
		}
		if (dictionary.length === 0) {
			throw new Error("Hash-anchor dictionary (.hash_anchors) not found next to the tools module");
		}
	}
	return dictionary;
}

function refill(usedWords: Set<string>, pool: string[]): void {
	const dict = getDictionary();
	const dictLen = dict.length;
	const newWords: string[] = [];

	// Try to find 10,000 unique two-word combinations.
	let attempts = 0;
	while (newWords.length < 10000 && attempts < 50000) {
		const w1 = dict[Math.floor(Math.random() * dictLen)];
		const w2 = dict[Math.floor(Math.random() * dictLen)];
		const word = `${w1}${w2}`;
		if (!usedWords.has(word)) newWords.push(word);
		attempts++;
	}

	// Fallback: three-word combinations if we are struggling.
	if (newWords.length < 100) {
		for (let i = 0; i < 100; i++) {
			const w1 = dict[Math.floor(Math.random() * dictLen)];
			const w2 = dict[Math.floor(Math.random() * dictLen)];
			const w3 = dict[Math.floor(Math.random() * dictLen)];
			const word = `${w1}${w2}${w3}`;
			if (!usedWords.has(word)) newWords.push(word);
		}
	}

	// Shuffle and append.
	for (let i = newWords.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[newWords[i], newWords[j]] = [newWords[j], newWords[i]];
	}
	pool.push(...newWords);
}

function getUniqueWord(usedWords: Set<string>, pool: string[]): string {
	while (true) {
		if (pool.length === 0) refill(usedWords, pool);
		const word = pool.pop() as string;
		if (!usedWords.has(word)) return word;
	}
}

function getTaskState(taskId = "default"): Map<string, TrackedDocument> {
	let state = storage.get(taskId);
	if (!state) {
		state = new Map<string, TrackedDocument>();
		storage.set(taskId, state);
		if (storage.size > MAX_TRACKED_TASKS) {
			const oldest = storage.keys().next().value;
			if (oldest !== undefined) storage.delete(oldest);
		}
	} else {
		// Refresh LRU position.
		storage.delete(taskId);
		storage.set(taskId, state);
	}
	return state;
}

function updateState(absolutePath: string, document: TrackedDocument, taskId?: string): void {
	const state = getTaskState(taskId);
	state.delete(absolutePath);
	state.set(absolutePath, document);
	if (state.size > MAX_TRACKED_FILES) {
		const oldest = state.keys().next().value;
		if (oldest !== undefined) state.delete(oldest);
	}
}

/**
 * Reconcile the current file content with our saved state using Myers diff
 * over line hashes. Unchanged lines keep their existing anchors; new lines
 * receive freshly-allocated unique words.
 */
function reconcile(absolutePath: string, currentLines: string[], taskId?: string): string[] {
	if (currentLines.length > MAX_TRACKED_LINES) {
		return currentLines.map((_, i) => `L${i + 1}`);
	}

	const state = getTaskState(taskId);
	const currentHashes = computeHashes(currentLines);
	let tracked = state.get(absolutePath);

	// Fast path: identical hashes.
	if (tracked && tracked.hashes.length === currentHashes.length) {
		let identical = true;
		for (let i = 0; i < currentHashes.length; i++) {
			if (tracked.hashes[i] !== currentHashes[i]) {
				identical = false;
				break;
			}
		}
		if (identical) {
			updateState(absolutePath, tracked, taskId);
			return tracked.anchors;
		}
	}

	// First time we see this file: assign random words to every line.
	if (!tracked) {
		const usedWords = new Set<string>();
		const pool = [...getDictionary()];
		for (let i = pool.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[pool[i], pool[j]] = [pool[j], pool[i]];
		}
		const anchors = currentLines.map(() => {
			const w = getUniqueWord(usedWords, pool);
			usedWords.add(w);
			return w;
		});
		tracked = { hashes: currentHashes, anchors, usedWords, availablePool: pool };
		updateState(absolutePath, tracked, taskId);
		return anchors;
	}

	// We have history: run Myers diff over the integer hash arrays.
	const changes = diff.diffArrays(Array.from(tracked.hashes), Array.from(currentHashes));

	const newAnchors: string[] = [];
	const newUsedWords = new Set<string>(tracked.usedWords);
	const pool = tracked.availablePool || [];
	if (pool.length === 0 && newUsedWords.size < getDictionary().length) {
		const dict = getDictionary();
		for (const word of dict) if (!newUsedWords.has(word)) pool.push(word);
		for (let i = pool.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[pool[i], pool[j]] = [pool[j], pool[i]];
		}
	}

	let oldIdx = 0;
	for (const change of changes) {
		if (change.added) {
			for (let i = 0; i < (change.count as number); i++) {
				const word = getUniqueWord(newUsedWords, pool);
				newAnchors.push(word);
				newUsedWords.add(word);
			}
		} else if (change.removed) {
			oldIdx += change.count as number;
		} else {
			for (let i = 0; i < (change.count as number); i++) {
				const preserved = tracked.anchors[oldIdx];
				newAnchors.push(preserved);
				newUsedWords.add(preserved);
				oldIdx++;
			}
		}
	}

	tracked = { hashes: currentHashes, anchors: newAnchors, usedWords: newUsedWords, availablePool: pool };
	updateState(absolutePath, tracked, taskId);
	return newAnchors;
}

function isTracking(absolutePath: string, taskId?: string): boolean {
	return getTaskState(taskId).has(absolutePath);
}

function getAnchors(absolutePath: string, taskId?: string): string[] | null {
	return getTaskState(taskId).get(absolutePath)?.anchors || null;
}

function clearState(absolutePath: string, taskId?: string): void {
	getTaskState(taskId).delete(absolutePath);
}

/** Reset state for a single task or for all tasks. */
function reset(taskId?: string): void {
	if (taskId) storage.delete(taskId);
	else storage.clear();
}

/**
 * Namespaced API matching the dirac AnchorStateManager surface.
 * Implemented as a frozen object literal (rather than a class with only static
 * members) to keep biome's `noStaticOnlyClass` rule happy.
 */
export const AnchorStateManager = Object.freeze({
	reconcile,
	isTracking,
	getAnchors,
	clearState,
	reset,
});

export type AnchorStateManagerType = typeof AnchorStateManager;
