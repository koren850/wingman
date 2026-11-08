// Cost per role, replayed over the golden dev meetings (usage.jsonl of the real engine modules), against the PLAN 3.6 table. Fails at +20 percent per role.
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
import { CostMeter } from "../cost.ts";
import { loadSettings } from "../settings.ts";
import type { ModelRegistry } from "../providers/llm.ts";
import type { SessionMemory } from "../session/types.ts";

// PLAN 3.6, USD per call.
export const TABLE: Record<string, number> = { moment: 0.00016, observer: 0.00013, memory: 0.0002, compact: 0.0006, ask: 0.0004, digest: 0.002, wrapup: 0.001 };
const TOL = 1.2;
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

test("cost per role: the average USD per call of every role stays within the PLAN 3.6 table + 20 percent", async () => {
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
      `COST ${role.padEnd(8)} ${String(v.calls).padStart(4)} calls  avg $${v.avg.toFixed(6)}  table $${TABLE[role]}  ratio ${(v.avg / TABLE[role]).toFixed(2)}`,
  );
  console.log(lines.join("\n"));
  for (const [role, v] of Object.entries(per)) {
    assert.ok(v.calls >= 1, `${role}: no usage rows`);
    assert.ok(v.avg > 0, `${role}: a zero price means the usage row was not priced`);
    assert.ok(v.avg <= TABLE[role] * TOL, `${role}: $${v.avg.toFixed(6)} per call is over the table $${TABLE[role]} + 20 percent`);
  }
});

test("cost per hour: the whole call (all roles, the old me-channel jobs included) is under the PLAN worst case and the $0.25 release gate", () => {
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

test("what-if (not in the product): the static role rules cached for 1 h right after block A would make moment and observer calls cheaper", async () => {
  // Today the role block (rules + per-call data) comes after the memory block and carries no cache marker, so about 700 tokens of unchanging rules are paid
  // in full on every moment and observer call. The simulation moves the rules to their own cached block and the data behind the memory block.
  const ids = ["dev-sales-en", "dev-support-he", "dev-vendor-en"];
  const now = await pool(ids, 3, (id) => runMeeting(id, { asks: false }));
  const alt = await pool(ids, 3, (id) => runMeeting(id, { asks: false, roleFirst: true }));
  const per = (rs: MeetingRun[], role: string) => avg(rs.flatMap((r) => r.usage).filter((x) => x.role === role));
  const share = (rs: MeetingRun[]) => {
    const c = rs.flatMap((r) => r.calls);
    return c.reduce((a, x) => a + x.read, 0) / c.reduce((a, x) => a + x.read + x.write + x.plain, 0);
  };
  for (const role of ["moment", "observer"])
    console.log(
      `WHAT-IF ${role}: $${per(now, role).toFixed(6)} now, $${per(alt, role).toFixed(6)} with the rules cached (${((1 - per(alt, role) / per(now, role)) * 100).toFixed(0)}% less)`,
    );
  console.log(`WHAT-IF cache read share of input tokens: ${(share(now) * 100).toFixed(0)}% now, ${(share(alt) * 100).toFixed(0)}% with the rules cached`);
  assert.ok(per(alt, "moment") < per(now, "moment") && per(alt, "observer") < per(now, "observer"));
});
