// Hebrew-aware question detector (STRUCTURE.md §4.1 step 2).
// Cheap first filter only: ambiguous lines go to Haiku, which can answer SKIP.
import { tokens, tokenVariants, containsPhrase, normalize } from "./normalize.ts";
import { evalMath } from "./calc.ts";

export const MIN_WORDS = 2;

const HEAD_WORDS = [
  "כמה", "יש", "אפשר", "מתי", "האם", "איך", "למה", "מה", "מי", "איפה", "לאן", "מאיפה", "כמה זמן",
  "מדוע", "איזה", "איזו", "אילו", "יכול", "יכולה", "יכולים", "צריך", "צריכה", "צריכים",
  "what", "how", "why", "when", "can", "is", "does", "do", "should", "where", "which",
];
// Head words are matched after normalize() (final letters folded), so normalize the list once.
const HEAD_NORM = HEAD_WORDS.filter((h) => !h.includes(" ")).map(normalize);
const MULTI = ["מה עושים", "מה אפשר לעשות", "מה עושים עם", "מה הסיבה", "איך עושים", "זה כולל", "מה זה", "אולי כדאי", "אולי עדיף", "מה ההבדל", "תוכל", "תוכלי", "תוכלו", "אתה יכול", "את יכולה", "אתם יכולים"];
const REQUEST = [
  "תסביר", "תסבירי", "תסבירו", "תגיד", "תגידי", "תגידו", "תבדוק", "תבדקי", "תבדקו", "תעזור", "תעזרי",
  "תראה לי", "תראי לי", "אני רוצה להבין", "רציתי לשאול", "רציתי להבין", "שאלה", "אשמח לדעת", "תעדכן",
  "זה אפשרי", "אפשרי", "אתם עובדים עם",
  "אני רוצה לדעת", "אני צריך לדעת", "אני צריכה לדעת", "תשלח לי", "תשלחי לי", "שלח לי", "שלחי לי", "תכין לי", "תכיני לי",
  "ספר לי", "ספרי לי", "תספר לי", "תספרי לי", "אתם עושים", "אתם מטפלים", "אתם מציעים", "אתם נותנים", "אתם מספקים", "אתם בונים",
  "אשמח לקבל", "אשמח שתשלחו", "אשמח שתשלח", "אשמח שתבדקו", "אשמח שתבדוק",
  "תבטיח", "תבטיחו", "אתה מבטיח", "את מבטיחה", "אתם מבטיחים", "אתה יכול להבטיח", "אתם יכולים להבטיח", "תתחייב", "תתחייבו", "אתה מתחייב", "אתם מתחייבים",
  "אחריות כתובה", "אחריות בכתב", "תציע לי", "אני מבקש", "אני מבקשת",
  "i have a question", "quick question", "i want to know", "i would like to know", "i need to know", "send me", "give me a quote",
  "explain", "tell me", "check",
];
// Statement openers that look like questions ("I don't know why...", "I already asked...").
const NEGATIVE = ["מה שלומך", "מה נשמע", "מה קורה", "מה המצב", "אני לא בטוח", "אני לא בטוחה", "אני לא יודע", "אני לא יודעת", "לא יודע למה", "שאלתי", "כבר שאלתי", "אמרתי", "הסברתי"];
const FILLERS = new Set(["כן", "אוקיי", "אוקי", "אוקיי", "רגע", "אהה", "אה", "טוב", "בסדר", "נכון", "יופי", "סבבה", "מעולה", "ok", "okay", "yes", "yeah", "mm", "אממ", "הממ", "כאילו", "נו", "אמממ", "הממממ", "אהה", "אההה"].map(normalize));
/** Elongated thinking sounds ("אממממ", "אההה", "הממ") are fillers whatever their length. */
const isFiller = (w: string) => FILLERS.has(w) || /^(אמ+|אה+|המ+|מממ*|הא+)$/.test(w);
/** "תן לי רגע" / "שנייה": asking for time, not a question. */
const TIME_ASK = /תן\s+לי\s+(רגע|שנייה|שניה|דקה)|תנו\s+לי\s+(רגע|שנייה|שניה|דקה)/g;
/** "Send me an email / שלח לי מייל": an action for later, not a question. A quote, price, details or info IS a request. */
const SEND_PHRASES = ["תשלח לי", "תשלחי לי", "שלח לי", "שלחי לי", "send me"];
const SEND_THINGS = ["מייל", "אימייל", "מסרון", "הודעה", "וואטסאפ", "ווטסאפ", "קישור", "לינק", "קובץ", "הזמנה", "תזכורת"].map(normalize);
const SEND_THINGS_EN = ["email", "e-mail", "mail", "message", "text", "link", "invite", "reminder", "whatsapp"];
const sendAction = (after: string): boolean => {
  const w = tokens(after.replace(/^לי\s/, "")).filter((x) => !["a", "an", "the", "לי"].includes(x));
  return !!w.length && (SEND_THINGS.includes(w[0]) || SEND_THINGS_EN.includes(w[0]));
};
/** A statement of wishes or background ("ורוצים לחדש את האתר", "אנחנו חברת לוגיסטיקה"): never a question, whatever the bank says. */
const INTENT_WORDS = ["רוצים", "רוצה", "רוצות", "נרצה", "אנחנו חברת", "אנחנו עסק", "אנחנו סטודיו"].map(normalize);
const INTENT_PREFIX = /^(מעוניינ|מתכננ|שוקלי)/;
const intentStatement = (raw: string): boolean => {
  const t = tokens(raw);
  return t.some((w, i) => [w, w.slice(1)].some((x) => INTENT_WORDS.includes(x) || INTENT_PREFIX.test(x)) || INTENT_WORDS.some((p) => p.includes(" ") && t.slice(i, i + 2).join(" ") === p));
};

// Exclamation openers: "וואו, איזה מזג אוויר" is not a question (unless it has a "?").
const INTERJECTIONS = new Set(["וואו", "ואו", "וואי", "יואו", "יוו", "אחלה", "כיף", "וואלה"].map(normalize));
// Confirmation words that make a question only at the edges: "נכון שאתם…", "בטוח שזה עובד", "…זה בטוח", "…זה נכון".
const CONFIRM = new Set(["נכון", "בטוח"].map(normalize));

export type Detection = { isQuestion: boolean; reason: string };
/** Optional bank context: a stall-* hit rescues short cue-less utterances; a strong multi-word hit rescues a problem statement. */
export type DetectCtx = { bankScore?: number; stall?: boolean };

export function detect(text: string, ctx: DetectCtx = {}): Detection {
  const raw = text.trim();
  const t = tokens(raw);
  // A "?" counts, except on nothing or on filler alone ("?", "כן?", "נכון?" are confirmations, not questions). One real word
  // with "?" ("מחיר?") is still a question.
  if (raw.includes("?")) {
    if (!t.some((w) => !isFiller(w))) return { isQuestion: false, reason: t.length ? "filler" : "too-short" };
    return { isQuestion: true, reason: "question-mark" };
  }
  if (t.length < MIN_WORDS) return { isQuestion: false, reason: "too-short" };
  if (t.every(isFiller)) return { isQuestion: false, reason: "filler" };
  // Fillers plus "give me a second": "אממ, רגע, כאילו, תן לי רגע" says nothing.
  if (tokens(raw.replace(TIME_ASK, " ")).every(isFiller)) return { isQuestion: false, reason: "filler" };
  // Bare arithmetic is a question for the calculator, with or without "?" or "כמה": "15 אחוז מ 2400", "3 כפול 450".
  if (evalMath(raw)) return { isQuestion: true, reason: "math" };
  // Request and multi-word cues first: "אני לא יודע, האתר איטי מה אפשר לעשות" is a question.
  for (const sp of SEND_PHRASES) {
    if (!containsPhrase(raw, sp)) continue;
    const after = normalize(raw).split(normalize(sp))[1]?.trim() ?? "";
    if (sendAction(after)) return { isQuestion: false, reason: "send-action" };
  }
  for (const r of REQUEST) if (containsPhrase(raw, r)) return { isQuestion: true, reason: `request:${r}` };
  for (const m of MULTI) if (containsPhrase(raw, m)) return { isQuestion: true, reason: `multi:${m}` };
  // Statement openers apply to short utterances, or when the phrase opens the utterance.
  const first3 = t.slice(0, 3).join(" ");
  for (const n of NEGATIVE) {
    if (containsPhrase(first3, n) || (t.length <= 5 && containsPhrase(raw, n))) return { isQuestion: false, reason: `negative:${n}` };
  }
  // "ואם משהו נשבר אפשר לשחזר": an if-clause that asks (STT often drops the "?")
  if ((t[0] === normalize("אם") || t[0] === normalize("ואם")) && t.length >= 4 && t.slice(1).some((w) => ["אפשר", "מה", "איך", "מי", "האם", "יש", "תעשו", "עושים"].map(normalize).includes(w))) return { isQuestion: true, reason: "if-open" };
  // "הבאת לה כבר מתנה": a past-tense "already" check on the listener
  if (/(^|\s)\S+ת\s+(לו\s|לה\s|לי\s|להם\s)?כבר(\s|$)/.test(normalize(raw)) && t.length >= 4) return { isQuestion: true, reason: "already-past" };
  if (INTERJECTIONS.has(t[0])) return { isQuestion: false, reason: "interjection" };
  if (CONFIRM.has(t[0]) && t.length >= 3) return { isQuestion: true, reason: "confirm-open" };
  if (CONFIRM.has(t[t.length - 1]) && t.length >= 3 && t[t.length - 2] !== "לא") return { isQuestion: true, reason: "confirm-tail" };
  // Head word in the first three tokens (Hebrew questions usually lead with it).
  // "ויש לכם…", "ומה עם…": a glued vav before a short head word (tokenVariants keeps short remainders whole).
  const NEED = new Set(["צריך", "צריכה", "צריכים"].map(normalize));
  for (let i = 0; i < Math.min(3, t.length); i++) {
    const w = t[i];
    if (w === normalize("כאילו") || isFiller(w)) continue;   // "כאילו" is a filler, not כ + אילו ("which")
    const variants = [...tokenVariants(w), ...(w.length >= 3 && w[0] === "ו" ? [w.slice(1)] : [])];
    const h = HEAD_NORM.find((x) => variants.includes(x));
    if (!h) continue;
    // Statements that open like a question: "יש לנו/לי אתר..." (we/I have), "אני/אנחנו צריך לענות..." (I need to...).
    if (h === normalize("יש") && ["לנו", "לי"].includes(t[i + 1] ?? "")) continue;
    if (h === normalize("יש") && ["עוד", "בעיה"].includes(t[i + 1] ?? "")) continue;   // "יש עוד בעיה": a statement
    if (h === normalize("כמה") && ["שאלות", "שאלה"].includes(t[i + 1] ?? "")) continue;   // "כמה שאלות יש לי" = "a few questions", an opener
    if (NEED.has(h) && ["אני", "אנחנו"].includes(t[i - 1] ?? "")) continue;
    if (h === normalize("מה") && /^ש/.test(t[i + 1] ?? "")) continue;   // "מה שאמרת", "לא מה שהוא": a relative clause, not "what?"
    return { isQuestion: true, reason: `head:${h}` };
  }
  // A question that opens a later clause: "ואם משהו נשבר, אפשר לשחזר", "זה עובד ככה, למה?" (strong question words only).
  const CLAUSE_HEADS = new Set(["אפשר", "כמה", "מתי", "איך", "למה", "האם", "איפה"].map(normalize));
  for (const clause of raw.split(/[,،;]/).slice(1)) {
    const c = tokens(clause);
    if (c[0] === normalize("כמה") && ["שאלות", "שאלה"].includes(c[1] ?? "")) continue;   // "היי דן, כמה שאלות מהירות"
    if (c[0] && [...tokenVariants(c[0]), ...(c[0].length >= 3 && c[0][0] === "ו" ? [c[0].slice(1)] : [])].some((v) => CLAUSE_HEADS.has(v)))
      return { isQuestion: true, reason: `clause-head:${c[0]}` };
  }
  if (ctx.stall && t.length < 8) return { isQuestion: true, reason: "stall-bank" };
  // D6: a problem statement ("האתר שלי קורס כל פעם") with a strong bank hit. Bank card only, never an AI answer.
  if (t.length >= 3 && (ctx.bankScore ?? 0) >= 2 && intentStatement(raw)) return { isQuestion: false, reason: "intent-statement" };
  if (t.length >= 3 && (ctx.bankScore ?? 0) >= 2) return { isQuestion: true, reason: "problem:bank" };
  return { isQuestion: false, reason: "no-cue" };
}
