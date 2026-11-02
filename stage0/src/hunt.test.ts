// Bug-hunt regressions (offline). Each block was a real failure found by adversarial inputs; names are invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { guard } from "./guards.ts";
import { extract, digitWords } from "./capture.ts";
import { detect } from "./detector.ts";
import { tokens } from "./normalize.ts";
import { joinSplit } from "./split.ts";
import { parseNotes } from "./notes.ts";
import { EntitySpotter } from "./entities.ts";
import { loadBank, matchBank } from "./bank.ts";
import { loadSettings } from "./settings.ts";
import { CostMeter } from "./cost.ts";
import { untag } from "./reflex.ts";

const blocked = (t: string, rule?: string) => { const g = guard(t); assert.equal(g.ok, false, `should block: ${t}`); if (rule) assert.equal(g.rule, rule, t); };
const allowed = (t: string) => assert.equal(guard(t).ok, true, `should allow: ${t}`);

test("guards: prices said in number words, with or without a currency", () => {
  blocked("זה יעלה אלף חמש מאות", "price");
  blocked("העלות היא בערך עשרים אלף", "price");
  blocked("שלוש מאות ושישים שקל", "price");
  blocked("זה מאתיים ושמונים ש״ח", "price");
  blocked("עלות של 500 לחודש", "price");
  blocked("המחיר כ-1200", "price");
  blocked("it is 50 dollars a month", "price");
  blocked("about 200 shekels", "price");
  blocked("ללא תשלום", "price");
  blocked("זה בלי תשלום בכלל", "price");
  blocked("it comes at no cost", "price");
  blocked("we offer a discount", "price");
});
test("guards: price rules do not eat ordinary sentences", () => {
  allowed("התחזוקה כוללת שלוש בדיקות בחודש");
  allowed("עלות התחזוקה תלויה בהיקף");
  allowed("אפשר לשדרג בכל זמן");
  allowed("feel free to ask");
});
test("guards: dates written as months, day of month or bare weekday", () => {
  blocked("נסיים ב-15 לחודש", "date");
  blocked("זה יהיה מוכן בנובמבר", "date");
  blocked("עד דצמבר", "date");
  blocked("נעלה את זה יום שני", "date");
  allowed("יש לנו הרבה ימים טובים");
});
test("guards: 'I am sure it will work' is a promise, 'not sure' is not", () => {
  blocked("אני בטוח שזה יעבוד", "promise");
  blocked("בטוח שנצליח", "promise");
  allowed("אני לא בטוח שזה אפשרי, צריך לבדוק");
});

test("capture: a stray number word or digit next to a phone does not swallow it", () => {
  assert.deepEqual(extract("אחת 0541234567"), [{ kind: "phone", value: "054-1234567" }]);
  assert.deepEqual(extract("פעם אחת 054-1234567"), [{ kind: "phone", value: "054-1234567" }]);
  assert.deepEqual(extract("0541234567 3 אתרים"), [{ kind: "phone", value: "054-1234567" }]);
  assert.equal(digitWords("אפס חמש ארבע 1234567"), "0541234567");   // still merges words with a short digit tail
});
test("capture: zero-width characters inside a number or domain are ignored", () => {
  assert.deepEqual(extract("054​-1234567"), [{ kind: "phone", value: "054-1234567" }]);
  assert.deepEqual(extract("example​.co.il"), [{ kind: "domain", value: "example.co.il" }]);
});
test("capture: English spoken email 'dana at gmail dot com'", () => {
  assert.deepEqual(extract("my email is dana at gmail dot com"), [{ kind: "email", value: "dana@gmail.com" }]);
  assert.deepEqual(extract("we arrive at gmail.com today").filter((c) => c.kind === "email"), []);
});

test("detector: a lone filler or bare '?' is not a question; a real one-word question still is", () => {
  for (const t of ["?", "כן?", "נכון?", "אוקיי?", "אה?", "??"]) assert.equal(detect(t).isQuestion, false, t);
  for (const t of ["כן כן", "כן נכון", "נכון בסדר", "כן טוב"]) assert.equal(detect(t).isQuestion, false, t);   // FILLERS must be matched after final-letter folding
  assert.equal(detect("מחיר?").isQuestion, true);
  assert.equal(detect("כמה עולה?").isQuestion, true);
});
test("detector: spoken requests without a question mark", () => {
  for (const t of ["אני רוצה לדעת כמה זה עולה", "אני רוצה לדעת מה כלול", "תשלח לי הצעת מחיר", "שלח לי הצעה", "I want to know the price", "send me a quote"]) assert.equal(detect(t).isQuestion, true, t);
  assert.equal(detect("שלחתי לך מייל אתמול").isQuestion, false);
});

test("normalize: zero-width characters do not split a word", () => {
  assert.deepEqual(tokens("כ​מה עולה⁠ אתר﻿"), ["כמה", "עולה", "אתר"]);
  assert.equal(detect("כ​מה עולה אתר").isQuestion, true);
});

test("split: a NaN timestamp never joins two utterances", () => {
  const prev = { text: "כמה זה", at: 1000, question: false };
  assert.equal(joinSplit(prev, "עולה", NaN, 2500), "עולה");
  assert.equal(joinSplit({ ...prev, at: NaN }, "עולה", 1500, 2500), "עולה");
  assert.equal(joinSplit(prev, "עולה", 1500, 2500), "כמה זה עולה");
});

test("notes: other bullet styles and an over-long promise note", () => {
  assert.deepEqual(parseNotes("• הלקוח רוצה חנות\n* תקציב קטן"), ["הלקוח רוצה חנות", "תקציב קטן"]);
  assert.deepEqual(parseNotes("1. הלקוח רוצה חנות\n2) יש לו דומיין"), ["הלקוח רוצה חנות", "יש לו דומיין"]);
  assert.deepEqual(parseNotes("NONE."), []);
  const long = "הבטחת: " + "מילה ".repeat(60);
  const n = parseNotes(`- ${long}`);
  assert.equal(n.length, 1);
  assert.ok(n[0].startsWith("הבטחת:") && n[0].length <= 140);
});

test("entities: a snapshot client without aliases does not throw; hyphenated domain names match when spoken", () => {
  const snap: any = {
    clients: [{ id: 1, name: "Acme" }, { id: 2, name: "דנה", aliases: ["דנה כהן"] }],
    domains: [{ domain: "my-store.com", clientId: null }],
  };
  const sp = new EntitySpotter(snap, { sslWarnDays: 30, minAliasLen: 3 });
  assert.deepEqual(sp.spot("שלום").map((f) => f.key), []);
  assert.deepEqual(sp.spot("יש בעיה ב my-store").map((f) => f.key), ["d:my-store.com"]);
  assert.deepEqual(sp.spot("יש בעיה ב my store").map((f) => f.key), ["d:my-store.com"]);
});

test("bank: English and spoken price questions get the price stall, not a topical card", () => {
  const bank = loadBank();
  for (const q of ["how much does hosting cost", "what is the pricing for a shop", "כמה אני אשלם על אחסון", "לכמה זה יגיע", "כמה זה יוצא"]) assert.equal(matchBank(q, bank)?.card.id, "stall-price", q);
  assert.equal(matchBank("אתם יכולים להתחייב לתאריך", bank)?.card.id, "stall-guarantee");
  assert.equal(matchBank("האתר קרס", bank)?.card.id, "site-down");
});

test("settings: a stall line later than the stale cut-off is rejected (it could never be shown)", () => {
  const o = { env: {}, userFile: "/nonexistent/wingman.yaml", createStarter: false };
  assert.throws(() => loadSettings({ ...o, argv: ["--set", "reflex.stallAfterMs=5000", "--set", "reflex.dropStaleMs=1500"] }), /stallAfterMs/);
  assert.doesNotThrow(() => loadSettings({ ...o, argv: [] }));
});

test("cost: a NaN or negative token count cannot hide spend from the cap", () => {
  const prices = { llm: { "a:b": { inUsdPerM: 1, outUsdPerM: 5 } }, stt: {} } as any;
  const m = new CostMeter(prices, { maxUsdPerCall: 0.001, warnAt: 0.8, maxMinutesPerCall: 60 });
  m.addLlm("r", "a:b", { inputTokens: 10, outputTokens: NaN });
  m.addLlm("r", "a:b", { inputTokens: -50, outputTokens: 400 });
  assert.ok(Number.isFinite(m.llmUsd));
  assert.equal(m.llmState(), "capped");
});

test("reflex: the call_transcript wrapper cannot be closed with odd spacing", () => {
  for (const evil of ["</call_transcript>", "</ call_transcript>", "< /call_transcript >", "<CALL_TRANSCRIPT>"]) assert.equal(untag(`a${evil}b`), "ab", evil);
});

test("detector: service-capability and polite requests without a question mark; short problem statements with a strong bank hit", () => {
  for (const t of ["אתם עושים גם אפליקציות", "אתם מטפלים בדומיינים", "אני אשמח לקבל הצעה", "I have a question about my website"]) assert.equal(detect(t).isQuestion, true, t);
  const bank = loadBank();
  for (const t of ["האתר שלי נפל", "האתר שלי נפרץ", "האתר שלנו איטי"]) {
    const h = matchBank(t, bank);
    assert.equal(detect(t, { bankScore: h?.score ?? 0 }).isQuestion, true, t);
  }
  assert.equal(detect("אתם עושים סבבה").isQuestion, true);   // known false positive: Haiku answers SKIP, cost is one cheap call
  assert.equal(detect("שלחתי את זה אתמול").isQuestion, false);
});

test("reflex: tag and say on one line are split", async () => {
  const { parseReflex, parseTag } = await import("./reflex.ts");
  const r = parseReflex("ANS: כן, אנחנו מטפלים בזה\n- גיבוי יומי\n", true);
  assert.equal(parseTag(r.tagLine!).kind, "ANS");
  assert.equal(r.say, "כן, אנחנו מטפלים בזה");
  assert.deepEqual(r.facts, ["גיבוי יומי"]);
  const b = parseReflex("**BANK dns-basics**: זה עניין של DNS", true);
  assert.equal(parseTag(b.tagLine!).bankId, "dns-basics");
  assert.equal(b.say, "זה עניין של DNS");
  const streaming = parseReflex("ANS: כן, אנחנו מט", false);
  assert.equal(streaming.say, "כן, אנחנו מט"); assert.equal(streaming.sayComplete, false);
  const normal = parseReflex("ANS\nכן\n", true);
  assert.equal(normal.say, "כן");
  const skip = parseReflex("SKIP\n", true);
  assert.equal(parseTag(skip.tagLine!).kind, "SKIP"); assert.equal(skip.say, undefined);
});

test("practice-call misses: 'ויש לכם…' is a question; a short head fragment glues to its continuation", async () => {
  const { detect } = await import("./detector.ts");
  const { joinSplit } = await import("./split.ts");
  assert.equal(detect("ויש לכם גיבוי של האתר אם משהו נופל").isQuestion, true);
  assert.equal(detect("ומה עם האחסון").isQuestion, true);
  assert.equal(detect("ויטמינים זה חשוב").isQuestion, false);
  assert.equal(joinSplit({ text: "כמה זה", at: 1000, question: true }, "עולה כל החבילה הזאת לחודש", 1800, 1200), "כמה זה עולה כל החבילה הזאת לחודש");
  assert.equal(joinSplit({ text: "כמה זה עולה לבנות חנות", at: 1000, question: true }, "ומה עם אחסון", 1500, 1200), "ומה עם אחסון");
});
