// Absolute ship gates (qa/ship.json), separate from the regression baseline (qa/eval-baseline.json).  pnpm eval --ship
// The baseline says "not worse than last time". These lines say "good enough to release". Most of them can be measured on scripted replies, but a
// scripted pass only proves the engine around the model. Lines marked `recordedOnly` need a recorded cassette run (see docs/RECORDING-EVALS.md); on scripted replies
// they print "n/a (scripted)" and do not count for or against.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../src/env.ts";
import { poolGrades } from "./grade-golden.ts";
import { fmt, type Unit, type V2Result } from "./eval-v2.ts";
import type { ControlResult } from "./eval-v2.ts";

export const SHIP_FILE = join(ROOT, "qa", "ship.json");
export type ShipLine = { id: string; label: string; metric: string; op: ">=" | "<="; limit: number; unit: Unit; recordedOnly?: boolean };
export type ShipFile = { v: 1; about: string; lines: ShipLine[] };
export const readShip = (file = SHIP_FILE): ShipFile => JSON.parse(readFileSync(file, "utf8")) as ShipFile;

/** The numbers a ship line can read. `undefined` = not measured on this run. Pure. */
export type ShipValues = Record<string, { value: number; n: number } | undefined>;

/** Values for the ship lines from a graded split. `extra` carries numbers from outside the golden run (memory F1 from a recorded memory eval, the direct-path p95 from the budget section). */
export function shipValues(res: V2Result, extra: Partial<Record<"memory.f1" | "ttc.direct.p95", number>> = {}): ShipValues {
  const out: ShipValues = {};
  for (const m of res.list) out[m.id] = { value: m.value, n: m.n };
  const lang = (l: string) => poolGrades(res.per.filter((x) => x.golden.lang === l));
  const en = lang("en"),
    he = lang("he");
  const enP = en.cards - en.allowed,
    heP = he.cards - he.allowed;
  out["gap.recall"] = { value: Math.abs(en.recall - he.recall), n: Math.min(en.moments, he.moments) };
  out["gap.precision"] = { value: Math.abs(en.precision - he.precision), n: Math.min(enP, heP) };
  if (extra["ttc.direct.p95"] !== undefined) out["ttc.direct.p95"] = { value: extra["ttc.direct.p95"], n: 0 };
  if (extra["memory.f1"] !== undefined) out["memory.f1"] = { value: extra["memory.f1"], n: 0 };
  return out;
}

export type ShipVerdict = "pass" | "FAIL" | "n/a (scripted)" | "n/a (no value)";
export type ShipRow = { id: string; label: string; now?: number; limit: number; op: ShipLine["op"]; unit: Unit; n: number; verdict: ShipVerdict };

/** Judges every line. `recorded`: the numbers come from a cassette; then recordedOnly lines count (and a missing value fails them: no evidence is no pass). */
export function judgeShip(values: ShipValues, lines: ShipLine[], recorded: boolean): { rows: ShipRow[]; failed: number; passed: number; skipped: number } {
  const rows = lines.map((l): ShipRow => {
    const v = values[l.metric];
    const base = { id: l.id, label: l.label, limit: l.limit, op: l.op, unit: l.unit, n: v?.n ?? 0 };
    if (l.recordedOnly && !recorded) return { ...base, verdict: "n/a (scripted)" };
    if (!v) return { ...base, verdict: l.recordedOnly ? "FAIL" : "n/a (no value)" };
    // a rate over nothing is not a pass: n = 0 on a rate line is "no value" unless it is a count or a number measured over hours
    const ok = l.op === ">=" ? v.value >= l.limit - 1e-9 : v.value <= l.limit + 1e-9;
    return { ...base, now: v.value, verdict: ok ? "pass" : "FAIL" };
  });
  return {
    rows,
    failed: rows.filter((r) => r.verdict === "FAIL").length,
    passed: rows.filter((r) => r.verdict === "pass").length,
    skipped: rows.filter((r) => r.verdict.startsWith("n/a")).length,
  };
}

export const fmtLimit = (r: Pick<ShipRow, "op" | "limit" | "unit">) => `${r.op} ${fmt(r.unit, r.limit)}`;

/** Does a bad model pass the gate? It must not. A control is judged on the lines a pooled grade can answer: recall, precision (when it showed cards), the silent rate. */
export function controlShip(
  c: Pick<ControlResult, "recall" | "precision" | "cards" | "silentCpm">,
  lines: ShipLine[] = readShip().lines,
): { passes: boolean; failing: string[] } {
  const values: ShipValues = {
    "card.recall": { value: c.recall, n: 1 },
    "silent.cpm": { value: c.silentCpm, n: 1 },
    ...(c.cards > 0 ? { "card.precision": { value: c.precision, n: c.cards } } : {}),
  };
  const mine = lines.filter((l) => !l.recordedOnly && l.metric in values);
  const j = judgeShip(values, mine, false);
  return { passes: j.failed === 0, failing: j.rows.filter((r) => r.verdict === "FAIL").map((r) => r.id) };
}
