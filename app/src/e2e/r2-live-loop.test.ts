// The memory loop is wired to the moment engine in the live call (coach.ts), run in-process on the virtual clock with the policy fake:
//  - the memory topic label changes -> topicChanged() -> the observer looks at the call now
//  - the user's ratings in tags.jsonl -> applyFeedback() -> three "not useful" on REPLY raise the observer REPLY bar
// One engine per process: setupEngine() once, reset() between cases.
import "../test-setup.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { setupEngine, type Engine } from "../testkit/engine-inproc.ts";
import { registerRole } from "../testkit/prompt.ts";

registerRole("memory", "You keep the memory of a live call");
registerRole("compact", "You tidy the memory of a live call");

let e: Engine;
let coach: typeof import("../engine/coach.ts");
before(async () => {
  e = await setupEngine();
  coach = await import("../engine/coach.ts");
  coach.tipsTick(); // starts the v2 timer (memory loop, ratings reader) like run.ts does
});
after(() => e?.stop());

const reply = (tag: string, say: string, value = 3) => `${tag}\nVALUE: ${value}\nAIM: me\nSAY: ${say}\nWHY: test`;

test("a topic shift in the memory makes the observer look at the call now (no word list involved)", async () => {
  await e.reset();
  // patch 1 names the first topic, patch 2 changes it
  e.pm.reply({ role: "memory" }, JSON.stringify({ topic: "pricing", add: { numbers: [{ what: "price per seat", value: "400", who: "them" }] } }), {
    ms: 300,
    times: 1,
  });
  e.pm.reply({ role: "memory" }, JSON.stringify({ topic: "rollout plan" }), { ms: 300, times: 1 });
  e.pm.reply({ role: "memory" }, "{}", { ms: 200 });
  e.pm.reply({ role: "observer" }, reply("NOTE", "New topic: the rollout plan", 3), { ms: 200 });
  e.say("them", "the price is 400 per seat");
  await e.vc.advance(3000);
  assert.equal(e.pm.callsFor("memory").length, 1, "first patch");
  assert.equal(coach.memoryLoop()?.memory.topic.now, "pricing");
  const before = e.pm.callsFor("observer").length;
  await e.vc.advance(10_000); // past the 8 s gap
  e.say("them", "ok next"); // a short line: not worth an observer call by itself
  e.say("me", "and 20 seats");
  await e.vc.advance(3000);
  assert.equal(e.pm.callsFor("memory").length, 2, "second patch");
  assert.equal(coach.memoryLoop()?.memory.topic.now, "rollout plan");
  await e.vc.advance(2000);
  assert.ok(e.pm.callsFor("observer").length > before, "the observer ran after the topic changed");
});

test("ratings in tags.jsonl reach the moment engine: three 'not useful' on REPLY raise the observer REPLY bar", async () => {
  await e.reset();
  const lines = [
    "Honestly your offer is much heavier than the other vendor we looked at",
    "Frankly the rollout you described sounds slower than what we planned",
    "To be fair the support hours you listed are shorter than our current vendor",
  ];
  for (const [i, l] of lines.entries()) {
    e.pm.reply({ role: "observer", lastLine: l }, reply("REPLY", `Ask what they compared us with ${i}`, 2), { ms: 200 });
    e.say("them", l);
    await e.vc.advance(5000);
    const card = e.screen().find((c) => String(c.say).includes(`compared us with ${i}`));
    assert.ok(card, `card ${i} shows: ${JSON.stringify(e.screen().map((c) => c.say))}`);
    appendFileSync(e.boot.log.dir + "/tags.jsonl", JSON.stringify({ id: card.id, useful: "n" }) + "\n");
    await e.vc.advance(11_000); // the coach reads the file every 10 s
    await e.vc.advance(55_000); // a new minute and past the novelty window
  }
  const l4 = "Candidly the price you quoted is higher than the other bid we hold";
  e.pm.reply({ role: "observer", lastLine: l4 }, reply("REPLY", "Ask what the other bid includes", 2), { ms: 200 });
  e.say("them", l4);
  await e.vc.advance(5000);
  const c4 = e.screen().find((c) => String(c.say).includes("other bid includes"));
  assert.ok(!c4 || c4.dim === true, "held back as a chip: " + JSON.stringify(c4));
});
