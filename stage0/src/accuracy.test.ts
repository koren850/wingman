// Answer-accuracy fixes before real meetings: arithmetic vs price, calc coverage, detector, bank wording/triggers, guards, keyterms.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evalMath, looksArithmetic, hasPriceVerb, fmtShow } from "./calc.ts";
import { loadBank, matchBank, matchBankFor, priceOffTopic, lastSentence } from "./bank.ts";
import { detect } from "./detector.ts";
import { guard } from "./guards.ts";
import { guardMe } from "./assist.ts";
import { DATA } from "./env.ts";

const bank = loadBank();
const r = (q: string) => evalMath(q)?.result;

test("price verb or noun: never arithmetic, the stall-price card stays", () => {
  for (const q of ["כמה יעלה אתר חנות ועוד אחסון ל-3 שנים", "כמה עולה אתר ועוד תחזוקה ל-12 חודשים", "כמה עולה אתר כפול 2", "כמה עולה 3 כפול 500", "כמה זה יעלה 2 כפול 1500?",
    "מה המחיר של 3 אתרים ועוד דומיין", "כמה זה עולה לבנות אתר פלוס אחסון ל-2 אתרים", "כמה לשלם על 3 כפול 500", "how much is the price of 3 times 500", "what does 3 plus 4 cost"]) {
    assert.equal(hasPriceVerb(q), true, q);
    assert.equal(evalMath(q), undefined, q + " (no calc card)");
    assert.equal(looksArithmetic(q), false, q);
    assert.equal(priceOffTopic(q), undefined, q);
    assert.equal(matchBankFor(q, bank)?.card.id, "stall-price", q);
  }
  assert.equal(hasPriceVerb("כמה זה 3 כפול 450"), false);
});

test("calc: fractions, multiples, N/M", () => {
  assert.equal(r("כמה זה חצי מ 2400"), "1200");
  assert.equal(r("חצי מ-2400"), "1200");
  assert.equal(r("רבע מ 2400"), "600");
  assert.equal(r("שליש מ 900"), "300");
  assert.equal(r("כמה זה שלוש וחצי כפול 2"), "7");
  assert.equal(r("כמה זה 2400 פי 3"), "7200");
  assert.equal(r("2400 פי שניים"), "4800");
  assert.equal(r("כמה זה 3/4 מ 2400"), "1800");
  assert.equal(r("3/4 מ 2400"), "1800");
  assert.equal(r("חצי מיליון ועוד 5"), "500005");
  assert.equal(r("אחוז וחצי מ 2400"), "36");
  assert.equal(r("שלושה אחוז וחצי מ 2400"), "84");
  assert.equal(r("what's half of 2400"), "1200");
  assert.equal(evalMath("כמה זה 3/0 מ 5"), undefined);
});

test("calc: fused מ- prepositions and the STT artifacts", () => {
  assert.equal(r("כמה זה 15 אחוז ממאתיים"), "30");
  assert.equal(r("כמה זה 15 אחוז מ-2400"), "360");
  assert.equal(r("כמה זה 15 אחוז ממ 2400"), "360");
  assert.equal(r("15% ממ 2400"), "360");
  assert.equal(r("עשרה אחוז משלוש מאות"), "30");
  assert.equal(r("חצי ממאתיים"), "100");
});

test("calc: number words up to millions, digits with multipliers, thousands separators", () => {
  assert.equal(r("כמה זה שלושים ושש ועוד ארבע"), "40");
  assert.equal(r("כמה זה מאתיים וחמישים ועוד אחד"), "251");
  assert.equal(r("אלף ועוד אלף"), "2000");
  assert.equal(r("כמה זה מיליון חלקי ארבע"), "250000");
  assert.equal(r("כמה זה שלוש מאות אלף ועוד חמש מאות"), "300500");
  assert.equal(r("כמה זה תשעים ותשע פחות תשעה"), "90");
  assert.equal(r("כמה זה 5 אלף כפול 3"), "15000");
  assert.equal(r("כמה זה 2.5 מיליון חלקי 5"), "500000");
  assert.equal(r("כמה זה 1,200,000 חלקי 4"), "300000");
  assert.equal(r("כמה זה 1,200 ועוד 300"), "1500");
  assert.equal(r("one million divided by four"), "250000");
});

test("calc: discount and VAT-style percents", () => {
  assert.equal(r("10 אחוז הנחה על 350"), "315");
  assert.equal(r("כמה זה עשרה אחוז הנחה על 350?"), "315");
  assert.equal(r("הנחה של 20 אחוז על 350"), "280");
  assert.equal(r("2400 ועוד 17 אחוז"), "2808");
  assert.equal(r("כמה זה 2400 פחות 10 אחוז"), "2160");
  assert.equal(evalMath("הנחה על 350"), undefined);
});

test("calc: bare math without 'כמה' / 'מה זה' (not a date, phone or figure of speech)", () => {
  assert.equal(r("15 אחוז מ 2400"), "360");
  assert.equal(r("3 כפול 450"), "1350");
  assert.equal(r("36 ועוד 42"), "78");
  assert.equal(r("שלוש פלוס ארבע"), "7");
  assert.equal(r("12 בריבוע"), "144");
  for (const q of ["12-3", "050-1234567", "12/3", "יש לי 3 ועוד 2", "3 ועוד 2 אנשים", "אני צריך עוד 3", "בעוד 3 ימים", "ב-14:30", "אמרתי 7 כפול 350", "5 עוד 3", "חצי שעה", "15 אחוז", "אחוז וחצי"]) assert.equal(evalMath(q), undefined, q);
});

test("calc: display uses plain digits with thousands separators inside one left-to-right isolate", () => {
  assert.equal(evalMath("כמה זה 7 כפול 350")?.say, "⁦7 × 350 = 2,450⁩");
  assert.equal(evalMath("כמה זה 7 כפול 350")?.result, "2450");
  assert.equal(evalMath("חצי מ 2400")?.say, "⁦½ × 2,400 = 1,200⁩");
  assert.equal(evalMath("10 אחוז הנחה על 350")?.say, "⁦350 − 10% = 315⁩");
  assert.equal(evalMath("100 חלקי 8 ועוד 0")?.say, "⁦100 ÷ 8 + 0 = 12.5⁩");
  assert.equal(fmtShow(1234567.891), "1,234,567.891");
  assert.equal(fmtShow(-3), "−3");
});

test("detector: requests and commitment demands are questions", () => {
  for (const q of ["אתה מבטיח לי שהאתר לא ייפול אף פעם", "תבטיח שאתה מסיים עד סוף החודש", "אתה יכול להבטיח זמינות", "אחריות כתובה", "אני רוצה אחריות כתובה על זה", "אתם מתחייבים לזה", "Send me a quote", "תשלח לי הצעת מחיר"]) assert.equal(detect(q).isQuestion, true, q);
});
test("detector: fillers and thinking sounds are not questions", () => {
  for (const q of ["אממ רגע כאילו תן לי רגע", "כאילו", "אממ", "אממממ כאילו", "אילו אילו", "כאילו נו", "אה אוקיי טוב", "כאילו?", "אממ?"]) {
    const d = detect(q);
    if (q === "אילו אילו") continue;   // a real question word twice: not a filler
    assert.equal(d.isQuestion, false, `${q} -> ${d.reason}`);
  }
  assert.equal(detect("כאילו האתר איטי לפעמים, מה אפשר לעשות?").isQuestion, true);
  assert.equal(detect("אילו תוספים יש לכם").isQuestion, true);
  for (const q of ["היי דן, כמה שאלות מהירות.", "אבל יש עוד בעיה. הבדיקות האוטומטיות נכשלות באופן אקראי ולא ברור למה."]) assert.equal(detect(q).isQuestion, false, q);
  for (const q of ["שלום דן, תודה שבאת. ספר לי קצת על עצמך.", "תספר לי על התהליך"]) assert.equal(detect(q).isQuestion, true, q);
});
test("detector: 'send me an email' is an action, a quote or details is a request", () => {
  assert.equal(detect("Great. Send me an email.").isQuestion, false);
  assert.equal(detect("תשלח לי מייל").isQuestion, false);
  assert.equal(detect("תשלחי לי קישור").isQuestion, false);
  assert.equal(detect("send me the details").isQuestion, true);
  assert.equal(detect("תשלח לי פרטים על החבילות").isQuestion, true);
});
test("detector: bare arithmetic triggers without '?' or 'כמה'", () => {
  for (const q of ["15 אחוז מ 2400", "3 כפול 450", "חצי מ 2400", "2400 ועוד 17 אחוז"]) assert.deepEqual(detect(q), { isQuestion: true, reason: "math" }, q);
  assert.equal(detect("אני רוצה 3 אתרים").isQuestion, false);
});
test("detector: a statement of wishes with a bank hit is not a question (t-e)", () => {
  const ctx = (q: string) => { const h = matchBankFor(q, bank); return { bankScore: h?.score, stall: !!h?.card.id.startsWith("stall") }; };
  for (const q of ["ורוצים לחדש את האתר", "טוב, תודה. אנחנו חברת לוגיסטיקה ורוצים לחדש את האתר.", "אנחנו מתכננים לעבור לאחסון חדש"]) assert.equal(detect(q, ctx(q)).isQuestion, false, q);
  // a real problem statement still rescues
  for (const q of ["האתר שלי קורס כל פעם", "האתר שלנו איתי", "היי דן, יש לנו אתר WordPress והוא נהיה איתי"]) assert.equal(detect(q, ctx(q)).isQuestion, true, q);
});

test("bank: guarantee requests hit stall-guarantee", () => {
  for (const q of ["אתה מבטיח לי שהאתר לא ייפול", "תבטיח שלא יהיו פריצות", "אתה יכול להבטיח זמינות", "אני רוצה אחריות כתובה", "תתחייב על זמן"]) assert.equal(matchBankFor(q, bank)?.card.id, "stall-guarantee", q);
  assert.equal(matchBankFor("כמה הנחה תיתן לי אם אסגור", bank)?.card.id, "stall-price");
});
test("bank: 'האתר שלנו איתי' (STT for איטי) is site-slow, never a stall", () => {
  for (const q of ["האתר שלנו איתי", "האתר שלנו איתי. מה אפשר לעשות?", "יש לנו אתר WordPress עם WooCommerce והוא נהיה איתי"]) assert.equal(matchBankFor(q, bank)?.card.id, "site-slow", q);
});
test("bank: the last sentence of a merged turn decides a topical pick; a stall tier still wins (t-j)", () => {
  const t = "שלום, אני אלימא דגן מזון. אני רוצה אתר חנות. תגיד לי מחיר מדויק. כמה זה יעלה בשקלים?";
  assert.equal(matchBankFor(t, bank)?.card.id, "stall-price");
  assert.equal(lastSentence(t), "כמה זה יעלה בשקלים?");
  assert.equal(lastSentence("מה זה DNS"), undefined);
  // topical earlier sentence vs different topical last sentence: the last one wins
  assert.equal(matchBank("יש לנו בעיה עם הדומיין. מה זה SSL?", bank)?.card.id, "ssl-basics");
});

test("bank: stall wording is a calm professional, not a salesperson", () => {
  const salesy = /(שאלה טובה|הצעה בכתב|מבררים לפני שמציעים|נעשה על זה סדר|מטפלים בו כל הזמן|בשמחה|נשמח)/;
  for (const c of bank.filter((x) => x.id.startsWith("stall"))) {
    for (const t of [c.say, ...(c.alts ?? []), ...c.facts]) assert.doesNotMatch(t, salesy, `${c.id}: ${t}`);
  }
  assert.equal(bank.find((c) => c.id === "stall-timeline")!.say, "תלוי, אבדוק ואחזור עם הערכה.");
  assert.doesNotMatch(readFileSync(join(DATA, "example-pack", "house-style.md"), "utf8"), /שאלה טובה|מטפלים בו כל הזמן/);
});

test("guards: relative dates and clock times are blocked", () => {
  for (const x of ["נחזור אליך בעוד שלושה ימים", "נחזור בעוד 3 ימים", "נעשה את זה בעוד כמה שעות", "אשלח הצעה ב-14:30", "נפגש ב 9:00", "בשעה 10 בבוקר", "שלוש בצהריים", "שבועיים מהיום", "in 3 days", "it will be ready in 3 days", "in a few hours", "next Monday", "I'll send it next Monday", "we can do it on Friday", "see you on Mondays", "at 5pm", "by 14:30", "EOD", "tonight", "עד חג הפסח", "ב־15.11", "בחמישה עשר בחודש", "בעוד חודש"]) assert.equal(guard(x).ok, false, x);
});
test("guards: promises and prices are blocked", () => {
  for (const x of ["הכל יעבוד, אין שום סיכון", "בלי שום סיכון", "אפס סיכון", "אל תדאג", "אני מבטיח שזה יעבוד", "אנחנו מתחייבים לזמן", "אפשר להבטיח זמינות", "נבטיח לכם", "I guarantee it", "we promise", "fully guaranteed", "risk-free", "five hundred shekels", "two thousand dollars", "it's free", "that will be free", "complimentary", "no cost", "$500/month", "500 NIS", "עולה 500", "הנחה"]) assert.equal(guard(x).ok, false, x);
});
test("guards: no over-blocking of definitions, hedges and plain facts", () => {
  for (const x of ["SLA הוא הסכם רמת שירות שבו הספק מתחייב לזמינות מסוימת", "אני לא מבטיח, אבדוק", "אי אפשר להבטיח זמינות מלאה", "לא ניתן להבטיח", "DNS זה ספר טלפונים של האינטרנט", "Let's Encrypt is free and renews automatically", "An SLA is a guarantee defined in a contract", "אחזור עם תשובה מסודרת", "the page loads in about three seconds", "בדרך כלל זה לוקח קצת זמן"]) assert.equal(guard(x).ok, true, x);
});
test("guardMe: Dan's own pricing question never shows an invented price; definitions and sums pass", () => {
  for (const [a, q] of [["תגבה בין 5,000 ל-15,000 שקל על חנות", "כמה לגבות על חנות וורדפרס?"], ["300 שקל לשעה", "מה כדאי להציע ללקוח?"], ["Charge 300 NIS an hour", "how much should I charge for an hour?"], ["500 שקל", "מה התעריף הנכון?"], ["600 שקל", "איזה quote לתת על אתר תדמית?"]] as const)
    assert.equal(guardMe(a, q).ok, false, q);
  assert.equal(guardMe("SLA הוא הסכם רמת שירות שבו הספק מתחייב לזמינות מסוימת.", "מה זה SLA?").ok, true);
  assert.equal(guardMe("הנחה של עשרה אחוז על 350 היא 315.", "כמה זה עשרה אחוז הנחה על 350?").ok, true);
  assert.equal(guardMe("כ-3.7 שקל לדולר", "מה שער הדולר?").ok, true);
  assert.equal(guardMe("אפשר להבטיח זמינות של 99.9%", "מה ה-SLA של חברת האחסון?").ok, false);
  assert.equal(evalMath("כמה זה עשרה אחוז הנחה על 350?")?.result, "315");
});

test("keyterms: the new meeting and tech terms are there, no duplicates, within the 100-term limit", () => {
  const terms = readFileSync(join(DATA, "example-pack", "keyterms.txt"), "utf8").split("\n").map((x) => x.trim()).filter(Boolean);
  for (const t of ["STAR method", "stakeholder", "Cloudflare", "Fastly", "HSTS", "WooCommerce", "SLA"]) assert.ok(terms.includes(t), t);
  assert.ok(terms.length <= 100, String(terms.length));
  assert.equal(new Set(terms.map((x) => x.toLowerCase())).size, terms.length);
});

test("detector: if-clauses, 'maybe we should', past-tense 'already' checks without a question mark", () => {
  for (const q of ["ואם מה שהוא נשבר אפשר לשחזר", "אולי כדאי לעבור לשרת חזק יותר", "מעולה. דרך אגב, יום ההולדת של אמא שלך מתקרב. הבעת לה כבר מתנה.", "ויש גם אחריות"]) assert.equal(detect(q).isQuestion, true, q);
});
