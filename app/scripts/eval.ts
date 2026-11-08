// Offline evaluation of Wingman. No API keys, no network, no private data.  pnpm eval
// HEADLINE: the golden meetings (data/meetings, qa/grade-golden.ts) played through the v2 engine (src/e2e/v2-kit.ts runMeeting): per-kind recall and
// precision, recall on moments with no "?" and no question word, direct-question recall, time to card p50 and p95, cards per minute in silent windows,
// noisy-ASR loss, cost per hour, and a rubric judge (qa/judge.ts). Four bad models (null, noise, shuffled replies, always-ANS) run on a third of the
// meetings and must score low: if one does not, the grader can be fooled and the run fails.
// The replies in the golden files are scripted, so the numbers prove plumbing, timing and the grader. They do not prove model judgement.
// AFTER the headline: "legacy smoke (in-sample)": the old detector word lists, the answer bank and the guards on the sentences they were tuned on.
// It is a smoke test for the offline path, not a measure of quality, and it is not in the headline.
//   pnpm eval                     v2 golden on dev + controls + legacy smoke. Exit 1 when a metric is worse than qa/eval-baseline.json
//   pnpm eval --update            rewrite the baseline (review the diff: it is the committed evidence)
//   pnpm eval --final             read the held-out splits test and test-b ONCE (checks test.lock and test-b.lock). Never use it to tune.
//   pnpm eval --meetings          one line per meeting
//   pnpm eval --broken shuffled   play a deliberately broken engine (null, noise, shuffled or always-ans); the run must FAIL
//   pnpm eval --limit 8           only the first 8 meetings (for tests of the eval itself)
//   pnpm eval --out file.json     also write metrics, controls and rubric verdicts as JSON (default folder: qa/out/, not committed)
import "../src/test-setup.ts"; // the invented user and the example pack: the numbers do not depend on whose machine this runs on
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { detect } from "../src/detector.ts";
import { guard, guardInterview } from "../src/guards.ts";
import { loadBank, matchBank, matchBankSmart } from "../src/bank.ts";
import { BANK_CASES } from "../src/bank-cases.ts";
import { BLOCKED, ALLOWED, SALARY_BLOCKED, SALARY_ALLOWED } from "../src/guards-cases.ts";
import { ROOT as APP_DIR, DATA } from "../src/env.ts";
import { loadSplit, loadFinalSplits } from "../qa/golden-load.ts";
import { CONTROLS, type Control } from "../qa/controls.ts";
import type { Golden } from "../qa/grade-golden.ts";
import { play, v2Meetings, v2Metrics, controlResults, baselineOf, compare, fmt, type V2Baseline } from "../qa/eval-v2.ts";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const arg = (f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
if (has("--final") && has("--update")) {
  console.error("--final never writes a baseline.");
  process.exit(2);
}
const broken = arg("--broken") as Control | undefined;
if (has("--broken") && !(CONTROLS as readonly string[]).includes(String(broken))) {
  console.error(`--broken takes one of: ${CONTROLS.join(", ")}`);
  process.exit(2);
}

const BASELINE = join(APP_DIR, "qa", "eval-baseline.json");
type LegacyBaseline = { tolerance: number; metrics: Record<string, number> };
type Baseline = { legacy: LegacyBaseline; v2?: V2Baseline };
const readBaseline = () => JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;

// ---------------------------------------------------------------- 1. the v2 golden run (the headline)
async function runV2(): Promise<{ failed: number; baseline?: V2Baseline }> {
  const final = has("--final");
  // test-b is read after test, both behind their lock files; loadSplit refuses a held-out split without { final: true }
  const all: Golden[] = final ? loadFinalSplits() : loadSplit("dev");
  // --limit n: only the first n meetings by id. For the tests of the eval itself; the numbers are not comparable with the baseline.
  const limit = Number(arg("--limit") ?? 0);
  const meetings = v2Meetings(all)
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, limit > 0 ? limit : undefined);
  const plan = await play(meetings, { split: (g) => g.split, engineControl: broken });
  const { list, per, pooled, rubric } = v2Metrics(meetings, plan.clean, plan.noisy);
  const controls = controlResults(
    meetings.filter((g) => plan.subset.includes(g.id)),
    plan.controls,
  );

  let baseline: V2Baseline | undefined = readBaseline().v2;
  const updating = has("--update") && !broken;
  if (updating) baseline = baselineOf(list, meetings.length, pooled.moments);
  const { rows, failed: metricFails } = compare(list, final ? undefined : baseline, { informational: final });
  const engine = broken ? `BROKEN ENGINE (${broken})` : "engine v2";
  console.log(
    `== Golden meetings, ${final ? "test + test-b (HELD OUT, read once, do not tune on this)" : "dev"}: ${engine}, ${meetings.length} meetings, ${pooled.moments} moments, ${pooled.cards} cards (${pooled.allowed} labelled extras), ${plan.seconds.toFixed(0)} s ==`,
  );
  console.log("   Scripted model replies: this proves plumbing, timing and the grader, not model judgement.");
  const head = ["metric", "sample", "now", "baseline", ""];
  const body = rows.map((r) => [
    r.label,
    `n=${r.n}`,
    fmt(r.unit, r.now),
    r.base === undefined ? (final ? "-" : "none") : fmt(r.unit, r.base),
    final ? "" : r.verdict,
  ]);
  const w = head.map((_, i) => Math.max(head[i].length, ...body.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(w[i])).join("  ");
  console.log([line(head), w.map((n) => "-".repeat(n)).join("  "), ...body.map(line)].join("\n"));
  for (const r of rows.filter((x) => x.verdict !== "ok" && x.verdict !== "" && x.why)) console.log(`  ${r.verdict} ${r.id}: ${r.why}`);
  console.log(
    `Rubric judge, cards that fail a check: relevant ${rubric.failed.relevant}, language ${rubric.failed.language}, repeat ${rubric.failed.fresh}, window ${rubric.failed.window} (of ${rubric.cards} cards).`,
  );
  if (has("--meetings"))
    for (const x of per)
      console.log(
        `  ${x.golden.id.padEnd(28)} recall ${(x.grade.recall * 100).toFixed(0).padStart(3)}%  precision ${(x.grade.precision * 100).toFixed(0).padStart(3)}%  cards ${String(x.grade.cards).padStart(2)}  moments ${x.grade.moments}`,
      );

  console.log(`\nControls on ${plan.subset.length} meetings (each must score LOW; if one scores high the grader can be fooled):`);
  let controlFails = 0;
  for (const c of controls) {
    const bad = c.problems.length > 0;
    if (bad && !broken) controlFails++;
    console.log(
      `  ${c.name.padEnd(10)} recall ${(c.recall * 100).toFixed(1).padStart(5)}%  precision ${(c.precision * 100).toFixed(1).padStart(5)}%  cards ${String(c.cards).padStart(3)}  silent ${c.silentCpm.toFixed(2)}/min  ${bad ? "FAIL: " + c.problems.join("; ") : "ok"}`,
    );
  }
  if (controls.length !== CONTROLS.length) {
    controlFails++;
    console.log("  FAIL: a control did not run");
  }
  const failed = metricFails + controlFails;
  if (broken) console.log(`\nThis is a deliberately broken engine. It must fail the gates: ${failed} failed.`);
  if (failed) console.error(`\n${failed} golden gate(s) failed`);

  mkdirSync(join(APP_DIR, "qa", "out"), { recursive: true });
  const outFile = arg("--out") ?? join(APP_DIR, "qa", "out", final ? "eval-last-final.json" : "eval-last.json");
  writeFileSync(
    outFile,
    JSON.stringify(
      { split: final ? "test+test-b" : "dev", engine, metrics: Object.fromEntries(list.map((m) => [m.id, { value: m.value, n: m.n }])), controls, rubric },
      null,
      1,
    ) + "\n",
  );
  return { failed, baseline: updating ? baseline : undefined };
}

// ---------------------------------------------------------------- 2. legacy smoke (in-sample)
/** The old word-list gates. They were tuned on the same sentences they score, so they are a smoke test of the offline path. Never part of the headline. */
function legacySmoke(update: boolean): number {
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
  const pct = (m: Metric) => (m.of ? Math.round((1000 * m.hits) / m.of) / 10 : 0);
  const base = readBaseline().legacy;
  if (update) {
    base.metrics = Object.fromEntries(metrics.map((m) => [m.id, pct(m)]));
  }
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
  console.log("\n== Legacy smoke (in-sample: the word lists and the bank were tuned on these sentences; not a quality measure) ==");
  const head = ["metric", "count", "now", "baseline", ""];
  const w = head.map((_, i) => Math.max(head[i].length, ...rows.map((r) => r[i].length)));
  const fmtRow = (r: string[]) => r.map((c, i) => c.padEnd(w[i])).join("  ");
  console.log([fmtRow(head), w.map((n) => "-".repeat(n)).join("  "), ...rows.map(fmtRow)].join("\n"));
  if (misses.length) console.log(`\nKnown misses (${misses.length}):\n${misses.map((m) => "  " + m).join("\n")}`);
  if (failed) console.error(`\n${failed} legacy smoke metric(s) below the baseline in qa/eval-baseline.json`);
  if (update) {
    const cur = readBaseline();
    cur.legacy = base;
    writeFileSync(BASELINE, JSON.stringify(cur, null, 2) + "\n");
  }
  return failed;
}

const v2 = await runV2();
if (v2.baseline) {
  const cur = readBaseline();
  writeFileSync(BASELINE, JSON.stringify({ ...cur, v2: v2.baseline }, null, 2) + "\n");
  console.log(`\nv2 baseline written to ${BASELINE}`);
}
const legacyFailed = broken || has("--final") ? 0 : legacySmoke(has("--update"));
process.exitCode = v2.failed || legacyFailed ? 1 : 0;
