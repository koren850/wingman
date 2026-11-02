// Hebrew-aware question detector (STRUCTURE.md §4.1 step 2).
// Cheap first filter only: ambiguous lines go to Haiku, which can answer SKIP.
import { tokens, tokenVariants, containsPhrase, normalize } from "./normalize.ts";

export const MIN_WORDS = 2;

const HEAD_WORDS = [
  "כמה", "יש", "אפשר", "מתי", "האם", "איך", "למה", "מה", "מי", "איפה", "לאן", "מאיפה", "כמה זמן",
  "מדוע", "איזה", "איזו", "אילו", "נכון", "בטוח", "יכול", "יכולה", "יכולים", "צריך", "צריכה", "צריכים",
  "what", "how", "why", "when", "can", "is", "does", "do", "should", "where", "which",
];
// Head words are matched after normalize() (final letters folded), so normalize the list once.
const HEAD_NORM = HEAD_WORDS.filter((h) => !h.includes(" ")).map(normalize);
const MULTI = ["מה עושים", "מה אפשר לעשות", "מה עושים עם", "מה הסיבה", "איך עושים", "זה כולל", "מה זה", "מה ההבדל", "תוכל", "תוכלי", "תוכלו", "אתה יכול", "את יכולה", "אתם יכולים"];
const REQUEST = [
  "תסביר", "תסבירי", "תסבירו", "תגיד", "תגידי", "תגידו", "תבדוק", "תבדקי", "תבדקו", "תעזור", "תעזרי",
  "תראה לי", "תראי לי", "אני רוצה להבין", "רציתי לשאול", "רציתי להבין", "שאלה", "אשמח לדעת", "תעדכן",
  "זה אפשרי", "אפשרי", "אתם עובדים עם",
  "אני רוצה לדעת", "אני צריך לדעת", "אני צריכה לדעת", "תשלח לי", "תשלחי לי", "שלח לי", "שלחי לי", "תכין לי", "תכיני לי",
  "אתם עושים", "אתם מטפלים", "אתם מציעים", "אתם נותנים", "אתם מספקים", "אתם בונים",
  "אשמח לקבל", "אשמח שתשלחו", "אשמח שתשלח", "אשמח שתבדקו", "אשמח שתבדוק",
  "i have a question", "quick question", "i want to know", "i would like to know", "i need to know", "send me", "give me a quote",
  "explain", "tell me", "check",
];
// Statement openers that look like questions ("I don't know why...", "I already asked...").
const NEGATIVE = ["מה שלומך", "מה נשמע", "מה קורה", "מה המצב", "אני לא בטוח", "אני לא בטוחה", "אני לא יודע", "אני לא יודעת", "לא יודע למה", "שאלתי", "כבר שאלתי", "אמרתי", "הסברתי"];
const FILLERS = new Set(["כן", "אוקיי", "אוקי", "אוקיי", "רגע", "אהה", "אה", "טוב", "בסדר", "נכון", "יופי", "סבבה", "מעולה", "ok", "okay", "yes", "yeah", "mm", "אממ", "הממ"].map(normalize));   // normalized: final letters are folded (כן -> כנ), so raw forms never matched

export type Detection = { isQuestion: boolean; reason: string };
/** Optional bank context: a stall-* hit rescues short cue-less utterances; a strong multi-word hit rescues a problem statement. */
export type DetectCtx = { bankScore?: number; stall?: boolean };

export function detect(text: string, ctx: DetectCtx = {}): Detection {
  const raw = text.trim();
  const t = tokens(raw);
  // A "?" counts, except on nothing or on filler alone ("?", "כן?", "נכון?" are confirmations, not questions). One real word
  // with "?" ("מחיר?") is still a question.
  if (raw.includes("?")) {
    if (!t.some((w) => !FILLERS.has(w))) return { isQuestion: false, reason: t.length ? "filler" : "too-short" };
    return { isQuestion: true, reason: "question-mark" };
  }
  if (t.length < MIN_WORDS) return { isQuestion: false, reason: "too-short" };
  if (t.every((w) => FILLERS.has(w))) return { isQuestion: false, reason: "filler" };
  // Request and multi-word cues first: "אני לא יודע, האתר איטי מה אפשר לעשות" is a question.
  for (const r of REQUEST) if (containsPhrase(raw, r)) return { isQuestion: true, reason: `request:${r}` };
  for (const m of MULTI) if (containsPhrase(raw, m)) return { isQuestion: true, reason: `multi:${m}` };
  // Statement openers apply to short utterances, or when the phrase opens the utterance.
  const first3 = t.slice(0, 3).join(" ");
  for (const n of NEGATIVE) {
    if (containsPhrase(first3, n) || (t.length <= 5 && containsPhrase(raw, n))) return { isQuestion: false, reason: `negative:${n}` };
  }
  // Head word in the first three tokens (Hebrew questions usually lead with it).
  // "ויש לכם…", "ומה עם…": a glued vav before a short head word (tokenVariants keeps short remainders whole).
  const NEED = new Set(["צריך", "צריכה", "צריכים"].map(normalize));
  for (let i = 0; i < Math.min(3, t.length); i++) {
    const w = t[i];
    const variants = [...tokenVariants(w), ...(w.length >= 3 && w[0] === "ו" ? [w.slice(1)] : [])];
    const h = HEAD_NORM.find((x) => variants.includes(x));
    if (!h) continue;
    // Statements that open like a question: "יש לנו/לי אתר..." (we/I have), "אני/אנחנו צריך לענות..." (I need to...).
    if (h === normalize("יש") && ["לנו", "לי"].includes(t[i + 1] ?? "")) continue;
    if (h === normalize("כמה") && ["שאלות", "שאלה"].includes(t[i + 1] ?? "")) continue;   // "כמה שאלות יש לי" = "a few questions", an opener
    if (NEED.has(h) && ["אני", "אנחנו"].includes(t[i - 1] ?? "")) continue;
    return { isQuestion: true, reason: `head:${h}` };
  }
  if (ctx.stall && t.length < 8) return { isQuestion: true, reason: "stall-bank" };
  // D6: a problem statement ("האתר שלי קורס כל פעם") with a strong bank hit. Bank card only, never an AI answer.
  if (t.length >= 3 && (ctx.bankScore ?? 0) >= 2) return { isQuestion: true, reason: "problem:bank" };
  return { isQuestion: false, reason: "no-cue" };
}
