// Card guards: AI text may never state prices, dates/deadlines or promises.
// Used by run.ts (reflex answers) and assist.ts (guardMe). A hit replaces the AI text with the stall line.
// Patterns are deliberately broad (a false hit only costs a stall line; a missed price or promise would be spoken to a client).
// Note: JS \b is ASCII-only, so Hebrew patterns use explicit lookaheads/lookbehinds on [א-ת] instead.

import { escapeRe } from "./text-util.ts";

// English number words and Hebrew number words, shared by the price, date and salary rules.
const EN_NUM =
  "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|a few|a couple of|several|a";
const HE_NUM =
  "אחד|אחת|שניים|שתיים|שני|שתי|שלושה|שלוש|ארבעה|ארבע|חמישה|חמש|שישה|שש|שבעה|שבע|שמונה|תשעה|תשע|עשרה|עשר|עשרים|שלושים|ארבעים|חמישים|שישים|שבעים|שמונים|תשעים|מאה|מאתיים|מאות";
const CURRENCY_CODES = "nis|ils|usd|eur|gbp|dollars?|shekels?|euros?|pounds?|quid|bucks";
const PRICE = [
  /[₪$€£]\s?\d/,
  new RegExp(`\\d[\\d,.]*\\s?(₪|ש"?ח|ש''ח|שקל|שקלים|דולר|יורו|${CURRENCY_CODES})(?![\\p{L}])`, "iu"),
  // currency code before the number: "USD 500", "GBP 200", "NIS 1200"
  /\b(?:nis|ils|usd|eur|gbp)\s?\d/i,
  // k / K / 1.2K / grand / spelled-out thousands, with or without a currency: "5K a month", "5 grand", "35 thousand", "thirty five thousand"
  /\d[\d,.]*\s?k\b(?!\s?(?:requests|users|tokens|rows|records|lines))/i,
  /\d[\d,.]*\s?(?:grand|thousand)\b/i,
  new RegExp(`\\b(?:${EN_NUM})(?:[- ](?:${EN_NUM}))?\\s+(?:thousand|grand\\b(?!\\s+(?:opening|total|tour|piano|slam|plan|scheme|prize)))\\b`, "i"),
  /\b(?:a|one) thousand\b/i,
  /\b(?:a|one|two|three|four|five|ten|twenty|fifty|few|couple of|several) grand\b(?!\s+(?:opening|total|tour|piano|slam|plan|scheme|prize))/i,
  // Hebrew: per-unit rates and bare big number words ("300 לשעה", "התעריף 300", "חמש מאות", "אלף וחמש מאות")
  /\d[\d,.]*\s?(?:ל(?:שעה|יום|שנה|משתמש|לקוח)|בשעה)(?![א-ת])/,
  /\d{3}[\d,.]*\s?(?:לחודש|בחודש)(?![א-ת])/, // "300 לשעה", "500 לחודש" but not the date "15 לחודש"
  /(?<![א-ת])(?:ה)?תעריף\s+(?:של\s+|כ-?\s?)?\d/,
  /(?<![א-ת])ו?(?:מאתיים|מאות|אלפיים|אלפים|אלף)(?![א-ת])/,
  // "we charge a flat 300", "quoted 1200" (a bare figure after a charging word)
  /\b(?:charge|charging|charged|flat|quote|quoted|billed?|billing)\s+(?:you\s+|a\s+|an\s+|of\s+|at\s+|is\s+|fee\s+|rate\s+|flat\s+)*\d{3,}/i,
  /(עולה|עולים|מחיר|מחירו|יעלה|יעלו|עלות|עלותו|תשלום)\s+(של\s+|כ-?\s?|בערך\s+|בסביבות\s+)?\d/,
  /\d+\s?(אלף|אלפים)\s?(שקל|₪)?/,
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
  // other money nouns followed by a figure: "a monthly retainer of 800", "a deposit of 1,500", "the budget is 20000" (3+ digits, not a measure)
  /\b(?:retainers?|deposits?|budgets?|quotes?|quoted|estimates?|invoices?|subscriptions?|instal?lments?|surcharges?|markups?)\s+(?:of\s+|at\s+|is\s+|are\s+|for\s+|about\s+|around\s+|roughly\s+)?\d[\d,.]{2,}(?![\d,.])(?!\s?(?:ms|seconds?|mb|gb|kb|requests?|users?|rows?|lines?|records?))/i,
  // Hebrew: "הצעה של 4,500", "תקציב של 20000", "ריטיינר 800"
  /(?<![א-ת])(?!(?:הצעה|הצעת מחיר|חשבונית)\s+\d{5,}(?![\d,.]|\s?(?:₪|ש"?ח|שקל|דולר|יורו)))(?:הצעה|הצעת מחיר|תקציב|ריטיינר|מקדמה|חשבונית|הערכה)\s+(?:של\s+|בסך\s+|כ-?\s?|בערך\s+|בסביבות\s+)?\d[\d,.]{2,}/,
  // spoken digits: "five fifty" (5.50), "nine ninety" (9.90): a unit word followed by a tens word, not a hyphenated compound ("three thirty-minute slots")
  /\b(?:one|two|three|four|five|six|seven|eight|nine)\s+(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b(?![- ]?(?:one|two|three|four|five|six|seven|eight|nine)\b)(?!-)/i,
  // percentage discounts and zero-price statements: "ten percent off", "20% off", "we charge nothing"
  new RegExp(`\\b(?:\\d+|(?:${EN_NUM}))\\s?(?:%|percent|per cent)\\s+(?:off|discount|cheaper|less|reduction|rebate)\\b`, "i"),
  /\b(?:charge|charging|charged|bill|billing)\s+(?:you\s+)?(?:nothing|zero)\b/i,
];
const MONTHS = "ינואר|פברואר|מרץ|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר";
const DATE = [
  new RegExp(`(?<![א-ת])(עד\\s|ב-?|ל|מ)?(${MONTHS})(?![א-ת])`), // "בנובמבר", "עד דצמבר"
  /\d{1,2}\s?(ל|ב)חודש(?![א-ת])/, // "ב-15 לחודש"
  /(?<![א-ת])יום\s(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)(?![א-ת])/, // bare weekday: "נעלה את זה יום שני"
  // numeric dates: 5/11, 5/11/26, 12.5.2026, and a two-part dotted "12.5" unless it is a version or a measure ("version 2.0", "4.5 years")
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/,
  /\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/,
  /(?<!(?:(?<![a-z\d])(?:version|ver|python|node|ios|android|chrome|php|java|windows|macos|react|vue|angular|wordpress|wp|tls|ssl|http|https|ipv|tcp|udp|usb|ssh|oauth|openssl|nginx|apache|mysql|mariadb|postgres|postgresql|docker|laravel|django|rails|ruby|rust|go|typescript|es|css|html|bootstrap|jquery|wpa|bluetooth|wifi|wi-fi|redis|memcached|elasticsearch|mongo|mongodb|sqlite|kafka|kubernetes|k8s|helm|terraform|ansible|ubuntu|debian|centos|alpine|linux|git|npm|pnpm|yarn|webpack|vite|tailwind|svelte|next|nuxt|cuda)|v)\s?)(?<![\d.,])(?:0?[1-9]|[12]\d|3[01])\.(?:0?[1-9]|1[0-2])(?![\d.,])(?!\s?(?:years?|months?|hours?|weeks?|days?|x|%|k\b|gb|mb|seconds?|handshakes?|protocol|spec|release|update|patch|build|api|sdk|runtime|compiler|kernel|שנ|חודש|שעות|ימים|אחוז))/i,
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
  // English month names and abbreviations, with or without a day ("Nov 12", "March 5th", "in November"). "may" only with a day or a preposition.
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch(?!\s+(?:of|on|to|into|through|forward)\b))?|apr(?:il)?|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b(?!-)/i,
  /\bmay\s+\d{1,2}\b|\b(?:in|of|by|until|till|since|from|early|late|mid|end of|beginning of)\s+may\b/i,
  /\b\d{1,2}(?:st|nd|rd|th)\b/i,
  // weekdays, any use ("this Thursday", "see you Thursday"), quarters, vague deadlines
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/i,
  /\bQ[1-4]\b|\b(?:asap|a\.s\.a\.p|fortnight|(?:later|by|until|before|sometime|earlier) today)\b/i,
  /\b(?:this|next|by|end of the|by the end of the)\s+(?:week|month|quarter|year)\b/i,
  /\bwithin\s+(?:\S+\s+){0,3}?(?:minutes?|hours?|days?|weeks?|months?|years?)\b/i,
  /\bin\s+(?:the\s+)?(?:next|coming|following)\s+(?:\w+\s+)?(?:minutes?|hours?|days?|weeks?|months?|years?)\b/i,
  /\bin\s+(?:\w+[- ])?(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|\w+teen)\s+(?:minutes?|hours?|days?|weeks?|months?)\b/i,
  // Hebrew additions: "בשבוע הבא", "בקרוב", "הערב", "ביום ה'", "תוך 30 יום", "בתוך שלושים יום"
  /(?<![א-ת])(?:ב?שבוע הבא|ב?חודש הבא|ב?שנה הבאה|ברבעון הבא|בקרוב|בימים הקרובים|בשבועות הקרובים|הערב|הלילה|היום בערב|בסוף היום|אחרי החגים|לפני החגים)(?![א-ת])/,
  /ביום\s[א-ו]['׳]/,
  new RegExp(`(?<![א-ת])תוך\\s+(?:\\d+|(?:${HE_NUM})(?:\\s+ו?(?:${HE_NUM}))?)\\s+(?:שעות|שעה|דקות|ימים|יום|שבועות|חודשים|שנים)(?![א-ת])`),
  /\b(?:eod|eow|end of (?:the )?(?:day|week|month|quarter)|tonight|this (?:evening|afternoon|weekend))\b/i,
];
// Promises are first-person: "אני מבטיח", "נבטיח", "אפשר להבטיח". A definition ("SLA: הספק מתחייב לזמינות") or a hedge ("אי אפשר להבטיח", "אני לא מבטיח") is fine.
const PROMISE = [
  /(?<!לא\s)(?<![א-ת])(אני\s)?בטוח ש/,
  /(?<![א-ת])בטוחה ש/,
  /(אפס|ללא|בלי)\s(שום\s)?(השבתה|סיכון)/,
  /(?<![א-ת])אין\s(שום\s)?(סיכון|סיכוי\sש|בעיה\sש)/,
  /(?<![א-ת])(שום סיכון|אל\s(תדאג|תדאגו|תדאגי|תחשוש))(?![א-ת])/,
  /(?<![א-ת])ש?(אני|אנחנו|אנו|אתה|את|אתם|אתן)\s(?!לא\s)(?:\S+\s)?(?!לא\s)(מבטיח|מבטיחה|מבטיחים|מתחייב|מתחייבת|מתחייבים|ערב|ערבה|ערבים)(?![א-ת])/,
  /(?<![א-ת])(נבטיח|אבטיח|נתחייב|אתחייב|מובטח|מובטחת|אחריות מלאה|בוודאות|100\s?%)(?![א-ת])/,
  /(?<!(?:לא|אי|אין)\s(?:\S+\s){0,2})(?<![א-ת])(אפשר|ניתן|אוכל|נוכל|אני יכול|אני יכולה|אנחנו יכולים|יכול|יכולים)\s(ל)?הבטיח(?![א-ת])/,
  /(?<!(?:לא|אי|אין)\s(?:\S+\s){0,2})(?<![א-ת])להבטיח(?![א-ת])/,
  /\b(?:i|we)(?:'ll| will|'d| would| can| do)?\s+(?:(?!(?:cannot|can't|can’t|don't|do not|won't|never)\b)\w+\s)?(?:guarantee|promise|assure)\b/i,
  /\b(?:fully |100% |totally )?guaranteed\b(?! to be)/i,
  /\b(?:100\s?%|no risk|zero risk|risk[- ]free|without (?:any )?risk|no chance (?:of|that))\b/i,
  // Unhedged certainty about the future is a soft promise: "I am sure it will work", "we're certain this will be fine". A hedge ("pretty sure",
  // "not sure", "I think") is not in the list on purpose: only sure / certain / positive / confident, optionally with an intensifier.
  /\b(?:i(?:'m|’m| am)|we(?:'re|’re| are))\s+(?:absolutely |completely |totally |100% |entirely |dead )?(?:sure|certain|positive|confident)\s+(?:that\s+)?(?:it|this|that|we|everything|things|the \w+|your \w+)\s*(?:'ll|’ll|will|'d|would|is going to|are going to|won't|will not)\b/i,
];

// More promise forms (English + Hebrew). Hedges ("can't promise", "I can't guarantee", "לא מבטיח") stay allowed.
PROMISE.push(
  /(?<!n['’]t\s)(?<!\b(?:not|never|cannot|no|a|an|the|money-back)\s)\b(?:promise[sd]?|guarantee[sd]?)\b/i,
  /\bmy word\b|\bconsider it done\b|\bcount on (?:us|me|it)\b|\brest assured\b|\b(?:i|we)\s+swear\b/i,
  /\b(?:i|we)(?:'ll|'d| will| would| can)?\s+(?:definitely |certainly |absolutely |surely |personally )?make sure\b/i,
  /\b(?:i|we)(?:'ll| will)\s+(?:definitely|certainly|absolutely|surely)\b/i,
  /\b(?:we(?:'re| are)|i(?:'m| am)) (?:committed|commit(?:ting)?) to\b|\b(?:i|we) commit to\b/i,
  /\b(?:it|this|that)(?:'ll| will)\s+(?:definitely |certainly |absolutely )?(?:be (?:done|ready|fixed|live|sorted|resolved|finished|delivered)|get done)\b/i,
  /\b(?:i|we)(?:'ll| will)\s+(?:definitely |certainly )?get (?:it|this|that) (?:done|sorted|fixed)\b/i,
  /\bno problem\b[^.?!]{0,30}\b(?:will|'ll|by)\b/i,
  /(?<!לא\s)(?<!אי\s)(?<![א-ת])(?:מבטיח|מבטיחה|מבטיחים|מבטיחות|הבטחה|הבטחתי|הבטחנו)(?![א-ת])/,
  /(?<!לא\s)(?<![א-ת])(?:נדאג|אדאג|ידאגו|נעשה את זה|אעשה את זה|אני אעשה|אנחנו נעשה|נסגור את זה|נסיים את זה|אסיים את זה)(?![א-ת])/,
  /(?<![א-ת])(?:המילה שלי|מילה שלי|יש לך את המילה|תהיה בטוח|תהיי בטוחה|אתה יכול לסמוך|תסמוך עלינו|זה ייעשה|זה יהיה מוכן|זה יסתדר|בהחלט נעשה|בהחלט נדאג|בוודאי נעשה)(?![א-ת])/,
);

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
const SALARY = /(salary|compensation|gross|net pay|שכר|משכורת|ברוטו|נטו|אלף ש)/i;
/** Salary figures that need no salary word: "25k", "$120k", "1.2K", "35 thousand", "thirty five thousand", "שלושים אלף". Technical counts ("30 thousand requests") pass. */
const TECH_NOUN =
  "(?:requests?|users?|tokens?|rows?|records?|lines?|sites?|pages?|documents?|messages?|calls?|tasks?|files?|events?|customers?|visitors?|items?|products?|דפים|משתמשים|בקשות|שורות|אתרים|מסמכים|הודעות|קבצים|לקוחות|מוצרים)";
const SALARY_FIGURE = [
  /\d[\d,.]*\s?k\b(?!\s?(?:requests?|users?|tokens?|rows?|records?|lines?|sites?|pages?|calls?|tasks?|hz|fps))/i,
  new RegExp(`\\b(?:\\d[\\d,.]*|(?:${EN_NUM})(?:[- ](?:${EN_NUM}))?)\\s+(?:thousand|grand)\\b(?!\\s+${TECH_NOUN})`, "i"),
  /\b(?:a|one) (?:thousand|grand)\b(?!\s+(?:requests?|users?|tokens?|rows?|records?|lines?|sites?|pages?|calls?|tasks?))/i,
  new RegExp(`(?<![א-ת])(?:\\d+|(?:${HE_NUM})(?:\\s+ו?(?:${HE_NUM}))?)\\s+אלף(?![א-ת])(?!\\s+${TECH_NOUN})`),
];
/** Tools, clouds and skills an interview answer must not claim unless the user's own profile, cards or plan name them (a card once said "OpenAI API" with no basis). */
const CLAIMABLE = [
  "OpenAI",
  "GPT",
  "ChatGPT",
  "Gemini",
  "Llama",
  "Mistral",
  "LangChain",
  "LlamaIndex",
  "Pinecone",
  "Weaviate",
  "Chroma",
  "pgvector",
  "AWS",
  "GCP",
  "Google Cloud",
  "Azure",
  "Kubernetes",
  "K8s",
  "Terraform",
  "Kafka",
  "Spark",
  "Airflow",
  "fine-tuning",
  "fine-tune",
  "Java",
  "C#",
  ".NET",
  "Go",
  "Golang",
  "Rust",
  "Angular",
  "Vue",
  "Django",
  "FastAPI",
  "Flask",
  "Spring",
  "PyTorch",
  "TensorFlow",
  "Snowflake",
  "Databricks",
];
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
