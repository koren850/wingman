// Records real model replies for a golden suite into a cassette, so the next run can replay them offline.  OWNER ONLY. Never run by an agent, never in CI.
//   pnpm tsx scripts/cassette-record.ts --suite dev --cap 5            record the dev meetings, stop when the booked cost passes 5 USD
//   pnpm tsx scripts/cassette-record.ts --suite test-b --cap 5 --final held-out suites need --final (the same rule as pnpm eval --final)
//   options: --out <file>  cassette file (default data/cassettes/<suite>.cassette.json)
//            --only <id>   record one meeting
//            --pace <n>    virtual clock speed against real time (default 1: a 7 minute meeting takes 7 minutes; the real model answers in real time)
//            --allow-partial  start even when the estimate is above the cap (the run stops at the cap)
// What it does: prints a cost estimate first, then plays each meeting through the real engine modules with every model call going through the cassette
// recorder (src/providers/cassette.ts) to the real provider. It needs ANTHROPIC_API_KEY in the environment (the key is never read from a file here).
// It refuses without a key and in CI. The tests use a mock transport (the policy fake) and never reach the network.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSplit } from "../qa/golden-load.ts";
import { runMeeting, pool, type MeetingRun } from "../src/e2e/v2-kit.ts";
import { v2Meetings } from "../qa/eval-v2.ts";
import { mergeParts } from "../qa/cassette-merge.ts";
import type { Golden } from "../qa/grade-golden.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SUITES = ["dev", "test", "test-b"] as const;
export type Suite = (typeof SUITES)[number];

export type Deps = {
  /** "mock" records the policy fake (tests); "real" records the provider (the owner's run). */
  transport: "mock" | "real";
  log: (line: string) => void;
  /** Where the baseline for the estimate lives. */
  baselineFile?: string;
  /** Plays one meeting. The default is the v2 worker in a child process. */
  run?: typeof runMeeting;
  /** Folder for cassettes. */
  dataDir?: string;
};
export type Args = { suite: Suite; cap: number; final: boolean; out?: string; only?: string; pace?: number; allowPartial: boolean };

export function parseArgs(argv: string[]): Args | string {
  const get = (f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const suite = get("--suite");
  if (!suite || !(SUITES as readonly string[]).includes(suite)) return `--suite must be one of: ${SUITES.join(", ")}`;
  const cap = Number(get("--cap"));
  if (!Number.isFinite(cap) || cap <= 0) return "--cap <usd> is required and must be above 0 (the run stops when the booked cost passes it)";
  const pace = get("--pace") === undefined ? undefined : Number(get("--pace"));
  if (pace !== undefined && !(pace > 0)) return "--pace must be above 0";
  return {
    suite: suite as Suite,
    cap,
    final: argv.includes("--final"),
    out: get("--out"),
    only: get("--only"),
    pace,
    allowPartial: argv.includes("--allow-partial"),
  };
}

/** Roughly what the run costs: the modelled cost per hour of the v2 baseline times the hours of the suite, times a safety factor for real prompt sizes. */
export type Estimate = { meetings: number; hours: number; calls: number; usd: number; wallMinutes: number; basis: string };
export function estimate(meetings: Golden[], pace: number, baselineFile = join(ROOT, "qa", "eval-baseline.json")): Estimate {
  const hours = meetings.reduce((a, g) => a + (g.lines.at(-1)?.t ?? 0), 0) / 3_600_000;
  let perHour = 0.06,
    callsPerHour = 300,
    basis = "no baseline found: assumed $0.06 and 300 calls per hour";
  try {
    const m = (JSON.parse(readFileSync(baselineFile, "utf8")) as { v2?: { metrics: Record<string, { value: number }> } }).v2?.metrics;
    if (m?.["cost.perHour"]) {
      perHour = m["cost.perHour"].value;
      callsPerHour = m["calls.perHour"]?.value ?? callsPerHour;
      basis = `qa/eval-baseline.json: $${perHour.toFixed(3)} and ${Math.round(callsPerHour)} calls per hour (modelled usage)`;
    }
  } catch {
    /* use the defaults */
  }
  const SAFETY = 2; // the baseline uses modelled token counts; real prompts and answers are larger
  return { meetings: meetings.length, hours, calls: Math.round(hours * callsPerHour), usd: hours * perHour * SAFETY, wallMinutes: (hours * 60) / pace, basis };
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, deps: Deps): Promise<number> {
  const err = (m: string) => (deps.log(`cassette-record: ${m}`), 2);
  const a = parseArgs(argv);
  if (typeof a === "string") return err(a);
  // 1. the refusals come before anything else is read or started
  if (env.CI && env.CI !== "false" && env.CI !== "0")
    return err("refusing to record in CI. Recording calls the real model and costs money; the owner runs it by hand.");
  if (env.GITHUB_ACTIONS) return err("refusing to record in CI (GITHUB_ACTIONS is set).");
  if (deps.transport === "real" && !env.ANTHROPIC_API_KEY)
    return err("no ANTHROPIC_API_KEY in the environment. Set it for this one command; nothing reads the key from a file.");
  if (a.suite !== "dev" && !a.final) return err(`${a.suite} is a held-out suite. Pass --final to say you mean it (the same rule as pnpm eval --final).`);

  const all = loadSplit(a.suite, { final: a.suite !== "dev" });
  const meetings = v2Meetings(all).filter((g) => !a.only || g.id === a.only);
  if (!meetings.length) return err(a.only ? `no meeting ${a.only} in ${a.suite}` : "no meetings to record");
  const pace = a.pace ?? (deps.transport === "real" ? 1 : 0);
  const est = estimate(meetings, pace || 1, deps.baselineFile);
  const out = a.out ?? join(deps.dataDir ?? join(ROOT, "data", "cassettes"), `${a.suite}.cassette.json`);

  // 2. the one-page estimate
  deps.log(
    [
      "Cassette recording: estimate",
      `  suite          ${a.suite}${a.only ? ` (only ${a.only})` : ""}, ${est.meetings} meetings, ${est.hours.toFixed(2)} hours of calls`,
      `  model calls    about ${est.calls}`,
      `  cost           about $${est.usd.toFixed(2)} (cap $${a.cap.toFixed(2)})`,
      `  basis          ${est.basis}, times 2 for real prompt sizes`,
      `  wall time      about ${est.wallMinutes.toFixed(0)} minutes at pace ${pace || 1} (4 meetings at a time)`,
      `  cassette       ${out}`,
      `  transport      ${deps.transport}`,
    ].join("\n"),
  );
  if (est.usd > a.cap && !a.allowPartial)
    return err(
      `the estimate ($${est.usd.toFixed(2)}) is above the cap ($${a.cap.toFixed(2)}). Raise --cap, record fewer meetings (--only), or pass --allow-partial to stop at the cap.`,
    );

  // 3. record. Each meeting gets what is left of the cap; a meeting that hits it is cut short and the run stops.
  mkdirSync(dirname(out), { recursive: true });
  const run = deps.run ?? runMeeting;
  const partOf = (id: string) => out.replace(/\.json$/, `.${id}.part.json`);
  let spent = 0;
  let stopped = false;
  const results: MeetingRun[] = [];
  await pool(meetings, deps.transport === "real" ? 4 : 1, async (g) => {
    if (stopped) return;
    const left = Math.max(0.01, a.cap - spent);
    // One cassette file is written by one process: each meeting records into its own part file, merged below.
    const r = await run(
      g.id,
      { split: a.suite, asks: false, record: { cassette: partOf(g.id), transport: deps.transport, pace: pace || undefined, capUsd: left } },
      3 * 3_600_000,
    );
    spent += r.usage.reduce((s, u) => s + (u.usd ?? 0), 0);
    results.push(r);
    if (r.error || spent >= a.cap) stopped = true;
    deps.log(`  recorded ${g.id}: ${r.calls.length} calls, spent so far $${spent.toFixed(3)}${r.error ? ` (${r.error})` : ""}`);
  });
  const n = mergeParts(
    out,
    meetings.map((g) => partOf(g.id)).filter((p) => existsSync(p)),
  );
  deps.log(`Done: ${n} entries in ${out}, about $${spent.toFixed(3)} booked${stopped ? " (stopped at the cap)" : ""}.`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2), process.env, { transport: "real", log: (l) => console.log(l) });
}
