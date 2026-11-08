// The morning run: one command that records everything the quality numbers need, once, with a cost cap.  OWNER ONLY. Never run by an agent, never in CI.
//   ANTHROPIC_API_KEY=... pnpm morning --cap 5 [--estimate] [--only dev,judge] [--skip test-c] [--allow-partial]
// It prints a one-page cost estimate first. Then, in this order, and stopping a step when the one cap for the whole run is used up:
//   1. dev          the moment role on the dev meetings (and the model judge)            -> data/cassettes/dev.cassette.json
//                   then `pnpm eval --cassette ... --update` and the cost reconciliation -> qa/recorded-baseline.json (v2Recorded)
//   2. memory       the 24 memory-eval calls through the real updater                    -> data/cassettes/memory.cassette.json
//   3. judge        the 120 judgement cases through the real moment role                 -> data/cassettes/judge-set.cassette.json
//   4. test, 5. test-b, 6. test-c   the held-out meetings. Each one asks for a yes first: reading a held-out split is a one-time act.
//                   After them one `pnpm eval --final --cassette ...` reads the recorded ones.
// It writes qa/out/morning.md (one page) with what ran, what it cost, the scores, and what failed.
// It refuses: without ANTHROPIC_API_KEY in the environment (nothing reads a key file), in CI, without --cap, and when the estimate is above the cap.
// Tests run it with a mock transport and stub steps; they never reach the network.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { main as recordMain, estimate as estimateSuite } from "./cassette-record.ts";
import { main as memoryMain, estimateRecord as estimateMemory } from "./eval-memory.ts";
import { main as judgeMain, estimateRecord as estimateJudge } from "./eval-judge.ts";
import { loadSplit } from "../qa/golden-load.ts";
import { v2Meetings } from "../qa/eval-v2.ts";
import { loadCases } from "../qa/memory-eval.ts";
import { loadJudgeSet } from "../qa/judge-set.ts";
import { reconcileCost, formatRecon, type Recon, type RoleUse } from "../qa/cost-recon.ts";
import { runMeeting, pool, costByRole } from "../src/e2e/v2-kit.ts";
import { tsx } from "../src/test-platform.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const STEP_ORDER = ["dev", "memory", "judge", "test", "test-b", "test-c"] as const;
export type StepName = (typeof STEP_ORDER)[number];
const HELD_OUT: readonly StepName[] = ["test", "test-b", "test-c"];

export type StepOut = { ok: boolean; spent: number; note: string; file?: string; text?: string };
export type Steps = {
  /** Does the split exist in this build? (test-c is added by another package; a missing one is skipped, not an error.) */
  exists(step: StepName): boolean;
  record(suite: "dev" | "test" | "test-b" | "test-c", o: { cap: number; final: boolean }): Promise<StepOut>;
  memory(o: { cap: number }): Promise<StepOut>;
  judge(o: { cap: number }): Promise<StepOut>;
  /** `pnpm eval --cassette <file> --update`: plays dev against the recording and writes the recorded baseline. */
  evalDev(cassette: string): Promise<{ ok: boolean; text: string }>;
  /** `pnpm eval --final --cassette a,b,c`: the one read of the held-out splits that were recorded. */
  evalFinal(cassettes: string[]): Promise<{ ok: boolean; text: string }>;
  /** Plays dev scripted and against the recording and compares the booked cost per role. */
  reconcile(cassette: string): Promise<(Recon & { hours: number }) | undefined>;
};
export type Deps = {
  transport: "mock" | "real";
  log: (line: string) => void;
  /** Asks a yes/no question. The default reads one line from a terminal; without a terminal the answer is no. */
  ask?: (question: string) => Promise<boolean>;
  steps?: Partial<Steps>;
  /** Folders and files, so a test can use a temp folder. */
  cassetteDir?: string;
  outDir?: string;
  baselineFile?: string;
  recordedBaselineFile?: string;
  now?: () => Date;
};
export type Row = { step: string; status: "ok" | "failed" | "skipped" | "declined"; spent: number; note: string };

const defaultAsk = (q: string): Promise<boolean> =>
  process.stdin.isTTY
    ? new Promise((res) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(`${q} [yes/no] `, (a) => (rl.close(), res(/^y(es)?$/i.test(a.trim()))));
      })
    : Promise.resolve(false);

function child(args: string[]): Promise<{ ok: boolean; text: string }> {
  return new Promise((res) => {
    const p = spawn(...tsx([join(ROOT, "scripts", "eval.ts"), ...args]), { cwd: ROOT, env: process.env });
    let out = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (out += b));
    p.on("exit", (code) => res({ ok: code === 0, text: out }));
    p.on("error", (e) => res({ ok: false, text: String(e) }));
  });
}
const lastLines = (s: string, n: number) => s.trim().split("\n").slice(-n).join("\n");

export function defaultSteps(deps: Deps, env: NodeJS.ProcessEnv): Steps {
  const dir = deps.cassetteDir ?? join(ROOT, "data", "cassettes");
  const capture = () => {
    const lines: string[] = [];
    return { lines, log: (l: string) => lines.push(l) };
  };
  return {
    exists: (step) => existsSync(join(ROOT, "data", "meetings", step)) || !HELD_OUT.includes(step),
    async record(suite, o) {
      const c = capture(),
        report = { spentUsd: 0, entries: 0, stopped: false, cassette: join(dir, `${suite}.cassette.json`) };
      const code = await recordMain(
        [
          "--suite",
          suite,
          "--cap",
          String(o.cap),
          "--allow-partial",
          "--out",
          report.cassette,
          ...(o.final ? ["--final"] : []),
          ...(suite === "dev" ? ["--judge"] : []),
        ],
        env,
        { transport: deps.transport, log: c.log, report },
      );
      return {
        ok: code === 0 && !report.stopped,
        spent: report.spentUsd,
        file: report.cassette,
        note: `${report.entries} entries${report.stopped ? ", stopped at the cap" : ""}`,
        text: c.lines.join("\n"),
      };
    },
    async memory(o) {
      const c = capture(),
        report = { spentUsd: 0, stopped: false, cassette: join(dir, "memory.cassette.json"), calls: 0 };
      const code = await memoryMain(["--record", "--cap", String(o.cap), "--cassette", report.cassette], env, {
        transport: deps.transport,
        log: c.log,
        report,
      });
      return { ok: code === 0 && !report.stopped, spent: report.spentUsd, file: report.cassette, note: `${report.calls} calls`, text: c.lines.join("\n") };
    },
    async judge(o) {
      const c = capture(),
        report = { spentUsd: 0, recorded: 0, stopped: false, cassette: join(dir, "judge-set.cassette.json") };
      const code = await judgeMain(["--record", "--cap", String(o.cap), "--out", report.cassette], env, { transport: deps.transport, log: c.log, report });
      return { ok: code === 0 && !report.stopped, spent: report.spentUsd, file: report.cassette, note: `${report.recorded} cases`, text: c.lines.join("\n") };
    },
    evalDev: (cassette) => child(["--cassette", cassette, "--update"]),
    evalFinal: (cassettes) => child(["--final", "--cassette", cassettes.join(",")]),
    async reconcile(cassette) {
      const meetings = v2Meetings(loadSplit("dev"));
      const sum = (runs: Awaited<ReturnType<typeof runMeeting>>[]) => {
        const by: Record<string, RoleUse> = {};
        for (const r of runs)
          for (const [k, v] of Object.entries(costByRole(r.usage))) {
            const t = (by[k] ??= { calls: 0, usd: 0 });
            t.calls += v.calls;
            t.usd += v.usd;
          }
        return { by, hours: runs.reduce((a, r) => a + r.lengthMs, 0) / 3_600_000 };
      };
      const scripted = sum(await pool(meetings, 4, (g) => runMeeting(g.id, { asks: false }, 600_000)));
      const recorded = sum(await pool(meetings, 4, (g) => runMeeting(g.id, { asks: false, replay: { cassette } }, 600_000)));
      return { ...reconcileCost(scripted.by, recorded.by, scripted.hours, recorded.hours), hours: scripted.hours };
    },
  };
}

/** The planned cost of every step, before anything runs. Held-out splits are NOT read for this: their size is the number of files times the average dev meeting. */
export function plan(deps: Deps, only: StepName[], steps: Steps): { step: StepName; usd: number; basis: string; skip?: string }[] {
  const dev = v2Meetings(loadSplit("dev"));
  const devEst = estimateSuite(dev, 1, undefined, true);
  const out: { step: StepName; usd: number; basis: string; skip?: string }[] = [];
  for (const step of STEP_ORDER) {
    if (!only.includes(step)) continue;
    if (!steps.exists(step)) {
      out.push({ step, usd: 0, basis: "", skip: `no ${step} split in this build` });
      continue;
    }
    if (step === "dev") out.push({ step, usd: devEst.usd, basis: `${devEst.meetings} meetings, about ${devEst.calls} calls, with the model judge` });
    else if (step === "memory") out.push({ step, usd: estimateMemory(loadCases()).usd, basis: "24 calls through the updater" });
    else if (step === "judge") out.push({ step, usd: estimateJudge(loadJudgeSet()).usd, basis: "120 cases through the moment role" });
    else {
      const dir = join(ROOT, "data", "meetings", step);
      const n = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).length : 0;
      out.push({
        step,
        usd: (devEst.usd - devEst.judgeUsd) * (n / Math.max(1, devEst.meetings)),
        basis: `${n} meetings (size assumed from the file count, the split is not read)`,
      });
    }
  }
  return out;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, deps: Deps): Promise<number> {
  const log = deps.log;
  const err = (m: string) => (log(`morning: ${m}`), 2);
  const get = (f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  // 1. the refusals come before anything is read or started
  if ((env.CI && env.CI !== "false" && env.CI !== "0") || env.GITHUB_ACTIONS)
    return err("refusing to run in CI. It calls the real model and costs money; the owner runs it by hand.");
  const cap = Number(get("--cap"));
  if (!Number.isFinite(cap) || cap <= 0) return err("--cap <usd> is required and must be above 0 (one cap for the whole run, about 3 to 5 USD)");
  const names = (f: string) => (get(f) ?? "").split(",").filter(Boolean);
  const bad = [...names("--only"), ...names("--skip")].filter((x) => !(STEP_ORDER as readonly string[]).includes(x));
  if (bad.length) return err(`unknown step ${bad.join(", ")}. Steps: ${STEP_ORDER.join(", ")}`);
  const only = names("--only").length ? (names("--only") as StepName[]) : [...STEP_ORDER];
  const wanted = only.filter((s) => !names("--skip").includes(s));
  const steps: Steps = { ...defaultSteps(deps, env), ...deps.steps };

  // 2. the one-page estimate
  const rows = plan(deps, wanted, steps);
  const total = rows.reduce((a, r) => a + r.usd, 0);
  log(
    [
      "Morning run: estimate",
      ...rows.map((r) => `  ${r.step.padEnd(8)} ${r.skip ? `skipped (${r.skip})` : `about $${r.usd.toFixed(2)}  ${r.basis}`}`),
      `  total    about $${total.toFixed(2)} (cap $${cap.toFixed(2)}, one cap for all steps)`,
      "  The estimates are floors: the dev plan prices the modelled usage twice; check the first step's booked cost before you leave it alone.",
      `  held-out steps (${HELD_OUT.join(", ")}) ask for a yes each; reading a held-out split is a one-time act`,
      `  transport ${deps.transport}`,
    ].join("\n"),
  );
  if (argv.includes("--estimate")) return 0;
  if (deps.transport === "real" && !env.ANTHROPIC_API_KEY)
    return err("no ANTHROPIC_API_KEY in the environment. Set it for this one command; nothing reads the key from a file.");
  if (total > cap && !argv.includes("--allow-partial"))
    return err(
      `the estimate ($${total.toFixed(2)}) is above the cap ($${cap.toFixed(2)}). Raise --cap, run fewer steps (--only), or pass --allow-partial to stop at the cap.`,
    );

  // 3. run
  const ask = deps.ask ?? defaultAsk;
  const out: Row[] = [];
  const detail: string[] = [];
  let spent = 0;
  let recon: (Recon & { hours: number }) | undefined;
  const recorded: Partial<Record<StepName, string>> = {};
  let evalDevText = "";
  let finalText = "";
  let devOk = false;
  let evalDevOk = false;
  for (const step of wanted) {
    const row = (status: Row["status"], note: string, usd = 0): void => void out.push({ step, status, spent: usd, note });
    if (!steps.exists(step)) {
      row("skipped", `no ${step} split in this build`);
      continue;
    }
    const left = cap - spent;
    if (left <= 0.0005) {
      row("skipped", "the cap is used up");
      continue;
    }
    if (HELD_OUT.includes(step)) {
      const yes = await ask(
        `Record the held-out split "${step}" now? It is read once and must not be used to tune. (about $${(rows.find((r) => r.step === step)?.usd ?? 0).toFixed(2)})`,
      );
      if (!yes) {
        row("declined", "no yes given; nothing was read");
        continue;
      }
    }
    log(`\n== ${step} (cap left $${left.toFixed(2)}) ==`);
    let r: StepOut;
    try {
      r =
        step === "memory"
          ? await steps.memory({ cap: left })
          : step === "judge"
            ? await steps.judge({ cap: left })
            : await steps.record(step, { cap: left, final: HELD_OUT.includes(step) });
    } catch (e) {
      r = { ok: false, spent: 0, note: e instanceof Error ? e.message.slice(0, 200) : String(e) };
    }
    spent += r.spent;
    row(r.ok ? "ok" : "failed", r.note, r.spent);
    if (r.text) log(lastLines(r.text, 6));
    if (r.file && r.ok) recorded[step] = r.file;
    if (step === "dev" && r.ok && r.file) {
      devOk = true;
      const e = await steps.evalDev(r.file);
      evalDevText = e.text;
      evalDevOk = e.ok;
      if (!e.ok) out.push({ step: "eval dev", status: "failed", spent: 0, note: "pnpm eval --cassette ... --update failed" });
      try {
        recon = await steps.reconcile(r.file);
      } catch (err2) {
        detail.push(`Cost reconciliation did not run: ${err2 instanceof Error ? err2.message : String(err2)}`);
      }
      if (recon) log(formatRecon(recon));
    }
  }
  const heldFiles = HELD_OUT.flatMap((s) => (recorded[s] ? [recorded[s]!] : []));
  if (heldFiles.length) {
    log("\n== held-out read (pnpm eval --final) ==");
    const f = await steps.evalFinal(heldFiles);
    finalText = f.text;
    out.push({ step: "eval --final", status: f.ok ? "ok" : "failed", spent: 0, note: `${heldFiles.length} recorded split(s) read once` });
  }

  // 4. the recorded baseline and the one-page report
  const baselineFile = deps.baselineFile ?? join(ROOT, "qa", "eval-baseline.json");
  const recordedFile = deps.recordedBaselineFile ?? join(ROOT, "qa", "recorded-baseline.json");
  if (devOk && !evalDevOk)
    detail.push("The dev eval against the recording failed, so recorded-baseline.json was not written (the old numbers in the baseline file would be stale).");
  if (devOk && evalDevOk && existsSync(baselineFile)) {
    const v2Recorded = (JSON.parse(readFileSync(baselineFile, "utf8")) as { v2Recorded?: unknown }).v2Recorded;
    if (v2Recorded) {
      mkdirSync(dirname(recordedFile), { recursive: true });
      writeFileSync(
        recordedFile,
        JSON.stringify({ writtenAt: (deps.now?.() ?? new Date()).toISOString(), cassette: recorded.dev, v2Recorded }, null, 2) + "\n",
      );
      detail.push(`Recorded baseline written to ${recordedFile}.`);
    } else detail.push("No v2Recorded section in the baseline after the eval: recorded-baseline.json was not written. See the eval output below.");
  }
  const failed = out.some((r) => r.status === "failed") || (recon ? !recon.ok : false);
  const md = report({ rows: out, spent, cap, recon, detail, evalDevText, finalText, when: (deps.now?.() ?? new Date()).toISOString(), failed });
  const outDir = deps.outDir ?? join(ROOT, "qa", "out");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "morning.md"), md);
  log(`\nBooked about $${spent.toFixed(3)} of $${cap.toFixed(2)}. Report: ${join(outDir, "morning.md")}`);
  for (const r of out) log(`  ${r.status.padEnd(8)} ${r.step.padEnd(14)} ${r.spent ? "$" + r.spent.toFixed(3) : ""}  ${r.note}`);
  return failed ? 1 : 0;
}

function report(o: {
  rows: Row[];
  spent: number;
  cap: number;
  recon?: Recon & { hours: number };
  detail: string[];
  evalDevText: string;
  finalText: string;
  when: string;
  failed: boolean;
}): string {
  return [
    `# Morning run, ${o.when}`,
    "",
    `Result: ${o.failed ? "NEEDS A LOOK (a step failed or the cost check failed)" : "all steps that ran are fine"}. Booked about $${o.spent.toFixed(3)} of the $${o.cap.toFixed(2)} cap.`,
    "",
    "| Step | Status | Cost | Note |",
    "|---|---|---|---|",
    ...o.rows.map((r) => `| ${r.step} | ${r.status} | ${r.spent ? "$" + r.spent.toFixed(3) : "-"} | ${r.note} |`),
    "",
    "## Cost check (simulated against recorded, per hour of call)",
    o.recon
      ? "```\n" + formatRecon(o.recon) + "\n```\n" + (o.recon.ok ? "Within 15 percent." : "FAILED: " + o.recon.failed.join("; "))
      : "Not run (the dev step did not finish).",
    "",
    "## Dev eval against the recording",
    o.evalDevText ? "```\n" + lastLines(o.evalDevText, 30) + "\n```" : "Not run.",
    "",
    "## Held-out read",
    o.finalText ? "```\n" + lastLines(o.finalText, 30) + "\n```" : "Not run (nothing was recorded, or no yes was given).",
    "",
    ...(o.detail.length ? ["## Notes", ...o.detail.map((d) => "- " + d), ""] : []),
    "## Next",
    "- Look at the memory and judgement numbers: `pnpm eval:memory --mode model`, `pnpm eval:judge --mode model`.",
    "- Then one real, low-risk call, and rate its cards with `pnpm tag`.",
    "",
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2), process.env, { transport: "real", log: (l) => console.log(l) });
}
