// S10: a client question split by a pause arrives as two utterances ("כמה זה" ... "עולה לבנות חנות?").
// The previous client utterance is glued to the new one when it was short, not a question, had no end mark,
// and ended within stt.joinWindowMs.

export type PrevUtterance = { text: string; at: number; question: boolean };

export function joinSplit(prev: PrevUtterance | undefined, text: string, now: number, windowMs: number, maxPrevWords = 12): string {
  if (!prev || windowMs <= 0 || prev.question) return text;
  if (now - prev.at > windowMs) return text;
  const p = prev.text.trim();
  if (!p || /[.?!:;…]$/.test(p)) return text;
  if (p.split(/\s+/).length > maxPrevWords) return text;
  return `${p} ${text}`;
}
