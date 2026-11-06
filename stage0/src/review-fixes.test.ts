// Regression tests for the engine review (AUDIT-2026-11-06 / 7): one block per finding.
import "./test-setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { parseReflex } from "./reflex.ts";

test("reflex: a prose line before the tag does not become the tag while streaming", () => {
  assert.equal(parseReflex("Let me think about this\n", false).tagLine, undefined);
  assert.equal(parseReflex("Let me think about this\nANS\n", false).tagLine, "ANS");
  assert.equal(parseReflex("Let me think about this\nANS\nשלום\n", true).tagLine, "ANS");
  assert.equal(parseReflex("ANS\nשלום\n", false).tagLine, "ANS");
  assert.equal(parseReflex("Hmm\n", true).tagLine, "Hmm");   // the end of the stream decides (parseTag turns this into SKIP)
});

import { checkClaims, parseClaim, spokenNumbers } from "./claims.ts";
test("claims: a number belonging to a neighbouring unit is not attributed to the claimed unit", () => {
  const claims = [parseClaim("4+ years")!];
  for (const line of ["I managed 12 clients for 4 years", "I led 20 people over 4 years", "worked 6 months and 4 years", "I have 4.5 years of experience"])
    assert.equal(checkClaims(line, claims), undefined, line);
  assert.equal(checkClaims("I have 12 years of experience", claims)?.said, 12);
  assert.deepEqual(spokenNumbers("70-80 customers").map((x) => x.n), [70, 80]);
  assert.deepEqual(spokenNumbers("70 80 לקוחות").map((x) => x.n).sort(), [70, 80]);
});

import { CostMeter } from "./cost.ts";
test("cost: call minutes are per channel, not the sum of both channels", () => {
  const prices = { llm: {}, stt: { deepgram: 0.55 } } as never, budget = { maxUsdPerCall: 5, warnAt: 0.8, maxMinutesPerCall: 90 } as never;
  const c = new CostMeter(prices, budget);
  c.setSttSeconds({ deepgram: 7200 }, 2);   // 60 minute call, two channels
  assert.equal(c.sttMinutes, 60);
  assert.equal(c.minutesState(), "ok");
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBank, matchBank } from "./bank.ts";
test("bank loader: numeric triggers and ids are coerced to strings, an empty file is no cards", () => {
  const d = mkdtempSync(join(tmpdir(), "bank-"));
  writeFileSync(join(d, "bank.yaml"), `- id: 404\n  title: t\n  say: hello\n  triggers: [2024, hosting]\n  facts: []\n`);
  const bank = loadBank(join(d, "bank.yaml"));
  assert.equal(bank[0].id, "404");
  assert.deepEqual(bank[0].triggers, ["2024", "hosting"]);
  assert.doesNotThrow(() => matchBank("what about 2024 hosting", bank));
  writeFileSync(join(d, "empty.yaml"), "");
  assert.deepEqual(loadBank(join(d, "empty.yaml")), []);
});
