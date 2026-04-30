/**
 * Per-turn batching registry for the `edit` tool.
 *
 * Layer 2 of the dirac batching protocol (the within-call multi-file form is
 * Layer 1, implemented inside edit.ts). When a single assistant turn emits
 * multiple `edit` tool calls, this registry lets the first call to dispatch
 * pick up its siblings, run them as one batched operation, cache the
 * per-tool-call results, and have the remaining sibling calls return their
 * cached result instead of re-running.
 *
 * The registry is wired up from agent-session.ts via the agent-loop's
 * `beforeToolCall` hook (which gets the entire `assistantMessage`, i.e. all
 * tool calls in the current turn).
 */

import type { AgentToolCall } from "../../agent/index.js";

const EDIT_TOOL_NAME = "edit";

export interface EditTurnBatch<TResult = unknown> {
	/** All `edit` tool calls in this turn, in dispatch order. */
	editCalls: AgentToolCall[];
	/**
	 * Resolves with one entry per tool call id. Set by the first edit call to
	 * arrive (the rest await it). Undefined until then. The shape of the
	 * per-call entry is opaque to the registry — it's whatever the edit tool
	 * decides to cache.
	 */
	resultsPromise?: Promise<Map<string, TResult>>;
	/**
	 * Number of edit calls that still need to consume their result. Counted down
	 * inside the edit tool's execute(); when it hits zero we drop the entry so
	 * the registry doesn't accumulate state across turns.
	 */
	remaining: number;
}

const editBatchByCallId = new Map<string, EditTurnBatch<unknown>>();

/**
 * Called from `beforeToolCall` for every dispatched tool call. Idempotent per
 * turn: the first edit-call to arrive seeds the batch; subsequent calls in the
 * same turn find their entry already populated and short-circuit.
 *
 * Non-edit tool calls are ignored — we only batch edits.
 */
export function registerTurnToolCalls(toolCalls: ReadonlyArray<AgentToolCall>): void {
	const editCalls = toolCalls.filter((tc) => tc.name === EDIT_TOOL_NAME);
	if (editCalls.length === 0) return;
	if (editBatchByCallId.has(editCalls[0].id)) return; // already registered this turn

	const batch: EditTurnBatch = { editCalls, remaining: editCalls.length };
	for (const tc of editCalls) editBatchByCallId.set(tc.id, batch);
}

/** Returns the batch entry for an edit tool-call id, if registered. */
export function getEditTurnBatch<TResult = unknown>(toolCallId: string): EditTurnBatch<TResult> | undefined {
	return editBatchByCallId.get(toolCallId) as EditTurnBatch<TResult> | undefined;
}

/**
 * Decrement the consumer count and drop the registry entry once every sibling
 * edit call has consumed its result. Safe to call multiple times for the same
 * tool-call id.
 */
export function consumeEditTurnBatch(toolCallId: string): void {
	const batch = editBatchByCallId.get(toolCallId);
	if (!batch) return;
	batch.remaining--;
	if (batch.remaining <= 0) {
		for (const tc of batch.editCalls) editBatchByCallId.delete(tc.id);
	}
}

/** Test helper: drop all in-flight batches. */
export function resetTurnBatchRegistry(): void {
	editBatchByCallId.clear();
}
