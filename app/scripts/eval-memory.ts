// Memory-quality eval: pnpm eval:memory [--mode all|fake|null|copy-all|model] [--noise 0.15] [--seed 7] [--json] [--live] [--cassette <file>] [--record --cap <usd>]
//   all (default)  null control, copy-all control and the fake-model run. Offline, free. Exits 1 when a control is over its limit or the fake run is under the floor.
//   model          the real updater. With WINGMAN_LLM_MODE=replay, or --cassette <file> (default data/cassettes/memory.cassette.json), it reads the recorded answers: no key,
//                  no network. Without either it needs --live and a key: 24 calls, about 4 to 12 updater runs each, about 0.03 USD in total.
//                  Recorded runs are held to RECORDED_FLOORS (F1 per class and per language); the fake and the controls are not.
//   --record       MANUAL ONLY: plays the 24 calls through the real updater and writes the cassette, then scores it from the cassette. Needs ANTHROPIC_API_KEY in the
//                  environment and --cap <usd>. Refuses in CI. Prints an estimate first. Used by `pnpm morning`.
// What is measured and how: qa/memory-eval.ts.
import "../src/test-setup.ts";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTROL_LIMITS,
  controlBreaches,
  driveCase,
  fakeRegistryFor,
  floorBreaches,
  formatEval,
  loadCases,
  runMemoryEval,
  type EvalCase,
  type MemoryEvalOpts,
  type MemoryEvalResult,
} from "../qa/memory-eval.ts";
import { Cassette, llmMode, wrapCassette } from "../src/providers/cassette.ts";
import { CostMeter } from "../src/cost.ts";
import { loadSettings } from "../src/settings.ts";
import { loadKeys } from "../src/env.ts";
import type { ModelRegistry } from "../src/providers/llm.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const MEMORY_CASSETTE = join(ROOT, "data", "cassettes", "memory.cassette.json");
const MODEL = "anthropic:claude-haiku-5-5";
export type Deps = {
  transport: "mock" | "real";
  log: (line: string) => void;
  cases?: EvalCase[];
  /** Filled in by --record: what it booked (for a caller that keeps one cap across several steps). */
  report?: { spentUsd: number; stopped: boolean; cassette: string; calls: number };
};

/** Updater runs per call: one per batch of 5 lines, one final pass. Each reads about 1500 tokens of rules and memory and writes about 120. */
export function estimateRecord(cases: EvalCase[]): { calls: number; usd: number } {
  const p = loadSettings({ userFile: "/nonexistent/settings.yaml" }).settings.budget.prices.llm[MODEL];
  const calls = cases.reduce((a, c) => a + Math.ceil(c.lines.length / 5) + 1 + (c.compactEveryMinutes ? 2 : 0), 0);
  return { calls, usd: ((calls * (1500 * p.inUsdPerM + 120 * p.outUsdPerM)) / 1e6) * 2 };
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, deps: Deps): Promise<number> {
  const get = (name: string, d?: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? (argv[i + 1] ?? d) : d;
  };
  const log = deps.log;
  const cases = deps.cases ?? loadCases();
  const json = argv.includes("--json");
  const noise = Number(get("noise", "0.15")),
    seed = Number(get("seed", "7"));
  const record = argv.includes("--record");
  const mode = get("mode", record ? "model" : "all")!;
  const cassetteFile = get("cassette") ?? MEMORY_CASSETTE;

  let cassette: Cassette | undefined;
  if (record) {
    if ((env.CI && env.CI !== "false" && env.CI !== "0") || env.GITHUB_ACTIONS)
      return (log("eval-memory: refusing to record in CI. Recording calls the real model and costs money."), 2);
    if (deps.transport === "real" && !env.ANTHROPIC_API_KEY)
      return (log("eval-memory: no ANTHROPIC_API_KEY in the environment. Set it for this one command; nothing reads the key from a file."), 2);
    const cap = Number(get("cap"));
    if (!Number.isFinite(cap) || cap <= 0) return (log("eval-memory: --cap <usd> is required with --record"), 2);
    const est = estimateRecord(cases);
    log(
      `Memory recording: estimate\n  calls ${cases.length}, about ${est.calls} updater runs\n  cost about $${est.usd.toFixed(3)} (cap $${cap.toFixed(2)})\n  transport ${deps.transport}`,
    );
    if (est.usd > cap) return (log(`eval-memory: the estimate ($${est.usd.toFixed(3)}) is above the cap ($${cap.toFixed(2)}). Raise --cap.`), 2);
    mkdirSync(dirname(cassetteFile), { recursive: true });
    cassette = new Cassette(cassetteFile);
    const prices = loadSettings({ userFile: "/nonexistent/settings.yaml" }).settings.budget.prices;
    const meter = new CostMeter(prices, { maxUsdPerCall: 1e9, warnAt: 1, maxMinutesPerCall: 1e9 });
    const real =
      deps.transport === "real" ? new (await import("../src/providers/llm.ts")).ModelRegistry({ anthropic: env.ANTHROPIC_API_KEY } as never) : undefined;
    let stopped = false,
      done = 0;
    try {
      for (const c of cases) {
        const inner = real ?? fakeRegistryFor(c, { noise: 0, seed });
        const registry = {
          resolve: async (ref: string, role?: string) =>
            wrapCassette({ mode: "record", cassette: cassette!, ref, role, inner: (await inner.resolve(ref, role)) as never, autosave: false }),
        };
        await driveCase(c, { registry, model: MODEL, onUsage: (role, usage) => void meter.addLlm(role, MODEL, usage) });
        done++;
        cassette.save(cassetteFile);
        if (meter.llmUsd > cap) {
          stopped = true;
          break;
        }
      }
    } finally {
      cassette.save(cassetteFile); // a failure at call 20 must not throw away the answers already paid for
    }
    log(`Recorded ${done} of ${cases.length} calls into ${cassetteFile}, about $${meter.llmUsd.toFixed(4)} booked${stopped ? " (stopped at the cap)" : ""}.`);
    if (deps.report) Object.assign(deps.report, { spentUsd: meter.llmUsd, stopped, cassette: cassetteFile, calls: done });
  }

  const results: MemoryEvalResult[] = [];
  const fail: string[] = [];
  const modes: NonNullable<MemoryEvalOpts["mode"]>[] = mode === "all" ? ["null", "copy-all", "fake"] : [mode as never];
  for (const m of modes) {
    let registry: Pick<ModelRegistry, "resolve"> | undefined;
    let evalCases = cases;
    if (m === "model") {
      if (record || argv.includes("--cassette") || (!argv.includes("--live") && llmMode() !== "replay" && existsSync(cassetteFile))) {
        if (!existsSync(cassetteFile))
          return (log(`eval-memory: no cassette at ${cassetteFile}. Record it with: pnpm eval:memory --record --cap 1 (run it by hand).`), 2);
        const c = cassette ?? new Cassette(cassetteFile);
        registry = { resolve: async (ref, role) => wrapCassette({ mode: "replay", cassette: c, ref, role, timing: "instant" }) };
        if (record && deps.report && deps.report.calls < cases.length) evalCases = cases.slice(0, deps.report.calls); // a run stopped at the cap is scored on what it recorded
      } else if (llmMode() === "replay") registry = new (await import("../src/providers/llm.ts")).ModelRegistry({});
      else if (argv.includes("--live")) registry = new (await import("../src/providers/llm.ts")).ModelRegistry(loadKeys());
      else
        return (
          log(
            "mode model: pass --cassette <file> (or set WINGMAN_LLM_MODE=replay) to read the recorded answers, or --live to call the real model (about 0.03 USD).",
          ),
          2
        );
    }
    const r = await runMemoryEval({ mode: m, noise, seed, cases: evalCases, ...(registry ? { registry } : {}) });
    results.push(r);
    if (!json) log(formatEval(r) + "\n");
    fail.push(...controlBreaches(r), ...floorBreaches(r));
    if (m === "fake" && r.overall.f1 < CONTROL_LIMITS.fakeF1Min)
      fail.push(`fake run F1 ${r.overall.f1.toFixed(2)} is under the floor ${CONTROL_LIMITS.fakeF1Min}`);
  }
  if (json) log(JSON.stringify(results, null, 1));
  if (fail.length) {
    log("FAILED:\n" + fail.map((f) => "  " + f).join("\n"));
    return 1;
  }
  if (!json) log(results.some((r) => r.mode === "model") ? "recorded run is above its floors" : "controls are under their limits");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2), process.env, { transport: "real", log: (l) => console.log(l) });
}
