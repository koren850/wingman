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
