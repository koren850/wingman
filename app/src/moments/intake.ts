// Intake: a structural noise filter and the features of a finished speech-to-text line. No word lists, no language rules.
// A line is dropped only when it is structurally empty: fewer than 2 tokens, an echo of the other side (the engine passes the echo test in),
// the same text again within 3 seconds, or a very low speech-to-text confidence. Two things are never dropped: a line with a digit or a
// currency sign (a number is always worth a look), and a line of 2 or more tokens that ends with a question mark.
// Tokens come from Intl.Segmenter, so Hebrew, English and mixed text count the same way.
import { normalize } from "../normalize.ts";

export type Side = "me" | "them";
export type IntakeLine = {
  text: string;
  side: Side;
  /** When the line was final (ms, any monotonic or wall clock; the same one for all lines). */
  at: number;
  speaker?: string;
  /** Speech-to-text confidence 0..1 when the provider gives one. */
  confidence?: number;
};
export type TurnFeatures = {
  words: number;
  /** Share of letters in each script, 0..1 (digits and punctuation are not letters). */
  script: { he: number; latin: number; other: number };
  /** "he", "en", "mixed" (both scripts above 20 percent), "none" (no letters). */
  lang: "he" | "en" | "mixed" | "none";
  hasDigits: boolean;
  hasCurrency: boolean;
  endsWithQuestion: boolean;
  side: Side;
  speaker?: string;
  /** Milliseconds since the previous kept or dropped line from any side, or undefined for the first line. */
  gapMs?: number;
};
export type IntakeDrop = "too-short" | "echo" | "repeat" | "low-confidence";
export type IntakeResult = { keep: true; features: TurnFeatures } | { keep: false; why: IntakeDrop; features: TurnFeatures };

export type IntakeOptions = {
  /** True when this "me" line is an echo of the other side (echo.ts EchoFilter.isEcho, passed in so this file has no state of the engine). */
  isEcho?: (text: string, at: number) => boolean;
  /** A line below this confidence is dropped when it has no digit. Default 0.3. */
  minConfidence?: number;
  /** The same text from the same side within this window is dropped. Default 3000 ms. */
  repeatMs?: number;
  /** Fewer tokens than this is dropped. Default 2. */
  minTokens?: number;
};

const segmenter = new Intl.Segmenter("und", { granularity: "word" });
/** Word-like tokens (letters and numbers; punctuation and spaces are not tokens). */
export function tokenCount(text: string): number {
  let n = 0;
  for (const s of segmenter.segment(text)) if (s.isWordLike) n++;
  return n;
}

const HE = /[֐-׿יִ-ﭏ]/u;
const LATIN = /[A-Za-zÀ-ɏ]/u;
const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;
const CURRENCY = /\p{Sc}/u; // symbols only ($ € ₪ £): no currency words
const END_Q = /[?؟]["')\]\s\u200e\u200f]*$/u;

export function features(line: IntakeLine, prevAt?: number): TurnFeatures {
  const text = String(line.text ?? "");
  let he = 0,
    latin = 0,
    other = 0;
  for (const ch of text) {
    if (!LETTER.test(ch)) continue;
    if (HE.test(ch)) he++;
    else if (LATIN.test(ch)) latin++;
    else other++;
  }
  const letters = he + latin + other;
  const share = (n: number) => (letters ? n / letters : 0);
  const script = { he: share(he), latin: share(latin), other: share(other) };
  const lang: TurnFeatures["lang"] = !letters
    ? "none"
    : script.he > 0.2 && script.latin > 0.2
      ? "mixed"
      : script.he >= script.latin
        ? script.he > 0
          ? "he"
          : "none"
        : "en";
  return {
    words: tokenCount(text),
    script,
    lang,
    hasDigits: DIGIT.test(text),
    hasCurrency: CURRENCY.test(text),
    endsWithQuestion: END_Q.test(text.trim()),
    side: line.side,
    ...(line.speaker ? { speaker: line.speaker } : {}),
    ...(prevAt !== undefined ? { gapMs: Math.max(0, line.at - prevAt) } : {}),
  };
}

/** One call has one Intake. It remembers only the previous line per side (for repeats) and the previous line's time (for the gap). */
export class Intake {
  private last: { text: string; at: number } | undefined;
  private lastBySide: Partial<Record<Side, { text: string; at: number }>> = {};
  constructor(private o: IntakeOptions = {}) {}

  accept(line: IntakeLine): IntakeResult {
    const f = features(line, this.last?.at);
    const norm = normalize(String(line.text ?? ""));
    const prev = this.lastBySide[line.side];
    this.last = { text: norm, at: line.at };
    this.lastBySide[line.side] = { text: norm, at: line.at };
    const safe = f.hasDigits || f.hasCurrency || (f.endsWithQuestion && f.words >= (this.o.minTokens ?? 2));
    if (safe) return { keep: true, features: f };
    const drop = (why: IntakeDrop): IntakeResult => ({ keep: false, why, features: f });
    // "מחיר?" is one real token and a question: kept. A bare "?" or a lone sound is not.
    if (f.words < (this.o.minTokens ?? 2) && !(f.endsWithQuestion && f.words >= 1)) return drop("too-short");
    if (line.side === "me" && this.o.isEcho?.(line.text, line.at)) return drop("echo");
    if (prev && prev.text === norm && line.at - prev.at <= (this.o.repeatMs ?? 3000)) return drop("repeat");
    if (line.confidence !== undefined && line.confidence < (this.o.minConfidence ?? 0.3)) return drop("low-confidence");
    return { keep: true, features: f };
  }
}
