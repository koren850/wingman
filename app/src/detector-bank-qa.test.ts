// hint tests, in-sample, not product truth: these check the frozen word-list hint (detector.ts, bank.ts). The product decides with the model; see r3-moments-floor.test.ts for the floor.
// Detector, bank, reflex tag parsing and question split/merge cases found by the synthetic QA harness (qa/).
// The "qa2" tests cover the second replay run.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReflex, parseTag } from "./reflex.ts";
import { detect } from "./detector.ts";
import { loadBank, matchBank, modelMayOverrideBank } from "./bank.ts";
import { isBareQuestionTail, joinSplit } from "./split.ts";
import { gradeFixtureCheck } from "../qa/grade.test-helpers.ts";

test("qa: a hyphenated bank id alone on the tag line is not cut at the hyphen", () => {
  for (const id of ["stall-guarantee", "stall-price", "woo-payments", "dns-basics"]) {
    const p = parseReflex(`BANK ${id}\nsay line\n- fact\n`, true);
    assert.deepEqual(parseTag(p.tagLine!), { kind: "BANK", bankId: id });
    assert.equal(p.say, "say line");
  }
  // the say-line on the tag line still splits, with a colon or a spaced dash
  const a = parseReflex("BANK stall-price: המחיר תלוי\n", true);
  assert.deepEqual(parseTag(a.tagLine!), { kind: "BANK", bankId: "stall-price" });
  assert.equal(a.say, "המחיר תלוי");
  const b = parseReflex("ANS - תשובה קצרה\n", true);
  assert.equal(b.tagLine, "ANS");
  assert.equal(b.say, "תשובה קצרה");
});

test("qa: 'יש לנו / יש לי ...' is a statement, 'יש לכם ...' still a question", () => {
  assert.equal(detect("יש לנו בערך 150 מוצרים ואנחנו רוצים לקבל תשלום באשראי").isQuestion, false);
  assert.equal(detect("יש לי אתר בוורדפרס").isQuestion, false);
  assert.equal(detect("ויש לכם גיבוי של האתר").isQuestion, true);
  assert.equal(detect("יש גיבוי אוטומטי").isQuestion, true);
});

test("qa: 'לעלות' (go live) is not the price word 'עלות'", () => {
  const bank = loadBank();
  assert.equal(matchBank("אנחנו רוצים לעלות לפני החגים", bank), undefined);
  assert.equal(matchBank("מה העלות של החבילה", bank)?.card.id, "stall-price");
  assert.equal(matchBank("כמה זה עולה", bank)?.card.id, "stall-price");
});

test("qa grader: word accuracy and the stall rule", () => {
  gradeFixtureCheck();
});

test("qa: 'מתי החנות תהיה מוכנה' gets the timeline stall card, not a topical card", () => {
  const bank = loadBank();
  for (const q of ["מתי החנות תהיה מוכנה", "מתי האתר יהיה מוכן", "ומתי זה יהיה מוכן"]) assert.equal(matchBank(q, bank)?.card.id, "stall-timeline", q);
});

test("qa: 'אני צריך לענות לטלפון' is a statement; 'צריך להעביר את זה?' stays a question", () => {
  assert.equal(detect("אני צריך לענות לטלפון תחכה לי בבקשה").isQuestion, false);
  assert.equal(detect("אנחנו צריכים לעדכן משהו").isQuestion, false);
  assert.equal(detect("צריך לעדכן את התוספים").isQuestion, true);
  assert.equal(detect("אוקיי רגע יש לי מישהו בדלת").isQuestion, false);
});

test("qa: a split question whose tail ends in '?' is still joined (800-1200 ms pause)", () => {
  assert.equal(isBareQuestionTail("עולה לחודש?", "question-mark"), true);
  assert.equal(isBareQuestionTail("כמה עולה חנות כזאת עם כל התוספים?", "question-mark"), false);
  assert.equal(isBareQuestionTail("מה אפשר לעשות", "head:מה"), false);
  const prev = { text: "כמה זה", at: 1000, question: true };
  assert.equal(joinSplit(prev, "עולה לחודש?", 1900, 1200), "כמה זה עולה לחודש?");
  assert.equal(matchBank("כמה זה עולה לחודש?", loadBank())?.card.id, "stall-price");
});

test("qa: a price/timeline/guarantee bank hit cannot be replaced by a model answer or a topical card", () => {
  assert.equal(modelMayOverrideBank("stall-price", { kind: "ANS" }), false);
  assert.equal(modelMayOverrideBank("stall-price", { kind: "BANK", bankId: "site-slow" }), false);
  assert.equal(modelMayOverrideBank("stall-price", { kind: "BANK", bankId: "stall-price" }), true);
  assert.equal(modelMayOverrideBank("stall-price", { kind: "STALL" }), true);
  assert.equal(modelMayOverrideBank("stall-price", { kind: "SKIP" }), true);
  assert.equal(modelMayOverrideBank("backups", { kind: "ANS" }), true);
  assert.equal(modelMayOverrideBank(undefined, { kind: "ANS" }), true);
});

test("qa: English timeline questions get the timeline stall card", () => {
  const bank = loadBank();
  for (const q of ["How long will it take?", "Great. How long will it take", "when will it be ready"])
    assert.equal(matchBank(q, bank)?.card.id, "stall-timeline", q);
});

test("qa: 'היי דן, כמה שאלות מהירות' is an opener, 'כמה שאלות יש' stays out too, 'כמה זה עולה' is a question", () => {
  assert.equal(detect("היי דן כמה שאלות מהירות").isQuestion, false);
  assert.equal(detect("כמה זה עולה").isQuestion, true);
});

// Second QA run (replay fixes): the "qa2" tests below. Imports sit here, next to the tests that use them.
import { joinSplit as joinSplit2 } from "./split.ts";
import { matchBank as matchBank2, loadBank as loadBank2 } from "./bank.ts";
import { detect as detect2 } from "./detector.ts";
const bank2 = loadBank2();
import { splitMergedQuestions } from "./multiq.ts";
const cut = (s: string) => splitMergedQuestions(s, bank2);

test("qa2: fast questions merged into one final are cut, one card each", () => {
  const parts = cut("יש לכם גיבוי כמה זה עולה האתר איתי מה עושים");
  assert.deepEqual(parts, ["יש לכם גיבוי", "כמה זה עולה", "האתר איתי מה עושים"]); // the slow-site question gets its own card, not the price stall
  assert.deepEqual(
    parts.map((p) => matchBank2(p, bank2)?.card.id),
    ["backups", "stall-price", "site-slow"],
  );
  assert.deepEqual(cut("יש לכם גיבוי? כמה זה עולה? האתר איטי, מה עושים?"), ["יש לכם גיבוי?", "כמה זה עולה?", "האתר איטי, מה עושים?"]);
});
test("qa2: a problem plus one question stays whole", () => {
  assert.deepEqual(cut("האתר איטי, כמה זה יעלה לתקן?"), ["האתר איטי, כמה זה יעלה לתקן?"]);
  assert.deepEqual(cut("אנחנו רוצים להעביר את הדומיין, איך עושים את זה?"), ["אנחנו רוצים להעביר את הדומיין, איך עושים את זה?"]);
  for (const q of [
    "כמה עולה חנות כזאת?",
    "אני מבינה, אבל תגיד לי מספר בערך. כמה זה יעלה.",
    "בסדר. ומה אם התחזוקה חודשית כמה זה יוצא בחודש?",
    "ומתי החנות תהיה מוכנה",
    "אתם מתחייבים שזה יהיה מוכן בזמן?",
  ])
    assert.deepEqual(cut(q), [q]);
  for (const q of [
    "The site is really slow lately. Why is that happening?",
    "Do you have a backup of the site?",
    "What about the SSL certificate? Is it included?",
    "Can you move our domain to Cloudflare?",
  ])
    assert.deepEqual(cut(q), [q]);
});
test("qa2: STT 'תעודת הבטחה' is an SSL question, not a guarantee stall", () => {
  assert.equal(matchBank2("ומה עם תעודת הבטחה", bank2)?.card.id, "ssl-basics");
  assert.equal(matchBank2("אתם נותנים הבטחה שזה יעבוד?", bank2)?.card.id, "stall-guarantee");
});
test("qa2: certificate renewal gets the SSL card", () => {
  assert.equal(matchBank2("איך מחדשים את התעודה של האתר מי עושה את זה", bank2)?.card.id, "ssl-basics");
});
test("qa2: detector edge cases from the replay", () => {
  assert.equal(detect2("וואו איזה מזג אוויר היום").isQuestion, false);
  assert.equal(detect2("מצוין. נכון. כן, זה מה שחשבתי.").isQuestion, false);
  assert.equal(detect2("לא מה שהוא, האתר של המשרד נפל לבוקר.").isQuestion, false);
  assert.equal(detect2("אנחנו רוצים להעביר את הDNS Cloudflare, זה בטוח.").isQuestion, true);
  assert.equal(detect2("נכון שאתם עושים גם אחסון").isQuestion, true);
  assert.equal(detect2("אני לא בטוח").isQuestion, false);
  assert.equal(detect2("ואם מה שהוא נשבר, אפשר לשחזר").isQuestion, true);
  assert.equal(detect2("בדקתי את זה אתמול, כמובן שזה עבד").isQuestion, false);
  assert.equal(detect2("זה קצת מסובך אבל אני לא בטוח").isQuestion, false);
});
test("qa2: a two-word head that Deepgram ended with '?' still glues to its tail", () => {
  assert.equal(joinSplit2({ text: "כמה זה?", at: 1000, question: true }, "עולה לחודש?", 2000, 1500), "כמה זה? עולה לחודש?");
  assert.equal(joinSplit2({ text: "כמה זה עולה?", at: 1000, question: true }, "ומה עם אחסון", 1500, 1500), "ומה עם אחסון");
});
