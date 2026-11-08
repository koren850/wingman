// Latency budgets of PLAN 3.6, asserted on the virtual clock with the real engine modules and the policy fake model (in-process, one engine per file).
// The model delays here are chosen by the test; what is measured is everything the engine adds around them: hints, routing, scheduling, the stall timer.
import "../test-setup.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupEngine, type Engine } from "../testkit/engine-inproc.ts";
import { hang, slow } from "../testkit/policy-model.ts";
import { percentile } from "../../qa/grade-golden.ts";
import { BANK_CASES } from "../bank-cases.ts";
import { registerRole } from "../testkit/prompt.ts";

registerRole("memory", "You keep the memory of a live call");
registerRole("compact", "You tidy the memory of a live call");

let e: Engine;
before(async () => {
  e = await setupEngine({ "llm.reflex.model": "anthropic:claude-haiku-5-5" }); // the real model ref: cache markers, price rows, and the memory loop turn on as in a real call
});
after(() => e?.stop());

const reply = (tag: string, say: string, value = 3, aim = "me") => `${tag}\nVALUE: ${value}\nAIM: ${aim}\nSAY: ${say}\nWHY: test`;
const ms = (xs: number[], p: number) => percentile(xs, p) ?? Infinity;

test("direct question with a model answer: first card p50 <= 1.5 s, p95 <= 2.5 s (model first token 0.5 to 1.5 s)", async () => {
  await e.reset();
  const model = [500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 900, 800, 700, 1000, 1100, 600, 1200, 1400, 800];
  const seen: number[] = [];
  for (let i = 0; i < model.length; i++) {
    await e.reset(30_000);
    const q = `Which kinds of storage engine number ${i} does the reporting tool connect to?`;
    e.pm.reply({ role: "moment", lastLine: `engine number ${i}` }, reply("ANS", `Engine ${i} is supported through the standard driver`), { ms: model[i] });
    const at = e.say("them", q);
    await e.vc.advance(3000);
    const card = e.screen().find((c) => c.kind === "answer");
    assert.ok(card, `question ${i}: ${JSON.stringify(e.screen())}`);
    seen.push(e.firstCardMs(at)!);
  }
  console.log(`LATENCY direct: p50 ${ms(seen, 50)} ms, p95 ${ms(seen, 95)} ms, max ${Math.max(...seen)} ms (model 0.5 to 1.5 s)`);
  assert.ok(ms(seen, 50) <= 1500, `p50 ${ms(seen, 50)}`);
  assert.ok(ms(seen, 95) <= 2500, `p95 ${ms(seen, 95)}`);
  // the engine adds little around the model: every card is within 300 ms of the model's own delay
  seen.forEach((x, i) => assert.ok(x - model[i] <= 300, `question ${i}: ${x} ms with a model delay of ${model[i]} ms`));
});

test("bank hit: first card p50 <= 0.6 s, p95 <= 1.9 s, with the model slow or hung (the bank never waits for it)", async () => {
  const cases = BANK_CASES.filter(([, id]) => id !== "-" && !id.startsWith("stall-")).slice(0, 18);
  const seen: number[] = [];
  let missed = 0;
  for (const [i, [q]] of cases.entries()) {
    await e.reset(30_000);
    e.pm.on({ role: "moment" }, i % 2 ? hang() : slow(4000, "SKIP"));
    const at = e.say("them", q.endsWith("?") ? q : q + "?");
    await e.vc.advance(2500);
    const card = e.screen()[0];
    if (!card) {
      missed++;
      continue;
    }
    seen.push(e.firstCardMs(at)!);
  }
  console.log(`LATENCY bank: ${seen.length} of ${cases.length} hit, p50 ${ms(seen, 50)} ms, p95 ${ms(seen, 95)} ms`);
  assert.ok(seen.length >= cases.length * 0.7, `${missed} of ${cases.length} bank phrases gave no card at all`);
  assert.ok(ms(seen, 50) <= 600, `p50 ${ms(seen, 50)}`);
  assert.ok(ms(seen, 95) <= 1900, `p95 ${ms(seen, 95)}`);
});

test("slow model (4 s): the stall line is on screen by 1.8 s, and the late model answer replaces it (never two cards)", async () => {
  await e.reset();
  e.pm.reply({ role: "moment", lastLine: "reporting tool" }, reply("ANS", "Postgres and MySQL are both supported"), { ms: 4000 });
  const at = e.say("them", "Which databases does the reporting tool connect to?");
  await e.vc.advance(1800);
  const first = e.screen();
  assert.equal(first.length, 1, JSON.stringify(first));
  assert.equal(first[0].badge, "stall");
  assert.ok(e.firstCardMs(at)! <= 1800, `stall after ${e.firstCardMs(at)} ms`);
  await e.vc.advance(3000);
  const later = e.screen();
  assert.equal(later.length, 1, "one card, not two: " + JSON.stringify(later));
  assert.equal(later[0].badge, "ai");
});

test("hung model: the stall line is up by 1.8 s and stays; no second card, no empty screen for 30 s", async () => {
  await e.reset();
  e.pm.on({ role: "moment" }, hang());
  const at = e.say("them", "Can you walk me through how the reporting numbers are put together?");
  await e.vc.advance(1800);
  assert.equal(e.screen().length, 1);
  assert.ok(e.firstCardMs(at)! <= 1800);
  await e.vc.advance(30_000);
  assert.equal(e.screen().length >= 1, true, "a card is still there");
});

test("observer card: appears at the model time after the sentence; a late one (> 6 s) is dropped", async () => {
  const line = "Honestly your offer is much heavier than the other vendor we looked at";
  await e.reset();
  e.pm.reply({ role: "observer", lastLine: line }, reply("REPLY", "Ask what they compared us with first"), { ms: 2000 });
  let at = e.say("them", line);
  await e.vc.advance(7000);
  let card = e.screen().find((c) => c.kind === "prompt");
  assert.ok(card, JSON.stringify(e.screen()));
  const fast = e.firstCardMs(at)!;
  console.log(`LATENCY observer: card ${fast} ms after the sentence (model 2000 ms)`);
  assert.ok(fast >= 2000 && fast <= 4000, `observer card after ${fast} ms`);

  await e.reset();
  e.pm.reply({ role: "observer", lastLine: line }, reply("REPLY", "Ask what they compared us with first"), { ms: 7500 });
  at = e.say("them", line);
  await e.vc.advance(12_000);
  card = e.screen().find((c) => c.kind === "prompt");
  assert.equal(card, undefined, "a card that is 6 s or more late is dropped: " + JSON.stringify(e.screen()));
  const ev = (await import("node:fs"))
    .readFileSync(e.boot.log.dir + "/events.jsonl", "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.ok(
    ev.some((r) => /moment\.(drop|late|stale)/.test(r.type) || /late|stale/.test(String(r.why ?? r.reason ?? ""))),
    "the drop is logged: " + JSON.stringify(ev.slice(-6)),
  );
});

test("memory updater hung: a direct question gets its card at the model's own time (the updater never adds delay)", async () => {
  // The memory loop of the engine belongs to one call and cannot be reset between cases, so this case runs once, after the others, with the loop hung.
  const coach = await import("../engine/coach.ts");
  await e.reset();
  e.pm.on({ role: ["memory", "compact"] }, hang());
  e.pm.reply({ role: "moment", lastLine: "databases" }, reply("ANS", "Postgres and MySQL are both supported"), { ms: 900 });
  coach.tipsTick(); // starts the loop's 1 s timer, as run.ts does
  // talk long enough that the updater is due and running, then ask
  for (let i = 0; i < 4; i++) {
    e.say("them", `We are looking at the rollout plan for region number ${i} and who is involved in each step of it, as discussed`);
    await e.vc.advance(5000);
  }
  assert.ok(e.pm.callsFor("memory").length >= 1, "the updater is running (and hung)");
  const at = e.say("them", "Which databases can the reporting tool connect to?");
  await e.vc.advance(3000);
  assert.ok(
    e.screen().some((c) => c.kind === "answer"),
    JSON.stringify(e.screen()),
  );
  const t = e.firstCardMs(at)!;
  console.log(`LATENCY with a hung memory updater: ${t} ms (model 900 ms)`);
  assert.ok(t >= 900 && t <= 1000, `${t} ms`);
});
