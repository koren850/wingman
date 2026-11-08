// Offline evaluation of the deterministic parts of Wingman: no API keys, no network, no private data. pnpm eval
//   - question detector: precision / recall on data/questions.tsv and on the labelled "them" turns of the QA scenarios
//   - answer-bank matcher: top-1 / wrong card / no card on held-out utterances (src/bank-cases.ts)
//   - guards: must-block sentences blocked with the right rule, must-pass sentences left alone (src/guards-cases.ts), plus the interview salary guard
// It prints one table and exits 1 when a metric is worse than qa/eval-baseline.json by more than its tolerance. After an intended
// improvement, run `pnpm eval --update` to rewrite the baseline (review the diff: it is the committed evidence).
// Those four gates are LEGACY and IN-SAMPLE: the detector word lists and the bank were tuned on the same sentences. The honest measure is the
// golden meetings (data/meetings, qa/grade-golden.ts): invented 6 to 20 minute calls with labelled moments, graded on cards, not on sentences.
//   pnpm eval            legacy gates + golden metrics on the dev split for the legacy engine, negative controls, noisy delta
//   pnpm eval --update   rewrite the baseline (both parts)
//   pnpm eval --final    read the held-out test split ONCE (checks data/meetings/test.lock). Never use it to tune.
//   pnpm eval --meetings add one line per dev meeting
import "../src/test-setup.ts"; // the invented user and the example pack: the numbers do not depend on whose machine this runs on
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detect } from "../src/detector.ts";
import { guard, guardInterview } from "../src/guards.ts";
import { loadBank, matchBank, matchBankSmart } from "../src/bank.ts";
import { BANK_CASES } from "../src/bank-cases.ts";
import { BLOCKED, ALLOWED, SALARY_BLOCKED, SALARY_ALLOWED } from "../src/guards-cases.ts";
import { ROOT as APP_DIR, DATA } from "../src/env.ts";
import { loadSplit } from "../qa/golden-load.ts";
import {
  gradeGolden,
  poolGrades,
  gradeMemory,
  nullTimeline,
  noiseTimeline,
  degradeAsr,
  CONTROL_LIMITS,
  type Golden,
  type PooledGrade,
  type GoldenGrade,
  type Kind,
} from "../qa/grade-golden.ts";
import { legacyTimeline, guardBreach, gateReport } from "../qa/legacy-replay.ts";

if (process.argv.includes("--final") && process.argv.includes("--update")) {
  console.error("--final never writes a baseline.");
  process.exit(2);
}

type Metric = { id: string; label: string; hits: number; of: number; better: "higher" | "lower" };
const metrics: Metric[] = [];
const add = (id: string, label: string, hits: number, of: number, better: "higher" | "lower") => metrics.push({ id, label, hits, of, better });
const misses: string[] = [];

/** Confusion matrix -> precision and recall rows. */
function detectorRows(prefix: string, name: string, rows: { text: string; q: boolean }[]) {
  let tp = 0,
    fp = 0,
    fn = 0;
  for (const r of rows) {
    const got = detect(r.text).isQuestion;
    if (got && r.q) tp++;
    else if (got && !r.q) {
      fp++;
      misses.push(`FP  ${name}: ${r.text}`);
    } else if (!got && r.q) {
      fn++;
      misses.push(`FN  ${name}: ${r.text}`);
    }
  }
  add(`${prefix}.precision`, `${name}: precision`, tp, tp + fp, "higher");
  add(`${prefix}.recall`, `${name}: recall`, tp, tp + fn, "higher");
}

// 1. detector on the labelled set
const lines = readFileSync(join(DATA, "questions.tsv"), "utf8")
  .split("\n")
  .map((l) => l.split("\t"))
  .filter(([, label]) => label?.trim() === "Q" || label?.trim() === "N")
  .map(([text, label]) => ({ text, q: label.trim() === "Q" }));
detectorRows("detector.set", `detector, questions.tsv (n=${lines.length})`, lines);

// 2. detector on the QA scenario turns ("them" turns that carry a question label)
const turns: { text: string; q: boolean }[] = [];
for (const f of readdirSync(join(APP_DIR, "qa", "scenarios")).sort()) {
  const d = JSON.parse(readFileSync(join(APP_DIR, "qa", "scenarios", f), "utf8")) as {
    turns: { speaker: string; text: string; expect?: { question?: unknown } }[];
  };
  for (const t of d.turns) if (t.speaker === "them" && typeof t.expect?.question === "boolean") turns.push({ text: t.text, q: t.expect.question });
}
detectorRows("detector.scenarios", `detector, QA scenario turns (n=${turns.length})`, turns);

// 3. bank matcher
const bank = loadBank();
let right = 0,
  wrong = 0,
  none = 0;
for (const [text, want] of BANK_CASES) {
  // trigger match first, then the local scorer (what the moment engine does for a paraphrase)
  const got = matchBank(text, bank)?.card.id ?? matchBankSmart(text, bank, "he").hit?.card.id ?? "-";
  if (got === want) right++;
  else if (got === "-") {
    none++;
    misses.push(`MISS  bank: want ${want}: ${text}`);
  } else {
    wrong++;
    misses.push(`WRONG bank: want ${want}, got ${got}: ${text}`);
  }
}
add("bank.top1", `bank, top-1 right (n=${BANK_CASES.length})`, right, BANK_CASES.length, "higher");
add("bank.wrong", "bank, wrong card", wrong, BANK_CASES.length, "lower");
add("bank.none", "bank, no card", none, BANK_CASES.length, "lower");

// 4. guards
const rightRule = BLOCKED.filter(([t, rule]) => guard(t).rule === rule);
for (const [t, rule] of BLOCKED) if (guard(t).rule !== rule) misses.push(`GUARD not blocked as ${rule}: ${t}`);
const falsePos = ALLOWED.filter((t) => !guard(t).ok);
for (const t of falsePos) misses.push(`GUARD false positive: ${t}`);
add("guards.blocked", `guards, blocked with the right rule (n=${BLOCKED.length})`, rightRule.length, BLOCKED.length, "higher");
add("guards.falsePositives", `guards, false positives (n=${ALLOWED.length})`, falsePos.length, ALLOWED.length, "lower");
const salaryMissed = SALARY_BLOCKED.filter((t) => guardInterview(t).ok);
const salaryFp = SALARY_ALLOWED.filter((t) => !guardInterview(t).ok);
for (const t of salaryMissed) misses.push(`SALARY not blocked: ${t}`);
for (const t of salaryFp) misses.push(`SALARY false positive: ${t}`);
add("salary.blocked", `salary guard, blocked (n=${SALARY_BLOCKED.length})`, SALARY_BLOCKED.length - salaryMissed.length, SALARY_BLOCKED.length, "higher");
add("salary.falsePositives", `salary guard, false positives (n=${SALARY_ALLOWED.length})`, salaryFp.length, SALARY_ALLOWED.length, "lower");

// Compare with the committed baseline (percent values; `tolerance` is in percentage points).
const BASELINE = join(APP_DIR, "qa", "eval-baseline.json");
type GoldenBaseline = { engine: string; split: string; meetings: number; moments: number; metrics: Record<string, { value: number; n: number }> };
type Baseline = { tolerance: number; metrics: Record<string, number>; golden?: GoldenBaseline };
const pct = (m: Metric) => (m.of ? Math.round((1000 * m.hits) / m.of) / 10 : 0);
if (process.argv.includes("--update")) {
  const b: Baseline = { tolerance: 1, metrics: Object.fromEntries(metrics.map((m) => [m.id, pct(m)])), golden: legacyGoldenBaseline() };
  writeFileSync(BASELINE, JSON.stringify(b, null, 2) + "\n");
  console.log(`baseline written to ${BASELINE}`);
}
const base = JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;
let failed = 0;
const rows = metrics.map((m) => {
  const b = base.metrics[m.id];
  const v = pct(m);
  // the guard counts are exact; the detector and bank rates may move by the baseline tolerance
  const tol = m.id.startsWith("guards.") || m.id.startsWith("salary.") ? 0 : base.tolerance;
  const bad = b === undefined || (m.better === "higher" ? v < b - tol : v > b + tol);
  if (bad) failed++;
  return [m.label, `${m.hits}/${m.of}`, `${v.toFixed(1)}%`, b === undefined ? "none" : `${b.toFixed(1)}%`, bad ? "FAIL" : "ok"];
});
console.log("== Legacy gates (in-sample: the word lists and the bank were tuned on these sentences) ==");
const head = ["metric", "count", "now", "baseline", ""];
const w = head.map((_, i) => Math.max(head[i].length, ...rows.map((r) => r[i].length)));
const fmt = (r: string[]) => r.map((c, i) => c.padEnd(w[i])).join("  ");
console.log([fmt(head), w.map((n) => "-".repeat(n)).join("  "), ...rows.map(fmt)].join("\n"));
if (misses.length) console.log(`\nKnown misses (${misses.length}):\n${misses.map((m) => "  " + m).join("\n")}`);
if (failed) console.error(`\n${failed} metric(s) below the baseline in qa/eval-baseline.json`);
process.exitCode = failed ? 1 : 0;

// ---------------------------------------------------------------- golden meetings (the honest measure)
const goldenFailed = runGolden(process.argv.includes("--final") ? "test" : "dev");
if (goldenFailed) process.exitCode = 1;

// ---- golden section (function declarations are hoisted, so the code above can call them)
type GM = { id: string; label: string; value: number; n: number; unit: "%" | "ms" | "/min" | "#"; better: "higher" | "lower" | "info" };

function gradeEngine(meetings: Golden[]) {
  const bank = loadBank();
  return meetings.map((golden) => ({ golden, grade: gradeGolden(golden, legacyTimeline(golden, bank), { guard: guardBreach }) }));
}
function goldenMetrics(meetings: Golden[]): { pooled: PooledGrade; list: GM[]; per: { golden: Golden; grade: GoldenGrade }[] } {
  const kinds: Kind[] = ["answer", "prompt", "check", "fact"];
  const per = gradeEngine(meetings);
  const p = poolGrades(per);
  const mem = meetings.reduce((s, g) => s + (g.memoryChecks?.length ?? 0), 0);
  // The legacy engine keeps no session memory, so it has no snapshots to grade: every check fails by construction.
  const memPassed = meetings.reduce((s, g) => s + gradeMemory(g, []).passed, 0);
  const bank = loadBank();
  const gate = meetings
    .map((g) => gateReport(g, bank))
    .reduce(
      (a, x) => ({
        answerMoments: a.answerMoments + x.answerMoments,
        answerFlagged: a.answerFlagged + x.answerFlagged,
        quietLines: a.quietLines + x.quietLines,
        quietFlagged: a.quietFlagged + x.quietFlagged,
      }),
      { answerMoments: 0, answerFlagged: 0, quietLines: 0, quietFlagged: 0 },
    );
  const list: GM[] = [
    { id: "card.recall", label: "card recall", value: p.recall, n: p.moments, unit: "%", better: "higher" },
    { id: "card.precision", label: "card precision", value: p.precision, n: p.cards, unit: "%", better: "higher" },
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
    { id: "ttc.p50", label: "time to card p50", value: p.ttcP50 ?? 0, n: p.hits, unit: "ms", better: "lower" },
    { id: "ttc.p95", label: "time to card p95", value: p.ttcP95 ?? 0, n: p.hits, unit: "ms", better: "lower" },
    { id: "silent.cpm", label: "cards per minute in silent windows", value: p.silentCpm, n: Math.round(p.silentMinutes), unit: "/min", better: "lower" },
    { id: "wrong.card", label: "wrong-card rate", value: p.wrongCardRate, n: p.inTime, unit: "%", better: "lower" },
    { id: "dup.rate", label: "duplicate rate", value: p.duplicateRate, n: p.cards, unit: "%", better: "lower" },
    { id: "wrong.lang", label: "wrong-language rate", value: p.wrongLangRate, n: p.langKnown, unit: "%", better: "lower" },
    {
      id: "gate.recall",
      label: "legacy gate alone: answer moments it calls a question",
      value: gate.answerFlagged / (gate.answerMoments || 1),
      n: gate.answerMoments,
      unit: "%",
      better: "higher",
    },
    {
      id: "gate.quietFp",
      label: "legacy gate alone: quiet lines it calls a question",
      value: gate.quietFlagged / (gate.quietLines || 1),
      n: gate.quietLines,
      unit: "%",
      better: "lower",
    },
    { id: "memory.pass", label: "memory-check pass rate", value: mem ? memPassed / mem : 1, n: mem, unit: "%", better: "higher" },
    { id: "guard.breaches", label: "guard breaches (answer and prompt cards)", value: p.guardBreaches, n: p.cards, unit: "#", better: "lower" },
  ];
  return { pooled: p, list, per };
}
/** Allowed drop in percentage points for a rate measured on n items: about a 95 percent band, never under 2 points. */
function tolPoints(p: number, n: number) {
  return Math.max(2, n ? 196 * Math.sqrt((p * (1 - p)) / n) : 100);
}
function fmtVal(m: { value: number; unit: GM["unit"] }) {
  return m.unit === "%"
    ? `${(m.value * 100).toFixed(1)}%`
    : m.unit === "ms"
      ? `${Math.round(m.value)} ms`
      : m.unit === "/min"
        ? m.value.toFixed(2)
        : String(m.value);
}

function legacyGoldenBaseline(): GoldenBaseline {
  const meetings = loadSplit("dev");
  const { list, pooled } = goldenMetrics(meetings);
  return {
    engine: "legacy",
    split: "dev",
    meetings: meetings.length,
    moments: pooled.moments,
    metrics: Object.fromEntries(list.map((m) => [m.id, { value: Math.round(m.value * 10000) / 10000, n: m.n }])),
  };
}

/** Prints the golden table for a split and returns the number of failed gates. */
function runGolden(split: "dev" | "test"): number {
  const final = split === "test";
  const meetings = loadSplit(split, { final });
  const { list, per, pooled } = goldenMetrics(meetings);
  const baseline = (JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline).golden;
  let bad = 0;
  console.log(
    `\n== Golden meetings, ${split}${final ? " (HELD OUT, read once, do not tune on this)" : ""}: engine legacy, ${meetings.length} meetings, ${pooled.moments} moments, ${pooled.cards} cards ==`,
  );
  const rows = list.map((m) => {
    const b = !final && baseline ? baseline.metrics[m.id] : undefined;
    let verdict = "";
    if (!final && m.better !== "info") {
      if (!b) {
        verdict = "no baseline";
        bad++;
      } else {
        const rate = m.unit === "%";
        const worse = m.better === "higher" ? b.value - m.value : m.value - b.value;
        const tol = rate ? tolPoints(b.value, Math.min(b.n, m.n)) / 100 : m.unit === "ms" ? 300 : m.unit === "/min" ? 0.1 : 0;
        if (worse > tol + 1e-9) {
          verdict = "FAIL";
          bad++;
        } else verdict = "ok";
      }
    }
    return [m.label, `n=${m.n}`, fmtVal(m), b ? fmtVal({ value: b.value, unit: m.unit }) : final ? "-" : "none", verdict];
  });
  const head2 = ["metric", "sample", "now", "legacy baseline", ""];
  const w2 = head2.map((_, i) => Math.max(head2[i].length, ...rows.map((r) => r[i].length)));
  const f2 = (r: string[]) => r.map((c, i) => c.padEnd(w2[i])).join("  ");
  console.log([f2(head2), w2.map((n) => "-".repeat(n)).join("  "), ...rows.map(f2)].join("\n"));
  if (process.argv.includes("--meetings"))
    for (const x of per)
      console.log(
        `  ${x.golden.id.padEnd(26)} recall ${(x.grade.recall * 100).toFixed(0).padStart(3)}%  precision ${(x.grade.precision * 100).toFixed(0).padStart(3)}%  cards ${x.grade.cards}  moments ${x.grade.moments}`,
      );

  // noisy delta: the same meetings with "?" and all punctuation removed (the clean-versus-noisy gap; PLAN section 6 wants it under 10 points once v2 lands)
  const degraded = meetings.map(degradeAsr);
  const noisy = poolGrades(gradeEngine(degraded));
  const bank = loadBank();
  const sumGate = (ms: Golden[]) =>
    ms.map((g) => gateReport(g, bank)).reduce((a, x) => ({ n: a.n + x.answerMoments, hit: a.hit + x.answerFlagged }), { n: 0, hit: 0 });
  const gc = sumGate(meetings),
    gn = sumGate(degraded);
  console.log(
    `\nNoisy ASR on the same meetings (no "?", no punctuation, lowercase): card recall ${(noisy.recall * 100).toFixed(1)}% (clean ${(pooled.recall * 100).toFixed(1)}%), ` +
      `legacy gate recall on answer moments ${((gn.hit / (gn.n || 1)) * 100).toFixed(1)}% (clean ${((gc.hit / (gc.n || 1)) * 100).toFixed(1)}%)`,
  );

  // negative controls: the grader must score a model that does nothing and a model that guesses as bad
  const nullG = poolGrades(meetings.map((golden) => ({ golden, grade: gradeGolden(golden, nullTimeline(golden)) })));
  const noiseG = poolGrades(meetings.map((golden, i) => ({ golden, grade: gradeGolden(golden, noiseTimeline(golden, 7 + i), { guard: guardBreach }) })));
  const okNull = nullG.recall < CONTROL_LIMITS.nullRecall,
    okNoise = noiseG.precision < CONTROL_LIMITS.noisePrecision && noiseG.recall < CONTROL_LIMITS.noiseRecall;
  console.log(
    `Negative controls: null recall ${(nullG.recall * 100).toFixed(1)}% (limit under ${CONTROL_LIMITS.nullRecall * 100}%) ${okNull ? "ok" : "FAIL"}; ` +
      `noise precision ${(noiseG.precision * 100).toFixed(1)}% (limit under ${CONTROL_LIMITS.noisePrecision * 100}%), recall ${(noiseG.recall * 100).toFixed(1)}% (limit under ${CONTROL_LIMITS.noiseRecall * 100}%) ${okNoise ? "ok" : "FAIL"}`,
  );
  if (!okNull) bad++;
  if (!okNoise) bad++;
  console.log(
    "Note: the legacy replay runs the real detector, bank and guards on every line; it has no model, no memory and no timers, so it only shows what the question gate and bank reach. Scripted replies prove plumbing, not model judgement (PLAN section 6).",
  );
  if (bad) console.error(`\n${bad} golden gate(s) failed`);
  return bad;
}
