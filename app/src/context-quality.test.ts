// Language-neutral wake hints, the topic callback, token drift and the cache layout of the memory calls.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { withVClock, type VClock } from "./testkit/vclock.ts";
import { policyModel } from "./testkit/policy-model.ts";
import { registerRole } from "./testkit/prompt.ts";
import { MemoryLoop, DEFAULT_MEMORY_CONFIG, makeModelRunner, type MemoryDeps } from "./engine/memory.ts";
import { emptyMemory, type SessionMemory } from "./session/types.ts";
import type { ModelRegistry } from "./providers/llm.ts";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallLog } from "./log.ts";
import { CostMeter, cacheAdvice, cacheReport, formatCacheReport, recentUsageRows, usageFields, usageTokens } from "./cost.ts";
import { cacheMinTokens, splitRoleText } from "./context/cache.ts";
import { driftPct, DriftTracker, DRIFT_WARN } from "./context/budget.ts";

registerRole("memory", "You keep the memory of a live call");
registerRole("compact", "You tidy the memory of a live call");

function rig(vc: VClock, o: { start?: SessionMemory; deps?: Partial<MemoryDeps>; reply?: string } = {}) {
  const pm = policyModel({ strict: false, defaultText: o.reply ?? "{}" });
  const registry = { resolve: async () => pm.model } as unknown as ModelRegistry;
  const run = makeModelRunner({ registry, model: "anthropic:claude-haiku-5-5", onUsage: () => {} });
  const events: Record<string, unknown>[] = [];
  const loop = new MemoryLoop(
    { now: () => vc.now(), run, save: () => {}, sendView: () => {}, log: (_s, row) => events.push(row), ...o.deps },
    { ...DEFAULT_MEMORY_CONFIG },
    o.start ?? emptyMemory(vc.now()),
  );
  return { loop, pm, events };
}
const letters = {
  en: "abcdefghijklmnopqrstuvwxyz",
  he: "אבגדהוזחטיכלמנסעפצקרשת",
};
/** About 120 different words of a script, in lines of 10. */
const vocab = (script: "en" | "he"): string[] => {
  const L = letters[script];
  const words = Array.from(
    { length: 120 },
    (_, i) => `${L[i % L.length]}${L[(i * 7 + 3) % L.length]}${L[((i / L.length) | 0) % L.length]}${L[(i * 3) % L.length]}`,
  );
  return Array.from({ length: 12 }, (_, i) => words.slice(i * 10, i * 10 + 10).join(" "));
};
const FRESH = { en: "we talked with yossi about it", he: "דיברנו עם יוסי על זה" };

for (const script of ["en", "he"] as const) {
  test(`wake hint (${script}): a token that is new to the call, right after the speaker changed, wakes the updater without capitals or a word list`, async () => {
    await withVClock(async (vc) => {
      const r = rig(vc);
      for (const l of vocab(script)) r.loop.addLine({ side: "them", text: l, name: "Dana" });
      await vc.advance(25_000);
      r.loop.tick(); // the periodic run for the warm-up lines
      await vc.advance(10);
      const base = r.pm.callsFor("memory").length;
      await vc.advance(9000);
      r.loop.addLine({ side: "me", text: FRESH[script] }); // speaker changed, "yossi" is new
      assert.equal(r.loop.tick().why, "name");
      await vc.advance(10);
      assert.equal(r.pm.callsFor("memory").length, base + 1);
    });
  });

  test(`wake hint (${script}): no wake without a speaker change, for a known roster name, or for a token heard before`, async () => {
    await withVClock(async (vc) => {
      const start = emptyMemory(vc.now());
      start.roster = [{ id: "p1", name: script === "en" ? "Yossi" : "יוסי", side: "them" }];
      const r = rig(vc, { start });
      for (const l of vocab(script)) r.loop.addLine({ side: "them", text: l, name: "Dana" });
      await vc.advance(25_000);
      r.loop.tick();
      await vc.advance(9000);
      r.loop.addLine({ side: "them", text: FRESH[script], name: "Dana" }); // same speaker
      assert.equal(r.loop.tick().why, undefined, "same speaker: nothing new to wake for");
      r.loop.addLine({ side: "me", text: FRESH[script] }); // speaker changed but the token is on the roster
      assert.equal(r.loop.tick().why, undefined, "roster name");
      r.loop.addLine({ side: "them", text: "qq", name: "Dana" });
      r.loop.addLine({ side: "me", text: "zzzxx wwwvv" }); // new tokens
      assert.equal(r.loop.tick().why, "name");
    });
  });
}

test("wake hint: the first minute (warm-up) does not fire on every new word", async () => {
  await withVClock(async (vc) => {
    const r = rig(vc);
    await vc.advance(30_000);
    r.loop.addLine({ side: "them", text: "hello there thanks for joining", name: "Dana" });
    r.loop.addLine({ side: "me", text: "happy to be here today" });
    assert.equal(r.loop.tick().why, undefined);
  });
});

test("wake hints: a digit, a question mark (also Hebrew and Arabic), a very long line and a turn end from the STT", async () => {
  await withVClock(async (vc) => {
    const cases: [string, Parameters<MemoryLoop["addLine"]>[0], string][] = [
      ["digit", { side: "them", text: "the budget is 40000" }, "number"],
      ["question mark", { side: "them", text: "what do you think?" }, ""],
      ["long line", { side: "them", text: Array.from({ length: 50 }, (_, i) => "w" + "abcdefghij"[i % 10] + "k".repeat(i % 5)).join(" ") }, "length"],
      ["turn end", { side: "them", text: Array.from({ length: 14 }, (_, i) => "v" + "abcdefghij"[i % 10]).join(" "), final: true }, "turn"],
    ];
    for (const [name, line, why] of cases) {
      const r = rig(vc);
      await vc.advance(30_000);
      r.loop.addLine(line);
      assert.equal(r.loop.tick().why ?? "", why, name);
    }
    for (const q of ["מה דעתך?", "ما رأيك؟"]) {
      const r = rig(vc);
      r.loop.addLine({ side: "them", text: q });
      await vc.advance(21_000);
      assert.equal(r.loop.tick().why, "question", q);
    }
  });
});

test("topic callback: the first label is not a shift, a different label is; the same label in other case is not", async () => {
  await withVClock(async (vc) => {
    const seen: string[] = [];
    const r = rig(vc, { deps: { onTopicChange: (now, prev) => seen.push(`${prev}>${now}`) } });
    const patch = (topic: string) => {
      r.pm.reply({ role: "memory" }, JSON.stringify({ topic }), { times: 1 });
    };
    const learn = async (topic: string) => {
      patch(topic);
      r.loop.addLine({ side: "them", text: "the price is 100" });
      await vc.advance(9000);
      r.loop.tick();
      await vc.advance(10);
    };
    await vc.advance(30_000);
    await learn("pricing");
    await learn("Pricing");
    await learn("rollout plan");
    assert.deepEqual(seen, ["pricing>rollout plan"]);
  });
});

// ---------------------------------------------------------------- cache numbers, report, drift
const SDK_USAGE = { inputTokens: 3000, outputTokens: 40, inputTokenDetails: { cacheReadTokens: 2400, cacheWriteTokens: 300, noCacheTokens: 300 } };

test("usageFields: input, output, cache_read and cache_write from the SDK usage or from the Anthropic metadata", () => {
  assert.deepEqual(usageFields(SDK_USAGE), { input_tokens: 3000, output_tokens: 40, cache_read: 2400, cache_write: 300 });
  assert.deepEqual(usageFields({ inputTokens: 900, outputTokens: 5 }, { anthropic: { cacheCreationInputTokens: 600 } }), {
    input_tokens: 900,
    output_tokens: 5,
    cache_read: 0,
    cache_write: 600,
  });
  assert.deepEqual(usageFields({ inputTokens: Number.NaN, outputTokens: -3 }), { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0 });
  assert.deepEqual(usageFields(undefined), { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0 });
  assert.equal(usageTokens(SDK_USAGE).noCacheTokens, 300);
});

test("the call log adds the cache numbers and the estimate drift to every usage row; a role off by more than 25 percent is warned about once", () => {
  const log = new CallLog({ a: 1 });
  const rows = (s: string) =>
    readFileSync(join(log.dir, `${s}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  log.write("usage", { role: "moment", model: "m", usage: SDK_USAGE, usd: 0.001, ctx: { tokens: 3100 } });
  log.write("usage", { role: "memory", model: "m", usage: { inputTokens: 1000, outputTokens: 20 }, usd: 0.0001, ctx: { tokens: 1600 } });
  log.write("usage", { role: "memory", model: "m", usage: { inputTokens: 1000, outputTokens: 20 }, usd: 0.0001, ctx: { tokens: 1700 } });
  log.write("usage", { role: "stt", usd: 0.1 });
  const u = rows("usage");
  assert.equal(u[0].cache_read, 2400);
  assert.equal(u[0].cache_write, 300);
  assert.equal(u[0].input_tokens, 3000);
  assert.equal(u[0].est_tokens, 3100);
  assert.equal(u[0].drift_pct, 3.3);
  assert.equal(u[1].drift_pct, 60);
  assert.equal(u[3].input_tokens, undefined, "a row without usage is left alone");
  const warns = rows("events").filter((e) => e.type === "tokens.drift");
  assert.equal(warns.length, 1, "memory warned once, moment is within the limit");
  assert.equal(warns[0].role, "memory");
  assert.equal(warns[0].pct, 60);
});

test("drift: percent, the 25 percent line, one warning per role per call", () => {
  assert.equal(driftPct(1250, 1000), 25);
  assert.equal(driftPct(500, 1000), -50);
  assert.equal(driftPct(0, 1000), undefined);
  const d = new DriftTracker();
  assert.equal(d.note("ask", 1240, 1000, 0).warn, false, "24 percent");
  assert.equal(DRIFT_WARN, 0.25);
  assert.equal(d.note("ask", 1300, 1000, 1).warn, true);
  assert.equal(d.note("ask", 1300, 1000, 2000).warn, false, "same role, soon after");
  assert.equal(d.note("ask", 1300, 1000, 400_000).warn, false, "one line per role per call, however late");
  assert.equal(new DriftTracker().note("ask", 1300, 1000, 0, 300_000).warn, true);
  const d2 = new DriftTracker();
  d2.note("ask", 1300, 1000, 0, 300_000);
  assert.equal(d2.note("ask", 1300, 1000, 400_000, 300_000).warn, true, "a finite interval may repeat");
  assert.equal(d.note("moment", 600, 1000, 3).warn, true, "too low is a warning too");
  assert.equal(d.samples.get("ask")?.n, 4);
});

test("cache report: per role calls, input, read and write share; advice says why nothing is cached", () => {
  const rows = [
    ...Array.from({ length: 10 }, () => ({
      role: "moment",
      usage: { inputTokens: 2000, inputTokenDetails: { cacheReadTokens: 1500, cacheWriteTokens: 100 } },
      usd: 0.0002,
    })),
    ...Array.from({ length: 10 }, () => ({ role: "memory", input_tokens: 400, cache_read: 0, cache_write: 0, usd: 0.0001, drift_pct: 40 })),
    ...Array.from({ length: 10 }, () => ({ role: "compact", usage: { inputTokens: 3000, inputTokenDetails: { cacheWriteTokens: 2500 } }, usd: 0.0005 })),
    { role: "stt", usd: 0.2 },
    { role: "summary", totalUsd: 1 },
  ];
  const rep = cacheReport(rows);
  assert.deepEqual(
    rep.map((r) => r.role),
    ["compact", "moment", "memory"],
    "biggest input first; stt and summary rows are not model calls",
  );
  const moment = rep.find((r) => r.role === "moment")!;
  assert.equal(moment.hitPct, 75);
  assert.equal(moment.writePct, 5);
  assert.equal(rep.find((r) => r.role === "memory")!.drift, 40);
  assert.match(formatCacheReport(rep)[1], /moment\s+10 calls.*cache read.*hit share\s+75%/);
  const adv = cacheAdvice(rep, () => 512);
  assert.ok(
    adv.some((a) => /^memory: 400 input tokens a call is under the model's cache minimum \(512\)/.test(a)),
    adv.join("|"),
  );
  assert.ok(
    adv.some((a) => /^compact: 83.3% of the input is written/.test(a)),
    adv.join("|"),
  );
  assert.ok(
    adv.some((a) => /^memory: the token estimate is off by \+40%/.test(a)),
    adv.join("|"),
  );
  assert.ok(!adv.some((a) => a.startsWith("moment")));
  // a role with few calls is not judged
  assert.deepEqual(
    cacheAdvice(cacheReport([{ role: "ask", input_tokens: 10, cache_read: 0, cache_write: 0 }]), () => 512),
    [],
  );
});

test("CostMeter.cacheReport and recentUsageRows read the same numbers", () => {
  const c = new CostMeter(
    { llm: { "x:m": { inUsdPerM: 1, outUsdPerM: 5, cacheReadUsdPerM: 0.1, cacheWriteUsdPerM: 2 } }, stt: {} } as never,
    {
      maxUsdPerCall: 5,
      warnAt: 0.8,
      maxMinutesPerCall: 90,
    } as never,
  );
  c.addLlm("moment", "x:m", SDK_USAGE);
  const rep = c.cacheReport();
  assert.equal(rep[0].hitPct, 80);
  assert.equal(rep[0].writePct, 10);
  const calls = mkdtempSync(join(tmpdir(), "wm-calls-"));
  for (const [d, role] of [
    ["2026-11-01-a", "moment"],
    ["2026-11-02-b", "ask"],
    ["2026-11-03-c", "memory"],
  ]) {
    mkdirSync(join(calls, d));
    writeFileSync(join(calls, d, "usage.jsonl"), JSON.stringify({ role, input_tokens: 10 }) + "\nnot json\n");
  }
  mkdirSync(join(calls, "2026-11-04-empty"));
  assert.deepEqual(
    recentUsageRows(calls, 2).map((r) => r.role),
    ["ask", "memory"],
    "the newest two folders that have a usage file, oldest first",
  );
  assert.deepEqual(recentUsageRows(join(calls, "missing")), []);
});

test("cache minimum per model (Anthropic docs, 2026-11-08) and the role text split", () => {
  const min = (m: string) => cacheMinTokens(`anthropic:${m}`);
  assert.equal(min("claude-haiku-5-5"), 512);
  assert.equal(min("claude-sonnet-5-5"), 512);
  assert.equal(min("claude-sonnet-5"), 1024);
  assert.equal(min("claude-sonnet-4-6"), 1024);
  assert.equal(min("claude-opus-4-7"), 2048);
  assert.equal(min("claude-haiku-4-5-20251001"), 4096);
  assert.equal(min("claude-opus-4-6"), 4096);
  assert.equal(min("claude-something-new"), 1024, "unknown: the safe middle");
  assert.equal(cacheMinTokens("openai:gpt-x"), Infinity);
  assert.deepEqual(splitRoleText("Rules.\n\n<call_facts>\nUser: Sam\n</call_facts>\n\nCall frame (x): y"), {
    rules: "Rules.",
    data: "<call_facts>\nUser: Sam\n</call_facts>\n\nCall frame (x): y",
  });
  assert.deepEqual(splitRoleText("Only rules."), { rules: "Only rules.", data: "" });
  assert.deepEqual(splitRoleText("Rules.\n\nCall frame (x): y"), { rules: "Rules.", data: "Call frame (x): y" });
});
