// Records real model replies for a golden suite into a cassette, so the next run can replay them offline.  OWNER ONLY. Never run by an agent, never in CI.
//   pnpm tsx scripts/cassette-record.ts --suite dev --cap 5            record the dev meetings, stop when the booked cost passes 5 USD
//   pnpm tsx scripts/cassette-record.ts --suite test-b --cap 5 --final held-out suites (test, test-b, test-c) need --final (the same rule as pnpm eval --final)
//   options: --out <file>  cassette file (default data/cassettes/<suite>.cassette.json)
//            --only <id>   record one meeting
//            --pace <n>    virtual clock speed against real time (default 1: a 7 minute meeting takes 7 minutes; the real model answers in real time)
//            --allow-partial  start even when the estimate is above the cap (the run stops at the cap)
//            --judge       after the meetings, record a model-judge verdict for every card the real model made, into <suite>.judge.cassette.json
//                          (about 0.0004 USD a card, counted in the estimate and the cap). Then: pnpm eval --cassette <engine cassette> prints the verdicts.
// Maintainer guide: docs/DEVELOPMENT.md, section "Recording a cassette". Dev first, then test-b, then test with --final, each with its own cap.
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
import { ModelJudge, JUDGE_MODEL, type JudgeTransport } from "../qa/judge.ts";
import { judgeCassettePath } from "../qa/judge-eval.ts";
import { Cassette } from "../src/providers/cassette.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SUITES = ["dev", "test", "test-b", "test-c"] as const;
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
  /** Asks the judge model one question. The default calls the provider with ANTHROPIC_API_KEY; the tests pass a canned one. */
  judgeTransport?: JudgeTransport;
  /** Filled in at the end: what the run booked, so a caller that runs several steps (pnpm morning) can keep one cap across them. */
  report?: { spentUsd: number; entries: number; stopped: boolean; cassette: string };
};
export type Args = { suite: Suite; cap: number; final: boolean; out?: string; only?: string; pace?: number; allowPartial: boolean; judge: boolean };
/** USD per judged card (about 450 input tokens and 30 output tokens on the judge model, no cache). A planning number, not a measurement. */
export const JUDGE_USD_PER_CARD = 0.0004;
/** Cards per hour of the v2 baseline, for the estimate of the judge cost. */
const CARDS_PER_HOUR_FALLBACK = 93;

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
    judge: argv.includes("--judge"),
  };
}

/** Roughly what the run costs: the modelled cost per hour of the v2 baseline times the hours of the suite, times a safety factor for real prompt sizes. */
export type Estimate = { meetings: number; hours: number; calls: number; usd: number; judgeUsd: number; wallMinutes: number; basis: string };
export function estimate(meetings: Golden[], pace: number, baselineFile = join(ROOT, "qa", "eval-baseline.json"), judge = false, parallel = 4): Estimate {
  const longestMin = Math.max(0, ...meetings.map((g) => (g.lines.at(-1)?.t ?? 0) / 60_000));
  const hours = meetings.reduce((a, g) => a + (g.lines.at(-1)?.t ?? 0), 0) / 3_600_000;
  let perHour = 0.06,
    callsPerHour = 300,
    cardsPerHour = CARDS_PER_HOUR_FALLBACK,
    basis = "no baseline found: assumed $0.06 and 300 calls per hour";
  try {
    const m = (JSON.parse(readFileSync(baselineFile, "utf8")) as { v2?: { metrics: Record<string, { value: number }> } }).v2?.metrics;
    if (m?.["cost.perHour"]) {
      perHour = m["cost.perHour"].value;
      callsPerHour = m["calls.perHour"]?.value ?? callsPerHour;
      cardsPerHour = m["cards.perHour"]?.value ?? cardsPerHour;
      basis = `qa/eval-baseline.json: $${perHour.toFixed(3)} and ${Math.round(callsPerHour)} calls per hour (modelled usage)`;
    }
  } catch {
    /* use the defaults */
  }
  const SAFETY = 2; // the baseline uses modelled token counts; real prompts and answers are larger
  const judgeUsd = judge ? hours * cardsPerHour * JUDGE_USD_PER_CARD * SAFETY : 0;
  return {
    meetings: meetings.length,
    hours,
    calls: Math.round(hours * callsPerHour),
    usd: hours * perHour * SAFETY + judgeUsd,
    judgeUsd,
    wallMinutes: Math.max((hours * 60) / pace / parallel, longestMin / pace),
    basis,
  };
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

  if (!existsSync(join(ROOT, "data", "meetings", a.suite))) return err(`there is no ${a.suite} split in data/meetings yet`);
  const all = loadSplit(a.suite as never, { final: a.suite !== "dev" });
  const meetings = v2Meetings(all).filter((g) => !a.only || g.id === a.only);
  if (!meetings.length) return err(a.only ? `no meeting ${a.only} in ${a.suite}` : "no meetings to record");
  const pace = a.pace ?? (deps.transport === "real" ? 1 : 0);
  const est = estimate(meetings, pace || 1, deps.baselineFile, a.judge, deps.transport === "real" ? 4 : 1);
  const out = a.out ?? join(deps.dataDir ?? join(ROOT, "data", "cassettes"), `${a.suite}.cassette.json`);

  // 2. the one-page estimate
  deps.log(
    [
      "Cassette recording: estimate",
      `  suite          ${a.suite}${a.only ? ` (only ${a.only})` : ""}, ${est.meetings} meetings, ${est.hours.toFixed(2)} hours of calls`,
      `  model calls    about ${est.calls}`,
      `  cost           about $${est.usd.toFixed(2)} (cap $${a.cap.toFixed(2)})${a.judge ? `, of which the judge about $${est.judgeUsd.toFixed(2)}` : ""}`,
      `  basis          ${est.basis}, times 2 for real prompt sizes`,
      `  wall time      about ${est.wallMinutes.toFixed(0)} minutes at pace ${pace || 1} (4 meetings at a time, never less than the longest meeting)`,
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
      { split: a.suite as never, asks: false, record: { cassette: partOf(g.id), transport: deps.transport, pace: pace || undefined, capUsd: left } },
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
  if (deps.report) Object.assign(deps.report, { spentUsd: spent, entries: n, stopped, cassette: out });
  // 4. the judge: one verdict per card the model made, read back by pnpm eval --cassette
  let judgedCards = 0;
  if (a.judge) {
    const jOut = judgeCassettePath(out);
    const jc = new Cassette(jOut);
    const judge = new ModelJudge({
      cassette: jc,
      transport: deps.judgeTransport ?? (deps.transport === "real" ? realJudgeTransport(env.ANTHROPIC_API_KEY!) : mockJudgeTransport),
    });
    let cards = 0,
      failedCards = 0,
      skipped = 0;
    // Save after every meeting and when a call throws: a network error at card 80 must not throw away the verdicts already paid for.
    try {
      for (const g of meetings) {
        const r = results.find((x) => x.id === g.id);
        if (!r) continue;
        if (spent + (cards + r.cards.length) * JUDGE_USD_PER_CARD > a.cap) {
          skipped += r.cards.length;
          continue;
        }
        for (const c of [...r.cards].sort((x, y) => x.atMs - y.atMs)) {
          try {
            await judge.judge(g, c);
            cards++;
          } catch (e) {
            failedCards++;
            deps.log(`Judge: a card of ${g.id} could not be judged (${e instanceof Error ? e.message : String(e)}). Its verdict is left out.`);
          }
        }
        jc.save(jOut);
      }
    } finally {
      jc.save(jOut);
    }
    judgedCards = cards;
    deps.log(
      `Judge: ${cards} cards judged into ${jOut}, about $${(cards * JUDGE_USD_PER_CARD).toFixed(3)}.${failedCards ? ` ${failedCards} failed.` : ""}${skipped ? ` ${skipped} cards skipped to stay under the cap.` : ""}`,
    );
  }
  if (deps.report && a.judge) deps.report.spentUsd = spent + judgedCards * JUDGE_USD_PER_CARD;
  return 0;
}

const mockJudgeTransport: JudgeTransport = async () => ({ text: "VERDICT: good\nREASON: mock judge", ms: 1 });
/** The real judge: one short call per card on the judge model. Only the owner's command gets here (a key in the environment, never in CI). */
function realJudgeTransport(apiKey: string): JudgeTransport {
  return async ({ model, system, user }) => {
    const { ModelRegistry } = await import("../src/providers/llm.ts");
    const { generateText } = await import("ai");
    const m = await new ModelRegistry({ anthropic: apiKey } as never).resolve(model || JUDGE_MODEL, "judge");
    const t0 = Date.now();
    const r = await generateText({ model: m, system, prompt: user, maxOutputTokens: 80 });
    return { text: r.text, usage: r.usage, ms: Date.now() - t0 };
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2), process.env, { transport: "real", log: (l) => console.log(l) });
}
