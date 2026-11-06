// Table-driven coverage for the card guards: English and Hebrew prices, dates, promises and interview salary figures.
// A false hit only costs a stall line, but ordinary technical talk must still pass.
import test from "node:test";
import assert from "node:assert/strict";
import { guard, guardInterview } from "./guards.ts";
import { BLOCKED, ALLOWED, SALARY_BLOCKED, SALARY_ALLOWED } from "./guards-cases.ts";

test("guards table: prices, dates and promises in English and Hebrew are blocked with the right rule", () => {
  assert.ok(BLOCKED.length >= 70, `table size ${BLOCKED.length}`);
  const bad = BLOCKED.filter(([text, rule]) => guard(text).rule !== rule).map(([t, r]) => `${t} (want ${r}, got ${guard(t).rule})`);
  assert.deepEqual(bad, []);
});
test("guards table: ordinary sentences, versions, counts and hedges pass", () => {
  assert.ok(ALLOWED.length >= 40);
  assert.deepEqual(
    ALLOWED.filter((t) => !guard(t).ok),
    [],
  );
});

test("guardInterview table: salary figures in k form, spelled-out and Hebrew are blocked; technical counts pass", () => {
  assert.deepEqual(
    SALARY_BLOCKED.filter((t) => guardInterview(t).ok),
    [],
  );
  assert.deepEqual(
    SALARY_ALLOWED.filter((t) => !guardInterview(t).ok),
    [],
  );
});
