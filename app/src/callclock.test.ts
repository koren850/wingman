// The test engine runs on a virtual clock that starts after boot.ts is imported. The call must still start on that clock: otherwise every elapsed-time rule
// (the wrap-up cue, the time-left card) sees a call that is years long, and a replay shows "Before you finish" cards in the first minute.
import "./test-setup.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupEngine, type Engine } from "./testkit/engine-inproc.ts";

let e: Engine;
before(async () => {
  e = await setupEngine();
});
after(() => e?.stop());

test("the call starts on the virtual clock, so elapsed minutes start at zero", async () => {
  const elapsedMin = () => (Date.now() - e.boot.callStart) / 60_000;
  assert.ok(Math.abs(elapsedMin()) < 0.01, `elapsed ${elapsedMin()} min right after start`);
  await e.vc.advance(90_000);
  assert.ok(Math.abs(elapsedMin() - 1.5) < 0.01, `elapsed ${elapsedMin()} min after 90 s`);
});
