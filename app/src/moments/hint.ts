// A hint on how fast to ask the model about a line. It never suppresses a model call on a line that passed intake.
//  - speedHint(features, ctx): language-neutral: it reads only the shape of the line (the speech-to-text "?", digits or a
//    currency sign, who speaks, whether it is aimed at the user, a short line with no full stop). No word list.
import type { TurnFeatures } from "./intake.ts";

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
