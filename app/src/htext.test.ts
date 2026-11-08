import { test } from "node:test";
import assert from "node:assert/strict";
import { ht, reasonText, HKEYS } from "./htext.ts";
import { decide, NO_SIGNALS } from "./health.ts";
import { diskText } from "./diskspace.ts";

const HEB = /[֐-׿]/;
const P = {
  why: " (x)",
  err: "e",
  ch: "c",
  sec: 3,
  name: "n",
  from: "a",
  to: "b",
  mb: 5,
  min: 4,
  line: "l",
  limit: 3,
  dev: "d",
  bankOnly: "1",
  n: 2,
  v: "s1",
  date: "2026-01-01",
  said: "4000 USD",
  ref: "5000 USD",
};

test("every status text exists in both languages, fills its placeholders and is in the right script", () => {
  const keys = HKEYS;
  assert.ok(keys.length > 30);
  for (const k of keys) {
    const he = ht("he", k, P),
      en = ht("en", k, P);
    assert.ok(he && en, k);
    assert.doesNotMatch(he + en, /undefined|\[object/, k);
    assert.doesNotMatch(en, HEB, `${k}: English text has Hebrew`);
    if (k.includes("(--no-ai)")) continue;
    assert.match(he, HEB, k);
  }
});

test("ladder reasons are translated; unknown reasons pass through", () => {
  const all = [
    ...decide({ ...NO_SIGNALS, themDead: true, llmSlow: true }).reasons,
    "AI slow",
    "STT slow",
    "AI rate-limited/overloaded",
    "reflex on fallback model",
    "STT on fallback provider",
    "no LLM provider usable",
    "LLM budget cap reached",
    "bank or detector failed",
  ];
  for (const r of all) {
    assert.match(reasonText("he", r), HEB, r);
    assert.doesNotMatch(reasonText("en", r), HEB, r);
  }
  assert.equal(reasonText("en", "consent withdrawn"), "consent withdrawn");
});

test("diskText and the default language", () => {
  assert.match(diskText("red", 50 * 1024 * 1024), HEB);
  assert.match(diskText("red", 50 * 1024 * 1024, "en"), /^Almost no disk space \(50 MB free\)/);
  assert.match(ht(undefined, "quiet"), HEB, "unknown language = Hebrew");
});
