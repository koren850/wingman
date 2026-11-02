// S10: a client question split by a pause arrives as two utterances ("כמה זה" ... "עולה לבנות חנות?").
// The previous client utterance is glued to the new one when it was short, not a question, had no end mark,
// and ended within stt.joinWindowMs.

export type PrevUtterance = { text: string; at: number; question: boolean };

/** A fragment of up to this many words still glues even when it was itself detected as a question ("כמה זה" ... "עולה לחודש"). */
export const SHORT_HEAD_WORDS = 3;

export function joinSplit(prev: PrevUtterance | undefined, text: string, now: number, windowMs: number, maxPrevWords = 12): string {
  if (!prev || windowMs <= 0) return text;
  if (prev.question && prev.text.trim().split(/\s+/).length > SHORT_HEAD_WORDS) return text;
  if (!(now - prev.at <= windowMs)) return text;   // also false for NaN timestamps
  const p = prev.text.trim();
  if (!p || /[.?!:;…]$/.test(p)) return text;
  if (p.split(/\s+/).length > maxPrevWords) return text;
  return `${p} ${text}`;
}

/**
 * The tail of a split question can itself end in "?" ("עולה לחודש?", "יהיה מוכן?"): Deepgram punctuates each final on its own.
 * Such a short tail is a fragment, not a whole question, so the join is still tried (and kept only if the glued text is a question).
 */
export function isBareQuestionTail(text: string, reason: string, maxWords = 4): boolean {
  return reason === "question-mark" && text.trim().split(/\s+/).length <= maxWords;
}
