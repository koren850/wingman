// The small summary of the memory that the UI shows ("What Wingman knows"). Pure.
import type { MemoryView, SessionMemory } from "./types.ts";

const clip = (s: string, n: number): string => {
  const c = Array.from(s);
  return c.length <= n
    ? s
    : c
        .slice(0, n - 1)
        .join("")
        .trimEnd() + "…";
};
const num = (id: string) => Number(id.slice(1));

export function toView(m: SessionMemory): MemoryView {
  // soFar: the newest decisions first, then the newest facts from the call; at most 4 lines
  const so = [
    ...m.decisions
      .slice()
      .sort((a, b) => num(b.id) - num(a.id))
      .map((d) => d.text),
    ...m.facts
      .filter((f) => f.src !== "brief")
      .sort((a, b) => num(b.id) - num(a.id))
      .map((f) => f.text),
  ];
  return {
    ver: m.ver,
    kind: m.kind,
    kindLocked: !!m.kindLocked,
    ...(m.modeId ? { modeId: m.modeId } : {}),
    topic: clip(m.topic.now, 80),
    soFar: so.slice(0, 4).map((t) => clip(t, 140)),
    open: m.openQuestions.filter((q) => q.status === "open").map((q) => ({ id: q.id, text: clip(q.text, 140) })),
    promises: m.commitments.filter((c) => c.status === "open").map((c) => ({ id: c.id, who: clip(c.who, 40), text: clip(c.what, 140) })),
    coverLeft: m.mustCover.filter((x) => !x.done).map((x) => ({ id: x.id, text: clip(x.text, 140) })),
    numbers: m.numbers.slice(-6).map((n) => ({ id: n.id, what: clip(n.what, 60), value: clip(n.value, 40) })),
  };
}
