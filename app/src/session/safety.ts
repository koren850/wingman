// Compaction safety. The compactor tidies the memory and rewrites the summary. It must not lose an open question, an open promise or an
// objection that nobody handled. A patch cannot remove an item by itself, but a full list drops its oldest items, and a rewrite can push an open item out.
// This is a local check (no model call). Items that are still there, or whose status moved to done / answered / dropped / handled, are fine.
// Items that are gone are put back, and the caller logs `compact.lost`. Pure.
import { CAPS } from "./caps.ts";
import type { SessionMemory } from "./types.ts";

export type LostItem = { list: "openQuestions" | "commitments" | "objections"; id: string };
const LISTS = ["openQuestions", "commitments", "objections"] as const;
const isOpen = (list: (typeof LISTS)[number], it: Record<string, unknown>): boolean =>
  list === "openQuestions" ? it.status === "open" : list === "commitments" ? it.status === "open" : it.handled === false;
const num = (id: string) => Number(id.slice(1));

/** Open items of `prev` that `next` does not have any more. */
export function lostOnCompact(prev: SessionMemory, next: SessionMemory): LostItem[] {
  const out: LostItem[] = [];
  for (const list of LISTS) {
    const have = new Set((next[list] as { id: string }[]).map((x) => x.id));
    for (const it of prev[list] as unknown as (Record<string, unknown> & { id: string })[])
      if (isOpen(list, it) && !have.has(it.id)) out.push({ list, id: it.id });
  }
  return out;
}

/**
 * Puts the lost items back (as they were in `prev`, in id order). When a list then goes over its cap, items that were not in `prev` go first
 * (newest first), then items of `prev` that were already finished. The lost items themselves are never the ones to go.
 */
export function restoreLost(prev: SessionMemory, next: SessionMemory, lost: readonly LostItem[]): SessionMemory {
  if (!lost.length) return next;
  const out: SessionMemory = { ...next };
  for (const list of LISTS) {
    const ids = new Set(lost.filter((l) => l.list === list).map((l) => l.id));
    if (!ids.size) continue;
    const back = (prev[list] as unknown as { id: string }[]).filter((x) => ids.has(x.id));
    let merged = [...(next[list] as unknown as { id: string }[]), ...back].sort((a, b) => num(a.id) - num(b.id));
    const cap = CAPS[list];
    if (merged.length > cap) {
      const inPrev = new Set((prev[list] as unknown as { id: string }[]).map((x) => x.id));
      const finishedPrev = new Set((prev[list] as unknown as (Record<string, unknown> & { id: string })[]).filter((x) => !isOpen(list, x)).map((x) => x.id));
      const rank = (x: { id: string }): number => (ids.has(x.id) ? 9 : !inPrev.has(x.id) ? 0 : finishedPrev.has(x.id) ? 1 : 2);
      const order = merged.map((x, i) => ({ x, i })).sort((a, b) => rank(a.x) - rank(b.x) || (rank(a.x) === 0 ? num(b.x.id) - num(a.x.id) : a.i - b.i));
      const drop = new Set(order.slice(0, merged.length - cap).map((o) => o.x.id));
      merged = merged.filter((x) => !drop.has(x.id));
    }
    (out[list] as unknown[]) = merged;
  }
  return out;
}
