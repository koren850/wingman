// Every language pack must implement every field, and the safety-critical guard families must not be empty.
// A language cannot ship without price, date and promise guards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LANGUAGES, he, en } from "./lang/index.ts";
import { guard } from "./guards.ts";
import { detect } from "./detector.ts";

const ARRAY_FIELDS = [
  "questionHeads",
  "questionPhrases",
  "requestCues",
  "notQuestionOpeners",
  "fillers",
  "fillerPatterns",
  "timeAskPatterns",
  "sendPhrases",
  "sendThings",
  "sendStopWords",
  "intentWords",
  "intentPatterns",
  "interjections",
  "confirmWords",
] as const;

test("lang: the registry lists he and en with unique ids", () => {
  assert.deepEqual(
    LANGUAGES.map((l) => l.id),
    ["he", "en"],
  );
});

test("lang: every language implements every field", () => {
  for (const l of LANGUAGES) {
    assert.equal(typeof l.numberWords, "string", `${l.id}.numberWords`);
    assert.ok(l.numberWords.length > 0, `${l.id}.numberWords is empty`);
    for (const f of ARRAY_FIELDS) assert.ok(Array.isArray(l[f]), `${l.id}.${f} must be an array`);
    for (const f of ["price", "date", "promise", "salaryFigure"] as const) assert.ok(Array.isArray(l.guards[f]), `${l.id}.guards.${f} must be an array`);
    assert.ok(l.guards.salaryWords instanceof RegExp, `${l.id}.guards.salaryWords`);
  }
});

test("lang: guard families are never empty, so a new language cannot skip the safety rules", () => {
  for (const l of LANGUAGES) {
    for (const f of ["price", "date", "promise", "salaryFigure"] as const) assert.ok(l.guards[f].length > 0, `${l.id}.guards.${f} is empty`);
    assert.ok(l.questionHeads.length > 0, `${l.id}.questionHeads is empty`);
    assert.ok(l.requestCues.length > 0, `${l.id}.requestCues is empty`);
    assert.ok(l.fillers.length > 0, `${l.id}.fillers is empty`);
  }
});

test("lang: the guards and detector read the language packs (spot checks per language)", () => {
  assert.equal(guard("זה יעלה 500 שקל").rule, "price");
  assert.equal(guard("it costs 500 dollars").rule, "price");
  assert.equal(guard("נעלה את זה מחר").rule, "date");
  assert.equal(guard("we can do it tomorrow").rule, "date");
  assert.equal(guard("אני מבטיח שזה יעבוד").rule, "promise");
  assert.equal(guard("I guarantee it works").rule, "promise");
  assert.equal(detect("מה ההבדל בין שתי האפשרויות").isQuestion, true);
  assert.equal(detect("what is the difference between them").isQuestion, true);
  assert.equal(he.id, "he");
  assert.equal(en.id, "en");
});
