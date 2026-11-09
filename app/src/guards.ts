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

// ---------- figures the user's own material states ----------
// A price, a date or a promise in a card is allowed when the user's own text (notes, brief, background, prepared cards, their own words in this call) holds the
// exact same text. The check works on what each pattern matched, so it is the same for every language that has patterns. Nothing the other side said is passed in.
const squash = (s: string): string =>
  asciiDigits(s)
    .toLowerCase()
    .replace(/[‎‏‪-‮⁦-⁩]/g, "")
    .replace(/(?<=\d)[,.](?=\d{3}(?!\d))/g, "")
    .replace(/[\s ]+/g, " ")
    .trim();
/** `needle` is in `hay` and not inside a longer number ("$45" is not in "$450"). Both squashed. */
function holds(hay: string, needle: string): boolean {
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    const before = hay[i - 1] ?? "";
    const after = hay[i + needle.length] ?? "";
    if (/\d/.test(needle[0]!) && /[\d.]/.test(before)) continue;
    if (/\d/.test(needle[needle.length - 1]!) && /\d/.test(after)) continue;
    return true;
  }
  return false;
}
/** The match widened to the whole number it cuts: "$4" in "$45.50" is "$45.50". */
function widen(text: string, start: number, end: number): string {
  let a = start;
  let b = end;
  const digit = (i: number) => /\p{Nd}/u.test(text[i] ?? "");
  if (digit(b - 1)) while (digit(b) || (/[.,]/.test(text[b] ?? "") && digit(b + 1))) b++;
  if (digit(a)) while (digit(a - 1) || (/[.,]/.test(text[a - 1] ?? "") && digit(a - 2))) a--;
  return text.slice(a, b);
}
const FIGURE_TOKEN = /(?:\p{Sc}\s?)?\p{Nd}[\p{Nd}.,]*(?:\s?[\p{Sc}%％٪])?/gu;
/** Like `guard`, but a hit passes when the user's own text holds the matched text. A hit with digits: the same text, or (with a currency or percent sign) every figure of it with its sign. A hit with words only: two words or more, or a part of a hit that passed (so "tomorrow" alone never passes). Every number in `text` must also be in `own`. A near miss ($45 for a note with $49) still fails. */
export function guardGrounded(text: string, own: string): GuardResult {
  const first = guard(text);
  if (first.ok) return first;
  const ownSq = squash(own);
  const families: [string, RegExp[]][] = [
    ["price", PRICE],
    ["date", DATE],
    ["promise", PROMISE],
  ];
  const hits: { rule: string; start: number; end: number; sq: string }[] = [];
  for (const [rule, list] of families)
    for (const r of list) {
      const re = new RegExp(r.source, r.flags.replace(/[gy]/g, "") + "g");
      for (const m of text.matchAll(re)) {
        const start = m.index ?? 0;
        const wide = widen(text, start, start + m[0].length);
        const end = Math.max(start + m[0].length, text.indexOf(wide, Math.max(0, start - wide.length)) + wide.length);
        hits.push({ rule, start, end, sq: squash(wide) });
      }
    }
  if (!ownSq) return { ok: false, rule: first.rule };
  const grounded = (h: (typeof hits)[number]): boolean => {
    if (h.sq.length < 3) return false;
    if (/\d/.test(h.sq)) {
      if (holds(ownSq, h.sq)) return true;
      if (!/[\p{Sc}%]/u.test(h.sq)) return false;
      const tokens = [...h.sq.matchAll(FIGURE_TOKEN)].map((t) => t[0]);
      return tokens.length > 0 && tokens.every((t) => /[\p{Sc}%]/u.test(t) && holds(ownSq, t));
    }
    return h.sq.split(" ").filter(Boolean).length >= 2 && holds(ownSq, h.sq);
  };
  const ok = hits.map(grounded);
  for (const [i, h] of hits.entries()) {
    if (ok[i]) continue;
    const inside = !/\d/.test(h.sq) && hits.some((o, j) => ok[j] && o.start <= h.start && o.end >= h.end && o !== h);
    if (!inside) return { ok: false, rule: h.rule };
  }
  if (unsupportedNumbers(text, own).length) return { ok: false, rule: first.rule };
  return { ok: true };
}
