// Offline checks for the QA grader helpers (used by src/detector-bank-qa.test.ts so `pnpm test` covers the harness too).
import assert from "node:assert/strict";
import { normWords, wordEdits } from "./grade.ts";

export function gradeFixtureCheck() {
  assert.deepEqual(normWords("שָׁלוֹם, עולם! WordPress?"), ["שלום", "עולם", "wordpress"]);
  assert.equal(wordEdits(["a", "b", "c"], ["a", "c"]), 1);
  assert.equal(wordEdits(["a", "b"], ["x", "y", "z"]), 3);
  assert.equal(wordEdits([], []), 0);
}
