// Size limits of the call memory. Code enforces them; the model is never trusted to.
import type { SessionMemory } from "./types.ts";

export const CAPS = {
  facts: 30,
  numbers: 20,
  commitments: 20,
  openQuestions: 20,
  decisions: 20,
  objections: 20,
  mustCover: 20,
  roster: 20,
  topicHistory: 20,
  /** characters */
  text: 300,
  short: 80,
  summaryWords: 250,
  summaryChars: 2000,
  /** items one patch may add to one list, and ids it may resolve or update */
  addPerList: 10,
  resolvePerPatch: 20,
  updatePerPatch: 20,
} as const;

const KEEP_NEWEST_CALL_FACTS = 8;

const LIST_CAPS = {
  facts: CAPS.facts,
  numbers: CAPS.numbers,
  commitments: CAPS.commitments,
  openQuestions: CAPS.openQuestions,
  decisions: CAPS.decisions,
  objections: CAPS.objections,
  mustCover: CAPS.mustCover,
  roster: CAPS.roster,
} as const;

/** Whether an item is finished (the first to go when a list is full). */
const finished = (kind: keyof typeof LIST_CAPS, it: Record<string, unknown>): boolean => {
  switch (kind) {
    case "commitments":
      return it.status === "done";
    case "openQuestions":
      return it.status !== "open";
    case "objections":
      return it.handled === true;
    case "mustCover":
      return it.done === true;
    default:
      return false;
  }
};

/** Order of eviction: finished items first, then (facts) call facts before brief/user facts, always oldest first. Returns a new array in the original order. */
function evict<T extends { id: string; at?: number }>(kind: keyof typeof LIST_CAPS, list: T[], cap: number): T[] {
  if (list.length <= cap) return list;
  // The newest call facts are never evicted before brief or user facts: a list full of brief facts must not drop what was just said.
  const newestCall = new Set(
    kind === "facts" ? list.filter((it) => (it as unknown as Record<string, unknown>).src === "call").slice(-KEEP_NEWEST_CALL_FACTS) : [],
  );
  const rank = (it: T, i: number): [number, number] => {
    const rec = it as unknown as Record<string, unknown>;
    let tier = 2;
    if (finished(kind, rec)) tier = 0;
    else if (kind === "facts" && rec.src === "call") tier = newestCall.has(it) ? 3 : 1;
    return [tier, i]; // the list is kept in insertion order, so the index is age
  };
  const order = list.map((it, i) => ({ i, r: rank(it, i) })).sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1]);
  const drop = new Set(order.slice(0, list.length - cap).map((o) => o.i));
  return list.filter((_, i) => !drop.has(i));
}

/** Returns a copy of the memory with every list inside its cap, and the summary inside its word limit. Pure. */
export function enforceCaps(m: SessionMemory): SessionMemory {
  const out: SessionMemory = { ...m };
  for (const k of Object.keys(LIST_CAPS) as (keyof typeof LIST_CAPS)[]) {
    (out[k] as unknown[]) = evict(k, m[k] as { id: string }[], LIST_CAPS[k]);
  }
  out.topic = { now: m.topic.now, history: m.topic.history.slice(-CAPS.topicHistory) };
  out.summary = clipWords(m.summary, CAPS.summaryWords).slice(0, CAPS.summaryChars);
  return out;
}

export function clipWords(s: string, maxWords: number): string {
  const w = s.split(/\s+/).filter(Boolean);
  return w.length <= maxWords ? s.trim() : w.slice(0, maxWords).join(" ");
}
