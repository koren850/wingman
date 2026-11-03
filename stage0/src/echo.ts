// Speakers mode: without headphones the mic also hears the client from the speakers.
// Settings: audio.echo.* . run.ts wires both layers: MicGate in the mic audio path, EchoFilter on "me" finals.
// Two cheap layers: (1) mic gate: while the client channel is voiced, the mic sends silence instead of sound;
// (2) echo text filter: a "me" final whose words mostly repeat a recent "them" final is dropped as echo.
import { tokens } from "./normalize.ts";

export type EchoMode = "gate" | "filter" | "both" | "off";

/** Share of the mic line's words that also appear in the client line (0-1). */
export function overlap(meText: string, themText: string): number {
  const me = tokens(meText);
  if (!me.length) return 0;
  const them = new Set(tokens(themText));
  return me.filter((t) => them.has(t)).length / me.length;
}

/** Text-level echo detector: remembers recent "them" finals and compares each "me" final against them. */
export class EchoFilter {
  private recent: { text: string; at: number }[] = [];
  constructor(private o: { windowMs: number; threshold: number }) {}
  /** Remember a client final (call for every "them" final). */
  noteThem(text: string, at = Date.now()) {
    this.recent.push({ text, at });
    this.recent = this.recent.filter((r) => at - r.at <= this.o.windowMs * 4);   // keep a few windows of history, but never grow without bound
  }
  /**
   * True when the mic line is an echo of what the client said within the window. Lines under 3 words are never
   * dropped (a short "כן" or "אחסון" right after the client is real speech); a real echo is a near-copy, so the
   * threshold is high (default 0.8): the user repeating part of the question back ("אתה שואל כמה עולה אחסון") stays.
   */
  isEcho(meText: string, at = Date.now()): { echo: boolean; score: number } {
    if (tokens(meText).length < 3) return { echo: false, score: 0 };
    let best = 0;
    for (const r of this.recent) if (at - r.at <= this.o.windowMs) best = Math.max(best, overlap(meText, r.text));
    return { echo: best >= this.o.threshold, score: best };
  }
}

/** Mic gate: closed (true) while the client was voiced within the hangover. run.ts then sends silence instead of mic audio.
 *  The hangover covers the room echo, which arrives slightly after the client's sound. */
export class MicGate {
  private lastThemVoiced = -Infinity;
  constructor(private o: { hangoverMs: number; peak: number }) {}
  noteThemPeak(peak: number, at = Date.now()) { if (peak > this.o.peak) this.lastThemVoiced = at; }
  closed(at = Date.now()): boolean { return at - this.lastThemVoiced < this.o.hangoverMs; }
}
