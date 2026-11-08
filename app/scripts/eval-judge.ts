// Judgement-set eval: pnpm eval:judge [--mode all|fake|always-skip|always-ans|model] [--cassette <file>] [--noise 0.15] [--seed 7] [--json] [--limit n]
//   all (default)   the two controls and the fake run. Offline, free. Exits 1 when a control is over its limit or the fake run is under its floor.
//   model           replays the moment role's recorded answers from --cassette (default data/cassettes/judge-set.cassette.json). No key, no network.
//                   Recorded runs are held to JUDGE_FLOORS. A call the cassette has no answer for counts as wrong; one recorded with an older prompt is reported as stale.
//   --record        OWNER ONLY: calls the real model once per case and writes the cassette. Needs ANTHROPIC_API_KEY in the environment and --cap <usd>.
//                   About 120 calls, a cent or two. Refuses in CI. Prints the estimate first. Used by `pnpm morning`.
// What a case is and how it is scored: qa/judge-set.ts.
import "../src/test-setup.ts";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cassette, wrapCassette } from "../src/providers/cassette.ts";
import { CostMeter } from "../src/cost.ts";
import { loadSettings } from "../src/settings.ts";
import { estimateTokens } from "../src/context/budget.ts";
import {
  JUDGE_CONTROL_LIMITS,
  JUDGE_MODEL,
  askCase,
  controlBreaches,
  fakeJudgeRegistry,
  floorBreaches,
  formatJudge,
  gradeCase,
  judgeContext,
  loadJudgeSet,
  runJudgeSet,
  scoreJudge,
  type JudgeCase,
  type JudgeMode,
  type JudgeRun,
  type Verdict,
} from "../qa/judge-set.ts";
import type { ModelRegistry } from "../src/providers/llm.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const JUDGE_CASSETTE = join(ROOT, "data", "cassettes", "judge-set.cassette.json");
export type Deps = {
  /** "mock" records the policy fake (tests); "real" records the provider (the owner's run). */
  transport: "mock" | "real";
  log: (line: string) => void;
  /** Cases to use (tests pass a few). Default: the whole set. */
  cases?: JudgeCase[];
  /** Filled in by --record: what it booked (for a caller that keeps one cap across several steps). */
  report?: { spentUsd: number; recorded: number; stopped: boolean; cassette: string };
};

/** Roughly what a recording costs: the prompt of every case at the input price, 40 output tokens, times 2 for the model's own overhead. */
export function estimateRecord(cases: JudgeCase[]): { calls: number; inputTokens: number; usd: number } {
  const p = loadSettings({ userFile: "/nonexistent/settings.yaml" }).settings.budget.prices.llm[JUDGE_MODEL];
  const inputTokens = cases.reduce((a, c) => {
    const ctx = judgeContext(c);
    return a + ctx.system.reduce((n, b) => n + estimateTokens(b.text), 0) + estimateTokens(ctx.messages[0].content);
  }, 0);
  return { calls: cases.length, inputTokens, usd: ((inputTokens * p.inUsdPerM + cases.length * 40 * p.outUsdPerM) / 1e6) * 2 };
}

const staleOf = (vs: Verdict[]) => vs.filter((v) => v.error?.includes("Cassette STALE")).length;
const missOf = (vs: Verdict[]) => vs.filter((v) => v.error?.includes("Cassette miss")).length;

export async function main(argv: string[], env: NodeJS.ProcessEnv, deps: Deps): Promise<number> {
  const get = (f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const log = deps.log;
  let cases = deps.cases ?? loadJudgeSet();
  const limit = get("--limit") === undefined ? undefined : Number(get("--limit"));
  if (limit !== undefined) {
    if (!(limit > 0)) return (log("eval-judge: --limit must be above 0"), 2);
    cases = cases.slice(0, limit);
  }
  const json = argv.includes("--json");
  const mode = (get("--mode") ?? (argv.includes("--record") ? "model" : "all")) as JudgeMode | "all";
  const noise = Number(get("--noise") ?? "0.15"),
    seed = Number(get("--seed") ?? "7");
  const fail: string[] = [];
  const runs: JudgeRun[] = [];

  if (argv.includes("--record")) {
    // 1. the refusals come before anything is read or started
    if ((env.CI && env.CI !== "false" && env.CI !== "0") || env.GITHUB_ACTIONS)
      return (log("eval-judge: refusing to record in CI. Recording calls the real model and costs money."), 2);
    if (deps.transport === "real" && !env.ANTHROPIC_API_KEY)
      return (log("eval-judge: no ANTHROPIC_API_KEY in the environment. Set it for this one command; nothing reads the key from a file."), 2);
    const cap = Number(get("--cap"));
    if (!Number.isFinite(cap) || cap <= 0) return (log("eval-judge: --cap <usd> is required with --record"), 2);
    const est = estimateRecord(cases);
    log(
      `Judgement set recording: estimate\n  calls ${est.calls}, about ${est.inputTokens} input tokens\n  cost about $${est.usd.toFixed(3)} (cap $${cap.toFixed(2)})\n  transport ${deps.transport}`,
    );
    if (est.usd > cap) return (log(`eval-judge: the estimate ($${est.usd.toFixed(3)}) is above the cap ($${cap.toFixed(2)}). Raise --cap.`), 2);
    const out = get("--out") ?? JUDGE_CASSETTE;
    mkdirSync(dirname(out), { recursive: true });
    const cassette = new Cassette(out);
    const inner: Pick<ModelRegistry, "resolve"> =
      deps.transport === "real"
        ? new (await import("../src/providers/llm.ts")).ModelRegistry({ anthropic: env.ANTHROPIC_API_KEY } as never)
        : fakeJudgeRegistry(cases, { noise: 0, seed });
    const registry = {
      resolve: async (ref: string, role?: string) =>
        wrapCassette({ mode: "record", cassette, ref, role, inner: (await inner.resolve(ref, role)) as never, autosave: false }),
    };
    const prices = loadSettings({ userFile: "/nonexistent/settings.yaml" }).settings.budget.prices;
    const meter = new CostMeter(prices, { maxUsdPerCall: 1e9, warnAt: 1, maxMinutesPerCall: 1e9 });
    const verdicts: Verdict[] = [];
    let stopped = false;
    try {
      for (const c of cases) {
        const v = await askCase(c, registry);
        verdicts.push(v);
        if (v.usage) meter.addLlm("moment", JUDGE_MODEL, v.usage);
        if (verdicts.length % 10 === 0) cassette.save(out);
        if (meter.llmUsd > cap) {
          stopped = true;
          break;
        }
      }
    } finally {
      cassette.save(out); // a failure at case 90 must not throw away the answers already paid for
    }
    log(`Recorded ${verdicts.length} of ${cases.length} cases into ${out}, about $${meter.llmUsd.toFixed(4)} booked${stopped ? " (stopped at the cap)" : ""}.`);
    if (deps.report) Object.assign(deps.report, { spentUsd: meter.llmUsd, recorded: verdicts.length, stopped, cassette: out });
    const done = cases.slice(0, verdicts.length);
    const results = done.map((c, i) => gradeCase(c, verdicts[i]));
    runs.push({ mode: "model", cases: done, results, verdicts, score: scoreJudge(done, results) });
  } else {
    const modes: JudgeMode[] = mode === "all" ? ["always-skip", "always-ans", "fake"] : [mode];
    for (const m of modes) {
      let registry: Pick<ModelRegistry, "resolve"> | undefined;
      if (m === "model") {
        const file = get("--cassette") ?? JUDGE_CASSETTE;
        if (!existsSync(file))
          return (log(`eval-judge: no cassette at ${file}. Record it with: pnpm eval:judge --record --cap 1 (owner only), or pass --cassette <file>.`), 2);
        const cassette = new Cassette(file);
        registry = { resolve: async (ref, role) => wrapCassette({ mode: "replay", cassette, ref, role, timing: "instant" }) };
      }
      runs.push(await runJudgeSet({ mode: m, cases, noise, seed, ...(registry ? { registry } : {}) }));
    }
  }
  for (const r of runs) {
    if (!json) log(formatJudge(r) + "\n");
    const stale = staleOf(r.verdicts),
      miss = missOf(r.verdicts);
    if (r.mode === "model" && (stale || miss)) {
      log(`Cassette: ${stale} case(s) STALE (recorded with an older prompt text or model; re-record, not an engine fault), ${miss} with no recorded answer.`);
    }
    fail.push(...controlBreaches(r.mode, r.score), ...floorBreaches(r.mode, r.score));
    if (r.mode === "fake" && r.score.macroF1 < JUDGE_CONTROL_LIMITS.fakeMacroF1Min)
      fail.push(`fake run macro F1 ${r.score.macroF1.toFixed(2)} is under the floor ${JUDGE_CONTROL_LIMITS.fakeMacroF1Min}`);
  }
  if (json)
    log(
      JSON.stringify(
        runs.map((r) => ({ mode: r.mode, score: r.score })),
        null,
        1,
      ),
    );
  if (fail.length) {
    log("FAILED:\n" + fail.map((f) => "  " + f).join("\n"));
    return 1;
  }
  if (!json) log(runs.some((r) => r.mode === "model") ? "recorded run is above its floors" : "controls are under their limits");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2), process.env, { transport: "real", log: (l) => console.log(l) });
}
