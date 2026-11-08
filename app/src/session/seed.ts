// Digest: what the optional pre-meeting context turns into (one model call, done by another package).
// seedFromDigest puts the safe part of it into a fresh memory. The chunks stay out of the memory: they are searched (context/retrieve.ts).
import { CAPS, enforceCaps } from "./caps.ts";
import { cleanText } from "./patch.ts";
import { emptyMemory, type MemoryKind, type SessionMemory } from "./types.ts";

export type DigestChunk = { id?: string; source?: string; text: string };
export type Digest = {
  roster: { name: string; side?: "me" | "them"; role?: string; stance?: string }[];
  agenda: string[];
  facts: (string | { text: string; who?: string })[];
  likelyQuestions: { q: string; a?: string }[];
  chunks: DigestChunk[];
  kind?: MemoryKind;
};

export const emptyDigest = (): Digest => ({ roster: [], agenda: [], facts: [], likelyQuestions: [], chunks: [] });

/** A new memory for a call, filled from the digest. Facts get src "brief". Missing parts are fine: an empty digest gives an empty memory. */
export function seedFromDigest(d: Digest | undefined, now = 0): SessionMemory {
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
  m.seq = seq;
  return enforceCaps(m);
}
