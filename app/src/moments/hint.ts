// Two hints on how fast to ask the model about a line. Neither one ever suppresses a model call on a line that passed intake.
//  - speedHint(features, ctx): the default (moments.engine = v2). Language-neutral: it reads only the shape of the line (the speech-to-text "?", digits or a
//    currency sign, who speaks, whether it is aimed at the user, a short line with no full stop). No word list.
//  - hint(line, ctx): the legacy question gate as a hint (FROZEN: it wraps detector.ts and adds no words and no rules). strong = a clear question to the
//    user, weak = some question cue, none = no cue. It runs only when the AI is paused (the offline path, where no model can read the line) and for the
//    legacy engine.
import { detect, isClearQuestion, type DetectCtx } from "../detector.ts";
import type { TurnFeatures } from "./intake.ts";
import type { Hint } from "./types.ts";

/** "fast": ask the model at once (the direct path). "normal": the line waits in the observer window. */
export type SpeedHint = "fast" | "normal";
export type SpeedCtx = {
  /** The line is aimed at the user: their name was said, or the call has one other voice. The caller knows the roster and the diarization. */
  addressed: boolean;
  /** The speech-to-text result is final. Default true. */
  final?: boolean;
};
/** A line this short (tokens) can be a request or a question without a question mark. */
export const SHORT_LINE_WORDS = 9;

/** Why `speedHint` said fast (for logs and tests). */
export function speedReason(f: TurnFeatures, ctx: SpeedCtx): "question-mark" | "figure-to-you" | "short-to-you" | undefined {
  if (f.side !== "them" || ctx.final === false) return undefined;
  if (f.endsWithQuestion) return "question-mark";
  if (!ctx.addressed || f.words < 1 || f.words > SHORT_LINE_WORDS) return undefined;
  if (f.hasDigits || f.hasCurrency) return "figure-to-you";
  return f.endsWithStop ? undefined : "short-to-you";
}
/** fast = a "?" from the speech-to-text; or a short line from the other side that is aimed at the user and has a figure or no full stop (a short request or question).
 *  normal = everything else; the observer window looks at it. */
export function speedHint(f: TurnFeatures, ctx: SpeedCtx = { addressed: false }): SpeedHint {
  return speedReason(f, ctx) ? "fast" : "normal";
}

/** Same context the legacy gate takes (bank score, stall-tier hit). */
export type HintCtx = DetectCtx;

/** `level !== "none"` equals `detect(line, ctx).isQuestion`. `reason` is the detector's reason string, for logs and tests. */
export function hint(line: string, ctx: HintCtx = {}): Hint {
  const d = detect(line, ctx);
  if (!d.isQuestion) return Object.freeze({ level: "none", reason: d.reason });
  return Object.freeze({ level: isClearQuestion(line, d.reason) ? "strong" : "weak", reason: d.reason });
}
