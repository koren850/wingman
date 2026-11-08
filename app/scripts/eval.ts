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
//   pnpm eval --final             read the held-out splits test and test-b ONCE, each on its own, printed next to the dev baseline (checks test.lock and
//                                 test-b.lock). Never use it to tune.
//   pnpm eval --ship             also judge the ABSOLUTE ship gates in qa/ship.json (separate from the baseline): pass or FAIL per line. recordedOnly lines print
//                                 "n/a (scripted)" on scripted replies. Exit 1 when a line fails or a bad-model control passes the gate. With --final it also
//                                 reads the blind split test-c (data/meetings/test-c, test-c.lock); without --ship test-c is never read.
//   pnpm eval --cassette <file>   play dev against a cassette of REAL model replies (scripts/cassette-record.ts). Numbers are marked RECORDED, compared with
//                                 the v2Recorded baseline, and the model judge reads <file>.judge.cassette.json if it exists. Works with --final and --update.
//   pnpm eval --meetings          one line per meeting
//   pnpm eval --broken shuffled   play a deliberately broken engine (null, noise, shuffled or always-ans); the run must FAIL
//   pnpm eval --limit 8           only the first 8 meetings (for tests of the eval itself)
//   pnpm eval --only id1,id2      only these dev meetings (never writes a baseline, never gates the budgets)
//   pnpm eval --out file.json     also write metrics, controls and rubric verdicts as JSON (default folder: qa/out/, not committed)
import "../src/test-setup.ts"; // the invented user and the example pack: the numbers do not depend on whose machine this runs on
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
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
import { measure, checkBudgets, readBudgets, writeBudgets, fmtBudget, BUDGET_TOLERANCE, COST_PER_HOUR_GATE, type Section } from "../qa/budgets.ts";
import { runMemoryEval, controlBreaches, CONTROL_LIMITS, type MemoryEvalResult } from "../qa/memory-eval.ts";
import { modelJudgeSummary, judgeCassettePath } from "../qa/judge-eval.ts";
import { readShip, shipValues, judgeShip, controlShip, fmtLimit } from "../qa/ship.ts";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const arg = (f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
if (has("--final") && has("--update")) {
  console.error("--final never writes a baseline.");
  process.exit(2);
}
for (const f of ["--cassette", "--only", "--out", "--limit", "--memory-f1"])
  if (has(f) && (!arg(f) || arg(f)!.startsWith("--"))) {
    console.error(`${f} needs a value.`);
    process.exit(2);
  }
const broken = arg("--broken") as Control | undefined;
if (has("--broken") && !(CONTROLS as readonly string[]).includes(String(broken))) {
  console.error(`--broken takes one of: ${CONTROLS.join(", ")}`);
  process.exit(2);
}

// --cassette a.json[,b.json]: several files are merged (the held-out run plays test and test-b together)
const cassette = arg("--cassette")
  ?.split(",")
  .map((f) => resolve(f))
  .join(",");
for (const f of cassette?.split(",") ?? [])
  if (!existsSync(f)) {
    console.error(`--cassette: no such file ${f}`);
    process.exit(2);
  }
const BASELINE = join(APP_DIR, "qa", "eval-baseline.json");
type LegacyBaseline = { tolerance: number; metrics: Record<string, number> };
type Baseline = { legacy: LegacyBaseline; v2?: V2Baseline; v2Recorded?: V2Baseline };
const readBaseline = () => JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;

// ---------------------------------------------------------------- 1. the v2 golden run (the headline)
type Played = {
  name: string;
  meetings: Golden[];
  plan: Awaited<ReturnType<typeof play>>;
  res: ReturnType<typeof v2Metrics>;
  controls: ReturnType<typeof controlResults>;
  section: Section;
};
/** Plays one split (or a part of it) and grades it. The basis is where the model replies come from: the scripted fake or a recorded cassette. */
async function playSplit(name: string, meetings: Golden[]): Promise<Played> {
  const plan = await play(meetings, { split: (g) => g.split, engineControl: broken, ...(cassette ? { replay: cassette } : {}) });
  const res = v2Metrics(meetings, plan.clean, plan.noisy);
  const controls = controlResults(
    meetings.filter((g) => plan.subset.includes(g.id)),
    plan.controls,
  );
  const section = measure(res.per, cassette ? "recorded" : "scripted", cassette ? `cassette ${cassette}, ${name}` : `scripted replies, policy fake, ${name}`);
  return { name, meetings, plan, res, controls, section };
}
const table = (head: string[], body: string[][]) => {
  const w = head.map((_, i) => Math.max(head[i].length, ...body.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(w[i])).join("  ");
  return [line(head), w.map((n) => "-".repeat(n)).join("  "), ...body.map(line)].join("\n");
};
function printControls(p: Played): number {
  if (cassette) {
    console.log(`\nControls: not run for a recorded cassette (their prompts are not in the file).`);
    return 0;
  }
  console.log(`\nControls on ${p.plan.subset.length} meetings (each must score LOW; if one scores high the grader can be fooled):`);
  let fails = 0;
  for (const c of p.controls) {
    const bad = c.problems.length > 0;
    if (bad && !broken) fails++;
    console.log(
      `  ${c.name.padEnd(10)} recall ${(c.recall * 100).toFixed(1).padStart(5)}%  precision ${(c.precision * 100).toFixed(1).padStart(5)}%  cards ${String(c.cards).padStart(3)}  silent ${c.silentCpm.toFixed(2)}/min  ${bad ? "FAIL: " + c.problems.join("; ") : "ok"}`,
    );
  }
  if (p.controls.length !== CONTROLS.length) {
    fails++;
    console.log("  FAIL: a control did not run");
  }
  return fails;
}
/** The absolute ship gates (qa/ship.json) for one played split: a line per gate, and the bad-model controls, which must NOT pass them. Returns the failures. */
function shipBlock(p: Played, title: string): number {
  const file = readShip();
  const memF1 = arg("--memory-f1") !== undefined ? Number(arg("--memory-f1")) : undefined;
  const direct = cassette ? p.section.paths.direct?.p95 : undefined;
  const values = shipValues(p.res, {
    ...(memF1 !== undefined && Number.isFinite(memF1) ? { "memory.f1": memF1 } : {}),
    ...(direct !== undefined ? { "ttc.direct.p95": direct } : {}),
  });
  const j = judgeShip(values, file.lines, !!cassette);
  console.log(`\n== Ship gates, ${title} (qa/ship.json, absolute, not the baseline) ==`);
  console.log(
    table(
      ["gate", "sample", "now", "needs", ""],
      j.rows.map((r) => [r.label, r.n ? `n=${r.n}` : "", r.now === undefined ? "-" : fmt(r.unit, r.now), fmtLimit(r), r.verdict]),
    ),
  );
  let failed = j.failed;
  console.log(
    `   ${j.passed} pass, ${j.failed} FAIL, ${j.skipped} n/a. ${cassette ? "RECORDED basis." : "SCRIPTED basis: recordedOnly lines do not count; a scripted pass is not a release pass."}`,
  );
  if (!cassette)
    for (const c of p.controls) {
      const cs = controlShip(c, file.lines);
      if (cs.passes) {
        failed++;
        console.log(`  FAIL control ${c.name} passes the ship gate: the gate can be fooled`);
      } else console.log(`  control ${c.name.padEnd(10)} fails the gate as it must (${cs.failing.join(", ")})`);
    }
  return failed;
}
const basisLine = () =>
  cassette
    ? `   Basis: RECORDED. Model replies are replayed from ${cassette}. These numbers measure the model.`
    : "   Basis: SCRIPTED model replies. This proves plumbing, timing and the grader, not model judgement.";

/** The held-out run: test and test-b, each read once behind its own lock, each reported next to the dev baseline. Prints only; never tune on it. */
async function runFinal(): Promise<number> {
  const ship = has("--ship");
  const all = loadFinalSplits(undefined, { ship });
  const names = ship ? (["test", "test-b", "test-c"] as const) : (["test", "test-b"] as const);
  const parts = names.map((name) => ({
    name,
    meetings: v2Meetings(all.filter((g) => g.split === name)).sort((a, b) => a.id.localeCompare(b.id)),
  }));
  const played: Played[] = [];
  for (const p of parts) if (p.meetings.length) played.push(await playSplit(p.name, p.meetings));
  const base = readBaseline()[cassette ? "v2Recorded" : "v2"];
  console.log(`== Held-out golden meetings, engine v2: READ ONCE, do not tune on this ==`);
  console.log(basisLine());
  console.log(
    `   dev column = committed baseline (${base ? base.meetings : "?"} meetings, ${base ? base.moments : "?"} moments). ${played.map((p) => `${p.name}: ${p.meetings.length} meetings, ${p.res.pooled.moments} moments, ${p.plan.seconds.toFixed(0)} s`).join(". ")}.`,
  );
  const head = ["metric", "dev", ...played.flatMap((p) => [p.name, "n"])];
  const body = played[0].res.list.map((m) => [
    m.label,
    base?.metrics[m.id] ? fmt(m.unit, base.metrics[m.id].value) : "-",
    ...played.flatMap((p) => {
      const x = p.res.list.find((y) => y.id === m.id)!;
      return [x.n === 0 && x.better !== "info" ? "n/a" : fmt(x.unit, x.value), `n=${x.n}`]; // a rate over nothing is not 100 percent
    }),
  ]);
  console.log(table(head, body));
  let failed = 0;
  for (const p of played) {
    const { rows } = compare(p.res.list, undefined, { informational: true });
    for (const r of rows.filter((x) => x.verdict === "FAIL")) {
      failed++;
      console.log(`  FAIL ${p.name} ${r.id}: ${r.why}`);
    }
    const b = p.res.rubric;
    console.log(
      `Rubric judge, ${p.name}, cards that fail a check: relevant ${b.failed.relevant}, language ${b.failed.language}, repeat ${b.failed.fresh}, window ${b.failed.window} (of ${b.cards} cards).`,
    );
    failed += printControls(p);
    // the blind split decides the ship verdict; the other two are printed for comparison and do not add failures
    if (ship) {
      const f = shipBlock(p, `${p.name}${p.name === "test-c" ? " (BLIND, decides)" : " (for comparison)"}`);
      if (p.name === "test-c") failed += f;
    }
    const chk = checkBudgets(p.section, readBudgets()[cassette ? "recorded" : "scripted"]);
    console.log(
      `Budgets on ${p.name} (information only, the dev run gates): ${chk.rows.filter((r) => r.verdict === "FAIL").length} over, cost per hour $${p.section.perHour.toFixed(3)}.`,
    );
  }
  mkdirSync(join(APP_DIR, "qa", "out"), { recursive: true });
  const outFile = arg("--out") ?? join(APP_DIR, "qa", "out", "eval-last-final.json");
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        basis: cassette ? "recorded" : "scripted",
        splits: Object.fromEntries(
          played.map((p) => [
            p.name,
            {
              metrics: Object.fromEntries(p.res.list.map((m) => [m.id, { value: m.value, n: m.n }])),
              controls: p.controls,
              rubric: p.res.rubric,
              section: p.section,
            },
          ]),
        ),
      },
      null,
      1,
    ) + "\n",
  );
  if (failed) console.error(`\n${failed} held-out hard limit(s) failed`);
  return failed;
}

async function runV2(): Promise<{ failed: number; baseline?: V2Baseline; section?: Section }> {
  // --limit n: only the first n meetings by id. For the tests of the eval itself; the numbers are not comparable with the baseline.
  const limit = Number(arg("--limit") ?? 0);
  const only = arg("--only")?.split(",");
  const meetings = v2Meetings(loadSplit("dev"))
    .filter((g) => !only || only.includes(g.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, limit > 0 ? limit : undefined);
  if (!meetings.length) {
    console.error("no dev meeting matches --only");
    process.exit(2);
  }
  const p = await playSplit("dev", meetings);
  const { list, per, pooled, rubric } = p.res;
  const key = cassette ? "v2Recorded" : "v2";
  let baseline: V2Baseline | undefined = readBaseline()[key];
  const updating = has("--update") && !broken && limit === 0 && !only;
  if (updating) baseline = baselineOf(list, meetings.length, pooled.moments, { cassette });
  const { rows, failed: metricFails } = compare(list, baseline);
  const engine = broken ? `BROKEN ENGINE (${broken})` : "engine v2";
  console.log(
    `== Golden meetings, dev: ${engine}, ${meetings.length} meetings, ${pooled.moments} moments, ${pooled.cards} cards (${pooled.allowed} labelled extras), ${p.plan.seconds.toFixed(0)} s ==`,
  );
  console.log(basisLine());
  if (cassette) {
    const misses = p.plan.clean.reduce((a, r) => a + (r.cassetteMisses ?? 0), 0);
    const stale = p.plan.clean.reduce((a, r) => a + (r.cassetteStale ?? 0), 0);
    console.log(
      `   Cassette misses: ${misses - stale} model call(s) had no recorded answer${misses - stale ? " (the engine treated each as a model error; re-record if this is high)" : ""}.`,
    );
    if (stale)
      console.log(`   Cassette STALE: ${stale} call(s) have an entry recorded with an older prompt text or model. Re-record; this is not an engine fault.`);
    if (!baseline) console.log("   No recorded baseline yet: this run prints numbers only. Run with --update to write the first one.");
  }
  console.log(
    table(
      ["metric", "sample", "now", "baseline", ""],
      rows.map((r) => [
        r.label,
        `n=${r.n}`,
        fmt(r.unit, r.now),
        r.base === undefined ? "none" : fmt(r.unit, r.base),
        r.verdict === "no baseline" && cassette ? "-" : r.verdict,
      ]),
    ),
  );
  for (const r of rows.filter((x) => x.verdict !== "ok" && x.verdict !== "" && x.why && !(cassette && !baseline)))
    console.log(`  ${r.verdict} ${r.id}: ${r.why}`);
  console.log(
    `Rubric judge, cards that fail a check: relevant ${rubric.failed.relevant}, language ${rubric.failed.language}, repeat ${rubric.failed.fresh}, window ${rubric.failed.window} (of ${rubric.cards} cards).`,
  );
  if (has("--meetings"))
    for (const x of per)
      console.log(
        `  ${x.golden.id.padEnd(28)} recall ${(x.grade.recall * 100).toFixed(0).padStart(3)}%  precision ${(x.grade.precision * 100).toFixed(0).padStart(3)}%  cards ${String(x.grade.cards).padStart(2)}  moments ${x.grade.moments}`,
      );
  let failed = cassette && !baseline ? 0 : metricFails;

  // budgets per role: cost and latency, +20 percent fails
  const budget = readBudgets()[p.section.basis];
  const chk = checkBudgets(p.section, updating || limit > 0 || only ? undefined : budget);
  console.log(
    `\nBudgets per role (${p.section.basis}; fail at +${Math.round(BUDGET_TOLERANCE * 100)} percent; ${budget ? "from qa/budgets.json" : "none yet"}):`,
  );
  console.log(
    table(
      ["role or path", "now", "budget", ""],
      chk.rows.map((r) => [r.id, fmtBudget(r, r.now), fmtBudget(r, r.budget), r.verdict === "new" ? "-" : r.verdict]),
    ),
  );
  for (const n of chk.notes) console.log(`  ${n}`);
  if (!budget && !updating && !cassette && limit === 0 && !only) {
    console.log("  FAIL: qa/budgets.json has no scripted section. Run pnpm eval --update.");
    failed++;
  }
  failed += chk.rows.filter((r) => r.verdict === "FAIL").length + (chk.notes.some((n) => /release gate/.test(n)) ? 1 : 0);
  console.log(
    `Cost per hour: $${p.section.perHour.toFixed(3)} (${p.section.basis}); the release gate is $${COST_PER_HOUR_GATE.toFixed(2)}. Cache read share of input tokens: ${(p.section.cacheReadShare * 100).toFixed(0)}%.`,
  );

  failed += printControls(p);
  if (has("--ship") && limit === 0 && !only) failed += shipBlock(p, "dev");
  else if (has("--ship")) console.log("\nShip gates: skipped (--limit or --only plays part of dev; the numbers would not be comparable).");

  // the memory eval (offline modes: the two controls must stay low, the fake run must stay above its floor)
  failed += await memoryBlock();
  // the model judge (recorded runs only)
  if (cassette) {
    const j = await modelJudgeSummary(
      per.map((x) => ({ golden: x.golden, run: x.run })),
      judgeCassettePath(cassette.split(",")[0]),
    );
    if (j.status === "no-cassette")
      console.log(`\nModel judge: not run. No judge cassette at ${j.path} (record it with cassette-record --judge). The rubric judge above is the only judge.`);
    else {
      console.log(
        `\nModel judge (recorded verdicts): ${j.good} of ${j.judged} judged cards are useful (${(j.rate * 100).toFixed(1)}%); ${j.unjudged} of ${j.cards} cards had no recorded verdict.`,
      );
      for (const b of j.bad.slice(0, 8)) console.log(`  bad: ${b.meeting}: ${b.text} -- ${b.reason}`);
    }
  } else console.log("\nModel judge: needs a recorded run (pnpm eval --cassette <file>). Until then the rubric judge above is the only judge.");

  if (broken) console.log(`\nThis is a deliberately broken engine. It must fail the gates: ${failed} failed.`);
  if (failed) console.error(`\n${failed} golden gate(s) failed`);

  mkdirSync(join(APP_DIR, "qa", "out"), { recursive: true });
  const outFile = arg("--out") ?? join(APP_DIR, "qa", "out", "eval-last.json");
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        split: "dev",
        engine,
        basis: p.section.basis,
        metrics: Object.fromEntries(list.map((m) => [m.id, { value: m.value, n: m.n }])),
        controls: p.controls,
        rubric,
        section: p.section,
      },
      null,
      1,
    ) + "\n",
  );
  return { failed, baseline: updating ? baseline : undefined, section: updating ? p.section : undefined };
}

/** Memory quality on the invented calls in data/memory-eval, offline: null and copy-all must stay low, the fake run above its floor. The model mode is `pnpm eval:memory --live`. */
async function memoryBlock(): Promise<number> {
  const fail: string[] = [];
  const out: MemoryEvalResult[] = [];
  for (const mode of ["null", "copy-all", "fake"] as const) {
    const r = await runMemoryEval({ mode, noise: 0.15, seed: 7 });
    out.push(r);
    fail.push(...controlBreaches(r));
    if (mode === "fake" && r.overall.f1 < CONTROL_LIMITS.fakeF1Min)
      fail.push(`fake run F1 ${r.overall.f1.toFixed(2)} is under the floor ${CONTROL_LIMITS.fakeF1Min}`);
  }
  const f = out[2];
  const pc = (x: number) => `${(x * 100).toFixed(0)}%`;
  console.log(
    `\nMemory eval (${f.cases.length} invented calls, scripted fake updater, plumbing and scorer only): precision ${pc(f.overall.precision)}, recall ${pc(f.overall.recall)}, F1 ${pc(f.overall.f1)}; null control F1 ${pc(out[0].overall.f1)}, copy-all control precision ${pc(out[1].overall.precision)}.`,
  );
  for (const m of fail) console.log(`  FAIL ${m}`);
  if (!fail.length) console.log("  controls are under their limits");
  return fail.length;
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
  console.log("\n========================================================================================================================");
  console.log("== LEGACY SMOKE, in-sample: the old word lists and the bank, scored on the sentences they were tuned on. Below the headline on purpose. ==");
  console.log("== It checks that the offline path still works. It says nothing about how good Wingman is. ==");
  console.log("========================================================================================================================");
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

if (has("--final")) {
  process.exitCode = (await runFinal()) ? 1 : 0;
} else {
  const v2 = await runV2();
  if (v2.baseline && v2.section) {
    const cur = readBaseline();
    writeFileSync(BASELINE, JSON.stringify({ ...cur, [cassette ? "v2Recorded" : "v2"]: v2.baseline }, null, 2) + "\n");
    writeBudgets(v2.section);
    console.log(`\n${cassette ? "recorded" : "v2"} baseline written to ${BASELINE} and the ${v2.section.basis} budgets to qa/budgets.json`);
  }
  // the legacy smoke is about the offline word lists; it has nothing to say about a recorded run
  const legacyFailed = broken || cassette ? 0 : legacySmoke(has("--update"));
  process.exitCode = v2.failed || legacyFailed ? 1 : 0;
}
