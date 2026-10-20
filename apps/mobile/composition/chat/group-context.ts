/**
 * GR-13 group context builder — Drunk recall window (T173).
 *
 * A participant with `drunk: true` sees only the newest ~512 estimated
 * tokens of prior history; persona instructions, the room scenario and the
 * current message always survive, compacted summary rows are excluded
 * entirely, and dropped history is NEVER summarized back in — the caller
 * must not hand the residue to `summarizeContext`. Stored history stays
 * untouched: toggling Drunk off restores full access. This window runs
 * before `packContext` and never touches its native allocation.
 */

export type GroupContextKind = "persona" | "room" | "history" | "current";

export interface GroupContextItem {
  id: string;
  kind: GroupContextKind;
  text: string;
  /** Compaction summary rows; a Drunk participant never sees these. */
  compacted?: boolean;
}

export const DRUNK_TOKEN_WINDOW = 512;

/** Cheap deterministic estimate (length / 4); T179 measures real tokens. */
export function estimateContextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Truncate a speaker's view of prior history to the Drunk window, keeping
 * the most recent items and preserving the original item order. Compact
 * history rows drop out completely; non-history items (persona, room
 * scenario, current message) are pinned.
 */
export function applyDrunkWindow(
  items: readonly GroupContextItem[],
): GroupContextItem[] {
  const history = items.filter(
    (item) => item.kind === "history" && item.compacted !== true,
  );
  const keepIds = new Set<string>();
  let usedTokens = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index]!;
    usedTokens += estimateContextTokens(item.text);
    // The single newest row survives even past the ≈512 budget.
    if (usedTokens > DRUNK_TOKEN_WINDOW && keepIds.size > 0) break;
    keepIds.add(item.id);
  }
  return items.filter(
    (item) => item.kind !== "history" || keepIds.has(item.id),
  );
}
