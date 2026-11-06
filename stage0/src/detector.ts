// Hebrew-aware question detector: decides if a finished utterance from the other side is a question worth answering.
// Cheap first filter only: ambiguous lines go to the model, which can answer SKIP. Called by run.ts with the bank score as context.
// Order matters: "?" and arithmetic first, then request/multi-word cues, then statement guards (negative, interjection),
// then head words, then context rescues (stall bank hit, strong bank match). The `reason` string is for logs and tests.
import { tokens, tokenVariants, containsPhrase, normalize } from "./normalize.ts";
import { nameRegex, nameWords } from "./profile.ts";
import { evalMath } from "./calc.ts";

/** Fewer tokens than this is never a question unless it carries a "?" ("מחיר?"). */
export const MIN_WORDS = 2;

const HEAD_WORDS = [
  "כמה",
  "יש",
  "אפשר",
  "מתי",
  "האם",
  "איך",
  "למה",
  "מה",
  "מי",
  "איפה",
  "לאן",
  "מאיפה",
  "כמה זמן",
  "מדוע",
  "איזה",
  "איזו",
  "אילו",
  "יכול",
  "יכולה",
  "יכולים",
  "צריך",
  "צריכה",
  "צריכים",
]; // English heads live in enQuestion() below: they only count at the start of a sentence ("That is a good idea" is a statement).
// Head words are matched after normalize() (final letters folded), so normalize the list once.
const HEAD_NORM = HEAD_WORDS.filter((h) => !h.includes(" ")).map(normalize);
const MULTI = [
  // asking for the listener's view or experience: "אתה חושב שזה קשור לגרסה של PHP", "מה דעתך", "אתה ממליץ"
  "אפשר לדעת",
  "אתה חושב",
  "את חושבת",
  "אתם חושבים",
  "אתה ממליץ",
  "את ממליצה",
  "אתם ממליצים",
  "מה דעתך",
  "מה דעתכם",
  "לדעתך",
  "לדעתכם",
  "אתה מכיר",
  "אתם מכירים",
  "יש לך ניסיון",
  "יש לכם ניסיון",
  // open prompts ("describe..."): "תאר לי", "תן לי דוגמה", "ספר על"
  "תאר",
  "תתאר",
  "תתארי",
  "תתארו",
  "תן לי דוגמה",
  "תני לי דוגמה",
  "תן דוגמה",
  "תדבר על",
  "תדברי על",
  "מה עושים",
  "מה אפשר לעשות",
  "מה עושים עם",
  "מה הסיבה",
  "איך עושים",
  "זה כולל",
  "מה זה",
  "אולי כדאי",
  "אולי עדיף",
  "מה ההבדל",
  "תוכל",
  "תוכלי",
  "תוכלו",
  "אתה יכול",
  "את יכולה",
  "אתם יכולים",
];
const REQUEST = [
  "תסביר",
  "תסבירי",
  "תסבירו",
  "תגיד",
  "תגידי",
  "תגידו",
  "תבדוק",
  "תבדקי",
  "תבדקו",
  "תעזור",
  "תעזרי",
  "תראה לי",
  "תראי לי",
  "אני רוצה להבין",
  "רציתי לשאול",
  "רציתי להבין",
  "שאלה",
  "אשמח לדעת",
  "תעדכן",
  "זה אפשרי",
  "אפשרי",
  "אתם עובדים עם",
  "אני רוצה לדעת",
  "אני צריך לדעת",
  "אני צריכה לדעת",
  "תשלח לי",
  "תשלחי לי",
  "שלח לי",
  "שלחי לי",
  "תכין לי",
  "תכיני לי",
  "ספר לי",
  "ספרי לי",
  "תספר לי",
  "תספרי לי",
  "אתם עושים",
  "אתם מטפלים",
  "אתם מציעים",
  "אתם נותנים",
  "אתם מספקים",
  "אתם בונים",
  "אשמח לקבל",
  "אשמח שתשלחו",
  "אשמח שתשלח",
  "אשמח שתבדקו",
  "אשמח שתבדוק",
  "תבטיח",
  "תבטיחו",
  "אתה מבטיח",
  "את מבטיחה",
  "אתם מבטיחים",
  "אתה יכול להבטיח",
  "אתם יכולים להבטיח",
  "תתחייב",
  "תתחייבו",
  "אתה מתחייב",
  "אתם מתחייבים",
  "אחריות כתובה",
  "אחריות בכתב",
  "תציע לי",
  "אני מבקש",
  "אני מבקשת",
  "i have a question",
  "quick question",
  "i want to know",
  "i would like to know",
  "i need to know",
  "send me",
  "give me a quote",
  "explain",
  "tell me",
  "check",
];
// Statement openers that look like questions ("I don't know why...", "I already asked...").
const NEGATIVE = [
  "מה שלומך",
  "מה נשמע",
  "מה קורה",
  "מה המצב",
  "אני לא בטוח",
  "אני לא בטוחה",
  "אני לא יודע",
  "אני לא יודעת",
  "לא יודע למה",
  "שאלתי",
  "כבר שאלתי",
  "אמרתי",
  "הסברתי",
];
const FILLERS = new Set(
  [
    "כן",
    "אוקיי",
    "אוקי",
    "אוקיי",
    "רגע",
    "אהה",
    "אה",
    "טוב",
    "בסדר",
    "נכון",
    "יופי",
    "סבבה",
    "מעולה",
    "ok",
    "okay",
    "yes",
    "yeah",
    "mm",
    "אממ",
    "הממ",
    "כאילו",
    "נו",
    "אמממ",
    "הממממ",
    "אהה",
    "אההה",
  ].map(normalize),
);
/** Elongated thinking sounds ("אממממ", "אההה", "הממ") are fillers whatever their length. */
const isFiller = (w: string) => FILLERS.has(w) || /^(אמ+|אה+|המ+|מממ*|הא+)$/.test(w);
/** "תן לי רגע" / "שנייה": asking for time, not a question. */
const TIME_ASK = /תן\s+לי\s+(רגע|שנייה|שניה|דקה)|תנו\s+לי\s+(רגע|שנייה|שניה|דקה)/g;
/** "Send me an email / שלח לי מייל": an action for later, not a question. A quote, price, details or info IS a request. */
const SEND_PHRASES = ["תשלח לי", "תשלחי לי", "שלח לי", "שלחי לי", "send me"];
const SEND_THINGS = ["מייל", "אימייל", "מסרון", "הודעה", "וואטסאפ", "ווטסאפ", "קישור", "לינק", "קובץ", "הזמנה", "תזכורת"].map(normalize);
const SEND_THINGS_EN = ["email", "e-mail", "mail", "message", "text", "link", "invite", "reminder", "whatsapp"];
/** `after` = normalized text following a send phrase. True when the first thing asked for is a message-like object (not a quote or info). */
const sendAction = (after: string): boolean => {
  const w = tokens(after.replace(/^לי\s/, "")).filter((x) => !["a", "an", "the", "לי"].includes(x));
  return !!w.length && (SEND_THINGS.includes(w[0]) || SEND_THINGS_EN.includes(w[0]));
};
/** A statement of wishes or background ("ורוצים לחדש את האתר", "אנחנו חברת לוגיסטיקה"): never a question, whatever the bank says. */
const INTENT_WORDS = ["רוצים", "רוצה", "רוצות", "נרצה", "אנחנו חברת", "אנחנו עסק", "אנחנו סטודיו"].map(normalize);
const INTENT_PREFIX = /^(מעוניינ|מתכננ|שוקלי)/;
/** True if the text states what someone wants or is (one-letter prefix tolerated: "ורוצים"). Two-word intents like "אנחנו חברת" match as a pair. */
const intentStatement = (raw: string): boolean => {
  const t = tokens(raw);
  return t.some(
    (w, i) =>
      [w, w.slice(1)].some((x) => INTENT_WORDS.includes(x) || INTENT_PREFIX.test(x)) ||
      INTENT_WORDS.some((p) => p.includes(" ") && t.slice(i, i + 2).join(" ") === p),
  );
};

// Exclamation openers: "וואו, איזה מזג אוויר" is not a question (unless it has a "?").
const INTERJECTIONS = new Set(["וואו", "ואו", "וואי", "יואו", "יוו", "אחלה", "כיף", "וואלה"].map(normalize));
// Confirmation words that make a question only at the edges: "נכון שאתם…", "בטוח שזה עובד", "…זה בטוח", "…זה נכון".
const CONFIRM = new Set(["נכון", "בטוח"].map(normalize));

// ---- English (and French-accented English, and Hebrew with English mixed in) ----
const EN_WH = new Set(["what", "how", "why", "when", "where", "who", "whom", "whose", "which"]);
const EN_AUX = new Set([
  "is",
  "are",
  "am",
  "was",
  "were",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "can",
  "could",
  "will",
  "would",
  "shall",
  "should",
  "may",
  "might",
  "must",
  "isn't",
  "aren't",
  "wasn't",
  "weren't",
  "don't",
  "doesn't",
  "didn't",
  "haven't",
  "hasn't",
  "can't",
  "couldn't",
  "won't",
  "wouldn't",
  "shouldn't",
]);
const EN_OPENERS = new Set([
  "and",
  "so",
  "but",
  "okay",
  "ok",
  "well",
  "yes",
  "yeah",
  "then",
  "also",
  "um",
  "uh",
  "hmm",
  "like",
  "now",
  "alright",
  "sorry",
  "actually",
  "just",
  "maybe",
  "perhaps",
  "right",
  "oh",
  "hi",
  "hello",
]);
const EN_PRON = new Set(["i", "we", "you", "they", "he", "she", "it"]);
/** Phrases that make an English utterance a question wherever they appear (indirect questions and polite requests). */
const EN_PHRASES = [
  "i was wondering",
  "i am wondering",
  "i'm wondering",
  "i wonder",
  "would like to know",
  "'d like to know",
  "like to understand",
  "want to understand",
  "wanna understand",
  "want to know",
  "wanna know",
  "need to understand",
  "need to know",
  "let me ask",
  "can i ask",
  "could i ask",
  "may i ask",
  "quick question",
  "a question",
  "any idea",
  "any chance",
  "do you know",
  "walk me through",
  "tell me",
  "explain",
  "what about",
  "how about",
  "what if",
  "is it possible",
  "would it be possible",
  "could it be possible",
  "is there",
  "are there",
  "do you think",
  "can you",
  "could you",
  "would you",
  "will you",
  "can we",
  "could we",
  "should we",
  "shall we",
  "is it ok",
  "is it okay",
  "is that ok",
  "is that okay",
  "i'm not sure whether",
  "not sure if",
  "curious",
  "clarify",
  "confirm that",
  "make sure that",
];
/** Tag questions without a "?": "We keep the same URLs, right". */
const EN_TAG =
  /,\s*(right|correct|no|yes|yeah|okay|ok|isn't it|aren't they|don't you|doesn't it|won't it|wouldn't it|can you|will you|is that right|is that correct|am I right)\s*$/i;
/** French-accented English as speech-to-text often writes it ("ze", "zis", "wat"): fold to plain English before matching. */
const FR_ACCENT: [RegExp, string][] = [
  [/\bze\b/g, "the"],
  [/\bzis\b/g, "this"],
  [/\bzat\b/g, "that"],
  [/\bzese\b/g, "these"],
  [/\bzose\b/g, "those"],
  [/\bzey\b/g, "they"],
  [/\bzem\b/g, "them"],
  [/\bzere\b/g, "there"],
  [/\bzen\b/g, "then"],
  [/\bwat\b/g, "what"],
  [/\beez\b/g, "is"],
  [/\beet\b/g, "it"],
  [/\bwiz\b/g, "with"],
  [/\bwich\b/g, "which"],
  [/\bzer\b/g, "their"],
];
/** English question detection on the Latin part of an utterance. Returns the rule name, or "" when it is not a question. */
export function enQuestion(raw: string): string {
  if (!/[a-z]{2}/i.test(raw)) return "";
  let s = raw.toLowerCase().replace(/[’`]/g, "'");
  for (const [re, to] of FR_ACCENT) s = s.replace(re, to);
  const flat = " " + s.replace(/[^a-z0-9'\u0590-\u05ff\s]/g, " ").replace(/\s+/g, " ") + " ";
  for (const p of EN_PHRASES) {
    if (!flat.includes(p.startsWith("'") ? p : " " + p)) continue;
    // Statements that carry the phrase: "I will explain later", "I'm curious but..." are rare; the model can SKIP the rest.
    return `en-phrase:${p.trim()}`;
  }
  if (EN_TAG.test(s.trim())) return "en-tag";
  for (const sentence of s.split(/[.!;?]+/)) {
    for (const clause of sentence.split(/,/)) {
      let w = clause
        .replace(/[^a-z0-9'\s]/g, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (!w.length) continue;
      // "hello <name>, ..." opens like a greeting. A name that is also a question word or auxiliary ("Will", "May", "Can") is stripped only right after
      // a greeting: at the start of the clause "Will you send it" is still a question.
      let afterOpener = false;
      while (w.length > 3) {
        if (EN_OPENERS.has(w[0])) {
          w = w.slice(1);
          afterOpener = true;
          continue;
        }
        if (nameWords().has(w[0]) && (afterOpener || !(EN_AUX.has(w[0]) || EN_WH.has(w[0].replace(/'s$|'re$|'ll$|'d$/, ""))))) {
          w = w.slice(1);
          afterOpener = false;
          continue;
        }
        break;
      }
      const [a, b, c] = w;
      if (w.length < 3 && !(w.length === 2 && EN_WH.has(a))) continue;
      const base = a.replace(/'s$|'re$|'ll$|'d$/, "");
      if (EN_WH.has(base)) {
        // "what I mean is...", "when we start" are relative clauses; "how/why we" still ask.
        if (["what", "who", "whom", "which", "when", "where"].includes(base) && EN_PRON.has(b ?? "") && !["do", "does"].includes(b ?? "")) continue;
        if (base === "what" && ["i", "we"].includes(b ?? "")) continue;
        return `en-wh:${base}`;
      }
      if (EN_AUX.has(a)) {
        if (["not", "n't"].includes(b ?? "")) continue;
        if (/^(have|has|had)$/.test(a) && b === "a" && ["nice", "great", "good", "lovely", "look", "chat", "moment", "second", "minute"].includes(c ?? ""))
          continue; // "have a nice day"
        if (
          a === "do" &&
          b &&
          !EN_PRON.has(b) &&
          !["the", "this", "that", "these", "those", "any", "all", "we", "there", "my", "our", "your", "their", "a", "an"].includes(b) &&
          !/^[a-z]+s$/.test(b)
        )
          continue; // imperative: "do whatever you want"
        return `en-aux:${a}`;
      }
    }
  }
  return "";
}

export type Detection = { isQuestion: boolean; reason: string };
/** Optional bank context: a stall-* hit rescues short cue-less utterances; a strong multi-word hit rescues a problem statement. */
export type DetectCtx = { bankScore?: number; stall?: boolean };

/**
 * Is this utterance a question? Pure and synchronous (no network). `reason` names the rule that fired, e.g. "head:מה", "question-mark",
 * "math". Hebrew is matched on normalize()d tokens, so the word lists above are normalized once at load (final letters folded).
 */
const DANGLING = /(?:^|\s)(עם|של|על|את|או|כמו|לגבי|בין|with|about|of|to|for|the|a|an|and|or|like|between)\s*$/iu;
/** "what are you looking for", "who did you work with", "who is this for": a wh-question that ends in a stranded preposition is complete.
 *  "do you have experience with" (no wh-word) and "what is the price of" (no pronoun subject) are still cut off. */
function strandedPreposition(raw: string): boolean {
  const w = raw.toLowerCase().replace(/[.,!]/g, "").split(/\s+/).filter(Boolean);
  return (
    w.length >= 4 &&
    /^(what|who|whom|which|where|whose)$/.test(w[0]) &&
    /^(with|about|for)$/.test(w[w.length - 1]) &&
    w.slice(1, -1).some((x) => /^(you|we|they|i|he|she|it|this|that)$/.test(x))
  );
}
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
  // Cut off mid-phrase ("יש לך ניסיון עם", "do you have experience with"): speech-to-text split it or lost the last word. Wait for
  // the rest (the next line), never guess an answer to half a question (seen in a mock call: it got the "about you" card).
  if (DANGLING.test(raw) && !strandedPreposition(raw)) return { isQuestion: false, reason: "unfinished" };
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
    if ((n === "מה קורה" || n === "מה המצב") && containsPhrase(raw, `${n} עם`)) continue; // "מה קורה עם הכתובות הישנות" asks about something; "מה קורה?" is a greeting
    if (containsPhrase(first3, n) || (t.length <= 5 && containsPhrase(raw, n))) return { isQuestion: false, reason: `negative:${n}` };
  }
  // "ואם משהו נשבר אפשר לשחזר": an if-clause that asks (STT often drops the "?")
  if (
    (t[0] === normalize("אם") || t[0] === normalize("ואם")) &&
    t.length >= 4 &&
    t.slice(1).some((w) => ["אפשר", "מה", "איך", "מי", "האם", "יש", "תעשו", "עושים"].map(normalize).includes(w))
  )
    return { isQuestion: true, reason: "if-open" };
  // "הבאת לה כבר מתנה": a past-tense "already" check on the listener
  if (/(^|\s)\S+ת\s+(לו\s|לה\s|לי\s|להם\s)?כבר(\s|$)/.test(normalize(raw)) && t.length >= 4) return { isQuestion: true, reason: "already-past" };
  const en = enQuestion(raw);
  if (en) return { isQuestion: true, reason: en };
  if (INTERJECTIONS.has(t[0])) return { isQuestion: false, reason: "interjection" };
  if (CONFIRM.has(t[0]) && t.length >= 3) return { isQuestion: true, reason: "confirm-open" };
  if (CONFIRM.has(t[t.length - 1]) && t.length >= 3 && t[t.length - 2] !== "לא") return { isQuestion: true, reason: "confirm-tail" };
  // Head word in the first three tokens (Hebrew questions usually lead with it).
  // "ויש לכם…", "ומה עם…": a glued vav before a short head word (tokenVariants keeps short remainders whole).
  const NEED = new Set(["צריך", "צריכה", "צריכים"].map(normalize));
  for (let i = 0; i < Math.min(3, t.length); i++) {
    const w = t[i];
    if (w === normalize("כאילו") || isFiller(w)) continue; // "כאילו" is a filler, not כ + אילו ("which")
    const variants = [...tokenVariants(w), ...(w.length >= 3 && w[0] === "ו" ? [w.slice(1)] : [])];
    const h = HEAD_NORM.find((x) => variants.includes(x));
    if (!h) continue;
    // Statements that open like a question: "יש לנו/לי אתר..." (we/I have), "אני/אנחנו צריך לענות..." (I need to...).
    if (h === normalize("יש") && ["לנו", "לי"].includes(t[i + 1] ?? "")) continue;
    if (h === normalize("יש") && ["עוד", "בעיה"].includes(t[i + 1] ?? "")) continue; // "יש עוד בעיה": a statement
    if (h === normalize("כמה") && ["שאלות", "שאלה"].includes(t[i + 1] ?? "")) continue; // "כמה שאלות יש לי" = "a few questions", an opener
    if (NEED.has(h) && ["אני", "אנחנו"].includes(t[i - 1] ?? "")) continue;
    if (h === normalize("מה") && /^ש/.test(t[i + 1] ?? "")) continue; // "מה שאמרת", "לא מה שהוא": a relative clause, not "what?"
    return { isQuestion: true, reason: `head:${h}` };
  }
  // "האם" later in the utterance ("רציתי לדעת בקשר לטפסים האם הם יעברו"): STT often drops the "?" and the lead-in is longer than three words.
  if (t.slice(3).some((w) => w === normalize("האם") || w === normalize("והאם"))) return { isQuestion: true, reason: "head:האם-late" };
  // "טוב, נחזור לעברית, מה קורה עם הטפסים": "what about X" after a lead-in of any length (STT often drops the "?").
  for (const p of ["מה קורה עם", "מה המצב עם", "מה לגבי"])
    if (containsPhrase(raw, p) && !containsPhrase(raw, `לא יודע ${p}`)) return { isQuestion: true, reason: `about:${p}` };
  // A question that opens a later clause: "ואם משהו נשבר, אפשר לשחזר", "זה עובד ככה, למה?" (strong question words only).
  const CLAUSE_HEADS = new Set(["אפשר", "כמה", "מתי", "איך", "למה", "האם", "איפה"].map(normalize));
  for (const clause of raw.split(/[,،;]/).slice(1)) {
    const c = tokens(clause);
    if (c[0] === normalize("כמה") && ["שאלות", "שאלה"].includes(c[1] ?? "")) continue; // "היי דן, כמה שאלות מהירות"
    if (c[0] && [...tokenVariants(c[0]), ...(c[0].length >= 3 && c[0][0] === "ו" ? [c[0].slice(1)] : [])].some((v) => CLAUSE_HEADS.has(v)))
      return { isQuestion: true, reason: `clause-head:${c[0]}` };
  }
  if (ctx.stall && t.length < 8) return { isQuestion: true, reason: "stall-bank" };
  // A problem statement ("האתר שלי קורס כל פעם") with a strong bank hit counts as a question, but a statement of wishes never does.
  // The bank card is shown; no AI answer is made from this.
  if (t.length >= 3 && (ctx.bankScore ?? 0) >= 2 && intentStatement(raw)) return { isQuestion: false, reason: "intent-statement" };
  if (t.length >= 3 && (ctx.bankScore ?? 0) >= 2) return { isQuestion: true, reason: "problem:bank" };
  return { isQuestion: false, reason: "no-cue" };
}

// "Important cards only" (cards.focus): is this detected line a clear question to the user? The weak cue "head" (a question word
// at the start; 124 of 225 detections in a real 70-minute call, mostly statements) counts only when the line speaks to the user.
const STRONG = /^(question-mark|request|stall-bank|confirm-tail|multi|math|clause-head|about)/; // clause-head / about: real questions whose "?" STT dropped
const TO_YOU = /(^|[\s,])(לכם|לך|אתם|אתה|תוכל|תוכלו|אפשר|you|your)(?![\p{L}])/iu;
/** Second person aimed at the user (Hebrew masculine/neutral forms, English you/your): "עבדת פעם עם", "ספר לי", "what's your". */
const YOU2 = /(^|[\s,.?!"'])(אתה|לך|שלך|אותך|עליך|ממך|איתך|ספר|תספר|תאר|תסביר|עבדת|היית|ניסית|יצא לך|you|your|yourself)(?![\p{L}])/iu;
export function addressesYou(text: string): boolean {
  return YOU2.test(text) || nameRegex().test(text);
}
/** A clear question for the user: a strong detector reason, a question head aimed at "you", or the user addressed by name (profile.ts nameRegex). */
export function isClearQuestion(text: string, reason: string): boolean {
  return STRONG.test(reason) || (/^head/.test(reason) && TO_YOU.test(text)) || nameRegex().test(text);
}
