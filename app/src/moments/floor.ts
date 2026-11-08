// The floor: what may show when the AI is paused (spend cap, no model, no network) and no model can read a line. It reads the SHAPE of the line
// (TurnFeatures: the speech-to-text "?", digits and currency signs, short length, a full stop, who the line is aimed at) and the local bank
// (trigger score, stall-tier hit, 3-gram + word scorer). It has no word list and no language rule of its own, so it works the same in Hebrew, English and mixed talk.
// "Aimed at you" comes from the caller: the user's name, or the only other voice. A line that opens with the name of another person is aimed elsewhere.
// The old question detector (detector.ts through moments/hint.ts) is NOT part of the floor. It may be passed in as `hint`: a tiebreak for a line the shape
// rules left undecided. Reports: src/e2e/r3-floor.test.ts prints the floor's recall and precision on the golden dev meetings with the hint on and off.
import type { TurnFeatures } from "./intake.ts";
import type { HintLevel } from "./types.ts";
import { SHORT_LINE_WORDS } from "./hint.ts";
import { normalize } from "../normalize.ts";

export type FloorCtx = {
  /** The line is aimed at the user: their name was said, or the call has one other voice. */
  addressed: boolean;
  /** The line is aimed at somebody else: it opens with the name of another person of the call and a comma ("Dana, can you ..."). See `vocativeOf`. */
  elsewhere?: boolean;
  /** Trigger score of the best bank card (bank.ts matchBank), 0 when none. */
  bankScore?: number;
  /** The best card is a stall-tier card (price, timeline, guarantee). */
  stall?: boolean;
  /** The local scorer (3-gram + word BM25) found a confident card. */
  scorer?: boolean;
  /** The legacy detector's level for this line, or undefined when the hint is off. A tiebreak only. */
  hint?: HintLevel;
};
export type FloorOut = { isQuestion: boolean; reason: string; via: "floor" | "hint" };

/** A line this short (tokens) from someone speaking to the user, with no full stop at the end, is a request or a question. */
export const IMPERATIVE_MAX_WORDS = 5;
/** The bank rule is for one question, not for a speech: longer lines are left to the model. */
export const BANK_MAX_WORDS = 18;
const BANK_MIN_WORDS = 3;

/** The name a line opens with when it is followed by a comma ("Dana, can you ..."), normalized, or undefined. Punctuation shape only. */
export function vocativeOf(text: string): string | undefined {
  const m = /^\s*([^\s,،]{2,20})\s*[,،]/u.exec(text);
  return m ? normalize(m[1]) : undefined;
}
/** True when the line opens with the name of somebody who is in the call and is not the user. `others` are names of the roster, `me` the user's names (any case). */
export function addressedElsewhere(text: string, others: Iterable<string>, me: Iterable<string> = []): boolean {
  const v = vocativeOf(text);
  if (!v) return false;
  const mine = new Set([...me].map(normalize));
  if (mine.has(v)) return false;
  for (const o of others) if (normalize(o) === v) return true;
  return false;
}

export function floorQuestion(f: TurnFeatures, ctx: FloorCtx): FloorOut {
  const yes = (reason: string, via: FloorOut["via"] = "floor"): FloorOut => ({ isQuestion: true, reason, via });
  if (f.side !== "them" || f.words < 1) return { isQuestion: false, reason: "no-cue", via: "floor" };
  const toYou = ctx.addressed && !ctx.elsewhere;
  const score = ctx.bankScore ?? 0;
  if (f.endsWithQuestion && !ctx.elsewhere) return yes("question-mark");
  if (ctx.elsewhere) return { isQuestion: false, reason: "aimed-elsewhere", via: "floor" };
  if (ctx.stall && f.words < 8) return yes("stall-bank");
  if ((f.hasDigits || f.hasCurrency) && toYou && f.words <= SHORT_LINE_WORDS) return yes("figure-to-you");
  // A card that matched on two or more trigger words, or the scorer's card, may speak for a statement that is aimed at the user or has no full stop. A single
  // trigger word only counts for a line aimed at the user that the speech-to-text left without a full stop ("the site is slow again").
  const inRange = f.words >= BANK_MIN_WORDS && f.words <= BANK_MAX_WORDS;
  if (inRange && score >= 2) return yes("bank");
  if (inRange && ctx.scorer && (toYou || !f.endsWithStop)) return yes("bank");
  if (inRange && score >= 1 && toYou && !f.endsWithStop) return yes("bank");
  if (toYou && f.words >= 2 && f.words <= IMPERATIVE_MAX_WORDS && !f.endsWithStop) return yes("short-imperative");
  if (ctx.hint === "strong") return yes("hint-strong", "hint");
  if (ctx.hint === "weak" && (score >= 1 || ctx.scorer || ctx.addressed)) return yes("hint-weak", "hint");
  return { isQuestion: false, reason: "no-cue", via: "floor" };
}
