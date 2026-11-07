// Health supervisor and degrade ladder (health.ts), CircuitBreaker, and CostMeter (cost.ts) budget states.
// Time is injected through a mutable `now` object, so no real timers or sleeps.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, NO_SIGNALS, capabilities, describeRung, CircuitBreaker, HealthSupervisor, type Rung } from "./health.ts";
import { CostMeter } from "./cost.ts";
import { loadSettings } from "./settings.ts";

const S = loadSettings({ env: {}, userFile: "/nonexistent/x.yaml" }).settings;
const sig = (p: object) => ({ ...NO_SIGNALS, ...p });

test("ladder: signals map to rungs, worst wins", () => {
  assert.equal(decide(NO_SIGNALS).rung, 0);
  assert.equal(decide(sig({ llmSlow: true })).rung, 1);
  assert.equal(decide(sig({ llmTrouble: true })).rung, 1);
  assert.equal(decide(sig({ llmOnFallback: true })).rung, 2);
  assert.equal(decide(sig({ sttOnFallback: true, llmSlow: true })).rung, 2);
  assert.equal(decide(sig({ llmDown: true })).rung, 3);
  assert.equal(decide(sig({ costCapped: true })).rung, 3);
  assert.equal(decide(sig({ noAi: true })).rung, 3);
  assert.equal(decide(sig({ themDead: true, llmDown: true })).rung, 4);
  assert.equal(decide(sig({ bankFailed: true })).rung, 4);
  assert.equal(decide(sig({ fatal: "STT down", themDead: true })).rung, 5);
  assert.deepEqual(capabilities(1), { detect: true, bank: true, llm: true, ans: true, listening: true, meAns: true });
  assert.equal(capabilities(2).ans, true);
  assert.equal(capabilities(3).ans, false);
  assert.equal(capabilities(3).llm, false);
  assert.equal(capabilities(4).detect, false);
  assert.equal(capabilities(5).listening, false);
});

function sup(now: { t: number }) {
  const s = new HealthSupervisor({ tickMs: 1000, recoverStableMs: 60_000, slowMs: 1500, slowSttMs: 1500, minSamples: 3 }, () => now.t);
  const log: string[] = [];
  s.on("rung", (e) => log.push(`${e.from}>${e.to}`));
  return { s, log };
}

test("ladder changes only between questions; recovery needs a stable minute", () => {
  const now = { t: 0 };
  const { s, log } = sup(now);
  s.beginQuestion();
  s.noteLlmHard(); // a hard error keeps the full calm period (a short outage recovers sooner, see below)
  s.set({ llmDown: true });
  s.tick();
  assert.equal(s.rung, 0, "no change mid-question");
  s.endQuestion();
  assert.equal(s.rung, 3);
  assert.deepEqual(log, ["0>3"]);
  s.set({ llmDown: false });
  s.tick();
  now.t += 30_000;
  s.tick();
  assert.equal(s.rung, 3, "30 s of calm is not enough");
  now.t += 29_000;
  s.tick();
  assert.equal(s.rung, 3);
  s.beginQuestion();
  now.t += 5000;
  s.tick();
  assert.equal(s.rung, 3, "not mid-question");
  s.endQuestion();
  assert.equal(s.rung, 0);
  assert.deepEqual(log, ["0>3", "3>0"]);
});

test("recovery timer restarts if trouble returns", () => {
  const now = { t: 0 };
  const { s } = sup(now);
  s.set({ llmOnFallback: true });
  s.tick();
  assert.equal(s.rung, 2);
  s.set({ llmOnFallback: false });
  s.tick();
  now.t += 50_000;
  s.tick();
  s.set({ llmOnFallback: true });
  s.tick();
  now.t += 20_000;
  s.set({ llmOnFallback: false });
  s.tick();
  now.t += 40_000;
  s.tick();
  assert.equal(s.rung, 2, "the timer was reset by the relapse");
  now.t += 30_000;
  s.tick();
  assert.equal(s.rung, 0);
});

test("slow AI: p50 of the last tags above slowMs drops to reduced AI; recovery clears the samples", () => {
  const now = { t: 0 };
  const { s } = sup(now);
  s.recordTag(2000);
  s.recordTag(2100);
  s.tick();
  assert.equal(s.rung, 0, "needs minSamples");
  s.recordTag(1900);
  s.tick();
  assert.equal(s.rung, 1);
  assert.equal(s.caps.ans, true, "slow AI keeps answering; stale ones are dropped by reflex.dropStaleMs");
  now.t += 61_000;
  s.recordTag(2000);
  s.tick(); // still slow when the minute passes: the flag stays; samples are cleared only on recovery
  s.set({ llmSlow: false });
  s.tick();
  now.t += 61_000;
  s.tick();
  assert.equal(s.rung, 0);
  s.recordTag(300);
  s.recordTag(400);
  s.recordTag(350);
  assert.equal(s.signals.llmSlow, false);
});

test("trouble (429/529) holds reduced AI for a minute, then lets go", () => {
  const now = { t: 0 };
  const { s } = sup(now);
  s.noteLlmTrouble();
  s.tick();
  assert.equal(s.rung, 1);
  now.t += 61_000;
  s.tick(); // trouble expired, then recover needs another stable period
  now.t += 61_000;
  s.tick();
  assert.equal(s.rung, 0);
});

test("fatal goes to off immediately, even mid-question, and stays off", () => {
  const now = { t: 0 };
  const { s, log } = sup(now);
  s.beginQuestion();
  s.set({ fatal: "STT down on every provider" });
  assert.equal(s.rung, 5);
  s.set({ fatal: null });
  now.t += 999_999;
  s.tick();
  assert.equal(s.rung, 5, "manual restart only");
  assert.deepEqual(log, ["0>5"]);
});

test("--no-ai alone is the user's choice (info bar), not a warning", () => {
  const now = { t: 0 };
  const { s } = sup(now);
  s.set({ noAi: true });
  s.tick();
  assert.equal(s.rung, 3);
  assert.equal(s.userChoiceOnly, true);
  assert.equal(describeRung(3, s.reasons, true)?.level, "info");
  assert.equal(describeRung(3, ["x"], false)?.level, "red");
  assert.equal(describeRung(0, []), null);
  for (const r of [1, 2, 4, 5] as Rung[]) assert.ok(describeRung(r, ["why"]));
});

test("circuit breaker: open after N failures in the window, half-open probe after cooldown, close after 2 successes", () => {
  const now = { t: 0 };
  const b = new CircuitBreaker({ failures: 3, windowMs: 10_000, cooldownMs: 15_000 }, () => now.t);
  b.failure();
  now.t += 1000;
  b.failure();
  assert.equal(b.state, "closed");
  now.t += 1000;
  b.failure();
  assert.equal(b.state, "open");
  assert.equal(b.allow(), false);
  now.t += 14_000;
  assert.equal(b.allow(), false);
  now.t += 2000;
  assert.equal(b.allow(), true);
  assert.equal(b.state, "half-open");
  b.failure();
  assert.equal(b.state, "open", "failed probe re-opens");
  now.t += 16_000;
  assert.ok(b.allow());
  b.success();
  assert.equal(b.state, "half-open");
  b.success();
  assert.equal(b.state, "closed");
  const old = new CircuitBreaker({ failures: 3, windowMs: 10_000, cooldownMs: 1 }, () => now.t);
  old.failure();
  now.t += 11_000;
  old.failure();
  now.t += 11_000;
  old.failure();
  assert.equal(old.state, "closed", "failures outside the window do not add up");
  old.failure(true);
  assert.equal(old.state, "open", "forceOpen for auth/spend cap");
});

test("CostMeter math from the price table and actual usage", () => {
  const m = new CostMeter(S.budget.prices, S.budget); // haiku: in 0.1, out 0.5, cache read 0.01, cache write 0.2 USD per M
  const a = m.addLlm("reflex", "anthropic:claude-haiku-5-5", {
    inputTokens: 10_000,
    outputTokens: 100,
    inputTokenDetails: { cacheReadTokens: 8000, cacheWriteTokens: 0, noCacheTokens: 2000 },
  });
  assert.ok(Math.abs(a.usd - (2000 * 0.1 + 8000 * 0.01 + 100 * 0.5) / 1e6) < 1e-12);
  const b = m.addLlm("reflex", "anthropic:claude-haiku-5-5", { inputTokens: 5000, outputTokens: 50, inputTokenDetails: { cacheWriteTokens: 4000 } }); // noCache inferred = 1000
  assert.ok(Math.abs(b.usd - (1000 * 0.1 + 4000 * 0.2 + 50 * 0.5) / 1e6) < 1e-12);
  assert.equal(m.roles.reflex.calls, 2);
  assert.equal(m.roles.reflex.cacheReadTokens, 8000);
  m.addLlm("summarizer", "mystery:model", { inputTokens: 100, outputTokens: 100 });
  assert.equal(m.roles.summarizer.usd, 0);
  assert.ok(m.unpriced.has("mystery:model"));
  assert.ok(Math.abs(m.llmUsd - (a.usd + b.usd)) < 1e-12);
  m.setSttSeconds({ deepgram: 3600, soniox: 1800 }); // 1 h deepgram 0.55 + 0.5 h soniox 0.12
  assert.ok(Math.abs(m.sttUsd - (0.55 + 0.06)) < 1e-9);
  assert.ok(Math.abs(m.totalUsd - (m.llmUsd + m.sttUsd)) < 1e-12);
});

test("CostMeter budget states: warn at warnAt, capped at the cap, cap 0 blocks all LLM spend", () => {
  const prices = { llm: { "p:m": { inUsdPerM: 1_000_000, outUsdPerM: 0 } }, stt: {} }; // $1 per input token
  const m = new CostMeter(prices, { maxUsdPerCall: 10, warnAt: 0.8, maxMinutesPerCall: 90 });
  assert.equal(m.llmState(), "ok");
  m.addLlm("reflex", "p:m", { inputTokens: 7 });
  assert.equal(m.llmState(), "ok");
  m.addLlm("reflex", "p:m", { inputTokens: 1 });
  assert.equal(m.llmState(), "warn");
  m.addLlm("reflex", "p:m", { inputTokens: 2 });
  assert.equal(m.llmState(), "capped");
  const z = new CostMeter(prices, { maxUsdPerCall: 0, warnAt: 0.8, maxMinutesPerCall: 90 });
  assert.equal(z.llmState(), "ok");
  z.addLlm("reflex", "p:m", { inputTokens: 1 });
  assert.equal(z.llmState(), "capped");
  const t = new CostMeter(prices, { maxUsdPerCall: 1, warnAt: 0.8, maxMinutesPerCall: 10 });
  t.setSttSeconds({ deepgram: 400 });
  assert.equal(t.minutesState(), "ok");
  t.setSttSeconds({ deepgram: 500 });
  assert.equal(t.minutesState(), "warn");
  t.setSttSeconds({ deepgram: 600 });
  assert.equal(t.minutesState(), "capped");
});

test("budget cap drives the ladder to bank-only", () => {
  const now = { t: 0 };
  const { s } = sup(now);
  const m = new CostMeter({ llm: { "p:m": { inUsdPerM: 1_000_000, outUsdPerM: 0 } }, stt: {} }, { maxUsdPerCall: 2, warnAt: 0.8, maxMinutesPerCall: 90 });
  m.addLlm("reflex", "p:m", { inputTokens: 2 });
  s.set({ costCapped: m.llmState() === "capped" });
  s.tick();
  assert.equal(s.rung, 3);
  assert.equal(s.caps.llm, false);
  assert.deepEqual(s.reasons, ["LLM budget cap reached"]);
});

test("circuit breaker: peek never uses up the half-open probe; allow takes it", () => {
  let now = 0;
  const b = new CircuitBreaker({ failures: 1, windowMs: 10_000, cooldownMs: 1000 }, () => now);
  b.failure(true);
  assert.equal(b.peek(), false);
  now = 1500;
  for (let i = 0; i < 5; i++) assert.equal(b.peek(), true); // status checks every tick
  assert.equal(b.allow(), true); // the real request gets the probe
  assert.equal(b.allow(), false); // one at a time
  assert.equal(b.peek(), false);
});

test("a short AI outage recovers after llmRecoverMs, not the full calm period", () => {
  const now = { t: 0 };
  const s = new HealthSupervisor({ tickMs: 1000, recoverStableMs: 60_000, llmRecoverMs: 15_000, slowMs: 1500, slowSttMs: 1500, minSamples: 3 }, () => now.t);
  s.set({ llmDown: true });
  s.tick();
  assert.equal(s.rung, 3);
  s.set({ llmDown: false }); // breaker cooldown over: a request may go through again
  s.tick();
  now.t += 14_000;
  s.tick();
  assert.equal(s.rung, 3, "not yet");
  now.t += 2000;
  s.tick();
  assert.equal(s.rung, 0, "back after the short period");
});

test("a hard AI error (key rejected, spend cap) keeps the full calm period", () => {
  const now = { t: 0 };
  const s = new HealthSupervisor({ tickMs: 1000, recoverStableMs: 60_000, llmRecoverMs: 15_000, slowMs: 1500, slowSttMs: 1500, minSamples: 3 }, () => now.t);
  s.noteLlmHard();
  s.set({ llmDown: true });
  s.tick();
  s.set({ llmDown: false });
  s.tick();
  now.t += 20_000;
  s.tick();
  assert.equal(s.rung, 3);
  now.t += 41_000;
  s.tick();
  assert.equal(s.rung, 0);
});

test("recovery from other reasons is not shortened", () => {
  const now = { t: 0 };
  const s = new HealthSupervisor({ tickMs: 1000, recoverStableMs: 60_000, llmRecoverMs: 15_000, slowMs: 1500, slowSttMs: 1500, minSamples: 3 }, () => now.t);
  s.set({ llmDown: true, costCapped: true });
  s.tick();
  s.set({ llmDown: false, costCapped: false });
  s.tick();
  now.t += 20_000;
  s.tick();
  assert.equal(s.rung, 3);
});

test("slow AI: median of the last 8 samples, so one or two slow replies do not flap the state", () => {
  const now = { t: 0 };
  const s = new HealthSupervisor({ tickMs: 1000, recoverStableMs: 60_000, slowMs: 2500, slowSttMs: 1500, minSamples: 3 }, () => now.t);
  for (const ms of [800, 900, 850, 3000, 900, 3200]) s.recordTag(ms);
  assert.equal(s.signals.llmSlow, false, "2 slow of 6 is not slow");
  for (const ms of [3000, 3100, 3300]) s.recordTag(ms);
  assert.equal(s.signals.llmSlow, true, "most of the last 8 are slow");
  for (let i = 0; i < 8; i++) s.recordTag(700);
  assert.equal(s.signals.llmSlow, false, "old samples fall out of the window");
});

test("ladder texts follow the UI language and keep the same meaning", () => {
  for (const r of [1, 2, 3, 4, 5] as Rung[]) {
    const he = describeRung(r, ["AI slow"], false, "he")!,
      en = describeRung(r, ["AI slow"], false, "en")!;
    assert.equal(he.level, en.level);
    assert.match(he.text, /[\u0590-\u05FF]/);
    assert.doesNotMatch(en.text, /[\u0590-\u05FF]/);
  }
  assert.match(describeRung(1, ["AI slow"], false, "en")!.text, /^AI is slow \(AI slow\)/);
  assert.match(describeRung(1, ["AI slow"])!.text, /[\u0590-\u05FF]/, "default language is Hebrew");
  assert.match(describeRung(3, [], true, "en")!.text, /no AI/);
});
