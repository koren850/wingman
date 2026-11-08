// Round 2 modes in the real engine modules, on the virtual clock and the policy fake model: each mode puts its text in the moment and observer prompts,
// applies its profile to the cards, and a silent window stays silent. The standup shows one time-left card at the planned length and none before.
// No real model, no network, no real time.
import "../test-setup.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupEngine, type Engine } from "../testkit/engine-inproc.ts";
import { modeInstructions, modeProfile } from "../moments/modes.ts";
import type { MemoryKind } from "../session/types.ts";

let e: Engine;
before(async () => {
  e = await setupEngine();
});
after(() => e?.stop());

const reply = (tag: string, say: string, value = 3, aim = "me") => `${tag}\nVALUE: ${value}\nAIM: ${aim}\nSAY: ${say}\nWHY: test`;
const calls = (role: string) => e.pm.callsFor(role);
const setKind = (kind: MemoryKind) => void (e.st.m.mem = { ...e.st.m.mem, kind });
const MODES: MemoryKind[] = ["client", "support", "team", "personal", "consult"];

for (const kind of MODES) {
  test(`mode ${kind}: the moment and observer prompts carry the mode text`, async () => {
    await e.reset();
    setKind(kind);
    e.pm.reply({ role: "moment" }, reply("ANS", "The contract owner is the finance lead", 3), { ms: 300 });
    e.say("them", "Who is the owner of the contract on your side?");
    await e.vc.advance(1500);
    assert.equal(calls("moment").length, 1);
    assert.ok(calls("moment")[0].view.system.includes(modeInstructions(kind)), "mode text in the moment prompt");
    assert.ok(
      e.screen().some((c) => /finance lead/.test(String(c.say))),
      JSON.stringify(e.screen()),
    );
    // the observer
    await e.reset();
    setKind(kind);
    e.pm.reply({ role: "observer" }, "SKIP\nWHY: nothing", { ms: 200 });
    e.say("them", "We talked about the rollout plan for the whole region and who owns the next steps.");
    await e.vc.advance(4000);
    assert.ok(calls("observer").length >= 1);
    assert.ok(calls("observer")[0].view.system.includes(modeInstructions(kind)), "mode text in the observer prompt");
    setKind("other");
  });

  test(`mode ${kind}: a silent window stays silent`, async () => {
    await e.reset();
    setKind(kind);
    e.pm.reply({ role: "observer" }, "SKIP\nWHY: small talk", { ms: 200 });
    e.pm.reply({ role: "moment" }, "SKIP\nWHY: small talk", { ms: 200 });
    e.say("them", "Good morning, how was the weekend? Mine was quiet, we mostly stayed home.");
    e.say("me", "Fine, thank you. The weather was nice for a walk.");
    await e.vc.advance(8000);
    assert.equal(e.screen().length, 0, JSON.stringify(e.screen()));
    setKind("other");
  });
}

test("mode profiles: a value 1 PROMPT is only a chip in every mode (the precision rule); a one-to-one needs value 3 for a card", async () => {
  const shown = async (kind: MemoryKind, tag: string, value: number) => {
    await e.reset();
    setKind(kind);
    e.pm.reply({ role: "observer" }, reply(tag, "Ask who decides on the budget", value), { ms: 200 });
    e.say("them", "We talked about the rollout plan for the whole region and who owns the next steps.");
    await e.vc.advance(4000);
    const c = e.screen().find((x) => /decides on the budget/.test(String(x.say)));
    setKind("other");
    return !!c && !c.chip && !c.dim;
  };
  assert.equal(await shown("client", "PROMPT", 1), false, "the client mode lets value 1 through the minimum, but VALUE 1 never takes the hero");
  assert.equal(await shown("support", "PROMPT", 1), false);
  assert.equal(await shown("client", "PROMPT", 2), true);
  assert.equal(await shown("team", "PROMPT", 1), false);
  assert.equal(await shown("other", "PROMPT", 1), false);
  assert.equal(await shown("personal", "PROMPT", 2), false);
  assert.equal(await shown("personal", "PROMPT", 3), true);
});

test("mode profiles: the observer budget follows the mode and never goes above the setting", async () => {
  await e.reset();
  const per = () => (e.boot.observer as unknown as { cfg: { perMinute: number } }).cfg.perMinute;
  const setting = e.boot.S.moments.observerPerMinute;
  for (const kind of [...MODES, "other"] as MemoryKind[]) {
    await e.reset();
    setKind(kind);
    e.pm.reply({ role: "observer" }, "SKIP\nWHY: nothing", { ms: 100 });
    e.say("them", "We talked about the rollout plan for the whole region and who owns the next steps.");
    await e.vc.advance(2000);
    assert.equal(per(), Math.min(modeProfile(kind).observerPerMinute ?? setting, setting), kind);
  }
  setKind("other");
});

test("standup: one time-left card at the planned length and none before; the card is not repeated", async () => {
  await e.reset();
  const S = e.boot.S as unknown as { tips: { plannedMin: number } };
  const elapsedMin = () => (Date.now() - e.boot.callStart) / 60_000;
  S.tips.plannedMin = Math.ceil(elapsedMin()) + 10;
  const timeCards = () => e.screen().filter((c) => /planned/.test(String(c.say)));
  e.pm.reply({ role: "observer" }, "SKIP\nWHY: nothing", { ms: 100 });
  (await import("../engine/coach.ts")).tipsTick(); // starts the 1 s timer of the live-reading engine, as the engine's own tick does
  e.say("them", "Good morning everyone, let us start the standup, we have fifteen minutes for the whole team.");
  setKind("team"); // after the tick: the memory loop starts from a fresh memory
  await e.vc.advance(5 * 60_000);
  assert.equal(timeCards().length, 0, "five minutes in");
  await e.vc.advance(4 * 60_000);
  assert.equal(timeCards().length, 0, "still before the planned length");
  await e.vc.advance(2 * 60_000);
  assert.equal(timeCards().length, 1, JSON.stringify(e.screen()));
  assert.match(String(timeCards()[0].say), /minutes are up/);
  await e.vc.advance(10 * 60_000);
  assert.equal(timeCards().length, 1, "once");
  S.tips.plannedMin = 0;
  setKind("other");
});
