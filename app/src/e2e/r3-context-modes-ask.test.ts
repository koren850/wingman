// r3-context-modes: the legacy / paused-AI question path (engine/question.ts askModel) reads the call memory and a size-based local tail.
// It no longer sends the last 12 transcript lines and no call frame. In-process, virtual clock, policy fake.
import "../test-setup.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupEngine, type Engine } from "../testkit/engine-inproc.ts";
import { emptyMemory } from "../session/types.ts";
import { applyPatch } from "../session/patch.ts";

let e: Engine;
before(async () => {
  e = await setupEngine({ "moments.engine": "legacy" });
});
after(() => e?.stop());

test("legacy question: the reflex prompt holds the call memory and more than 12 short lines of tail", async () => {
  await e.reset();
  const state = await import("../engine/state.ts");
  const m = applyPatch(emptyMemory(0), { topic: "Move the shop", add: { facts: [{ text: "The shop has 400 products and a small blog" }] } }, { now: 1 });
  assert.ok(m.applied);
  state.st.m.mem = m.mem;
  e.pm.reply({}, "SKIP", { ms: 100 });
  for (let i = 0; i < 20; i++) {
    e.say("them", `short filler line number ${i} about the plan`);
    await e.vc.advance(1500);
  }
  e.say("them", "How long will the whole migration take for you?");
  await e.vc.advance(4000);
  const calls = e.pm.calls.filter((c) => /How long will the whole migration/.test(c.view.user));
  assert.ok(calls.length >= 1, "a reflex call was made: " + e.pm.calls.map((c) => c.view.role).join());
  const user = calls[0].view.user;
  assert.match(user, /<call_memory>/);
  assert.match(user, /The shop has 400 products/);
  assert.match(user, /filler line number 19 /, "newest line");
  assert.match(user, /filler line number 5 /, "far more than the last 12 lines");
  assert.match(user, /What the call has taught Wingman so far/);
  assert.doesNotMatch(user, /Call frame/, "no old frame text");
});
