// Small decisions the engine modules share, kept free of call state (no imports from boot.ts) so tests can call them directly.
import { addressesYou } from "../detector.ts";

/** Second-person forms that detector.addressesYou does not cover: feminine and "opinion" forms ("מה דעתך", "תוכלי", "את חושבת"), English contractions and texting forms.
 *  Plural forms (אתם, לכם) are left out on purpose: inside their own discussion two of them say "אתם" to each other. */
const MORE_YOU =
  /(^|[\s,.?!"'])(דעתך|לדעתך|בעיניך|ניסיונך|מניסיונך|תוכלי|תגיד|תגידי|ספרי|תספרי|תארי|תסבירי|עבדת|את\s+(?:יכולה|חושבת|מכירה|יודעת|רוצה|מוכנה|עובדת|רואה|שומעת|מסכימה|הייתי?)|u|ya|you'?(?:re|ll|ve|d)|yourself)(?![\p{L}])/iu;

/** Is this line aimed at the user ("you", their name, Hebrew masculine/feminine forms)? Used by flow mode, which holds questions the others ask each other. */
export function addressesUser(text: string): boolean {
  return addressesYou(text) || MORE_YOU.test(text);
}

/** How many of the AI notes written so far go back to the notes model each round (it only needs the recent ones to avoid repeating itself). */
export const NOTES_EXISTING_MAX = 40;
export function recentNotes(notes: readonly string[]): string[] {
  return notes.slice(-NOTES_EXISTING_MAX);
}

/** Interview: when the current answer of the user began. An answer is the user talking since the other side last spoke; a pause of more than 10 s
 *  between the user's lines starts a new one (if the interviewer's audio is dead, the other-side clock never moves and the answer would never end). */
export const ANSWER_PAUSE_MS = 10_000;
export function nextAnswerStart(o: { answerStart: number; lastThemSpeech: number; lastMeLineAt: number; now: number }): number {
  if (!o.answerStart || o.lastThemSpeech > o.answerStart || (o.lastMeLineAt > 0 && o.now - o.lastMeLineAt > ANSWER_PAUSE_MS))
    return Math.max(o.lastThemSpeech, o.now - 5000);
  return o.answerStart;
}

// ---- coach.ts: transcript window and frame pacing ----
export const wordCount = (t: string) => t.split(/\s+/).filter(Boolean).length;
/** The newest `maxLines` lines from the last `minutes` of the call, oldest first. */
export function recentWindow<T extends { at: number }>(lines: readonly T[], now: number, minutes: number, maxLines = 80): T[] {
  return lines.filter((l) => now - l.at <= minutes * 60_000).slice(-maxLines);
}
export const TRANSCRIPT_MAX_CHARS = 6000;
/** Keeps the newest part of a transcript when it is longer than the prompt budget. */
export const capTail = (text: string, max = TRANSCRIPT_MAX_CHARS) => (text.length > max ? text.slice(-max) : text);
/** Is a call-frame look due? The first frame comes early (at most 20 new words, no waiting) so the first question already knows what the call is about;
 *  the final look at shutdown needs only 8 words and ignores the pacing. */
export function frameDue(o: {
  final: boolean;
  hasFrame: boolean;
  newWords: number;
  minNewWords: number;
  now: number;
  lastFrameAt: number;
  everyMs: number;
}): boolean {
  const need = o.final ? 8 : o.hasFrame ? o.minNewWords : Math.min(o.minNewWords, 20);
  if (o.newWords < need) return false;
  return o.final || !o.hasFrame || o.now - o.lastFrameAt >= o.everyMs;
}

// ---- degrade.ts: what a failed model call does to the model's health ----
export const SPEND_CAP_PARK_MS = 6 * 3600_000;
/** `hard` errors (auth, spend cap, quota, unsupported) open the circuit breaker for longer and put a red bar up; a spend-capped model is parked for 6 h;
 *  overload-type errors tell the supervisor the AI is in trouble (the degrade ladder may step down). */
export function llmFailurePolicy(kind: string): { hard: boolean; parkMs: number; noteTrouble: boolean } {
  return {
    hard: kind === "auth" || kind === "spend_cap" || kind === "quota" || kind === "unsupported",
    parkMs: kind === "spend_cap" ? SPEND_CAP_PARK_MS : 0,
    noteTrouble: kind === "rate" || kind === "overload" || kind === "timeout" || kind === "network",
  };
}

// ---- question.ts: which questions get a turn at all, and which prepared cards may repeat ----
/** Answers older than reflex.dropStaleMs are never shown. */
export const isFresh = (speechEnd: number, now: number, dropStaleMs: number) => now - speechEnd < dropStaleMs;
/** The same prepared card twice in one call is almost always a keyword echo. A repeat shows only for a clear question at least 2 minutes after the last time. */
export const REPEAT_BANK_MS = 120_000;
export function isBankRepeat(o: { shownAt: number | undefined; now: number; clearQuestion: boolean }): boolean {
  return o.shownAt !== undefined && !(o.clearQuestion && o.now - o.shownAt > REPEAT_BANK_MS);
}
/** Not a client / support call and the question is not about the user's own services: no agency bank card and no stall line. An interview never gets a stall line either. */
export function agencyGate(o: {
  interview: boolean;
  kind: string | undefined;
  kindIsAgency: boolean;
  agencyTopic: boolean;
  agencyRecent: boolean;
  stallEnabled: boolean;
}) {
  const noAgency = !o.interview && !!o.kind && !o.kindIsAgency && !o.agencyTopic && !o.agencyRecent;
  return { noAgency, noStall: noAgency || o.interview || !o.stallEnabled };
}
/** Why a line is dropped before a turn starts (the event type that is logged), or undefined when it gets a turn. Inputs are thunks so the costly checks run only when reached. */
export type SkipWhy = "ifopen.skip" | "head.skip" | "focus.skip" | "flow.hold";
export function questionSkip(o: {
  interview: boolean;
  reason: string;
  aimedAtYou: () => boolean;
  hasBankHit: () => boolean;
  focusOn: boolean;
  focusWorthy: () => boolean;
  flowHolds: () => boolean;
}): SkipWhy | undefined {
  if (!o.interview && o.reason.startsWith("if-open") && !o.aimedAtYou()) return "ifopen.skip";
  if (o.interview && o.reason.startsWith("head") && !o.aimedAtYou() && !o.hasBankHit()) return "head.skip";
  if (o.focusOn && !o.interview && !o.focusWorthy()) return "focus.skip";
  if (o.flowHolds()) return "flow.hold";
  return undefined;
}
