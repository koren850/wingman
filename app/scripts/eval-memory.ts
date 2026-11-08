// Memory-quality eval: pnpm eval:memory [--mode all|fake|null|copy-all|model] [--noise 0.15] [--seed 7] [--json] [--live]
//   all (default)  null control, copy-all control and the fake-model run. Offline, free. Exits 1 when a control is over its limit or the fake run is under the floor.
//   model          the real updater. With WINGMAN_LLM_MODE=replay it reads the cassette (no key, no network). Without replay it needs --live and a key:
//                  12 calls, about 4 updater runs each, about 0.01 USD in total. Only the owner records it.
// What is measured and how: qa/memory-eval.ts.
import "../src/test-setup.ts";
import { CONTROL_LIMITS, controlBreaches, formatEval, runMemoryEval, type MemoryEvalOpts, type MemoryEvalResult } from "../qa/memory-eval.ts";
import { ModelRegistry } from "../src/providers/llm.ts";
import { llmMode } from "../src/providers/cassette.ts";
import { loadKeys } from "../src/env.ts";

const arg = (name: string, d?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};
const mode = arg("mode", "all")!;
const noise = Number(arg("noise", "0.15"));
const seed = Number(arg("seed", "7"));
const json = process.argv.includes("--json");

const results: MemoryEvalResult[] = [];
const fail: string[] = [];
const modes: NonNullable<MemoryEvalOpts["mode"]>[] = mode === "all" ? ["null", "copy-all", "fake"] : [mode as never];
for (const m of modes) {
  let registry: ModelRegistry | undefined;
  if (m === "model") {
    if (llmMode() === "replay") registry = new ModelRegistry({});
    else if (process.argv.includes("--live")) registry = new ModelRegistry(loadKeys());
    else {
      console.error("mode model: set WINGMAN_LLM_MODE=replay to read the cassette, or pass --live to call the real model (about 0.01 USD).");
      process.exit(2);
    }
  }
  const r = await runMemoryEval({ mode: m, noise, seed, ...(registry ? { registry } : {}) });
  results.push(r);
  if (!json) console.log(formatEval(r) + "\n");
  fail.push(...controlBreaches(r));
  if (m === "fake" && r.overall.f1 < CONTROL_LIMITS.fakeF1Min)
    fail.push(`fake run F1 ${r.overall.f1.toFixed(2)} is under the floor ${CONTROL_LIMITS.fakeF1Min}`);
}
if (json) console.log(JSON.stringify(results, null, 1));
if (fail.length) {
  console.error("FAILED:\n" + fail.map((f) => "  " + f).join("\n"));
  process.exit(1);
}
if (!json) console.log("controls are under their limits");
