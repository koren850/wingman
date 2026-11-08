// scripts/morning.ts: one command for the whole recording. Tested with stub steps and the mock transport only; it is never run for real in a test.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, plan, STEP_ORDER, type Steps, type StepName } from "../scripts/morning.ts";
import { reconcileCost } from "../qa/cost-recon.ts";
import { Cassette } from "./providers/cassette.ts";

type Calls = string[];
function stubs(calls: Calls, o: { spend?: Partial<Record<StepName, number>>; missing?: StepName[]; reconFail?: boolean; failStep?: StepName } = {}): Steps {
  const spend = (s: StepName) => o.spend?.[s] ?? 0.5;
  const out = (s: StepName) => ({ ok: o.failStep !== s, spent: spend(s), file: `/x/${s}.cassette.json`, note: "stub" });
  return {
    exists: (s) => !o.missing?.includes(s),
    async record(suite, a) {
      calls.push(`record ${suite} cap=${a.cap.toFixed(2)} final=${a.final}`);
      return out(suite);
    },
    async memory(a) {
      calls.push(`memory cap=${a.cap.toFixed(2)}`);
      return out("memory");
    },
    async judge(a) {
      calls.push(`judge cap=${a.cap.toFixed(2)}`);
      return out("judge");
    },
    async evalDev(c) {
      calls.push(`evalDev ${c}`);
      return { ok: true, text: "dev eval text" };
    },
    async evalFinal(cs) {
      calls.push(`evalFinal ${cs.join(",")}`);
      return { ok: true, text: "final eval text" };
    },
    async reconcile() {
      calls.push("reconcile");
      const sim = { moment: { calls: 100, usd: 1 } };
      return { ...reconcileCost(sim, { moment: { calls: 100, usd: o.reconFail ? 1.5 : 1.05 } }, 1), hours: 1 };
    },
  };
}
const tmp = () => mkdtempSync(join(tmpdir(), "wingman-morning-"));
const paths = (dir: string) => ({
  outDir: join(dir, "out"),
  baselineFile: join(dir, "eval-baseline.json"),
  recordedBaselineFile: join(dir, "recorded-baseline.json"),
  cassetteDir: join(dir, "c"),
});

test("morning refuses in CI, without a cap, without a key (real), for an unknown step, and when the estimate is above the cap", async () => {
  const logs: string[] = [];
  const dir = tmp();
  try {
    const run = (argv: string[], env: NodeJS.ProcessEnv, transport: "mock" | "real" = "real") =>
      main(argv, env, { transport, log: (l) => logs.push(l), steps: stubs([]), ...paths(dir) });
    assert.equal(await run(["--cap", "5"], { CI: "true", ANTHROPIC_API_KEY: "k" }), 2);
    assert.match(logs.join("\n"), /refusing to run in CI/);
    assert.equal(await run(["--cap", "5"], { GITHUB_ACTIONS: "true", ANTHROPIC_API_KEY: "k" }), 2);
    assert.equal(await run([], { ANTHROPIC_API_KEY: "k" }), 2);
    assert.equal(await run(["--cap", "5"], {}), 2);
    assert.match(logs.join("\n"), /no ANTHROPIC_API_KEY/);
    assert.equal(await run(["--cap", "5", "--only", "nonsense"], { ANTHROPIC_API_KEY: "k" }), 2);
    logs.length = 0;
    assert.equal(await run(["--cap", "0.001"], { ANTHROPIC_API_KEY: "k" }), 2);
    assert.match(logs.join("\n"), /the estimate .* is above the cap/);
    assert.ok(!existsSync(join(dir, "out", "morning.md")), "nothing ran");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("morning --estimate prints the one-page cost estimate first and needs no key", async () => {
  const logs: string[] = [];
  assert.equal(await main(["--cap", "5", "--estimate"], {}, { transport: "real", log: (l) => logs.push(l), steps: stubs([]) }), 0);
  const text = logs.join("\n");
  assert.match(text, /Morning run: estimate/);
  for (const s of ["dev", "memory", "judge", "test", "test-b"]) assert.match(text, new RegExp(`^\\s+${s}\\s+about \\$`, "m"), s);
  assert.match(text, /total\s+about \$\d+\.\d\d \(cap \$5\.00/);
  assert.match(text, /held-out steps .* ask for a yes each/);
  const p = plan({ transport: "mock", log: () => {} }, [...STEP_ORDER], stubs([], { missing: ["test-c"] }));
  assert.equal(p.find((x) => x.step === "test-c")?.skip, "no test-c split in this build");
  assert.ok(p.find((x) => x.step === "dev")!.usd > 0 && p.find((x) => x.step === "dev")!.usd < 5, "dev alone fits the maintainer's cap");
});

test("morning runs every step in order, asks before each held-out read, reads them once, writes the baseline and the one-page report", async () => {
  const dir = tmp();
  try {
    const p = paths(dir);
    writeFileSync(p.baselineFile, JSON.stringify({ legacy: {}, v2: {}, v2Recorded: { scripted: false, metrics: { "cards.recall": { value: 0.7 } } } }));
    const calls: Calls = [];
    const asked: string[] = [];
    const logs: string[] = [];
    const code = await main(
      ["--cap", "5", "--allow-partial"],
      { ANTHROPIC_API_KEY: "k" },
      {
        transport: "mock",
        log: (l) => logs.push(l),
        ask: async (q) => (asked.push(q), true),
        steps: stubs(calls, { spend: { dev: 0.5, memory: 0.1, judge: 0.1, test: 0.4, "test-b": 0.4, "test-c": 0.4 } }),
        now: () => new Date("2026-11-09T07:00:00Z"),
        ...p,
      },
    );
    assert.equal(code, 0, logs.join("\n"));
    assert.deepEqual(calls, [
      "record dev cap=5.00 final=false",
      "evalDev /x/dev.cassette.json",
      "reconcile",
      "memory cap=4.50",
      "judge cap=4.40",
      "record test cap=4.30 final=true",
      "record test-b cap=3.90 final=true",
      "record test-c cap=3.50 final=true",
      "evalFinal /x/test.cassette.json,/x/test-b.cassette.json,/x/test-c.cassette.json",
    ]);
    assert.equal(asked.length, 3, "one yes for each held-out split");
    assert.deepEqual(
      asked.map((q) => /"([^"]+)"/.exec(q)![1]),
      ["test", "test-b", "test-c"],
    );
    const rb = JSON.parse(readFileSync(p.recordedBaselineFile, "utf8"));
    assert.equal(rb.v2Recorded.metrics["cards.recall"].value, 0.7);
    assert.equal(rb.cassette, "/x/dev.cassette.json");
    const md = readFileSync(join(p.outDir, "morning.md"), "utf8");
    assert.match(md, /^# Morning run, 2026-11-09T07:00:00.000Z/);
    assert.match(md, /\| dev \| ok \| \$0\.500 \|/);
    assert.match(md, /\| eval --final \| ok/);
    assert.match(md, /Within 15 percent/);
    assert.ok(md.split("\n").length < 60, "one page");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("morning enforces one cap across all steps: a step that uses it up stops the rest", async () => {
  const dir = tmp();
  try {
    const calls: Calls = [];
    const logs: string[] = [];
    const code = await main(
      ["--cap", "1", "--allow-partial"],
      { ANTHROPIC_API_KEY: "k" },
      {
        transport: "mock",
        log: (l) => logs.push(l),
        ask: async () => true,
        steps: stubs(calls, { spend: { dev: 0.9, memory: 0.2 } }),
        ...paths(dir),
      },
    );
    assert.ok(code === 0 || code === 1);
    assert.deepEqual(
      calls.filter((c) => /^(record|memory|judge)/.test(c)),
      ["record dev cap=1.00 final=false", "memory cap=0.10"],
      "the second step got only what was left; the third found the cap used up",
    );
    const md = readFileSync(join(paths(dir).outDir, "morning.md"), "utf8");
    assert.match(md, /\| judge \| skipped .* the cap is used up/);
    assert.match(md, /\| test \| skipped/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("morning: no yes means the held-out split is not recorded and not read; a missing split is skipped; a failed cost check fails the run", async () => {
  const dir = tmp();
  try {
    const calls: Calls = [];
    const logs: string[] = [];
    const code = await main(
      ["--cap", "50", "--allow-partial"],
      { ANTHROPIC_API_KEY: "k" },
      {
        transport: "mock",
        log: (l) => logs.push(l),
        ask: async (q) => q.includes('"test-b"'),
        steps: stubs(calls, { missing: ["test-c"], reconFail: true }),
        ...paths(dir),
      },
    );
    assert.equal(code, 1, "the cost check failed");
    assert.ok(!calls.some((c) => c.startsWith("record test ")), "test was declined");
    assert.ok(calls.includes("record test-b cap=" + (50 - 0.5 * 4).toFixed(2) + " final=true") || calls.some((c) => c.startsWith("record test-b")));
    assert.ok(!calls.some((c) => c.includes("test-c")));
    assert.equal(
      calls.find((c) => c.startsWith("evalFinal")),
      "evalFinal /x/test-b.cassette.json",
    );
    const md = readFileSync(join(paths(dir).outDir, "morning.md"), "utf8");
    assert.match(md, /\| test \| declined \|/);
    assert.match(md, /\| test-c \| skipped \| - \| no test-c split in this build/);
    assert.match(md, /NEEDS A LOOK/);
    assert.match(md, /FAILED: .*moment/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("morning with a terminal-less ask says no to every held-out split (the default)", async () => {
  const dir = tmp();
  try {
    const calls: Calls = [];
    await main(
      ["--cap", "50", "--allow-partial", "--only", "test,test-b"],
      { ANTHROPIC_API_KEY: "k" },
      { transport: "mock", log: () => {}, steps: stubs(calls), ...paths(dir) },
    );
    assert.deepEqual(calls, [], "stdin is not a terminal in a test: no yes, no read");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("morning wires the memory and judgement steps to the real commands (mock transport): both cassettes are written and the cost is booked", async () => {
  const dir = tmp();
  try {
    const p = paths(dir);
    const calls: Calls = [];
    const logs: string[] = [];
    const s = stubs(calls);
    const code = await main(
      ["--cap", "5", "--only", "memory,judge"],
      { ANTHROPIC_API_KEY: "k" },
      { transport: "mock", log: (l) => logs.push(l), steps: { exists: s.exists }, ...p },
    );
    assert.ok(code === 0 || code === 1, logs.join("\n"));
    assert.ok(new Cassette(join(p.cassetteDir, "memory.cassette.json")).size > 50, "memory calls recorded");
    assert.equal(new Cassette(join(p.cassetteDir, "judge-set.cassette.json")).size, 120, "all 120 judgement cases recorded");
    const md = readFileSync(join(p.outDir, "morning.md"), "utf8");
    assert.match(md, /\| memory \| (ok|failed) \|/);
    assert.match(md, /\| judge \| ok \|.*120 cases/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("morning does not write the recorded baseline when the dev eval failed (the baseline file would hold old numbers)", async () => {
  const dir = tmp();
  try {
    const p = paths(dir);
    writeFileSync(p.baselineFile, JSON.stringify({ v2Recorded: { old: true } }));
    const steps = { ...stubs([]), evalDev: async () => ({ ok: false, text: "boom" }) };
    const code = await main(["--cap", "5", "--only", "dev", "--allow-partial"], { ANTHROPIC_API_KEY: "k" }, { transport: "mock", log: () => {}, steps, ...p });
    assert.equal(code, 1);
    assert.ok(!existsSync(p.recordedBaselineFile), "no stale baseline");
    assert.match(readFileSync(join(p.outDir, "morning.md"), "utf8"), /was not written/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("morning without a terminal answers no to the held-out question and reads nothing", async () => {
  const dir = tmp();
  try {
    const calls: Calls = [];
    const code = await main(
      ["--cap", "5", "--only", "test,test-b", "--allow-partial"],
      { ANTHROPIC_API_KEY: "k" },
      {
        transport: "mock",
        log: () => {},
        ask: async () => false,
        steps: stubs(calls),
        ...paths(dir),
      },
    );
    assert.equal(code, 0);
    assert.deepEqual(calls, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
