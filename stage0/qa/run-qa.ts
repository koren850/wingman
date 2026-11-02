// Synthetic QA runner:  pnpm qa [scenario…|--all] [--no-ai] [--dry] [--regrade] [--concurrency N] [--cap USD]
// Renders each scenario to a WAV, plays it through src/run.ts in file mode (real Deepgram + real Haiku, profile "qa", no window),
// grades the call folder against the scenario expectations, and writes qa/report.md + qa/report.json.
// QA calls go to qa/calls/ (WINGMAN_CALLS_DIR), never into Dan's real calls/.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync, createWriteStream, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderScenario, loadScenario, allScenarioNames } from "./render.ts";
import { grade, type Grade } from "./grade.ts";

const QA = dirname(fileURLToPath(import.meta.url));
const STAGE0 = join(QA, "..");
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const opt = (n: string, d: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const noAi = flag("--no-ai"), dry = flag("--dry"), regrade = flag("--regrade");   // --regrade: grade the newest saved run again, no network
const concurrency = Number(opt("--concurrency", "4")), capUsd = Number(opt("--cap", "0.9"));
const valueFlags = new Set(["--concurrency", "--cap"]);
const names = flag("--all") || !argv.filter((a, i) => !a.startsWith("--") && !valueFlags.has(argv[i - 1])).length
  ? allScenarioNames()
  : argv.filter((a, i) => !a.startsWith("--") && !valueFlags.has(argv[i - 1]));

const DG_PER_MIN = 2 * 0.55 / 60;   // two channels, USD/hour per channel from budget.prices
const HAIKU_PER_Q = 0.0008, SUMMARY = 0.003;

const scenarios = names.map(loadScenario);
const rendered = new Map<string, Awaited<ReturnType<typeof renderScenario>>>();
for (const sc of scenarios) rendered.set(sc.name, await renderScenario(sc));
const estimate = scenarios.reduce((s, sc) => {
  const mins = rendered.get(sc.name)!.durationMs / 60000;
  const qs = sc.turns.filter((t) => t.speaker === "them" && t.expect?.question).length;
  return s + mins * DG_PER_MIN + (noAi ? 0 : qs * HAIKU_PER_Q + SUMMARY);
}, 0);
const totalMin = scenarios.reduce((s, sc) => s + rendered.get(sc.name)!.durationMs / 60000, 0);
console.log(`${scenarios.length} scenario(s), ${totalMin.toFixed(1)} min of audio, estimated spend $${estimate.toFixed(2)} (cap $${capUsd.toFixed(2)})`);
if (estimate > capUsd) { console.error(`Estimate is over the cap: pass --cap or fewer scenarios.`); process.exit(3); }
if (dry) { console.log("--dry: rendered only, nothing sent to Deepgram or Anthropic."); process.exit(0); }

mkdirSync(join(QA, "calls"), { recursive: true });
const stamp = regrade ? readdirSync(join(QA, "calls")).map((d) => d.slice(0, 14)).filter((d) => /^\d{14}$/.test(d)).sort().at(-1)! : new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

async function runOne(name: string): Promise<Grade> {
  const sc = scenarios.find((s) => s.name === name)!;
  const r = rendered.get(name)!;
  const callsDir = join(QA, "calls", `${stamp}-${name}`);
  mkdirSync(callsDir, { recursive: true });
  const log = createWriteStream(join(callsDir, "run.log"));
  const args = [join(STAGE0, "src", "run.ts"), "--profile", "qa", "--file", r.wav, "--no-brief", ...(noAi ? ["--no-ai"] : [])];
  if (!regrade) console.log(`[${name}] start (${(r.durationMs / 1000).toFixed(0)} s of audio)`);
  const t0 = Date.now();
  if (!regrade) await new Promise<void>((res) => {
    const p = spawn(join(STAGE0, "node_modules", ".bin", "tsx"), args, { cwd: STAGE0, env: { ...process.env, WINGMAN_CALLS_DIR: callsDir }, stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.pipe(log, { end: false }); p.stderr.pipe(log, { end: false });
    const kill = setTimeout(() => { console.error(`[${name}] timeout, killing`); p.kill("SIGTERM"); }, r.durationMs + 120_000);
    p.on("exit", (code) => { clearTimeout(kill); log.end(); console.log(`[${name}] done in ${((Date.now() - t0) / 1000).toFixed(0)} s (exit ${code})`); res(); });
  });
  const callDir = readdirSync(callsDir).filter((d) => d !== "latest" && existsSync(join(callsDir, d, "call.json"))).map((d) => join(callsDir, d)).at(0);
  if (!callDir) throw new Error(`[${name}] no call folder written; see ${join(callsDir, "run.log")}`);
  return grade(sc, r.timeline, callDir);
}

let spent = 0;
const results: Grade[] = [];
const queue = [...names];
async function worker() {
  while (queue.length) {
    if (spent > capUsd) { console.error(`Spend cap reached ($${spent.toFixed(3)}), skipping the rest: ${queue.join(", ")}`); queue.length = 0; return; }
    const n = queue.shift()!;
    try { const g = await runOne(n); spent += g.costUsd; results.push(g); }
    catch (e) { console.error(String((e as Error).message)); }
  }
}
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
results.sort((a, b) => a.scenario.localeCompare(b.scenario));
writeReport(results);
console.log(`\nReport: ${join(QA, "report.md")}\nSpend (from call logs): $${spent.toFixed(3)}`);

function writeReport(rs: Grade[]) {
  const P = (x: number) => `${Math.round(x * 100)}%`;
  const S = (ms?: number) => ms === undefined ? "-" : `${(ms / 1000).toFixed(1)}s`;
  const sum = (f: (g: Grade) => number) => rs.reduce((s, g) => s + f(g), 0);
  const allLat = rs.flatMap((g) => g.turns.map((t) => t.latencyMs).filter((x): x is number => typeof x === "number")).sort((a, b) => a - b);
  const q = (p: number) => allLat.length ? allLat[Math.min(allLat.length - 1, Math.floor(p / 100 * allLat.length))] : undefined;
  const tp = sum((g) => g.tp), fp = sum((g) => g.fp), fn = sum((g) => g.fn);
  const refW = sum((g) => g.sttRefWords);
  const totals = {
    scenarios: rs.length, questionRecall: tp + fn ? tp / (tp + fn) : 1, questionPrecision: tp + fp ? tp / (tp + fp) : 1,
    cardAccuracy: sum((g) => g.cardGraded) ? sum((g) => g.cardOk) / sum((g) => g.cardGraded) : 1,
    priceStall: `${sum((g) => g.priceOk)}/${sum((g) => g.priceTurns)}`, splitJoin: `${sum((g) => g.splitOk)}/${sum((g) => g.splitTested)}`,
    latencyP50Ms: q(50), latencyP95Ms: q(95), sttWordAccuracy: refW ? sum((g) => g.sttWordAcc * g.sttRefWords) / refW : 0,
    summaries: `${rs.filter((g) => g.summary.present).length}/${rs.length}`, guardLeaks: sum((g) => g.aiGuardLeaks.length + g.summary.emailLeaks.length), costUsd: sum((g) => g.costUsd),
  };
  const L: string[] = [];
  L.push(`# Wingman synthetic QA report`, ``, `Run ${stamp} · ${noAi ? "bank only (--no-ai)" : "real Deepgram + Haiku"} · TTS voice is cleaner than a real call, so STT accuracy is optimistic.`, ``);
  L.push(`| Scenario | Min | Q recall | Q precision (false cards) | Right card | Price stall | Split join | Card p50 / p95 | STT words | Summary | Guard leaks | Cost |`, `|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const g of rs) L.push(`| ${g.scenario} | ${(g.durationS / 60).toFixed(1)} | ${P(g.recall)} (${g.tp}/${g.expectedQ}) | ${P(g.precision)} (${g.fp} false, ${g.falseCards} w/ card) | ${P(g.cardAcc)} (${g.cardOk}/${g.cardGraded}) | ${g.priceTurns ? `${g.priceOk}/${g.priceTurns}` : "-"} | ${g.splitTested ? `${g.splitOk}/${g.splitTested}` : "-"} | ${S(g.latP50)} / ${S(g.latP95)} | ${P(g.sttWordAcc)} | ${g.summary.present ? (g.summary.emailLeaks.length ? "LEAK" : g.summary.otherLeaks.length ? "ok (soft: date word)" : "ok") : "none"} | ${g.aiGuardLeaks.length + g.summary.emailLeaks.length} | $${g.costUsd.toFixed(3)} |`);
  L.push(`| **All** | ${(sum((g) => g.durationS) / 60).toFixed(1)} | **${P(totals.questionRecall)}** | **${P(totals.questionPrecision)}** | **${P(totals.cardAccuracy)}** | ${totals.priceStall} | ${totals.splitJoin} | ${S(totals.latencyP50Ms)} / ${S(totals.latencyP95Ms)} | **${P(totals.sttWordAccuracy)}** | ${totals.summaries} | ${totals.guardLeaks} | **$${totals.costUsd.toFixed(3)}** |`, ``);
  L.push(`Card time = end of the question (as heard by STT) to the first card. Cost is the call's own estimate (budget.prices); questions detected: ${sum((g) => g.questionsAsked)}, of which the final card was hidden by the 3-per-minute cap in graded turns: ${sum((g) => g.hiddenByCap)}.`, ``);
  L.push(`## Failures`, ``);
  for (const g of rs) {
    const extra = [...g.aiGuardLeaks.map((x) => `AI card guard leak: ${x}`), ...g.summary.emailLeaks.map((x) => `summary email: ${x}`), ...g.summary.otherLeaks.map((x) => `summary (soft): ${x}`), ...(g.crashed ? ["run crashed (see events.jsonl)"] : []), ...(!g.summary.present && !noAi ? ["no summary.json written"] : [])];
    if (!g.failures.length && !extra.length) continue;
    L.push(`### ${g.scenario}`, ``);
    for (const f of g.failures) L.push(`- **${f.kind}** (turn ${f.turn}) script: "${f.script}"`, `  - heard: "${f.heard}"`, `  - expected: ${f.expected}`, `  - got: ${f.got}`);
    for (const e of extra) L.push(`- ${e}`);
    L.push(``);
  }
  L.push(`## STT word accuracy per scenario`, ``, `| Scenario | Words | Accuracy |`, `|---|---|---|`, ...rs.map((g) => `| ${g.scenario} | ${g.sttRefWords} | ${P(g.sttWordAcc)} |`), ``);
  writeFileSync(join(QA, "report.md"), L.join("\n"));
  writeFileSync(join(QA, "report.json"), JSON.stringify({ stamp, noAi, totals, scenarios: rs }, null, 1));
}
