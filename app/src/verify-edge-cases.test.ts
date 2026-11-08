// Edge cases of the rubric judge and verdict parser. No network.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSplit } from "../qa/golden-load.ts";
import { rubricJudge, parseVerdict } from "../qa/judge.ts";
import type { Golden } from "../qa/grade-golden.ts";

test("rubric judge: a meeting with no cards or no lines does not throw", () => {
  const g = loadSplit("dev")[0] as Golden;
  assert.equal(rubricJudge(g, []).summary.rate, 1);
  const empty = { ...g, lines: [], moments: [], silent: [] } as Golden;
  const r = rubricJudge(empty, [{ atMs: 10, kind: "answer", text: "hello there friend" }]);
  assert.equal(r.verdicts[0].window, false);
});

test("rubric judge: cards given out of order are judged by time", () => {
  const g = loadSplit("dev")[0] as Golden;
  const r = rubricJudge(g, [
    { atMs: 90_000, kind: "prompt", text: "same words again for the card" },
    { atMs: 80_000, kind: "prompt", text: "same words again for the card" },
  ]);
  assert.equal(r.verdicts[0].card, 0);
  assert.equal(r.verdicts[1].fresh, false);
});

test("parseVerdict: junk, mixed case and empty input", () => {
  assert.equal(parseVerdict("").good, false);
  assert.equal(parseVerdict("verdict: GOOD\nreason: fine").good, true);
  assert.equal(parseVerdict("VERDICT: goodness").good, false);
  assert.match(parseVerdict("maybe").reason, /unreadable/);
});
