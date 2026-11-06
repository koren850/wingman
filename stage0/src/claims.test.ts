import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaim, spokenNumbers, checkClaims, tooBig } from "./claims.ts";

const claims = ["4+ years of full-stack work", "30+ client sites", "3+ juniors mentored", "60+ MCP tools"].map((c) => parseClaim(c)!);

test("parseClaim reads number, plus and unit", () => {
  assert.deepEqual(parseClaim("30+ client sites"), { text: "30+ client sites", value: 30, plus: true, unit: "sites" });
  assert.equal(parseClaim("4+ years")!.unit, "years");
  assert.equal(parseClaim("no numbers here"), undefined);
});

test("spoken numbers from real interview lines", () => {
  assert.deepEqual(spokenNumbers("יש לנו מעל 70 80 לקוחות בפרודקשן"), [
    { unit: "customers", n: 70 },
    { unit: "customers", n: 80 },
  ]);
  assert.deepEqual(spokenNumbers("לפי דעתי מעל 100 אתרים"), [{ unit: "sites", n: 100 }]);
  assert.deepEqual(spokenNumbers("כבר חמש שנים בתחום"), [{ unit: "years", n: 5 }]);
});

test("checkClaims flags inflated numbers only", () => {
  assert.equal(checkClaims("מעל 100 אתרים לפרודקשן", claims)?.claim.text, "30+ client sites");
  assert.equal(checkClaims("70 80 לקוחות", claims), undefined); // no customers claim: nothing to compare
  assert.equal(checkClaims("בניתי 35 אתרים", claims), undefined); // within 30+
  assert.equal(checkClaims("4 שנים בפרודקשן", claims), undefined);
  assert.equal(checkClaims("חמש שנים", claims), undefined); // 4+ allows 5
  assert.equal(checkClaims("שש שנים", claims)?.unit, "years");
  assert.equal(checkClaims("I mentored 10 juniors", claims)?.unit, "juniors");
});

test("tooBig: exact claims allow nothing else", () => {
  assert.equal(tooBig(5, { text: "4 years", value: 4, plus: false, unit: "years" }), true);
  assert.equal(tooBig(4, { text: "4 years", value: 4, plus: false, unit: "years" }), false);
});
