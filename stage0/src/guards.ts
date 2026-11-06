// Card guards: AI text may never state prices, dates/deadlines or promises.
// Used by run.ts (reflex answers) and assist.ts (guardMe). A hit replaces the AI text with the stall line.
// Patterns are deliberately broad (a false hit only costs a stall line; a missed price or promise would be spoken to a client).
// Note: JS \b is ASCII-only, so Hebrew patterns use explicit lookaheads/lookbehinds on [א-ת] instead.

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
  /\b(it'?s|that'?s|that will be|it will be|it'?ll be|will be|would be)\s+(totally |completely |absolutely |entirely )?free\b|\bcomplimentary\b|\b(no|zero) (extra )?(cost|fee|fees)\b|\bon the house\b/i,
  // English number words before a currency: "five hundred shekels", "two thousand dollars"
  /\b(hundred|thousand|million|(?:ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|one|two|three|four|five|six|seven|eight|nine)(?:[- ]\w+)?)\s+(?:\w+\s+){0,2}(shekels?|nis|dollars?|euros?|bucks|usd|eur)\b/i,
  /\b(costs?|prices?|priced|charge[sd]?|fees?|rates?)\s+(of\s+|at\s+|is\s+|are\s+|about\s+|around\s+)?(\d|a hundred|hundreds?|thousands?)/i,
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
  // relative dates and clock times: "בעוד שלושה ימים", "בעוד 3 ימים", "בעוד כמה שעות", "ב-14:30", "in 3 days", "next Monday", "on Friday"
  /בעוד\s+(?:\S+\s+){0,2}?(שניות|דקות|דקה|שעות|שעה|שעתיים|ימים|יום|יומיים|שבועות|שבוע|שבועיים|חודשים|חודש|חודשיים|שנים|שנה|שנתיים)(?![א-ת])/,
  /(ימים|שבועות|חודשים|שעות|דקות|יומיים|שבועיים|חודשיים|שעתיים)\s+(מהיום|מעכשיו|מחר)(?![א-ת])/,
  /(?<![\d:.])\d{1,2}:\d{2}(?![\d:])/,
  /(?:\d{1,2}|אחת|שתיים|שלוש|ארבע|חמש|שש|שבע|שמונה|תשע|עשר|אחת עשרה|שתים עשרה)\s*(?:בבוקר|בצהריים|בערב|בלילה|אחר הצהריים|אחה"צ)/,
  /(?:\d{1,2}|אחד|שניים|שלושה|ארבעה|חמישה|שישה|שבעה|שמונה|תשעה|עשרה|עשר|עשרים|שלושים)\s+ב?ל?חודש(?![א-ת])/,
  /(?<![א-ת])(בתחילת|בתחילתו|באמצע|בסוף|בראשית|לקראת|עד)\s(ה)?(חודש|שבוע|שנה|רבעון)(?![א-ת])/,
  /(?<![א-ת])(עד|לקראת|ב|אחרי|לפני)\s?(חג\s|ראש השנה|יום כיפור|סוכות|חנוכה|פורים|פסח|שבועות|הפסח)/,
  /(?<![\d.,])(?:ב-?|עד\s|בשנת\s)?20[2-4]\d(?![\d.,])/,
  /\bin\s+(?:\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|a few|a couple of|a couple|several|\w+teen)\s+(?:more\s+)?(minutes?|hours?|days?|weeks?|months?|years?)\b/i,
  /\b(?:next|this coming|coming)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|year|weekend)\b/i,
  /\bon\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/i,
  /\b(?:at|by|before|after)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b/i,
  /\b(?:eod|eow|end of (?:the )?(?:day|week|month|quarter)|tonight|this (?:evening|afternoon|weekend))\b/i,
];
// Promises are first-person: "אני מבטיח", "נבטיח", "אפשר להבטיח". A definition ("SLA: הספק מתחייב לזמינות") or a hedge ("אי אפשר להבטיח", "אני לא מבטיח") is fine.
const PROMISE = [
  /(?<!לא\s)(?<![א-ת])(אני\s)?בטוח ש/, /(?<![א-ת])בטוחה ש/,
  /(אפס|ללא|בלי)\s(שום\s)?(השבתה|סיכון)/, /(?<![א-ת])אין\s(שום\s)?(סיכון|סיכוי\sש|בעיה\sש)/, /(?<![א-ת])(שום סיכון|אל\s(תדאג|תדאגו|תדאגי|תחשוש))(?![א-ת])/,
  /(?<![א-ת])ש?(אני|אנחנו|אנו|אתה|את|אתם|אתן)\s(?!לא\s)(?:\S+\s)?(?!לא\s)(מבטיח|מבטיחה|מבטיחים|מתחייב|מתחייבת|מתחייבים|ערב|ערבה|ערבים)(?![א-ת])/,
  /(?<![א-ת])(נבטיח|אבטיח|נתחייב|אתחייב|מובטח|מובטחת|אחריות מלאה|בוודאות|100\s?%)(?![א-ת])/,
  /(?<!(?:לא|אי|אין)\s(?:\S+\s){0,2})(?<![א-ת])(אפשר|ניתן|אוכל|נוכל|אני יכול|אני יכולה|אנחנו יכולים|יכול|יכולים)\s(ל)?הבטיח(?![א-ת])/, /(?<!(?:לא|אי|אין)\s(?:\S+\s){0,2})(?<![א-ת])להבטיח(?![א-ת])/,
  /\b(?:i|we)(?:'ll| will|'d| would| can| do)?\s+(?:\w+\s)?(?:guarantee|promise|assure)\b/i, /\b(?:fully |100% |totally )?guaranteed\b(?! to be)/i, /\b(?:100\s?%|no risk|zero risk|risk[- ]free|without (?:any )?risk|no chance (?:of|that))\b/i,
];

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
const SALARY = /(salary|compensation|gross|net pay|\bk\b|שכר|משכורת|ברוטו|נטו|אלף ש)/i;
/** Tools, clouds and skills an interview answer must not claim unless the user's own profile, cards or plan name them (a card once said "OpenAI API" with no basis). */
const CLAIMABLE = ["OpenAI", "GPT", "ChatGPT", "Gemini", "Llama", "Mistral", "LangChain", "LlamaIndex", "Pinecone", "Weaviate", "Chroma", "pgvector", "AWS", "GCP", "Google Cloud", "Azure", "Kubernetes", "K8s", "Terraform", "Kafka", "Spark", "Airflow", "fine-tuning", "fine-tune", "Java", "C#", ".NET", "Go", "Golang", "Rust", "Angular", "Vue", "Django", "FastAPI", "Flask", "Spring", "PyTorch", "TensorFlow", "Snowflake", "Databricks"];
const escapeRe = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const termRe = (w: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(w)}(?![\\p{L}\\p{N}])`, "u");   // case-sensitive: "go over it" is not Go
/** The first claimable term in `text` that `allowed` does not contain, or undefined. */
export function unclaimedTerm(text: string, allowed: string): string | undefined {
  return CLAIMABLE.find((w) => termRe(w).test(text) && !termRe(w).test(allowed));
}
export function guardInterview(text: string, allowed?: string): GuardResult {
  if (/\d/.test(text) && SALARY.test(text)) return { ok: false, rule: "price" };
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
