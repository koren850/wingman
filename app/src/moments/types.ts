// Shared types of the moment engine core (pure code, no globals). A "moment" is the model's verdict on one stretch of the call:
// SKIP (stay silent) or one kind of short private help. Contract: PLAN.md 3.2 (round 12).

export const MOMENT_TAGS = ["SKIP", "ANS", "BANK", "STALL", "REPLY", "CHECK", "TERM", "PROMPT", "NOTE"] as const;
export type MomentTag = (typeof MOMENT_TAGS)[number];

/** Who the card is for. `other` means the user cannot act on it (the other side must), so it is dropped. */
export const AIMS = ["me", "other", "all", "unclear"] as const;
export type Aim = (typeof AIMS)[number];

export type Value = 0 | 1 | 2 | 3;

/** For STALL: what kind of commitment is asked. Price and guarantee stalls are exempt from the per-minute cap. */
export type StallKind = "price" | "guarantee" | "timeline" | "other";

export type Moment = {
  tag: MomentTag;
  /** BANK only: the card id, lower case. */
  bankId?: string;
  /** STALL only. */
  stall?: StallKind;
  value: Value;
  aim: Aim;
  /** The line to say or the point to see. At most 14 words. Empty for SKIP and for BANK/STALL (the code supplies the card text). */
  say: string;
  /** One short line, shown small. */
  why: string;
  /** Up to 3 short lines. */
  more: string[];
  /** A memory id (q12, c3). */
  ref?: string;
};

/** A row for the call log when the parser had to fall back to SKIP. Same family as the other error.survived rows. */
export type SurvivedRow = { type: "error.survived"; where: "moments.parse"; reason: string; sample: string };

export type HintLevel = "strong" | "weak" | "none";
export type Hint = { level: HintLevel; reason: string };

/** Where a moment came from. `observer` moments are not a reply to a direct question, so a late one is dropped. */
export type MomentSource = "direct" | "observer" | "ask";

/** What the scheduler needs to know about a moment besides its text. Set by the engine, not by the model. */
export type MomentMeta = {
  /** Id of the turn (the model call) that made it. Compared with the current turn id to drop a late stream. */
  turnId?: number;
  source?: MomentSource;
  /** When the line that caused it ended (ms, the clock the scheduler is given). */
  lineAt?: number;
  /** Short topic label from the memory (lower case). Used by novelty and topic lifetime. */
  topic?: string;
  /** The hint the legacy gate gave for the line (offline mode needs it). */
  hint?: HintLevel;
};

/** Limits in one place. */
export const LIMITS = {
  sayWords: 14,
  sayChars: 160,
  whyChars: 120,
  moreLines: 3,
  moreChars: 120,
  refChars: 16,
  /** The parser looks at no more than this many characters of a reply. */
  inputChars: 4000,
  /** What a row in the log keeps of a bad reply. */
  sampleChars: 80,
} as const;

export const SKIP_MOMENT: Moment = Object.freeze({ tag: "SKIP", value: 0, aim: "unclear", say: "", why: "", more: Object.freeze([] as string[]) }) as Moment;
