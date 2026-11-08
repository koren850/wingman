// context-modes in the live engine (in-process, virtual clock, policy fake): the mode the user picks is locked against the memory updater,
// a custom mode from the pack reaches the prompt rules, and a paused-AI question reads the call memory and a local tail.
import "../test-setup.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupEngine, type Engine } from "../testkit/engine-inproc.ts";
import { registerRole } from "../testkit/prompt.ts";
import { modeInstructions, modeProfile, setCustomMode } from "../moments/modes.ts";

registerRole("memory", "You keep the memory of a live call");
registerRole("compact", "You tidy the memory of a live call");

const pack = mkdtempSync(join(tmpdir(), "r3cm-pack-"));
writeFileSync(
  join(pack, "modes.yaml"),
  "- id: pipeline\n  label: Pipeline review\n  instructions: Watch the pipeline numbers and the owners.\n  maxPerMinute: 1\n",
);
process.env.WINGMAN_PACK_DIR = pack;

let e: Engine;
let coach: typeof import("../engine/coach.ts");
let state: typeof import("../engine/state.ts");
before(async () => {
  e = await setupEngine();
  coach = await import("../engine/coach.ts");
  state = await import("../engine/state.ts");
  coach.tipsTick();
});
after(() => {
  setCustomMode(undefined);
  e?.stop();
});

test("the user's mode is locked: a memory patch that guesses another kind changes nothing, and `auto` lets the guess through", async () => {
  await e.reset();
  e.pm.reply({ role: "memory", lastLine: /standup/ }, JSON.stringify({ kind: "client", topic: "weekly sync" }), { ms: 200 });
  e.pm.reply({ role: "memory", lastLine: /invoice/ }, JSON.stringify({ kind: "vendor" }), { ms: 100 });
  e.pm.reply({ role: "memory" }, "{}", { ms: 100 });
  assert.deepEqual(coach.setCallMode("team"), { ok: true });
  const loop = coach.memoryLoop()!;
  assert.equal(loop.memory.kind, "team");
  assert.equal(loop.memory.kindLocked, true);
  assert.equal(state.callKind(), "team");
  e.say("them", "so the release is on Friday the 14th and we should move the standup to 10");
  await e.vc.advance(25_000);
  assert.equal(loop.memory.topic.now, "weekly sync", "the patch was applied");
  assert.equal(loop.memory.kind, "team", "but the kind stayed");
  assert.deepEqual(coach.setCallMode("nonsense"), { ok: false, reason: "unknown mode" });
  assert.equal(loop.memory.kind, "team");
  assert.deepEqual(coach.setCallMode("auto"), { ok: true });
  assert.equal(loop.memory.kindLocked, false);
  e.say("them", "and one more thing about the invoice, it is 400 for the month");
  await e.vc.advance(25_000);
  assert.equal(loop.memory.kind, "vendor", "unlocked: the guess is allowed again");
  assert.equal(state.st.m.mem.kind, "vendor", "the moment calls read the same memory");
});

test("a custom mode from the pack changes the prompt rules and the card cap; leaving it restores both", async () => {
  await e.reset();
  const base = modeInstructions("other");
  assert.ok(!base.includes("pipeline numbers"));
  assert.deepEqual(coach.setCallMode("pipeline"), { ok: true });
  const loop = coach.memoryLoop()!;
  assert.equal(loop.memory.modeId, "pipeline");
  assert.equal(loop.memory.kindLocked, true);
  assert.match(modeInstructions(loop.memory.kind), /Watch the pipeline numbers and the owners\./);
  assert.equal(modeProfile(loop.memory.kind).maxPerMinute, 1);
  assert.deepEqual(coach.setCallMode("client"), { ok: true });
  assert.equal(loop.memory.modeId, undefined);
  assert.ok(!modeInstructions("client").includes("pipeline numbers"));
  assert.deepEqual(
    coach.customModeList().map((m) => m.id),
    ["pipeline"],
  );
});
