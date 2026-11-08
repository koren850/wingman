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
import { wordCount } from "../text-util.ts";

export type Coaching = {
  talkSharePct: number;
  longestMonologueSec: number;
  questionsAsked: number;
  paceWpm: { me: number; them: number };
  interruptions: number;
};

export type Row = { ch: "me" | "them"; text: string; t: number; words?: { start?: number; end?: number }[] };
/** `timed`: the speaking time came from word times (not from the average pace). */
export type Span = { ch: "me" | "them"; start: number; end: number; words: number; q: number; timed: boolean };

/** Average speaking pace (words a second) when a row has no word times. 2.5 = 150 words a minute. */
const AVG_WPS = 2.5;
/** A row of the other side with at most this many words does not break the user's monologue (a "yes", a "mm-hm"). */
const SHORT_REPLY_WORDS = 2;
/** The user must be over the other side's speech by this long, and the other side must still have this long to go, to count as an interruption. */
const OVER_MS = 400;
const STILL_TALKING_MS = 700;

const questions = (s: string) => (s.match(/[?？؟]+/g) ?? []).length;

export function spanOf(r: Row): Span | undefined {
  const n = wordCount(r.text);
  if (!n || !Number.isFinite(r.t)) return undefined;
  const w = r.words ?? [];
  const first = w.find((x) => typeof x.start === "number")?.start;
  const last = [...w].reverse().find((x) => typeof x.end === "number")?.end;
  const timed = typeof first === "number" && typeof last === "number" && last > first;
  let sec = timed ? last - first : n / AVG_WPS;
  sec = Math.min(Math.max(sec, 0.3), 120); // a single row is never longer than two minutes
  return { ch: r.ch, start: r.t - sec * 1000, end: r.t, words: n, q: questions(r.text), timed };
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

// ---------------------------------------------------------------- live nudges
// A nudge is one short line on a thin bar, from numbers the app already measures while the call runs. It is not a card, it has no model call and it uses
// no word lists. Off by default (settings coach.nudges). Rules:
//   - at most one nudge per `gapMs` (5 minutes), of any kind;
//   - never while a Check is on screen (`checkHold`), and never in quiet mode;
//   - pace: the user's pace over the last 60 s is above `paceMax` words a minute, and the user spoke at least 20 s in it;
//   - share: the user's share of speaking time over the last 5 minutes is above `talkShareMax` percent (after 3 minutes of call, 40 s of speech from both sides);
//   - interruptions: the user's last 3 turns inside the last 2 minutes all started over the other side.
// The nudge carries kind and numbers only. The window writes the words in its own language.
export type NudgeKind = "pace" | "share" | "interrupt";
export type Nudge = { kind: NudgeKind; value: number; limit: number };
export type NudgeCfg = {
  enabled: boolean;
  talkShareMax: number;
  paceMax: number;
  gapMs: number;
  paceWindowMs: number;
  shareWindowMs: number;
  streakWindowMs: number;
  streakLength: number;
};
export const DEFAULT_NUDGE_CFG: NudgeCfg = {
  enabled: false,
  talkShareMax: 70,
  paceMax: 180,
  gapMs: 5 * 60_000,
  paceWindowMs: 60_000,
  shareWindowMs: 5 * 60_000,
  streakWindowMs: 2 * 60_000,
  streakLength: 3,
};
const MIN_PACE_SPEECH_MS = 20_000;
const MIN_SHARE_SPEECH_MS = 40_000;
const MIN_SHARE_CALL_MS = 3 * 60_000;

/** The live numbers at `now` from the rows of the call so far (the same rows as the transcript). */
export function liveNumbers(
  rows: readonly Row[],
  now: number,
  cfg: Pick<NudgeCfg, "paceWindowMs" | "shareWindowMs" | "streakWindowMs"> = DEFAULT_NUDGE_CFG,
): { paceWpm?: number; sharePct?: number; streak: number; callMs: number } {
  const spans = rows
    .filter((r) => (r.ch === "me" || r.ch === "them") && typeof r.text === "string" && r.t <= now)
    .map(spanOf)
    .filter((s): s is Span => !!s)
    .sort((a, b) => a.end - b.end);
  const callMs = spans.length ? now - spans[0].start : 0;
  const within = (ms: number) => spans.filter((s) => s.end > now - ms);
  const dur = (xs: Span[], ch: "me" | "them") => xs.filter((s) => s.ch === ch).reduce((n, s) => n + (s.end - s.start), 0);
  // pace needs real word times: a row without them would only give back the average pace we assumed
  const pw = within(cfg.paceWindowMs).filter((s) => s.timed);
  const meMs = dur(pw, "me");
  const paceWpm = meMs >= MIN_PACE_SPEECH_MS ? Math.round(pw.filter((s) => s.ch === "me").reduce((n, s) => n + s.words, 0) / (meMs / 60_000)) : undefined;
  const sw = within(cfg.shareWindowMs);
  const sm = dur(sw, "me"),
    st = dur(sw, "them");
  const sharePct = sm >= MIN_SHARE_SPEECH_MS && st >= MIN_SHARE_SPEECH_MS && callMs >= MIN_SHARE_CALL_MS ? Math.round((sm / (sm + st)) * 100) : undefined;
  // the trailing run of the user's turns that started over the other side (a turn is a span of the user)
  const them = spans.filter((s) => s.ch === "them");
  const mine = within(cfg.streakWindowMs).filter((s) => s.ch === "me");
  let streak = 0;
  for (let i = mine.length - 1; i >= 0; i--) {
    const m = mine[i];
    if (them.some((o) => m.start > o.start + OVER_MS && m.start < o.end - STILL_TALKING_MS)) streak++;
    else break;
  }
  return { ...(paceWpm !== undefined ? { paceWpm } : {}), ...(sharePct !== undefined ? { sharePct } : {}), streak, callMs };
}

/** Decides when a nudge may show. Holds only the time of the last one. `now` always comes from the caller (a virtual clock in tests). */
export class Nudger {
  private lastAt = -Infinity;
  constructor(public cfg: NudgeCfg = DEFAULT_NUDGE_CFG) {}
  /** The nudge to show now, or undefined. `checkHold`: a Check is on screen. `quiet`: quiet mode. */
  check(now: number, rows: readonly Row[], o: { checkHold?: boolean; quiet?: boolean } = {}): Nudge | undefined {
    const c = this.cfg;
    if (!c.enabled || o.quiet || o.checkHold) return undefined;
    if (now - this.lastAt < c.gapMs) return undefined;
    const n = liveNumbers(rows, now, c);
    let out: Nudge | undefined;
    if (n.streak >= c.streakLength) out = { kind: "interrupt", value: n.streak, limit: c.streakLength };
    else if (n.paceWpm !== undefined && n.paceWpm > c.paceMax) out = { kind: "pace", value: n.paceWpm, limit: c.paceMax };
    else if (n.sharePct !== undefined && n.sharePct > c.talkShareMax) out = { kind: "share", value: n.sharePct, limit: c.talkShareMax };
    if (out) this.lastAt = now;
    return out;
  }
  /** For a test or a call restart. */
  reset(): void {
    this.lastAt = -Infinity;
  }
}

/**
 * The last few minutes of speech as the engine hears it (the final rows, with their word times). The engine pushes each final here; the nudger reads it.
 * Memory stays small: rows older than `keepMs` (6 minutes) and anything past 400 rows are dropped.
 */
export class SpeechRing {
  private list: Row[] = [];
  constructor(private keepMs = 6 * 60_000) {}
  push(r: Row): void {
    if (!r || typeof r.text !== "string" || !Number.isFinite(r.t)) return;
    // only the first start and the last end of the word times matter: two small numbers instead of every word
    const w = r.words ?? [];
    const first = w.find((x) => typeof x.start === "number")?.start;
    const last = [...w].reverse().find((x) => typeof x.end === "number")?.end;
    this.list.push({
      ch: r.ch,
      text: r.text,
      t: r.t,
      ...(first !== undefined || last !== undefined
        ? { words: [{ ...(first !== undefined ? { start: first } : {}), ...(last !== undefined ? { end: last } : {}) }] }
        : {}),
    });
    const cut = r.t - this.keepMs;
    while (this.list.length > 400 || (this.list.length && this.list[0].t < cut)) this.list.shift();
  }
  rows(): Row[] {
    return this.list.slice();
  }
  clear(): void {
    this.list = [];
  }
}
export const speechRing = new SpeechRing();
