// Offline evaluation of the deterministic parts of Wingman: no API keys, no network, no private data. pnpm eval
//   - question detector: precision / recall on data/questions.tsv and on the labelled "them" turns of the QA scenarios
//   - answer-bank matcher: top-1 / wrong card / no card on held-out utterances (src/bank-cases.ts)
//   - guards: must-block sentences blocked with the right rule, must-pass sentences left alone (src/guards-cases.ts), plus the interview salary guard
// It prints one table and exits 1 when a metric is worse than qa/eval-baseline.json by more than its tolerance. After an intended
// improvement, run `pnpm eval --update` to rewrite the baseline (review the diff: it is the committed evidence).
import "../src/test-setup.ts"; // the invented user and the example pack: the numbers do not depend on whose machine this runs on
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detect } from "../src/detector.ts";
import { guard, guardInterview } from "../src/guards.ts";
import { loadBank, matchBank } from "../src/bank.ts";
import { BANK_CASES } from "../src/bank-cases.ts";
import { BLOCKED, ALLOWED, SALARY_BLOCKED, SALARY_ALLOWED } from "../src/guards-cases.ts";
import { ROOT as APP_DIR, DATA } from "../src/env.ts";

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
  const got = matchBank(text, bank)?.card.id ?? "-";
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
type Baseline = { tolerance: number; metrics: Record<string, number> };
const pct = (m: Metric) => (m.of ? Math.round((1000 * m.hits) / m.of) / 10 : 0);
if (process.argv.includes("--update")) {
  const b: Baseline = { tolerance: 1, metrics: Object.fromEntries(metrics.map((m) => [m.id, pct(m)])) };
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
const head = ["metric", "count", "now", "baseline", ""];
const w = head.map((_, i) => Math.max(head[i].length, ...rows.map((r) => r[i].length)));
const fmt = (r: string[]) => r.map((c, i) => c.padEnd(w[i])).join("  ");
console.log([fmt(head), w.map((n) => "-".repeat(n)).join("  "), ...rows.map(fmt)].join("\n"));
if (misses.length) console.log(`\nKnown misses (${misses.length}):\n${misses.map((m) => "  " + m).join("\n")}`);
if (failed) console.error(`\n${failed} metric(s) below the baseline in qa/eval-baseline.json`);
process.exitCode = failed ? 1 : 0;
