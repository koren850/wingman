// Coaching numbers of a finished call, from transcript.jsonl alone: no model call, no word lists (no counting of particular words).
//   talkSharePct         the user's share of the speaking time (0-100)
//   longestMonologueSec  the longest stretch the user talked without the other side saying more than a short word
//   questionsAsked       sentences the user ended with a question mark (a lower bound: speech-to-text does not always write the mark)
//   paceWpm              words per speaking minute, for each side
//   interruptions        times the user started talking while the other side was still talking (the two channels overlap)
// A row of transcript.jsonl is one final line; `t` is when it arrived (about when the speech ended). Its speaking time comes from the word
// times when the row has them, else from the word count at an average pace. The word times of the two channels are not on one clock, so
// only `t` and the length of each row are used to place a row on the call's time line.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Coaching = {
  talkSharePct: number;
  longestMonologueSec: number;
  questionsAsked: number;
  paceWpm: { me: number; them: number };
  interruptions: number;
};

type Row = { ch: "me" | "them"; text: string; t: number; words?: { start?: number; end?: number }[] };
type Span = { ch: "me" | "them"; start: number; end: number; words: number; q: number };

/** Average speaking pace (words a second) when a row has no word times. 2.5 = 150 words a minute. */
const AVG_WPS = 2.5;
/** A row of the other side with at most this many words does not break the user's monologue (a "yes", a "mm-hm"). */
const SHORT_REPLY_WORDS = 2;
/** The user must be over the other side's speech by this long, and the other side must still have this long to go, to count as an interruption. */
const OVER_MS = 400;
const STILL_TALKING_MS = 700;

const wordsIn = (s: string) => s.split(/\s+/).filter(Boolean).length;
const questions = (s: string) => (s.match(/[?？؟]+/g) ?? []).length;

function spanOf(r: Row): Span | undefined {
  const n = wordsIn(r.text);
  if (!n || !Number.isFinite(r.t)) return undefined;
  const w = r.words ?? [];
  const first = w.find((x) => typeof x.start === "number")?.start;
  const last = [...w].reverse().find((x) => typeof x.end === "number")?.end;
  let sec = typeof first === "number" && typeof last === "number" && last > first ? last - first : n / AVG_WPS;
  sec = Math.min(Math.max(sec, 0.3), 120); // a single row is never longer than two minutes
  return { ch: r.ch, start: r.t - sec * 1000, end: r.t, words: n, q: questions(r.text) };
}

/** Rows of transcript.jsonl into coaching numbers. Undefined when there is too little speech (under 20 words in total) to say anything. */
export function computeCoaching(rows: readonly Row[]): Coaching | undefined {
  const spans = rows
    .filter((r) => (r.ch === "me" || r.ch === "them") && typeof r.text === "string")
    .map(spanOf)
    .filter((s): s is Span => !!s)
    .sort((a, b) => a.end - b.end);
  const total = spans.reduce((n, s) => n + s.words, 0);
  if (total < 20) return undefined;
  const dur = { me: 0, them: 0 },
    words = { me: 0, them: 0 };
  let q = 0;
  for (const s of spans) {
    dur[s.ch] += s.end - s.start;
    words[s.ch] += s.words;
    if (s.ch === "me") q += s.q;
  }
  const talk = dur.me + dur.them;
  const pace = (ch: "me" | "them") => (dur[ch] >= 1000 ? Math.round(words[ch] / (dur[ch] / 60_000)) : 0);

  // The user's longest monologue: consecutive rows of the user; a short reply from the other side does not end it.
  let longest = 0,
    runStart: number | undefined,
    runEnd = 0;
  const close = () => {
    if (runStart !== undefined) longest = Math.max(longest, runEnd - runStart);
    runStart = undefined;
  };
  for (const s of spans) {
    if (s.ch === "me") {
      if (runStart === undefined) runStart = s.start;
      runEnd = s.end;
    } else if (s.words > SHORT_REPLY_WORDS) close();
  }
  close();

  // Interruptions: the user's row starts inside a row of the other side that goes on for a while.
  let inter = 0;
  const them = spans.filter((s) => s.ch === "them");
  for (const m of spans.filter((s) => s.ch === "me")) {
    if (them.some((o) => m.start > o.start + OVER_MS && m.start < o.end - STILL_TALKING_MS)) inter++;
  }

  return {
    talkSharePct: talk ? Math.round((dur.me / talk) * 100) : 0,
    longestMonologueSec: Math.round(longest / 1000),
    questionsAsked: q,
    paceWpm: { me: pace("me"), them: pace("them") },
    interruptions: inter,
  };
}

/** Reads calls/<id>/transcript.jsonl and computes the numbers. Undefined when the file is missing or has too little speech. */
export function coachingForCall(dir: string): Coaching | undefined {
  const f = join(dir, "transcript.jsonl");
  if (!existsSync(f)) return undefined;
  const rows: Row[] = [];
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as Row;
      if (r && typeof r.t === "number") rows.push(r);
    } catch {
      /* a half-written line */
    }
  }
  return computeCoaching(rows);
}
