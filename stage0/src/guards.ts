// Card guards: AI text may never state prices, dates/deadlines or promises (PLAN §5).
// A hit replaces the AI text with the stall line.
// Note: JS \b is ASCII-only, so Hebrew patterns use explicit lookaheads instead.

const PRICE = [
  /[₪$€]\s?\d/, /\d[\d,.]*\s?(₪|ש"?ח|שקל|שקלים|דולר|יורו|nis|usd|eur|dollars?|shekels?|euros?|bucks)(?![\p{L}])/iu,
  /(עולה|עולים|מחיר|מחירו|יעלה|יעלו|עלות|עלותו|תשלום)\s+(של\s+|כ-?\s?|בערך\s+|בסביבות\s+)?\d/, /\d+\s?(אלף|אלפים)\s?(שקל|₪)?/,
  // a price verb followed shortly by a big number word, no currency said: "יעלה אלף חמש מאות", "עלות כעשרים אלף"
  /(עולה|עולים|יעלה|יעלו|עלות|עלותו|מחיר|מחירו|תעריף)\s+(?:\S+\s+){0,3}?ו?(מאה|מאתיים|מאות|אלף|אלפיים|אלפים|עשרות|עשרים|שלושים|ארבעים|חמישים|שישים|שבעים|שמונים|תשעים)(?![א-ת])/,
  // number words before a currency: "אלף שקל", "מאתיים ש״ח", "חמש מאות דולר"
  /ו?(אחד|אחת|שניים|שתיים|שני|שתי|שלושה|שלוש|ארבעה|ארבע|חמישה|חמש|שישה|שש|שבעה|שבע|שמונה|תשעה|תשע|עשרה|עשר|עשרים|שלושים|ארבעים|חמישים|שישים|שבעים|שמונים|תשעים|מאה|מאתיים|מאות|אלף|אלפיים|אלפים|עשרות)\s+(שקל|שקלים|ש["״]?ח|₪|דולר|דולרים|יורו|אירו)(?![א-ת])/,
  /\d[\d,.]*\s?ש[״]ח/,
  // free / discount are price statements too
  /(בחינם|חינם|הנחה|הנחות|ללא עלות|בלי עלות|ללא תשלום|בלי תשלום)(?![א-ת])/,
  /\b(for free|free of charge|at no (extra )?(cost|charge)|no charge|discount)\b/i,
];
const MONTHS = "ינואר|פברואר|מרץ|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר";
const DATE = [
  new RegExp(`(?<![א-ת])(עד\\s|ב-?|ל|מ)?(${MONTHS})(?![א-ת])`),   // "בנובמבר", "עד דצמבר"
  /\d{1,2}\s?(ל|ב)חודש(?![א-ת])/,                                  // "ב-15 לחודש"
  /(?<![א-ת])יום\s(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)(?![א-ת])/,   // bare weekday: "נעלה את זה יום שני"
  /\b\d{1,2}[./]\d{1,2}([./]\d{2,4})?\b/,
  /(עד|ב|ביום|לפני|אחרי)\s?(יום\s)?(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)(?![\u05D0-\u05EA])/,
  /(מחר|מחרתיים|השבוע|בשבוע הבא|בחודש הבא|עד סוף (היום|השבוע|החודש)|תוך \d+\s?(שעות|ימים|דקות))/,
  /תוך\s(שעה|שעתיים|יום|יומיים|שבוע|שבועיים|חודש|חודשיים|(שני|שלושה|שלוש|ארבעה|ארבע|חמישה|חמש|שישה|שש|שבעה|שבע|שמונה|תשעה|תשע|עשרה|עשר)\s(שעות|ימים|דקות|שבועות|חודשים))(?![א-ת])/,
  /בעוד\s(שעה|שעתיים|יום|יומיים|שבוע|שבועיים|חודש|חודשיים)(?![א-ת])/,
  /(עוד היום|עד היום|(נטפל|נסיים|נסדר|נעלה|נעביר|נתקן|נחזור)[^.\n]{0,25}היום)(?![א-ת])/,
  /\b(tomorrow|by (monday|tuesday|wednesday|thursday|friday)|next week|within \d+ (hours|days))\b/i,
];
const PROMISE = [/(?<!לא\s)(?<![א-ת])(אני\s)?בטוח ש/, /(?<![א-ת])בטוחה ש/,/(אפס|ללא|בלי)\s(השבתה|סיכון)/, /(אני\s)?(מבטיח|מבטיחה|מתחייב|מתחייבת|מובטח|אחריות מלאה|100\s?%|בוודאות)/, /\b(guarantee|promise|100%)\b/i];

export type GuardResult = { ok: boolean; rule?: string };

export function guard(text: string): GuardResult {
  for (const r of PRICE) if (r.test(text)) return { ok: false, rule: "price" };
  for (const r of DATE) if (r.test(text)) return { ok: false, rule: "date" };
  for (const r of PROMISE) if (r.test(text)) return { ok: false, rule: "promise" };
  return { ok: true };
}

/** Strip anything that is not plain text (cards are text only). Keep bidi isolates/marks. */
export function sanitize(text: string): string {
  return text
    .replace(/[‪-‮]/g, "") // embeddings/overrides out; isolates (2066-2069) and LRM/RLM stay
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
    .replace(/[*_#`>]+/g, "")
    .trim();
}
