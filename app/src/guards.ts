// Card guards: AI text may never state prices, dates/deadlines or promises.
// Used by run.ts (reflex answers) and assist.ts (guardMe). A hit replaces the AI text with the stall line.
// Patterns are deliberately broad (a false hit only costs a stall line; a missed price or promise would be spoken to a client).
// Note: JS \b is ASCII-only, so Hebrew patterns use explicit lookaheads/lookbehinds on [א-ת] instead.
//
// What the rule families cover (the patterns are mostly Hebrew and English, with English glosses here):
//   PRICE    any money figure or price statement: ₪ / $ / € amounts, "300 לשעה" (300 per hour), "חמש מאות שקל" (five hundred shekels),
//            "5K a month", "אלף" (a thousand), "עולה / מחיר / תעריף" (costs / price / rate) + number, "בחינם / הנחה" (free / discount), "20% off"
//   DATE     any date or deadline: month names (נובמבר), "יום שני" (Monday), "מחר" (tomorrow), "בעוד שלושה ימים" (in three days), "תוך שעה" (within an hour),
//            clock times (14:30), 5/11 and 12.5.2026, holidays (פסח), years 2020-2049, "next week", "by Friday", "ASAP"
//   PROMISE  first-person promises and certainty: "אני מבטיח" (I promise), "אחריות מלאה" (full guarantee), "בוודאות" (for sure), "אל תדאג" (do not worry),
//            "I guarantee", "100%", "no risk", "rest assured", "I'll make sure". Hedges such as "לא מבטיח" (I do not promise) pass
//   SALARY / SALARY_FIGURE / CLAIMABLE   practice-mode only: no salary figure ("25k", "שלושים אלף") and no tool the user's own profile does not name

import { escapeRe } from "./text-util.ts";
import { LANGUAGES, SHARED_PRICE, SHARED_DATE, CLAIMABLE } from "./lang/index.ts";

// The patterns live in src/lang/ (he.ts, en.ts, shared.ts). Order inside a family does not matter: only the family name is reported.
const PRICE = [...SHARED_PRICE, ...LANGUAGES.flatMap((l) => l.guards.price)];
const DATE = [...SHARED_DATE, ...LANGUAGES.flatMap((l) => l.guards.date)];
const PROMISE = LANGUAGES.flatMap((l) => l.guards.promise);

export type GuardResult = { ok: boolean; rule?: string };

/** Promises only (a promise is never allowed, even where a price or a date is: guardMe checks this first). */
export function guardPromise(text: string): GuardResult {
  for (const r of PROMISE) if (r.test(text)) return { ok: false, rule: "promise" };
  return { ok: true };
}

/** Full check, in order price, date, promise. Returns the first rule that hit ("price" | "date" | "promise"). */
export function guard(text: string): GuardResult {
  for (const r of PRICE) if (r.test(text)) return { ok: false, rule: "price" };
  for (const r of DATE) if (r.test(text)) return { ok: false, rule: "date" };
  for (const r of PROMISE) if (r.test(text)) return { ok: false, rule: "promise" };
  return { ok: true };
}

/** Interview answers: technical talk about costs, rates, dates and durations is the candidate's own content there ("$0.10 per million
 *  tokens", "2,100 tasks in 4 days"). Only a salary figure is blocked: salary comes from the prepared card, never from the model. */
const SALARY = new RegExp(LANGUAGES.map((l) => l.guards.salaryWords.source).join("|"), "i");
const SALARY_FIGURE = LANGUAGES.flatMap((l) => l.guards.salaryFigure);
const termRe = (w: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(w)}(?![\\p{L}\\p{N}])`, "u"); // case-sensitive: "go over it" is not Go
/** The first claimable term in `text` that `allowed` does not contain, or undefined. */
export function unclaimedTerm(text: string, allowed: string): string | undefined {
  return CLAIMABLE.find((w) => termRe(w).test(text) && !termRe(w).test(allowed));
}
export function guardInterview(text: string, allowed?: string): GuardResult {
  if (/\d/.test(text) && SALARY.test(text)) return { ok: false, rule: "price" };
  if (SALARY_FIGURE.some((r) => r.test(text))) return { ok: false, rule: "price" };
  if (allowed !== undefined && unclaimedTerm(text, allowed)) return { ok: false, rule: "unclaimed" };
  return { ok: true };
}

/** Strip anything that is not plain text (cards are text only). Keep bidi isolates/marks so mixed Hebrew/English lines still render right. */
export function sanitize(text: string): string {
  return text
    .replace(/[‪-‮]/g, "") // embeddings/overrides out; isolates (2066-2069) and LRM/RLM stay
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
    .replace(/[*_#`>]+/g, "")
    .trim();
}

// ---------- digit-based over-promise guard (language neutral) ----------
// The word lists above need one file per language. A figure does not: whatever the language of the card, a number the call never said
// (a price, a count, a percent, a day) is a promise the user did not make. These helpers only look at digits and currency/percent signs.
const ZEROS = [0x30, 0x660, 0x6f0, 0x966, 0xff10]; // ASCII, Arabic-Indic, Persian, Devanagari, fullwidth
/** Any Unicode decimal digit to ASCII, so "٤٥" and "45" compare equal. */
export function asciiDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, (ch) => {
    const c = ch.codePointAt(0)!;
    const z = ZEROS.find((b) => c >= b && c < b + 10);
    return z === undefined ? ch : String(c - z);
  });
}
/** The numbers in a text as plain strings: "1,500" and "1.500" and "1500" are "1500" when the separator groups three digits; "4.5" stays "4.5". */
export function numbersIn(text: string): string[] {
  const out: string[] = [];
  for (const m of asciiDigits(text).matchAll(/\d+(?:[.,]\d+)*/g)) {
    let n = m[0];
    if (/^\d{1,3}(?:[.,]\d{3})+$/.test(n)) n = n.replace(/[.,]/g, "");
    else if (n.includes(".") && n.includes(",")) {
      // Both signs ("12,345.67" or "12.345,67"): the last one is the decimal point, the other one groups thousands.
      const dec = Math.max(n.lastIndexOf("."), n.lastIndexOf(","));
      n = n.slice(0, dec).replace(/[.,]/g, "") + "." + n.slice(dec + 1);
    } else n = n.replace(",", ".");
    out.push(n.replace(/^0+(?=\d)/, ""));
  }
  return out;
}
/** A figure with a currency sign or a percent sign next to it: a price or a rate, in any language. */
export const FIGURE = /[\p{Sc}]\s?\d|\d\s?[\p{Sc}]|\d\s?[%％٪]/u;
/** Numbers in `text` that `allowed` (what was said in the call, the memory, the prepared cards) does not contain. One-digit numbers are not counted (a step number, "2 options"). */
export function unsupportedNumbers(text: string, allowed: string): string[] {
  const have = new Set(numbersIn(allowed));
  return [...new Set(numbersIn(text))].filter((n) => (n.length >= 2 || n.includes(".")) && !have.has(n));
}
/** Digit guard for model text: a figure sign, or a number the context never had, is not allowed. Rule "number". */
export function guardDigits(text: string, allowed: string): GuardResult {
  const nums = unsupportedNumbers(text, allowed);
  if (nums.length) return { ok: false, rule: "number" };
  if (FIGURE.test(text) && !FIGURE.test(allowed)) return { ok: false, rule: "number" };
  return { ok: true };
}
