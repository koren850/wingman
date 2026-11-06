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
