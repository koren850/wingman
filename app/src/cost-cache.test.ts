// Prompt-cache hit % in the per-call usage summary (CostMeter.cacheHitPct).
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CostMeter } from "./cost.ts";

const meter = () =>
  new CostMeter(
    { llm: { "x:m": { inUsdPerM: 1, outUsdPerM: 5, cacheReadUsdPerM: 0.1 } }, stt: {} } as never,
    { maxUsdPerCall: 5, warnAt: 0.8, maxMinutesPerCall: 90 } as never,
  );

test("cache hit %: share of input tokens read from the cache, per role and overall", () => {
  const c = meter();
  assert.equal(c.cacheHitPct(), undefined, "no calls yet");
  c.addLlm("reflex", "x:m", { inputTokens: 1000, outputTokens: 20, inputTokenDetails: { cacheReadTokens: 750, cacheWriteTokens: 0 } });
  c.addLlm("reflex", "x:m", { inputTokens: 1000, outputTokens: 20, inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 1000 } });
  c.addLlm("notes", "x:m", { inputTokens: 500, outputTokens: 20 });
  assert.equal(c.cacheHitPct("reflex"), 37.5);
  assert.equal(c.cacheHitPct("notes"), 0);
  assert.equal(c.cacheHitPct(), 30);
  assert.deepEqual(c.cacheHitByRole, { reflex: 37.5, notes: 0 });
});
