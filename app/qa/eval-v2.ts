// The v2 evaluation: golden meetings through the real v2 engine (src/e2e/v2-kit.ts runMeeting, one child process per meeting, virtual clock, the policy
// fake), graded by qa/grade-golden.ts and qa/judge.ts. scripts/eval.ts prints it; src/r2-verify-core.test.ts tests the pieces.
// The replies in the golden files are SCRIPTED (written next to the moments), so these numbers prove the plumbing, timing and the grader, not model
// judgement. The controls below are what keeps the grader honest: a model that does nothing, guesses, or answers from the wrong slot must score low.
import { availableParallelism } from "node:os";
import { guard } from "../src/guards.ts";
import { runMeeting, pool, type MeetingRun, type WorkerOptions } from "../src/e2e/v2-kit.ts";
import { gradeGolden, gradeMemory, poolGrades, controlProblems, type Golden, type GoldenGrade, type PooledGrade, type ControlName } from "./grade-golden.ts";
import { CONTROLS, type Control } from "./controls.ts";
import { poolRubric, rubricJudge, type RubricSummary } from "./judge.ts";

/** Meeting types the v2 engine does not play yet in this build. Practice interviews keep the classic engine until the moments package lands. */
export const SKIP_TYPES: readonly string[] = ["interview"];
export const v2Meetings = (all: Golden[]) => all.filter((g) => !SKIP_TYPES.includes(g.type));

export type Unit = "%" | "ms" | "/min" | "usd" | "#";
export type GM = { id: string; label: string; value: number; n: number; unit: Unit; better: "higher" | "lower" | "info"; max?: number };

// ---------------------------------------------------------------- playing
export type Plan = {
  clean: MeetingRun[];
  noisy: MeetingRun[];
  /** control name -> runs on the control subset */
  controls: Partial<Record<Control, MeetingRun[]>>;
  subset: string[];
  seconds: number;
};
/** Every fourth meeting (sorted by id): enough variety for the controls and the noisy copy at a quarter of the cost. */
export const controlSubset = (ms: Golden[]) =>
  [...ms]
    .sort((a, b) => a.id.localeCompare(b.id))
    .filter((_, i) => i % 4 === 0)
    .map((g) => g.id);

/** Plays every meeting clean, and the noisy copy and the four controls on the subset, all in one pool of child processes. */
export async function play(
  meetings: Golden[],
  o: {
    split: (g: Golden) => WorkerOptions["split"];
    engineControl?: Control;
    controls?: boolean;
    noisy?: boolean;
    concurrency?: number;
    controlsOn?: string[];
    /** play against a recorded cassette: no controls, no noisy copy (their prompts are not in the file) */
    replay?: string;
  } = {
    split: () => "dev",
  },
): Promise<Plan> {
  const t0 = Date.now();
  const subset = o.controlsOn ?? controlSubset(meetings);
  type Job = { id: string; kind: "clean" | "noisy" | Control; opts: WorkerOptions };
  const jobs: Job[] = [];
  const base = (g: Golden): WorkerOptions => ({
    split: o.split(g),
    ...(o.engineControl ? { control: o.engineControl } : {}),
    ...(o.replay ? { replay: { cassette: o.replay } } : {}),
  });
  for (const g of meetings) jobs.push({ id: g.id, kind: "clean", opts: base(g) });
  if (o.noisy !== false && !o.replay)
    for (const g of meetings.filter((m) => subset.includes(m.id))) jobs.push({ id: g.id, kind: "noisy", opts: { ...base(g), noisy: true, asks: false } });
  if (o.controls !== false && !o.replay)
    for (const c of CONTROLS)
      for (const g of meetings.filter((m) => subset.includes(m.id))) jobs.push({ id: g.id, kind: c, opts: { split: o.split(g), control: c, asks: false } });
  const done = await pool(jobs, o.concurrency ?? Math.min(8, availableParallelism()), async (j) => ({ j, run: await runMeeting(j.id, j.opts, 180_000) }));
  const plan: Plan = { clean: [], noisy: [], controls: {}, subset, seconds: (Date.now() - t0) / 1000 };
  for (const { j, run } of done) {
    if (j.kind === "clean") plan.clean.push(run);
    else if (j.kind === "noisy") plan.noisy.push(run);
    else (plan.controls[j.kind] ??= []).push(run);
  }
  return plan;
}

// ---------------------------------------------------------------- grading
const guardBreach = (t: string) => !guard(t).ok;
export function gradeRuns(meetings: Golden[], runs: MeetingRun[]): { golden: Golden; run: MeetingRun; grade: GoldenGrade }[] {
  return runs.map((run) => {
    const golden = meetings.find((g) => g.id === run.id)!;
    return { golden, run, grade: gradeGolden(golden, run.cards) };
  });
}

export type V2Result = {
  list: GM[];
  pooled: PooledGrade;
  per: { golden: Golden; run: MeetingRun; grade: GoldenGrade }[];
  rubric: RubricSummary;
};
export function v2Metrics(meetings: Golden[], runs: MeetingRun[], noisyRuns: MeetingRun[] = []): V2Result {
  const per = gradeRuns(meetings, runs);
  const p = poolGrades(per);
  const kinds = ["answer", "prompt", "check", "fact"] as const;
  const noq = per.flatMap((x) => x.golden.moments.filter((m) => m.tags?.includes("noq")).map((m) => x.grade.results.find((r) => r.id === m.id)!));
  const noqHits = noq.filter((r) => r.status === "hit").length;
  const byLang = (lang: string) => {
    const xs = per.filter((x) => x.golden.lang === lang);
    const q = xs.reduce((s, x) => s + x.grade.moments, 0);
    return { n: q, v: q ? xs.reduce((s, x) => s + x.grade.hits, 0) / q : 1 };
  };
  const en = byLang("en"),
    he = byLang("he");
  const mem = meetings.reduce((s, g) => s + (g.memoryChecks?.length ?? 0), 0);
  const memPassed = per.reduce((s, x) => s + gradeMemory(x.golden, x.run.snapshots as never).passed, 0);
  const hours = runs.reduce((a, r) => a + r.lengthMs, 0) / 3_600_000;
  const usd = runs.reduce((a, r) => a + r.usage.reduce((s, u) => s + (u.usd ?? 0), 0), 0);
  const calls = runs.reduce((a, r) => a + (r.calls.length || r.usage.length), 0); // a replayed run has no cache simulator records, only usage rows
  // the noisy copy runs on the control subset: compare it with the clean run of the same meetings
  const nz = gradeRuns(meetings, noisyRuns);
  const same = new Set(noisyRuns.map((r) => r.id));
  const cleanSame = poolGrades(per.filter((x) => same.has(x.golden.id)));
  const noisyRecall = nz.length ? poolGrades(nz).recall : p.recall;
  const noisyLoss = nz.length ? Math.max(0, cleanSame.recall - noisyRecall) : 0;
  // Guard breaches are counted on the cards the user may read out loud: answer and prompt cards of the moment path (a direct question q*, an observer line o*).
  // Open-loop prompts ("Promised, not done yet: ...") and the AI-down notes cards quote the call, so a guard word in them is not a breach.
  const sayable = runs.flatMap((r) => r.cards.filter((c, i) => /^[qo]\d+$/.test(String(r.screen[i]?.turnId)) && (c.kind === "answer" || c.kind === "prompt")));
  const breaches = sayable.filter((c) => guardBreach(c.text)).length;
  const rubric = poolRubric(per.map((x) => rubricJudge(x.golden, x.run.cards).summary));
  const ttc = (v: number | null) => v ?? 0;
  const list: GM[] = [
    { id: "card.recall", label: "card recall", value: p.recall, n: p.moments, unit: "%", better: "higher" },
    { id: "card.precision", label: "card precision (labelled extras left out)", value: p.precision, n: p.cards - p.allowed, unit: "%", better: "higher" },
    ...kinds.map((k): GM => ({ id: `recall.${k}`, label: `  recall, ${k}`, value: p.byKind[k].recall, n: p.byKind[k].moments, unit: "%", better: "higher" })),
    ...kinds.map((k): GM => ({
      id: `precision.${k}`,
      label: `  precision, ${k}`,
      value: p.byKind[k].precision,
      n: p.byKind[k].cards,
      unit: "%",
      better: "higher",
    })),
    { id: "direct.recall", label: "direct-question recall", value: p.directRecall, n: p.directMoments, unit: "%", better: "higher" },
    {
      id: "noq.recall",
      label: "recall, no '?' and no question word",
      value: noq.length ? noqHits / noq.length : 1,
      n: noq.length,
      unit: "%",
      better: "higher",
    },
    { id: "recall.en", label: "  recall, English calls", value: en.v, n: en.n, unit: "%", better: "higher" },
    { id: "recall.he", label: "  recall, Hebrew calls", value: he.v, n: he.n, unit: "%", better: "higher" },
    { id: "ttc.p50", label: "time to card p50", value: ttc(p.ttcP50), n: p.hits, unit: "ms", better: "lower" },
    { id: "ttc.p95", label: "time to card p95", value: ttc(p.ttcP95), n: p.hits, unit: "ms", better: "lower" },
    {
      id: "silent.cpm",
      label: "cards per minute in silent windows",
      value: p.silentCpm,
      n: Math.round(p.silentMinutes),
      unit: "/min",
      better: "lower",
      max: 1 / 3,
    },
    { id: "wrong.card", label: "wrong-card rate", value: p.wrongCardRate, n: p.inTime, unit: "%", better: "lower" },
    { id: "dup.rate", label: "duplicate rate", value: p.duplicateRate, n: p.cards, unit: "%", better: "lower" },
    { id: "wrong.lang", label: "wrong-language rate", value: p.wrongLangRate, n: p.langKnown, unit: "%", better: "lower" },
    {
      id: "guard.rate",
      label: "guard breaches in answer and prompt cards (moment path)",
      value: sayable.length ? breaches / sayable.length : 0,
      n: sayable.length,
      unit: "%",
      better: "lower",
      max: 0.0001,
    },
    { id: "memory.pass", label: "memory-check pass rate", value: mem ? memPassed / mem : 1, n: mem, unit: "%", better: "higher" },
    { id: "rubric.pass", label: "rubric judge: cards that pass all four checks", value: rubric.rate, n: rubric.cards, unit: "%", better: "higher" },
    {
      id: "noisy.delta",
      label: "noisy ASR: recall lost against the clean run",
      value: noisyLoss,
      n: cleanSame.moments,
      unit: "%",
      better: "lower",
      max: 0.1,
    },
    { id: "cost.perHour", label: "model cost per hour (modelled usage, all roles)", value: hours ? usd / hours : 0, n: calls, unit: "usd", better: "lower" },
    { id: "calls.perHour", label: "model calls per hour", value: hours ? calls / hours : 0, n: calls, unit: "#", better: "info" },
    { id: "cards.perHour", label: "cards per hour on screen", value: hours ? p.cards / hours : 0, n: p.cards, unit: "#", better: "info" },
  ];
  return { list, pooled: p, per, rubric };
}

// ---------------------------------------------------------------- controls
export type ControlResult = { name: ControlName; recall: number; precision: number; cards: number; silentCpm: number; problems: string[] };
export function controlResults(meetings: Golden[], controls: Plan["controls"]): ControlResult[] {
  const out: ControlResult[] = [];
  for (const name of CONTROLS) {
    const runs = controls[name];
    if (!runs?.length) continue;
    const p = poolGrades(gradeRuns(meetings, runs));
    out.push({ name, recall: p.recall, precision: p.precision, cards: p.cards, silentCpm: p.silentCpm, problems: controlProblems(name, p) });
  }
  return out;
}

// ---------------------------------------------------------------- baseline
export type V2Baseline = {
  engine: "v2";
  split: "dev";
  /** true: the model replies are scripted. false: replayed from a recorded cassette (the `v2Recorded` section). */
  scripted: boolean;
  /** recorded baselines: the cassette the numbers come from */
  cassette?: string;
  meetings: number;
  moments: number;
  /** Lowest value a baseline keeps. A rate of exactly 0 is a gate that cannot fail, so lower-is-better metrics are stored at least at this level. */
  floor: Record<Unit, number>;
  metrics: Record<string, { value: number; n: number }>;
};
export const FLOOR: Record<Unit, number> = { "%": 0.005, ms: 1, "/min": 0.01, usd: 0.0001, "#": 1 };
export function baselineOf(list: GM[], meetings: number, moments: number, o: { cassette?: string } = {}): V2Baseline {
  const r = (x: number) => Math.round(x * 100000) / 100000;
  return {
    engine: "v2",
    split: "dev",
    scripted: !o.cassette,
    ...(o.cassette ? { cassette: o.cassette } : {}),
    meetings,
    moments,
    floor: FLOOR,
    metrics: Object.fromEntries(list.map((m) => [m.id, { value: Math.max(r(m.value), FLOOR[m.unit]), n: m.n }])),
  };
}
/** Allowed drop in a rate measured on n items: about a 95 percent band, never under 2 points. Fractions in, fraction out. */
export function tolPoints(p: number, n: number): number {
  return Math.max(2, n ? 196 * Math.sqrt((p * (1 - p)) / n) : 100) / 100;
}
export type Row = { id: string; label: string; n: number; now: number; base?: number; unit: Unit; verdict: "ok" | "FAIL" | "no baseline" | ""; why?: string };
/** Compares the metrics with the baseline. A metric is bad when it is worse than the baseline by more than its tolerance, or past its own hard limit.
 *  `informational` (the held-out run) prints the numbers and enforces only the hard limits. */
export function compare(list: GM[], base: V2Baseline | undefined, o: { informational?: boolean } = {}): { rows: Row[]; failed: number } {
  let failed = 0;
  const rows = list.map((m): Row => {
    const b = base?.metrics[m.id];
    const row: Row = { id: m.id, label: m.label, n: m.n, now: m.value, base: b?.value, unit: m.unit, verdict: "" };
    if (m.max !== undefined && m.value > m.max + 1e-9) return fail(row, `over its limit ${m.max}`);
    if (m.better === "info" || o.informational) return row;
    if (!b) return fail({ ...row, verdict: "no baseline" }, "no baseline");
    const worse = m.better === "higher" ? b.value - m.value : m.value - b.value;
    const tol =
      m.unit === "%" ? tolPoints(b.value, Math.min(b.n, m.n)) : m.unit === "ms" ? 300 : m.unit === "/min" ? 0.1 : m.unit === "usd" ? b.value * 0.2 : 0;
    return worse > tol + 1e-9 ? fail(row, `worse than ${b.value} by more than ${tol}`) : { ...row, verdict: "ok" };
  });
  function fail(row: Row, why: string): Row {
    failed++;
    return { ...row, verdict: row.verdict === "no baseline" ? "no baseline" : "FAIL", why };
  }
  return { rows, failed };
}
export function fmt(unit: Unit, v: number): string {
  return unit === "%"
    ? `${(v * 100).toFixed(1)}%`
    : unit === "ms"
      ? `${Math.round(v)} ms`
      : unit === "/min"
        ? v.toFixed(2)
        : unit === "usd"
          ? `$${v.toFixed(3)}`
          : String(Math.round(v));
}
