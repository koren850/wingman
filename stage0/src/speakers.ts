// Speakers on the other side. The other side's audio is one mixed stream (a Zoom call with four people is still one "them"
// channel), so the STT provider's diarization tells the voices apart and gives each word a raw speaker id. This module turns
// those ids into stable call-local numbers ("Speaker 1" is the first voice heard) and, when known, names.
// Nothing is kept across calls: no voice prints, only the numbers and names of this call.
import type { Word } from "./providers/stt/types.ts";

/** The raw speaker id most of a final's words belong to, or undefined when the provider gave none. */
export function dominantSpeaker(words: Word[]): number | undefined {
  const n = new Map<number, number>();
  for (const w of words) if (typeof w.speaker === "number") n.set(w.speaker, (n.get(w.speaker) ?? 0) + 1);
  let best: number | undefined, most = 0;
  for (const [id, c] of n) if (c > most) { best = id; most = c; }
  return best;
}

export type SpeakerInfo = { spk: number; name?: string };

/** Call-local speaker numbers (1, 2, 3... in order of first appearance) and optional names. */
export class SpeakerBook {
  private nums = new Map<number, number>();
  private names = new Map<number, string>();
  /** The call-local number for a raw provider id (a new id gets the next number). */
  number(raw: number): number {
    let n = this.nums.get(raw);
    if (n === undefined) { n = this.nums.size + 1; this.nums.set(raw, n); }
    return n;
  }
  /** Speaker info for a final's words, or undefined when the words carry no speaker. */
  of(words: Word[]): SpeakerInfo | undefined {
    const raw = dominantSpeaker(words);
    if (raw === undefined) return undefined;
    const spk = this.number(raw);
    const name = this.names.get(spk);
    return name ? { spk, name } : { spk };
  }
  /** Name call-local speaker `spk` (empty name clears it). */
  setName(spk: number, name: string) { const n = name.trim().slice(0, 40); if (n) this.names.set(spk, n); else this.names.delete(spk); }
  get count(): number { return this.nums.size; }
}

/** How a line is labelled for the models: "me", "them" or "them (Speaker 2)" / "them (Miriam)". */
export function lineLabel(ch: "me" | "them", who?: SpeakerInfo): string {
  if (ch === "me" || !who) return ch;
  return `them (${who.name ?? `Speaker ${who.spk}`})`;
}

