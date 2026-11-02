// Fast back-to-back questions can arrive as ONE Deepgram final with no punctuation:
//   "יש לכם גיבוי כמה זה עולה האתר איטי מה עושים"
// Cut it into separate questions, but only where a new question clearly starts, so a normal single question is never chopped.
import { splitMulti } from "./split.ts";
import { bankStarts, matchBank, type BankCard } from "./bank.ts";
import { detect } from "./detector.ts";
import { tokens, tokenVariants, normalize } from "./normalize.ts";

// Words that open a new question. Matched prefix-aware ("ומה", "וכמה", "ויש").
const OPENERS = new Set(["כמה", "מתי", "איך", "למה", "מה", "האם", "איפה", "אפשר", "יש", "מי", "how", "what", "when", "why", "can", "do", "does", "is"].map(normalize));
const opens = (w: string) => { const t = tokens(w)[0]; if (!t) return false; const v = [...tokenVariants(t), ...(t.length >= 3 && t[0] === "ו" ? [t.slice(1)] : [])]; return v.some((x) => OPENERS.has(x)); };
// "ומה עם התחזוקה, כמה זה יוצא" is one question: "what about X" only introduces the topic.
// (\b does not work next to Hebrew letters, hence the lookahead.)
const TOPIC_INTRO = /(^|[.?!,]\s*)(ו?מה|what)\s+(עם|אם|לגבי|about)(?=\s|$)/i;

export function splitMergedQuestions(text: string, bank: BankCard[]): string[] {
  const words = text.trim().split(/\s+/);
  if (words.length < 6) return [text];
  const pureQ = (s: string) => detect(s).isQuestion && !TOPIC_INTRO.test(s.trim());
  const starts = bankStarts(text, bank).map((b) => b.at)
    // the cut must open a new question: a question word, or right after a sentence end
    .flatMap((i) => {
      for (let j = i; j >= Math.max(0, i - 2); j--) { if (opens(words[j]) || /[.?!]$/.test(words[j - 1] ?? "")) return [j]; }
      // "…כמה זה עולה האתר איתי מה עושים": a topic that starts mid-sentence and carries its own question word ("מה עושים") starts a new question
      return i >= 3 && words.slice(i + 1).some(opens) ? [i] : [];
    });
  const parts = splitMulti(text, starts, pureQ, 3, (p) => !!matchBank(p, bank));
  if (parts.length < 2) return [text];
  // Every piece must be a question on its own AND carry its own, different topic.
  const ids = parts.map((p) => matchBank(p, bank)?.card.id);
  if (!parts.every(pureQ) || ids.some((x) => !x) || new Set(ids).size !== ids.length) return [text];
  return parts;
}
