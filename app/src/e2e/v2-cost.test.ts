// Cost per role, replayed over the golden dev meetings (usage.jsonl of the real engine modules), against the cost table below. Fails at +20 percent per role.
// The policy fake reports usage computed from each real prompt and a simulated prompt cache (v2-kit.ts), so the rows carry honest prices. Output sizes
// are the scripted replies (memory and compaction answers are padded to a typical size). Digest and wrap-up run once each, in this process.
import "../test-setup.ts";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSplit } from "../../qa/golden-load.ts";
import { runMeeting, pool, observePolicy, costByRole, type MeetingRun } from "./v2-kit.ts";
import { policyModel } from "../testkit/policy-model.ts";
import { registerRole } from "../testkit/prompt.ts";
import { runDigest } from "../digest.ts";
import { runWrapup } from "../summary.ts";
import { CostMeter, cacheReport, formatCacheReport } from "../cost.ts";
import { loadSettings } from "../settings.ts";
import type { ModelRegistry } from "../providers/llm.ts";
import type { SessionMemory } from "../session/types.ts";
import { readBudgets, BUDGET_TOLERANCE } from "../../qa/budgets.ts";

// Planned cost, USD per call. This table is the ceiling. The gate itself is qa/budgets.json (calibrated from the golden run by `pnpm eval --update`, section
// `scripted`; `oneShot` holds the digest and the wrap-up, measured by this file). A role over its calibrated budget + 20 percent fails.
export const TABLE: Record<string, number> = { moment: 0.00016, observer: 0.00013, memory: 0.0002, compact: 0.0006, ask: 0.0004, digest: 0.002, wrapup: 0.001 };
const TOL = 1 + BUDGET_TOLERANCE;
const BUDGETS = readBudgets();
/** The calibrated budget of a role (USD per call), else the planned table. */
export const budgetOf = (role: string): number => BUDGETS.scripted?.roles[role]?.usdPerCall ?? BUDGETS.oneShot?.[role] ?? TABLE[role];
const dev = loadSplit("dev").filter((g) => g.type !== "interview");
const S0 = loadSettings({ env: {}, userFile: "/nonexistent/x.yaml" }).settings;
let runs: MeetingRun[] = [];
before(
  async () => {
    runs = await pool(dev, 4, (g) => runMeeting(g.id));
  },
  { timeout: 300_000 },
);

const avg = (rows: { usd?: number }[]) => rows.reduce((a, r) => a + (r.usd ?? 0), 0) / Math.max(1, rows.length);

/** One digest and one wrap-up on a golden meeting, priced like the engine prices them. */
async function digestAndWrapup() {
  const g = dev.find((x) => x.id === "dev-sales-en")!;
  const r = runs.find((x) => x.id === g.id)!;
  const out: Record<string, number> = {};
  // digest: the meeting's pre-meeting text and its scripted reply
  {
    registerRole("digest", "You prepare a pre-meeting brief");
    const pm = policyModel({ strict: false });
    pm.reply({ role: "digest" }, g.script!.find((s) => s.role === "digest")!.reply, { ms: 1800 });
    const o = observePolicy(pm);
    const reg = { resolve: async (_r: string, role?: string) => o.wrap(role) } as unknown as ModelRegistry;
    const d = await runDigest({ text: g.context ?? "" }, { registry: reg, models: [S0.digest.model] });
    assert.equal(d.source, "ai");
    out.digest = new CostMeter(S0.budget.prices, S0.budget).addLlm("digest", S0.digest.model, d.usage!.usage, d.usage!.providerMetadata).usd;
  }
  // wrap-up: the final memory of the run, the tail of the call, a model answer of typical size
  {
    const pm = policyModel({ strict: false });
    pm.reply(
      { system: "post-call summary" },
      JSON.stringify({
        summary: ["They want an online store with delivery slots", "The budget in the form and the budget she named differ", "A proposal is due on Friday"],
        decisions: ["Start with the product list"],
        nextSteps: [{ who: "Maya", what: "send the full product list", when: "Wednesday" }],
        openQuestions: ["Do you handle pickup lockers"],
        followUpEmail: "Hi Maya,\nThank you for the call today. We will start with the product list you will send on Wednesday.\nBest regards",
      }),
    );
    const o = observePolicy(pm);
    const reg = { resolve: async (_r: string, role?: string) => o.wrap(role) } as unknown as ModelRegistry;
    const cost = new CostMeter(S0.budget.prices, S0.budget);
    const rows: { stream: string; [k: string]: unknown }[] = [];
    await runWrapup({
      dir: mkdtempSync(join(tmpdir(), "wm-wrapcost-")),
      callId: "C1",
      S: S0,
      registry: reg,
      cost,
      mem: r.memory as SessionMemory,
      lines: r.tail,
      contextNotes: [],
      write: (stream, row) => rows.push({ stream, ...row }),
      generate: undefined,
    });
    out.wrapup = rows.find((x) => x.stream === "usage" && x.role === "wrapup")?.usd as number;
  }
  return out;
}

test("cost per role: the average USD per call of every role stays within its calibrated budget (qa/budgets.json) + 20 percent", async () => {
  const rows = runs.flatMap((r) => r.usage);
  const byRole: Record<string, number[]> = {};
  const per: Record<string, { calls: number; avg: number }> = {};
  for (const role of ["moment", "observer", "memory", "compact", "ask"]) {
    const rr = rows.filter((x) => x.role === role);
    per[role] = { calls: rr.length, avg: avg(rr) };
    byRole[role] = [];
  }
  const once = await digestAndWrapup();
  per.digest = { calls: 1, avg: once.digest };
  per.wrapup = { calls: 1, avg: once.wrapup };
  const lines = Object.entries(per).map(
    ([role, v]) =>
      `COST ${role.padEnd(8)} ${String(v.calls).padStart(4)} calls  avg $${v.avg.toFixed(6)}  budget $${budgetOf(role)}  planned table $${TABLE[role]}  ratio ${(v.avg / budgetOf(role)).toFixed(2)}`,
  );
  console.log(lines.join("\n"));
  for (const [role, v] of Object.entries(per)) {
    assert.ok(v.calls >= 1, `${role}: no usage rows`);
    assert.ok(v.avg > 0, `${role}: a zero price means the usage row was not priced`);
    assert.ok(v.avg <= budgetOf(role) * TOL, `${role}: $${v.avg.toFixed(6)} per call is over its budget $${budgetOf(role)} + 20 percent`);
    assert.ok(v.avg <= TABLE[role] * TOL, `${role}: $${v.avg.toFixed(6)} per call is over the planned table $${TABLE[role]} + 20 percent`);
  }
});

test("cost per hour: the whole call (all roles, the old me-channel jobs included) is under the planned worst case and the $0.25 release gate", () => {
  const rows = runs.flatMap((r) => r.usage);
  const minutes = runs.reduce((a, r) => a + r.lengthMs, 0) / 60_000;
  const total = rows.reduce((a, r) => a + (r.usd ?? 0), 0);
  const perHour = (total / minutes) * 60;
  const by = costByRole(rows);
  const desc = Object.entries(by)
    .map(([k, v]) => `${k} ${v.calls} calls $${v.usd.toFixed(4)}`)
    .join(", ");
  console.log(`COST per hour: $${perHour.toFixed(3)} over ${minutes.toFixed(0)} min of golden dev calls (${desc})`);
  const legacyMe = (by.assist?.usd ?? 0) + (by.me?.usd ?? 0);
  console.log(`COST of the old me-channel jobs (assist, me) inside that: $${((legacyMe / minutes) * 60).toFixed(3)} per hour`);
  assert.ok(perHour <= 0.25, `$${perHour.toFixed(3)} per hour is over the $0.25 release gate`);
  // calls per hour of the engine's own jobs stay inside their caps
  const hourly = (role: string) => ((by[role]?.calls ?? 0) / minutes) * 60;
  assert.ok(hourly("memory") <= 240, `memory updater ${hourly("memory")} calls per hour (cap 240)`);
  assert.ok(hourly("observer") <= 6 * 60, `observer ${hourly("observer")} calls per hour (cap 6 per minute)`);
});

test("cost: a replayed call books every priced row in usage.jsonl with the model and the usd, none unpriced", () => {
  for (const r of runs)
    for (const u of r.usage) {
      assert.ok(u.model, `${r.id}: usage row without a model: ${JSON.stringify(u)}`);
      assert.ok(typeof u.usd === "number", `${r.id}: usage row without usd: ${JSON.stringify(u)}`);
    }
});

test("usage rows carry input_tokens, cache_read and cache_write per role, and the cache report adds them up", () => {
  const rows = runs.flatMap((r) => r.usage) as Record<string, unknown>[];
  for (const role of ["moment", "observer", "memory", "compact", "ask"]) {
    const rr = rows.filter((x) => x.role === role);
    assert.ok(rr.length, role);
    for (const x of rr) {
      assert.equal(typeof x.input_tokens, "number", `${role}: input_tokens`);
      assert.equal(typeof x.cache_read, "number", `${role}: cache_read`);
      assert.equal(typeof x.cache_write, "number", `${role}: cache_write`);
      assert.ok((x.cache_read as number) + (x.cache_write as number) <= (x.input_tokens as number), `${role}: cache tokens are part of the input`);
    }
  }
  const rep = cacheReport(rows);
  console.log("CACHE REPORT (golden dev calls, simulated provider cache)\n" + formatCacheReport(rep).join("\n"));
  const by = Object.fromEntries(rep.map((r) => [r.role, r]));
  assert.ok(by.moment.read > 0 && by.observer.read > 0, "moment and observer read the cache");
  assert.ok(by.moment.hitPct > 30, `moment hit ${by.moment.hitPct}%`);
  assert.ok(rep.every((r) => r.hitPct + r.writePct <= 100));
});

test("cache layout: the current layout (rules and memory cached by role) costs less per hour than the layout before it, on the same calls", async () => {
  // Before: A (1 h), the memory block (5 min) for every role, then the rules and the per-call facts as one block with no marker.
  // After: A (1 h), the role's fixed rules (1 h), the memory block (5 min, only moment and observer), the per-call facts last. The calls are the same;
  // only the cache markers and the block order differ (the simulator in v2-kit.ts prices what the provider would bill).
  const ids = ["dev-sales-en", "dev-support-he", "dev-vendor-en"];
  const after = await pool(ids, 3, (id) => runMeeting(id, { asks: false }));
  const before = await pool(ids, 3, (id) => runMeeting(id, { asks: false, legacyLayout: true }));
  const per = (rs: MeetingRun[], role: string) => avg(rs.flatMap((r) => r.usage).filter((x) => x.role === role));
  const hour = (rs: MeetingRun[]) =>
    (rs.flatMap((r) => r.usage).reduce((a, x) => a + (x.usd ?? 0), 0) / (rs.reduce((a, r) => a + r.lengthMs, 0) / 60_000)) * 60;
  const share = (rs: MeetingRun[]) => {
    const c = rs.flatMap((r) => r.calls);
    return c.reduce((a, x) => a + x.read, 0) / c.reduce((a, x) => a + x.read + x.write + x.plain, 0);
  };
  for (const role of ["moment", "observer", "memory", "compact"])
    console.log(
      `LAYOUT ${role.padEnd(8)} $${per(before, role).toFixed(6)} before, $${per(after, role).toFixed(6)} after (${((1 - per(after, role) / per(before, role)) * 100).toFixed(0)}% less)`,
    );
  console.log(`LAYOUT cost per hour: $${hour(before).toFixed(3)} before, $${hour(after).toFixed(3)} after`);
  console.log(`LAYOUT cache read share of input tokens: ${(share(before) * 100).toFixed(0)}% before, ${(share(after) * 100).toFixed(0)}% after`);
  assert.ok(per(after, "moment") < per(before, "moment") && per(after, "observer") < per(before, "observer"), "moment and observer calls are cheaper");
  assert.ok(hour(after) < hour(before), "the whole call is cheaper");
  assert.ok(per(after, "memory") <= per(before, "memory") * 1.02, "the memory updater does not get dearer");
  assert.ok(hour(after) <= 0.25);
});
