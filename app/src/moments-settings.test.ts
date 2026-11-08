// Moment engine settings (PLAN 3.5): defaults, validation, the price rule for the new model keys, and the soft hourly cap in CostMeter.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, SettingsError } from "./settings.ts";
import { CostMeter, SHED_ORDER, SHED_AT } from "./cost.ts";
import { minValueFrom, DEFAULT_SCHEDULER } from "./moments/scheduler.ts";

const dir = mkdtempSync(join(tmpdir(), "wingman-moments-settings-"));
const load = (yaml?: string) => {
  const userFile = join(dir, `u${Math.random().toString(36).slice(2)}.yaml`);
  if (yaml !== undefined) writeFileSync(userFile, yaml);
  return loadSettings({ env: {}, userFile });
};

test("defaults: live reading (v2) is the default; every key of PLAN 3.5 has its documented default", () => {
  const { settings: s } = load();
  assert.equal(s.moments.engine, "v2");
  assert.equal(s.moments.observerPerMinute, 6);
  assert.equal(s.moments.windowSeconds, 40);
  assert.deepEqual(s.moments.minValue, { default: 2, STALL: 1, CHECK: 1 });
  assert.equal(s.moments.checkPromises, true);
  assert.equal(s.memory.enabled, true);
  assert.equal(s.memory.everySeconds, 20);
  assert.equal(s.memory.minNewWords, 25);
  assert.equal(s.memory.compactEveryMinutes, 6);
  assert.equal(s.memory.budgetTokens, 1800);
  assert.equal(s.ctx.rawTailTokens, 1200);
  assert.equal(s.budget.maxLlmUsdPerHour, 0.4);
  assert.ok(s.budget.prices.llm[s.memory.model] && s.budget.prices.llm[s.digest.model], "each new model key has a price");
});

test("minValue takes one number or a map; the scheduler config reads both", () => {
  assert.deepEqual(load("moments:\n  minValue: 3\n").settings.moments.minValue, 3);
  const m = load("moments:\n  minValue: { ANS: 3 }\n").settings.moments.minValue;
  assert.deepEqual(m, { default: 2, STALL: 1, CHECK: 1, ANS: 3 }, "a map is added to the default map");
  assert.deepEqual(minValueFrom(3), { default: 3 });
  assert.deepEqual(minValueFrom(m), { default: 2, STALL: 1, CHECK: 1, ANS: 3 });
  assert.deepEqual(minValueFrom(DEFAULT_SCHEDULER.minValue), DEFAULT_SCHEDULER.minValue);
});

test("validation: bad engine, out-of-range values, unknown tag keys and an unpriced memory model are refused with the key named", () => {
  const bad = (yaml: string, key: string) => {
    try {
      load(yaml);
      assert.fail(`${key} should be refused`);
    } catch (e) {
      assert.ok(e instanceof SettingsError, String(e));
      assert.ok(
        e.issues.some((i) => i.key.startsWith(key)),
        `${key} in ${JSON.stringify(e.issues)}`,
      );
    }
  };
  bad("moments:\n  engine: v3\n", "moments.engine");
  bad("moments:\n  observerPerMinute: 99\n", "moments.observerPerMinute");
  bad("moments:\n  minValue: 4\n", "moments.minValue");
  bad("moments:\n  minValue: { MAYBE: 1 }\n", "moments.minValue");
  bad("memory:\n  everySeconds: 1\n", "memory.everySeconds");
  bad("memory:\n  budgetTokens: 10\n", "memory.budgetTokens");
  bad("budget:\n  maxLlmUsdPerHour: -1\n", "budget.maxLlmUsdPerHour");
  bad('memory:\n  model: "anthropic:claude-unpriced-9"\n', "memory.model");
  bad('digest:\n  model: "openai:gpt-unpriced"\n', "digest.model");
  assert.equal(load('memory:\n  model: "scripted:policy"\n').settings.memory.model, "scripted:policy", "an offline double needs no price");
  assert.equal(load('memory:\n  model: "x:y"\nbudget:\n  prices:\n    llm:\n      "x:y": { inUsdPerM: 1, outUsdPerM: 1 }\n').settings.memory.model, "x:y");
});

const prices = { llm: { "p:m": { inUsdPerM: 1_000_000, outUsdPerM: 0 } }, stt: {} }; // 1 USD per input token
const budget = { maxUsdPerCall: 100, warnAt: 0.8, maxMinutesPerCall: 90, maxLlmUsdPerHour: 1 };
const spend = (m: CostMeter, role: string, usd: number) => m.addLlm(role, "p:m", { inputTokens: usd, outputTokens: 0 });

test("hourly cap: shedding order is compaction, observer, memory, direct last; ask, digest and wrap-up are never shed", () => {
  assert.deepEqual(SHED_ORDER, ["compact", "observer", "memory", "moment"]);
  assert.ok(SHED_AT.compact! < SHED_AT.observer! && SHED_AT.observer! < SHED_AT.memory! && SHED_AT.memory! < SHED_AT.moment!);
  const m = new CostMeter(prices, budget);
  const state = () => ["compact", "observer", "memory", "moment", "ask", "digest", "wrapup", "reflex"].map((r) => (m.shed(r) ? 1 : 0)).join("");
  assert.equal(state(), "00000000");
  spend(m, "moment", 0.6);
  assert.equal(state(), "10000000", "60%: compaction stops");
  spend(m, "moment", 0.2);
  assert.equal(state(), "11000000", "80%: the observer stops too");
  spend(m, "moment", 0.1);
  assert.equal(state(), "11100000", "90%: memory updates stop");
  assert.equal(m.paused(), undefined);
  spend(m, "memory", 0.1);
  assert.equal(state(), "11110000", "100%: direct questions stop last");
  assert.equal(m.paused(), "hour-cap");
});

test("hourly cap is rolling and soft: spend older than an hour no longer counts; 0 means no hourly cap", () => {
  const m = new CostMeter(prices, budget);
  const t0 = Date.now();
  spend(m, "moment", 1);
  assert.equal(m.shed("moment", t0 + 1000), true);
  assert.equal(m.shed("moment", t0 + 3_600_001), false, "the spend left the window");
  assert.ok(Math.abs(m.hourUsd(t0 + 3_600_001)) < 1e-9);
  const off = new CostMeter(prices, { ...budget, maxLlmUsdPerHour: 0 });
  spend(off, "moment", 50);
  assert.equal(off.shed("observer"), false);
  assert.equal(off.hourRatio(), 0);
  const callCap = new CostMeter(prices, { ...budget, maxUsdPerCall: 1, maxLlmUsdPerHour: 100 });
  spend(callCap, "moment", 2);
  assert.equal(callCap.paused(), "call-cap");
});
