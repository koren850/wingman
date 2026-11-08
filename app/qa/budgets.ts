// Cost and latency budgets per role, calibrated from the usage rows and card timings of the golden run, and the gate that fails at +20 percent.
//   qa/budgets.json has two sections: `scripted` (the policy fake: real prompts, a simulated provider cache, scripted replies and delays) and `recorded`
//   (a cassette of real model calls, written by `pnpm eval --cassette <file> --update`). Every number belongs to one section, so it is always clear which
//   kind of evidence it is. The recorded section does not exist until the owner has recorded a cassette.
// What is gated, per role: USD per call, USD per hour. Per card path (direct question, observer, other): time to card p50 and p95.
// A role or path that has no budget yet is reported, not failed: the first `--update` after a new role creates it.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../src/env.ts";
import type { MeetingRun } from "../src/e2e/v2-kit.ts";
import { percentile, type GoldenGrade } from "./grade-golden.ts";

export const BUDGET_FILE = join(ROOT, "qa", "budgets.json");
/** Allowed growth over the budget, per role and per path. */
export const BUDGET_TOLERANCE = 0.2;
/** The release gate for the whole call, USD per hour. */
export const COST_PER_HOUR_GATE = 0.25;
/** Roles with fewer calls than this in the sample are not budgeted: an average of two calls is noise. */
const MIN_CALLS = 5;
/** Latency never gets a budget under this many ms, so a 5 ms path does not fail on 7 ms. */
const MIN_LATENCY_MS = 50;

export type Basis = "scripted" | "recorded";
export type RoleBudget = { calls: number; usdPerCall: number; usdPerHour: number };
export type PathBudget = { n: number; p50: number; p95: number };
export type Section = {
  basis: Basis;
  /** Where the numbers come from, in words. */
  source: string;
  hours: number;
  perHour: number;
  roles: Record<string, RoleBudget>;
  paths: Record<string, PathBudget>;
  /** Share of input tokens read from the prompt cache (information only). */
  cacheReadShare: number;
};
export type BudgetFile = {
  v: 1;
  tolerance: number;
  scripted?: Section;
  recorded?: Section;
  /** USD per call of the jobs that run once per call (digest, wrap-up). Measured by src/e2e/v2-cost.test.ts on the scripted fixtures; edited by hand. */
  oneShot?: Record<string, number>;
};

export const PATHS = ["direct", "observer", "other"] as const;
/** Which engine path made a card: a direct question (turn id q...), the observer (o...), or anything else (bank, stall, prepared, open loop). */
export const pathOf = (turnId: unknown): (typeof PATHS)[number] =>
  /^q\d+$/.test(String(turnId)) ? "direct" : /^o\d+$/.test(String(turnId)) ? "observer" : "other";

type Per = { run: MeetingRun; grade: GoldenGrade }[];
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** Measures a section from a played set of meetings. Pure. */
export function measure(per: Per, basis: Basis, source: string): Section {
  const rows = per.flatMap((p) => p.run.usage);
  const hours = per.reduce((a, p) => a + p.run.lengthMs, 0) / 3_600_000;
  const roles: Record<string, RoleBudget> = {};
  for (const role of [...new Set(rows.map((r) => r.role))].sort()) {
    const rr = rows.filter((r) => r.role === role);
    if (rr.length < MIN_CALLS) continue;
    const usd = rr.reduce((a, r) => a + (r.usd ?? 0), 0);
    if (!(usd > 0)) continue; // an unpriced role has nothing to budget
    roles[role] = { calls: rr.length, usdPerCall: r6(usd / rr.length), usdPerHour: r6(hours ? usd / hours : 0) };
  }
  const byPath: Record<string, number[]> = { direct: [], observer: [], other: [] };
  for (const p of per)
    for (const r of p.grade.results)
      if (r.status === "hit" && r.ttcMs !== undefined && r.card !== undefined) byPath[pathOf(p.run.screen[r.card]?.turnId)].push(r.ttcMs);
  const paths: Record<string, PathBudget> = {};
  for (const k of PATHS)
    if (byPath[k].length >= MIN_CALLS) paths[k] = { n: byPath[k].length, p50: percentile(byPath[k], 50) ?? 0, p95: percentile(byPath[k], 95) ?? 0 };
  const total = rows.reduce((a, r) => a + (r.usd ?? 0), 0);
  const input = rows.reduce((a, r) => a + ((r as { input_tokens?: number }).input_tokens ?? 0), 0);
  const read = rows.reduce((a, r) => a + ((r as { cache_read?: number }).cache_read ?? 0), 0);
  return { basis, source, hours: r6(hours), perHour: r6(hours ? total / hours : 0), roles, paths, cacheReadShare: input ? r6(read / input) : 0 };
}

export type BudgetRow = { id: string; now: number; budget: number | undefined; unit: "usd" | "ms"; verdict: "ok" | "FAIL" | "new" };
/** Compares a measured section with its budget. Fails at more than +20 percent per role and per path, and above the $0.25 per hour release gate. */
export function checkBudgets(now: Section, budget: Section | undefined, tol = BUDGET_TOLERANCE): { rows: BudgetRow[]; failed: number; notes: string[] } {
  const rows: BudgetRow[] = [];
  const notes: string[] = [];
  const add = (id: string, n: number, b: number | undefined, unit: "usd" | "ms", floor = 0) => {
    const limit = b === undefined ? undefined : Math.max(b * (1 + tol), floor);
    rows.push({ id, now: n, budget: b, unit, verdict: limit === undefined ? "new" : n > limit + 1e-12 ? "FAIL" : "ok" });
  };
  for (const [role, v] of Object.entries(now.roles)) {
    add(`${role}: USD per call`, v.usdPerCall, budget?.roles[role]?.usdPerCall, "usd");
    add(`${role}: USD per hour`, v.usdPerHour, budget?.roles[role]?.usdPerHour, "usd");
  }
  for (const role of Object.keys(budget?.roles ?? {})) if (!now.roles[role]) notes.push(`role ${role} has a budget but made too few calls in this run`);
  add("whole call: USD per hour", now.perHour, budget?.perHour, "usd");
  for (const [k, v] of Object.entries(now.paths)) {
    add(`${k} path: time to card p50`, v.p50, budget?.paths[k]?.p50, "ms", MIN_LATENCY_MS);
    add(`${k} path: time to card p95`, v.p95, budget?.paths[k]?.p95, "ms", MIN_LATENCY_MS);
  }
  let failed = rows.filter((r) => r.verdict === "FAIL").length;
  if (now.perHour > COST_PER_HOUR_GATE) {
    failed++;
    notes.push(`cost per hour $${now.perHour.toFixed(3)} is over the $${COST_PER_HOUR_GATE.toFixed(2)} release gate`);
  }
  return { rows, failed, notes };
}

export function readBudgets(file = BUDGET_FILE): BudgetFile {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as BudgetFile;
  } catch {
    return { v: 1, tolerance: BUDGET_TOLERANCE };
  }
}
export function writeBudgets(section: Section, file = BUDGET_FILE): void {
  const cur = readBudgets(file);
  writeFileSync(file, JSON.stringify({ ...cur, v: 1, tolerance: BUDGET_TOLERANCE, [section.basis]: section }, null, 2) + "\n");
}

export const fmtBudget = (r: BudgetRow, v: number | undefined) =>
  v === undefined ? "-" : r.unit === "usd" ? `$${v.toFixed(v < 0.01 ? 6 : 3)}` : `${Math.round(v)} ms`;
