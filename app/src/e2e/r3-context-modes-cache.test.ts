// r3-context-modes: the tail-chunk decision from the cache simulator, and the equal-prefix proof across roles.
// The simulator (v2-kit.ts observePolicy) prices a simulated provider cache on the real prompts of the golden dev calls. It is a SIMULATION: it says how a
// layout would behave under the documented cache rules (minimum 512 tokens, write 1.25x or 2x, read 0.1x), not what a provider bills.
// Rule of the plan: tailChunk is switched on for a role only when the simulation shows a cost gain of more than 10 percent for that role.
import "../test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runMeeting, pool, type MeetingRun } from "./v2-kit.ts";
import { CACHE_POLICY } from "../context/cache.ts";
import { ROLES } from "../context/budget.ts";

const IDS = ["dev-sales-en", "dev-support-he", "dev-vendor-en"];
const CHUNK = 12; // raw lines per cached chunk in the study
const avg = (rs: MeetingRun[], role: string) => {
  const u = rs.flatMap((r) => r.usage).filter((x) => x.role === role);
  return u.reduce((a, x) => a + (x.usd ?? 0), 0) / Math.max(1, u.length);
};

test("tailChunk decision: the policy matches the simulator (on only where it gains more than 10 percent)", async () => {
  const off = await pool(IDS, 3, (id) => runMeeting(id, { asks: false }));
  const on = await pool(IDS, 3, (id) => runMeeting(id, { asks: false, tailChunk: { moment: CHUNK, observer: CHUNK, memory: CHUNK, compact: CHUNK } }));
  const lines: string[] = [];
  for (const role of ["moment", "observer", "memory", "compact"] as const) {
    const a = avg(off, role),
      b = avg(on, role);
    const gain = a > 0 ? (1 - b / a) * 100 : 0;
    lines.push(`TAILCHUNK ${role.padEnd(9)} $${a.toFixed(6)} off, $${b.toFixed(6)} on (${gain.toFixed(1)}% less)  policy now ${CACHE_POLICY[role].tailChunk}`);
    assert.equal(
      CACHE_POLICY[role].tailChunk > 0,
      gain > 10,
      `${role}: tailChunk ${CACHE_POLICY[role].tailChunk} but the simulator says ${gain.toFixed(1)}% gain`,
    );
  }
  console.log("TAILCHUNK study (simulated provider cache, golden dev calls, chunk of " + CHUNK + " lines)\n" + lines.join("\n"));
  for (const role of ROLES)
    if (!["moment", "observer", "memory", "compact"].includes(role)) assert.equal(CACHE_POLICY[role].tailChunk, 0, `${role} runs too rarely to profit`);
});
