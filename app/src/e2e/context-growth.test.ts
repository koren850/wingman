// A two hour call through the real memory loop on the virtual clock with the policy fake: does the context stay inside its budget while the call
// grows, and is a fact from minute 5 still in what a model reads at minute 90?
//
// What the fake stands in for: the memory updater adds a few items a run (more than the lists can hold), and the compactor rewrites the summary every
// 6 minutes the way a faithful model does (it keeps what still matters). The code under test is everything else: the caps, the eviction order, the
// render and its trim order, buildContext and its budgets, the hourly limits of the loop.
// A real model's compaction is not tested here; the memory eval (qa/memory-eval.ts) and the cassettes are for that.
import "../test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { withVClock } from "../testkit/vclock.ts";
import { policyModel } from "../testkit/policy-model.ts";
import { registerRole } from "../testkit/prompt.ts";
import { MemoryLoop, DEFAULT_MEMORY_CONFIG, makeModelRunner, type MemoryRequest } from "../engine/memory.ts";
import { buildContext, type RawLine } from "../context/build.ts";
import { DEFAULT_BUDGETS, ROLES, estimateTokens, withSettings } from "../context/budget.ts";
import { CAPS } from "../session/caps.ts";
import { emptyMemory, type SessionMemory } from "../session/types.ts";
import { MEMORY_UPDATER_INSTRUCTIONS } from "../session/prompt.ts";
import type { ModelRegistry } from "../providers/llm.ts";

registerRole("memory", "You keep the memory of a live call");
registerRole("compact", "You tidy the memory of a live call");

const FACT = "The warehouse door code is 4471 and Noa keeps the cabinet key";
const FACT_LINE = "Just so you have it, the warehouse door code is 4471 and Noa keeps the cabinet key.";
const SUMMARY_WORDS = 190;
const summaryText = (topic: string) =>
  // a faithful compaction: the early fact stays, the newest topic is added, the rest is short
  `Call about the spring logistics plan. Early on: ${FACT}. Now we are on ${topic}. ` +
  Array.from({ length: SUMMARY_WORDS - 30 }, (_, i) => `note${i % 40}`).join(" ");
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Line i of the call: one every 6 seconds, 12 to 14 words, alternating sides, with the key line at minute 5. */
function lineAt(i: number): { side: "me" | "them"; name?: string; text: string } {
  if (i === 50) return { side: "them", name: "Maya", text: FACT_LINE };
  const t = `item${i} of the plan needs a check on the schedule for lane ${i % 17} and the crew for shift ${i % 5} before the next review`;
  return i % 2 ? { side: "me", text: t } : { side: "them", name: "Maya", text: t };
}

test("2 hour call: the memory and every prompt stay in budget, the summary stays under 250 words, a fact from minute 5 is read at minute 90", async () => {
  await withVClock(async (vc) => {
    const pm = policyModel({ strict: false, defaultText: "{}" });
    // The key line is learned by the first run that sees it.
    pm.reply(
      (v) => v.role === "memory" && v.user.includes("door code is 4471"),
      JSON.stringify({ add: { facts: [{ text: FACT, who: "Maya" }], numbers: [{ what: "door code", value: "4471", who: "Maya" }] } }),
      {
        ms: 300,
        times: 1,
      },
    );
    // Every other run adds more than the lists hold: 3 facts, a number, a promise, a question, a decision.
    for (let k = 0; k < 520; k++)
      pm.reply(
        { role: "memory" },
        JSON.stringify({
          add: {
            facts: [
              { text: `Detail ${k}a: lane ${k % 17} is blocked on Tuesdays` },
              { text: `Detail ${k}b: crew ${k % 5} starts late` },
              { text: `Detail ${k}c: review ${k}` },
            ],
            numbers: [{ what: `measure ${k}`, value: String(k), who: "Maya" }],
            commitments: [{ who: k % 2 ? "me" : "Maya", what: `send note ${k}` }],
            openQuestions: [{ asker: "Maya", text: `Is lane ${k} ready?` }],
            decisions: [{ text: `Decision ${k}: keep lane ${k % 17}` }],
          },
          ...(k % 10 === 0 ? { topic: `topic ${k / 10}` } : {}),
        }),
        { ms: 300, times: 1 },
      );
    // The compactor keeps the summary short and keeps the early fact.
    let compactions = 0;
    for (let k = 0; k < 40; k++) pm.reply({ role: "compact" }, JSON.stringify({ summary: summaryText(`part ${k}`) }), { ms: 500, times: 1 });
    const registry = { resolve: async () => pm.model } as unknown as ModelRegistry;
    const inner = makeModelRunner({ registry, model: "anthropic:claude-haiku-5-5", onUsage: () => {} });
    const seen: { role: string; tokens: number; ver: number }[] = [];
    const run = async (req: MemoryRequest) => {
      seen.push({ role: req.role, tokens: req.ctx.record.tokens, ver: req.ctx.record.memV });
      if (req.role === "compact") compactions++;
      return inner(req);
    };
    const start = emptyMemory(vc.now());
    const loop = new MemoryLoop({ now: () => vc.now(), run, save: () => {}, sendView: () => {}, log: () => {} }, { ...DEFAULT_MEMORY_CONFIG }, start);

    const at90: { mem?: SessionMemory; tail: RawLine[] } = { tail: [] };
    const tail: RawLine[] = [];
    const MINUTES = 120;
    let line = 0;
    for (let s = 1; s <= MINUTES * 60; s++) {
      await vc.advance(1000);
      if (s % 6 === 0) {
        const l = lineAt(line++);
        loop.addLine(l);
        tail.push({ side: l.side, text: l.text, ...(l.name ? { name: l.name } : {}) });
      }
      loop.tick();
      if (s === 90 * 60) at90.mem = structuredClone(loop.memory);
    }
    await vc.advance(2000);
    if (at90.mem) at90.tail = tail.slice(-40);

    // ---- the loop held its limits
    const runsOf = (role: string) => seen.filter((x) => x.role === role).length; // whole run (2 hours)
    assert.ok(runsOf("memory") <= 2 * DEFAULT_MEMORY_CONFIG.maxPerHour, `${runsOf("memory")} updater runs in 2 hours`);
    assert.ok(
      compactions >= 8 && compactions <= 2 * DEFAULT_MEMORY_CONFIG.maxCompactPerHour,
      `${compactions} compactions in 2 hours (at most one every 6 minutes)`,
    );
    assert.equal(loop.stats.dropped, 0, "no patch was dropped");
    assert.ok(loop.stats.applied > 100, `${loop.stats.applied} patches applied`);

    // ---- the prompts the loop built stayed inside the role budgets
    for (const x of seen) {
      const cap = DEFAULT_BUDGETS[x.role as "memory" | "compact"].total;
      assert.ok(x.tokens <= cap, `${x.role} prompt of ${x.tokens} tokens at memory version ${x.ver} is over ${cap}`);
    }

    // ---- the memory at the end: lists inside their caps, ids still rising, summary under 250 words
    const m = loop.memory;
    assert.ok(m.facts.length <= CAPS.facts && m.numbers.length <= CAPS.numbers && m.commitments.length <= CAPS.commitments, "lists inside their caps");
    assert.ok(m.openQuestions.length <= CAPS.openQuestions && m.decisions.length <= CAPS.decisions, "lists inside their caps");
    assert.ok(words(m.summary) <= CAPS.summaryWords, `summary of ${words(m.summary)} words`);
    assert.ok(m.seq && (m.seq.f ?? 0) > 1000 && (m.seq.n ?? 0) > 300, "ids are never reused: the counters ran far past the list sizes");

    // ---- the fact from minute 5 is gone from the fact list at minute 90 (the lists are full of newer items) but the summary carries it
    const mem90 = at90.mem!;
    assert.ok(!mem90.facts.some((f) => f.text.includes("4471")), "the fact was evicted from the list: the compactor's summary is what keeps it");
    assert.ok(mem90.summary.includes("4471"), "the summary at minute 90 has the fact");
    assert.ok(words(mem90.summary) <= 250);

    // ---- what every role reads at minute 90: the fact is there, the prompt is in budget
    const budgets = withSettings({ memoryTokens: DEFAULT_MEMORY_CONFIG.budgetTokens, rawTailTokens: DEFAULT_MEMORY_CONFIG.rawTailTokens });
    for (const role of ROLES.filter((r) => r !== "digest")) {
      const ctx = buildContext({
        role,
        roleInstructions: MEMORY_UPDATER_INSTRUCTIONS,
        memory: mem90,
        rawLines: at90.tail,
        trigger: "What was the door code again?",
        budgets,
        shared: { rules: "You are Wingman, a live meeting assistant.", profile: "Name: Lee. Logistics.", bankIndex: "price: Pricing" },
      });
      const system = ctx.system.map((b) => b.text).join("\n");
      assert.ok(system.includes("4471"), `${role}: the minute-5 fact is in what the model reads`);
      const total = ctx.record.tokens;
      assert.ok(total <= budgets[role].total, `${role}: ${total} tokens is over ${budgets[role].total}`);
      const mem = ctx.system.find((b) => b.name === "memory");
      assert.ok(mem && estimateTokens(mem.text) <= budgets[role].memory, `${role}: memory block inside its budget`);
      assert.match(mem!.text, /Summary so far:/);
    }
    // the render's own count and the loop's last view agree on the size class
    assert.ok(
      estimateTokens(
        buildContext({ role: "moment", roleInstructions: "x", memory: m, rawLines: [], trigger: "t", budgets })
          .system.map((b) => b.text)
          .join(""),
      ) <= budgets.moment.total,
    );
    loop.stop();
  });
});

test("a pinned fact (the user's own) is not evicted by the call's newer facts", async () => {
  // The other way to keep something for two hours: the user pins it. User and brief facts leave a full list after the call facts.
  const { applyPatch } = await import("../session/patch.ts");
  let mem = applyPatch(emptyMemory(0), { add: { facts: [{ text: "Never discuss the old price list", src: "user" }] } }, { now: 1, src: "user" }).mem;
  assert.equal(mem.facts[0].src, "user");
  for (let k = 0; k < 40; k++)
    mem = applyPatch(mem, { add: { facts: [{ text: `Call detail ${k}` }, { text: `Call detail ${k} again` }] } }, { now: 2 + k }).mem;
  assert.ok(mem.facts.length <= CAPS.facts);
  assert.ok(
    mem.facts.some((f) => f.text.includes("old price list")),
    "the user's fact is still there",
  );
});
