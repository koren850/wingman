// Cost reconciliation: the eval prices model calls from a simulated usage (token estimates, a cache simulator). A recorded run books the usage the provider
// reported. This compares the two per role, per hour of call, and fails when the total or a material role is more than 15 percent apart.
// Pure code: the caller passes the numbers (from usage rows of a scripted run and of a replay of a cassette).
import { CostMeter } from "../src/cost.ts";
import { loadSettings } from "../src/settings.ts";
import type { Cassette } from "../src/providers/cassette.ts";

export const RECON_MAX_DELTA = 0.15;
/** A role below this share of the larger total is shown but cannot fail the check on its own (a few cents of noise). */
export const RECON_MATERIAL_SHARE = 0.05;

export type RoleUse = { calls: number; usd: number };
export type ReconRow = {
  role: string;
  simCallsPerHour: number;
  recCallsPerHour: number;
  simUsdPerHour: number;
  recUsdPerHour: number;
  /** (recorded - simulated) / simulated; Infinity when only the recorded side has cost */
  delta: number;
  material: boolean;
  ok: boolean;
};
export type Recon = { rows: ReconRow[]; total: ReconRow; ok: boolean; failed: string[] };

const sum = (m: Record<string, RoleUse>): RoleUse =>
  Object.values(m).reduce((a, r) => ({ calls: a.calls + r.calls, usd: a.usd + r.usd }), { calls: 0, usd: 0 });
const deltaOf = (sim: number, rec: number) => (sim > 0 ? (rec - sim) / sim : rec > 0 ? Infinity : 0);

/** `simHours` and `recHours` are the hours of call behind each side (they may differ: the replay can be cut short). */
export function reconcileCost(sim: Record<string, RoleUse>, rec: Record<string, RoleUse>, simHours: number, recHours = simHours): Recon {
  const hs = Math.max(simHours, 1e-9),
    hr = Math.max(recHours, 1e-9);
  const bigger = Math.max(sum(sim).usd / hs, sum(rec).usd / hr);
  const row = (role: string, s: RoleUse, r: RoleUse, force?: boolean): ReconRow => {
    const simUsd = s.usd / hs,
      recUsd = r.usd / hr,
      delta = deltaOf(simUsd, recUsd);
    const material = force ?? Math.max(simUsd, recUsd) >= bigger * RECON_MATERIAL_SHARE;
    return {
      role,
      simCallsPerHour: s.calls / hs,
      recCallsPerHour: r.calls / hr,
      simUsdPerHour: simUsd,
      recUsdPerHour: recUsd,
      delta,
      material,
      ok: !material || Math.abs(delta) <= RECON_MAX_DELTA,
    };
  };
  const zero = { calls: 0, usd: 0 };
  const roles = [...new Set([...Object.keys(sim), ...Object.keys(rec)])].sort();
  const rows = roles.map((k) => row(k, sim[k] ?? zero, rec[k] ?? zero));
  const total = row("all", sum(sim), sum(rec), true);
  const failed = [...rows, total]
    .filter((r) => !r.ok)
    .map(
      (r) =>
        `${r.role}: recorded cost is ${Number.isFinite(r.delta) ? (r.delta * 100).toFixed(0) + " percent" : "unmatched"} off the simulated cost (limit ${RECON_MAX_DELTA * 100} percent)`,
    );
  return { rows, total, ok: failed.length === 0, failed };
}

const usd = (x: number) => "$" + x.toFixed(4);
export function formatRecon(r: Recon): string {
  const line = (x: ReconRow) =>
    `${x.role.padEnd(10)} calls/h ${x.simCallsPerHour.toFixed(0).padStart(5)} -> ${x.recCallsPerHour.toFixed(0).padStart(5)}   usd/h ${usd(x.simUsdPerHour)} -> ${usd(x.recUsdPerHour)}   ${Number.isFinite(x.delta) ? ((x.delta >= 0 ? "+" : "") + (x.delta * 100).toFixed(0) + "%").padStart(6) : "  n/a "}${x.ok ? "" : "  FAIL"}${x.material ? "" : "  (small)"}`;
  return ["Cost reconciliation (simulated -> recorded, per hour of call)", ...r.rows.map(line), line(r.total)].join("\n");
}

/** USD per role of the usage stored in a cassette's entries, priced with the default price table. For a cassette that has no run behind it. */
export function cassetteUsageByRole(
  c: Cassette,
  prices = loadSettings({ userFile: "/nonexistent/settings.yaml" }).settings.budget.prices,
): Record<string, RoleUse> {
  const meter = new CostMeter(prices, { maxUsdPerCall: 1e9, warnAt: 1, maxMinutesPerCall: 1e9 });
  const out: Record<string, RoleUse> = {};
  for (const e of c.entries()) {
    const u = e.usage as {
      inputTokens?: { total?: number; cacheRead?: number; cacheWrite?: number; noCache?: number };
      outputTokens?: { total?: number };
    } | null;
    if (!u) continue;
    const t = u.inputTokens ?? {};
    const { usd: cost } = meter.addLlm(e.role, e.model, {
      inputTokens: t.total ?? 0,
      outputTokens: u.outputTokens?.total ?? 0,
      inputTokenDetails: { cacheReadTokens: t.cacheRead ?? 0, cacheWriteTokens: t.cacheWrite ?? 0, noCacheTokens: t.noCache },
    });
    const r = (out[e.role] ??= { calls: 0, usd: 0 });
    r.calls++;
    r.usd += cost;
  }
  return out;
}
