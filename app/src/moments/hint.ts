// The legacy question gate as a hint. FROZEN: it wraps detector.ts and adds no words and no rules.
// strong = a clear question to the user (the detector's strong reasons), weak = some question cue, none = no cue.
// A hint never suppresses a model call on a line that passed intake; it only says how fast to ask (observer.ts) and, offline, what may show (scheduler.ts).
import { detect, isClearQuestion, type DetectCtx } from "../detector.ts";
import type { Hint } from "./types.ts";

/** Same context the legacy gate takes (bank score, stall-tier hit). */
export type HintCtx = DetectCtx;

/** `level !== "none"` equals `detect(line, ctx).isQuestion`. `reason` is the detector's reason string, for logs and tests. */
export function hint(line: string, ctx: HintCtx = {}): Hint {
  const d = detect(line, ctx);
  if (!d.isQuestion) return Object.freeze({ level: "none", reason: d.reason });
  return Object.freeze({ level: isClearQuestion(line, d.reason) ? "strong" : "weak", reason: d.reason });
}
