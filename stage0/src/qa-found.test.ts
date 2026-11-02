// Regressions found by the synthetic QA harness (qa/): see qa/report.md.
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
  assert.equal(b.tagLine, "ANS"); assert.equal(b.say, "תשובה קצרה");
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
  for (const q of ["How long will it take?", "Great. How long will it take", "when will it be ready"]) assert.equal(matchBank(q, bank)?.card.id, "stall-timeline", q);
});

test("qa: 'היי דן, כמה שאלות מהירות' is an opener, 'כמה שאלות יש' stays out too, 'כמה זה עולה' is a question", () => {
  assert.equal(detect("היי דן כמה שאלות מהירות").isQuestion, false);
  assert.equal(detect("כמה זה עולה").isQuestion, true);
});
