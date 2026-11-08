// Small decisions the engine modules share, kept free of call state (no imports from boot.ts) so tests can call them directly.

/** Is this line aimed at the user ("you", their name, Hebrew masculine/feminine forms)? Used by flow mode, which holds questions the others ask each other. The patterns are in lang/address.ts. */
export { addressesUser } from "../lang/address.ts";

/** How many of the AI notes written so far go back to the notes model each round (it only needs the recent ones to avoid repeating itself). */
export const NOTES_EXISTING_MAX = 40;
export function recentNotes(notes: readonly string[]): string[] {
  return notes.slice(-NOTES_EXISTING_MAX);
}

/** Practice mode: when the user's current rehearsed answer began. An answer is the user talking since the other side (the mock interviewer) last spoke; a pause of more than 10 s
 *  between the user's lines starts a new one (if the other side's audio is dead, its clock never moves and the answer would never end). */
export const ANSWER_PAUSE_MS = 10_000;
export function nextAnswerStart(o: { answerStart: number; lastThemSpeech: number; lastMeLineAt: number; now: number }): number {
  if (!o.answerStart || o.lastThemSpeech > o.answerStart || (o.lastMeLineAt > 0 && o.now - o.lastMeLineAt > ANSWER_PAUSE_MS))
    return Math.max(o.lastThemSpeech, o.now - 5000);
  return o.answerStart;
}

// ---- coach.ts: transcript window and frame pacing ----
export { wordCount } from "../text-util.ts";
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

// ---- boot.ts: what the call loads ----
/** The client snapshot (domains, servers) feeds fact cards about the user's own clients. An interview is not a client call: no snapshot, so no such facts. */
export const factsActive = (o: { factsEnabled: boolean; interview: boolean }) => o.factsEnabled && !o.interview;

// ---- moments.ts: where a finished line goes in the moment engine, and when the AI counts as paused ----
export type MomentRoute = "legacy" | "direct" | "observer" | "local" | "drop";
/** Where a kept line from the other side goes. `direct`: ask the model now (strong hint). `observer`: the line waits in the observer window. `local`: no model call,
 *  the old path with bank, calc and the stall line (AI paused). `drop`: no call for this line (slow model: observer off; hourly cap: observer shed). A hint never drops a line
 *  by itself: only the state of the model does. */
export function momentRoute(o: { v2: boolean; hint: "strong" | "weak" | "none"; paused: boolean; slow: boolean; observerShed: boolean; observerOn: boolean }): {
  route: MomentRoute;
  why: string;
} {
  if (!o.v2) return { route: "legacy", why: "engine-legacy" };
  if (o.paused) return { route: o.hint === "strong" ? "local" : "drop", why: "ai-paused" };
  if (o.hint === "strong") return { route: "direct", why: "strong-hint" };
  if (o.slow) return { route: "drop", why: "model-slow" };
  if (!o.observerOn) return { route: "drop", why: "observer-off" };
  if (o.observerShed) return { route: "drop", why: "observer-shed" };
  return { route: "observer", why: o.hint === "weak" ? "weak-hint" : "no-hint" };
}
/** Why the AI is paused, or undefined when it works: the spend cap (per call or per hour), no usable model, or no network (the last failures were network errors). */
export function pausedReason(o: {
  noAi: boolean;
  usable: number;
  llmAllowed: boolean;
  costPaused: string | undefined;
  lastFailKind?: string;
}): "cap" | "down" | "net" | undefined {
  if (o.noAi) return undefined; // the user's own choice: not a pause
  if (o.costPaused) return "cap";
  if (o.usable === 0 || !o.llmAllowed) return o.lastFailKind === "network" ? "net" : "down";
  return undefined;
}
