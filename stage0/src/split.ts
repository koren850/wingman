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
  // Deepgram punctuates each final on its own, so a short head fragment can end in "?" ("כמה זה?" … "עולה לחודש?").
  if (!p || (/[.!:;…]$/.test(p)) || (/\?$/.test(p) && p.split(/\s+/).length > 2)) return text;   // "כמה זה?" yes; "כמה זה עולה?" is a whole question
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

/**
 * Fast back-to-back questions can arrive as ONE final ("יש לכם גיבוי כמה זה עולה האתר איטי מה עושים").
 * `starts` = raw word index where each distinct bank card's trigger begins. Cut there, so each question gets its own card.
 * Kept only when at least two pieces are questions on their own (`isQ`); else the utterance stays whole.
 */
export function splitMulti(text: string, starts: number[], isQ: (s: string) => boolean, minWords = 2, hasTopic: (s: string) => boolean = () => true): string[] {
  const words = text.trim().split(/\s+/);
  const cuts = [...new Set(starts.filter((i) => i >= minWords && words.length - i >= minWords))].sort((a, b) => a - b);
  if (!cuts.length) return [text];
  const parts: string[] = [];
  let from = 0;
  for (const c of cuts) { if (c - from >= minWords) { parts.push(words.slice(from, c).join(" ")); from = c; } }
  parts.push(words.slice(from).join(" "));
  // A piece with no bank topic of its own is half a sentence ("The site is really" | "slow lately…"): glue it to the next one.
  for (let i = parts.length - 2; i >= 0; i--) if (!hasTopic(parts[i])) { parts[i + 1] = parts[i] + " " + parts[i + 1]; parts.splice(i, 1); }
  // A piece that is not a question joins the one before it ("האתר איטי, כמה זה יעלה" stays one question).
  const merged: string[] = [];
  for (const p of parts) { if (merged.length && !isQ(p)) merged[merged.length - 1] += " " + p; else merged.push(p); }
  if (merged.length > 1 && !isQ(merged[0])) { merged[1] = merged[0] + " " + merged[1]; merged.shift(); }
  return merged.filter(isQ).length >= 2 ? merged : [text];
}
