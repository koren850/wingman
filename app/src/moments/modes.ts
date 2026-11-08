// Call modes for the moment engine. Two functions are the whole interface: modeInstructions(kind) is extra prompt text for a kind of call,
// modeProfile(kind) is how the scheduler and the observer should behave for it. The prompt builder and the scheduler call nothing else,
// so a new mode is one entry here. The text is in English and has no word lists: the model works in the language of the call.
import type { MemoryKind } from "../session/types.ts";
import type { MomentTag } from "./types.ts";

export type ModeProfile = {
  /** Least VALUE per tag for this kind of call. A tag not listed keeps the setting (moments.minValue). */
  minValue?: Partial<Record<MomentTag | "default", number>>;
  /** Cards per minute before a card becomes a chip. */
  maxPerMinute?: number;
  /** Observer calls a minute. */
  observerPerMinute?: number;
  /** The user talks this many words in a row: the observer looks at the answer (a coaching call). 0 or missing = off. */
  monologueWords?: number;
};

const INTERVIEW = `Mode: practice interview. The user is the candidate, the other side is the interviewer. You are the candidate's coach.
- The interviewer asks a question: ANS or REPLY with the shape of a good answer (for example situation, action, result), not a script. Use only the user's own notes.
- The user answers (lines marked as the user's side). Coach the answer:
  - REPLY: a structure, when the answer wanders.
  - NOTE: the answer is too long (about 90 seconds or more), or a claim is vague (no example, no number).
  - PROMPT: a part of the question is not answered yet. Name the missing part in SAY.
- An answer that is on track and short enough: SKIP. Never praise. Do not coach every line.`;

const DEFAULT_PROFILE: ModeProfile = {};
const PROFILES: Partial<Record<MemoryKind, ModeProfile>> = {
  // A practice interview: every question deserves a look, so a marginal card is allowed, and a long answer gets a coaching look.
  interview: { minValue: { default: 1, STALL: 1, CHECK: 1 }, maxPerMinute: 6, monologueWords: 90 },
};
const TEXT: Partial<Record<MemoryKind, string>> = { interview: INTERVIEW };

/** Extra instructions for this kind of call. Empty for every kind without its own mode (the neutral default). */
export function modeInstructions(kind: MemoryKind | undefined): string {
  return (kind && TEXT[kind]) || "";
}

/** Behaviour numbers for this kind of call. The neutral default is an empty profile: the settings decide. */
export function modeProfile(kind: MemoryKind | undefined): ModeProfile {
  return (kind && PROFILES[kind]) || DEFAULT_PROFILE;
}
