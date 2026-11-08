// Digest: what the optional pre-meeting context turns into (one model call, done by another package).
// seedFromDigest puts the safe part of it into a fresh memory. The chunks stay out of the memory: they are searched (context/retrieve.ts).
import { CAPS, enforceCaps } from "./caps.ts";
import { cleanText } from "./patch.ts";
import type { PastFact } from "./people.ts";
import { emptyMemory, type MemoryKind, type SessionMemory } from "./types.ts";

export type DigestChunk = { id?: string; source?: string; text: string };
export type Digest = {
  roster: { name: string; side?: "me" | "them"; role?: string; stance?: string }[];
  agenda: string[];
  /** `source` = the line of the pre-meeting text the fact came from (shown next to the fact; not put in the memory) */
  facts: (string | { text: string; who?: string; source?: string })[];
  likelyQuestions: { q: string; a?: string }[];
  chunks: DigestChunk[];
  kind?: MemoryKind;
  /** "Last time" facts about people on the roster, from earlier calls (session/people.ts). Made without a model; shown before the call, recomputed at call start. */
  past?: PastFact[];
};

export const emptyDigest = (): Digest => ({ roster: [], agenda: [], facts: [], likelyQuestions: [], chunks: [] });

/** At most this many "Last time" facts go into a new memory. */
export const MAX_PAST = 5;

/**
 * A new memory for a call, filled from the digest. Facts get src "brief". Missing parts are fine: an empty digest gives an empty memory.
 * `past` (else d.past) are facts from earlier calls: src "past", at most 5, put after the brief facts.
 */
export function seedFromDigest(d: Digest | undefined, now = 0, past?: PastFact[]): SessionMemory {
  const m = emptyMemory(now, d?.kind ?? "other");
  if (!d) return m;
  const seq: Record<string, number> = {};
  const id = (p: string) => `${p}${(seq[p] = (seq[p] ?? 0) + 1)}`;
  const seen = new Set<string>();
  for (const p of d.roster ?? []) {
    const name = cleanText(p?.name, CAPS.short);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const person: SessionMemory["roster"][number] = { id: id("p"), name, side: p.side === "me" ? "me" : "them" };
    const role = cleanText(p.role, CAPS.short);
    if (role) person.role = role;
    const stance = cleanText(p.stance, CAPS.text);
    if (stance) person.stance = stance;
    m.roster.push(person);
  }
  for (const a of d.agenda ?? []) {
    const text = cleanText(a, CAPS.text);
    if (text) m.mustCover.push({ id: id("m"), text, done: false });
  }
  for (const f of d.facts ?? []) {
    const text = cleanText(typeof f === "string" ? f : f?.text, CAPS.text);
    if (!text) continue;
    const who = typeof f === "string" ? undefined : cleanText(f.who, CAPS.short);
    m.facts.push({ id: id("f"), text, ...(who ? { who } : {}), at: now, src: "brief" });
  }
  const seenPast = new Set<string>();
  for (const f of (past ?? d.past ?? []).slice(0, MAX_PAST * 2)) {
    if (m.facts.filter((x) => x.src === "past").length >= MAX_PAST) break;
    const text = cleanText(f?.text, CAPS.text);
    if (!text || seenPast.has(text.toLowerCase())) continue;
    seenPast.add(text.toLowerCase());
    const who = cleanText(f.who, CAPS.short);
    m.facts.push({ id: id("f"), text, ...(who ? { who } : {}), at: now, src: "past" });
  }
  m.seq = seq;
  return enforceCaps(m);
}
