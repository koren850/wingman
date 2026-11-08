// Hebrew-aware question detector: decides if a finished utterance from the other side is a question worth answering.
// Cheap first filter only: ambiguous lines go to the model, which can answer SKIP. Called by run.ts with the bank score as context.
// Order matters: "?" and arithmetic first, then request/multi-word cues, then statement guards (negative, interjection),
// then head words, then context rescues (stall bank hit, strong bank match). The `reason` string is for logs and tests.
//
// The word lists (question heads, request cues, fillers, send phrases, intent words, interjections, English phrases) are in src/lang/he.ts and
// en.ts, with English glosses. Still inline here: the Hebrew-only rules in detect() (if-clause, "already", clause heads, "about" phrases),
// DANGLING and the "addressesYou" patterns. A new language needs its own file in src/lang/ and, for question rules, its own branch below.
import { tokens, tokenVariants, containsPhrase, normalize } from "./normalize.ts";
import { nameRegex, nameWords } from "./profile.ts";
import { evalMath } from "./calc.ts";
import { LANGUAGES, he, en, EN_SYNTAX } from "./lang/index.ts";
import { addressesYou, headAimedAtYou } from "./lang/address.ts";

export { addressesYou };

/** Fewer tokens than this is never a question unless it carries a "?" ("מחיר?"). */
export const MIN_WORDS = 2;

// The word lists live in src/lang/ (he.ts, en.ts). Hebrew is matched on normalize()d tokens (final letters folded), so the lists are normalized once at load.
// English heads live in enQuestion() below: they only count at the start of a sentence ("That is a good idea" is a statement).
const HEAD_NORM = he.questionHeads.filter((h) => !h.includes(" ")).map(normalize);
const MULTI = he.questionPhrases;
const REQUEST = LANGUAGES.flatMap((l) => l.requestCues);
// Statement openers that look like questions ("I don't know why...", "I already asked...").
const NEGATIVE = he.notQuestionOpeners;
const FILLERS = new Set(LANGUAGES.flatMap((l) => l.fillers).map(normalize));
/** Elongated thinking sounds ("אממממ", "אההה", "הממ") are fillers whatever their length. */
const isFiller = (w: string) => FILLERS.has(w) || LANGUAGES.some((l) => l.fillerPatterns.some((r) => r.test(w)));
/** "תן לי רגע" / "שנייה": asking for time, not a question. */
const TIME_ASKS = LANGUAGES.flatMap((l) => l.timeAskPatterns);
/** "Send me an email / שלח לי מייל": an action for later, not a question. A quote, price, details or info IS a request. */
const SEND_PHRASES = LANGUAGES.flatMap((l) => l.sendPhrases);
const SEND_THINGS = he.sendThings.map(normalize);
const SEND_THINGS_EN = en.sendThings;
const SEND_STOP = LANGUAGES.flatMap((l) => l.sendStopWords);
/** `after` = normalized text following a send phrase. True when the first thing asked for is a message-like object (not a quote or info). */
const sendAction = (after: string): boolean => {
  const w = tokens(after.replace(/^לי\s/, "")).filter((x) => !SEND_STOP.includes(x));
  return !!w.length && (SEND_THINGS.includes(w[0]) || SEND_THINGS_EN.includes(w[0]));
};
/** A statement of wishes or background ("ורוצים לחדש את האתר", "אנחנו חברת לוגיסטיקה"): never a question, whatever the bank says. */
const INTENT_WORDS = he.intentWords.map(normalize);
const INTENT_PREFIXES = LANGUAGES.flatMap((l) => l.intentPatterns);
/** True if the text states what someone wants or is (one-letter prefix tolerated: "ורוצים"). Two-word intents like "אנחנו חברת" match as a pair. */
const intentStatement = (raw: string): boolean => {
  const t = tokens(raw);
  return t.some(
    (w, i) =>
      [w, w.slice(1)].some((x) => INTENT_WORDS.includes(x) || INTENT_PREFIXES.some((p) => p.test(x))) ||
      INTENT_WORDS.some((p) => p.includes(" ") && t.slice(i, i + 2).join(" ") === p),
  );
};

// Exclamation openers: "וואו, איזה מזג אוויר" is not a question (unless it has a "?").
const INTERJECTIONS = new Set(he.interjections.map(normalize));
// Confirmation words that make a question only at the edges: "נכון שאתם…", "בטוח שזה עובד", "…זה בטוח", "…זה נכון".
const CONFIRM = new Set(he.confirmWords.map(normalize));

// ---- English (and French-accented English, and Hebrew with English mixed in) ----
const EN_WH = new Set(en.questionHeads);
const EN_AUX = EN_SYNTAX.auxiliaries;
const EN_OPENERS = EN_SYNTAX.openers;
const EN_PRON = EN_SYNTAX.pronouns;
/** Phrases that make an English utterance a question wherever they appear (indirect questions and polite requests). */
const EN_PHRASES = en.questionPhrases;
/** English question detection on the Latin part of an utterance. Returns the rule name, or "" when it is not a question. */
export function enQuestion(raw: string): string {
  if (!/[a-z]{2}/i.test(raw)) return "";
  let s = raw.toLowerCase().replace(/[’`]/g, "'");
  for (const [re, to] of EN_SYNTAX.accentFixes) s = s.replace(re, to);
  const flat = " " + s.replace(/[^a-z0-9'\u0590-\u05ff\s]/g, " ").replace(/\s+/g, " ") + " ";
  for (const p of EN_PHRASES) {
    if (!flat.includes(p.startsWith("'") ? p : " " + p)) continue;
    // Statements that carry the phrase: "I will explain later", "I'm curious but..." are rare; the model can SKIP the rest.
    return `en-phrase:${p.trim()}`;
  }
  if (EN_SYNTAX.tag.test(s.trim())) return "en-tag";
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
  if (tokens(TIME_ASKS.reduce((x, re) => x.replace(re, " "), raw)).every(isFiller)) return { isQuestion: false, reason: "filler" };
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
/** A clear question for the user: a strong detector reason, a question head aimed at "you", or the user addressed by name (profile.ts nameRegex). */
export function isClearQuestion(text: string, reason: string): boolean {
  return STRONG.test(reason) || (/^head/.test(reason) && headAimedAtYou(text)) || nameRegex().test(text);
}
