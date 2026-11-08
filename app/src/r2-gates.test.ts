// Tests of the round 2 gates: the per-role cost and latency budgets (+20 percent fails), the committed numbers (no zero, every number marked scripted or
// recorded), the recorded-cassette path (record with the mock transport, replay in the v2 worker, read the judge verdicts back) and the eval's own output.
// No model call anywhere: the recorder runs on the policy fake. The snapshot script is only checked for shape here; the run itself needs Electron and takes
// minutes (scripts/snapshot-check.sh, see the build report).
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./env.ts";
import { tsx } from "./test-platform.ts";
import { measure, checkBudgets, readBudgets, pathOf, BUDGET_TOLERANCE, COST_PER_HOUR_GATE, type Section } from "../qa/budgets.ts";
import { modelJudgeSummary, judgeCassettePath } from "../qa/judge-eval.ts";
import { loadSplit } from "../qa/golden-load.ts";
import { main as recordMain, estimate, parseArgs, JUDGE_USD_PER_CARD } from "../scripts/cassette-record.ts";
import { runMeeting } from "./e2e/v2-kit.ts";
import { Cassette } from "./providers/cassette.ts";
import type { MeetingRun } from "./e2e/v2-kit.ts";
import type { GoldenGrade } from "../qa/grade-golden.ts";

// ---------------------------------------------------------------- budgets (pure)
const fakeRun = (usd: Record<string, number[]>, lengthMs = 3_600_000, cards: { turnId: string; ttc: number }[] = []) => {
  const run = {
    id: "x",
    lengthMs,
    usage: Object.entries(usd).flatMap(([role, xs]) => xs.map((u) => ({ role, usd: u, input_tokens: 1000, cache_read: 400 }))),
    screen: cards.map((c) => ({ id: c.turnId, turnId: c.turnId, at: 0 })),
  } as unknown as MeetingRun;
  const grade = {
    results: cards.map((c, i) => ({ id: String(i), kind: "answer", status: "hit", ttcMs: c.ttc, card: i })),
  } as unknown as GoldenGrade;
  return { run, grade };
};
const sample = () =>
  measure(
    [
      fakeRun({ moment: Array(10).fill(0.0001), observer: Array(20).fill(0.00008), rare: [0.0000001] }, 3_600_000, [
        ...Array.from({ length: 6 }, (_, i) => ({ turnId: `q${i}`, ttc: 1000 + i * 100 })),
        ...Array.from({ length: 6 }, (_, i) => ({ turnId: `o${i}`, ttc: 2000 + i * 100 })),
      ]),
    ],
    "scripted",
    "test",
  );

test("budgets: measure() gives USD per call and per hour for each role, skips roles with too few calls, and splits latency by path", () => {
  const s = sample();
  assert.deepEqual(Object.keys(s.roles).sort(), ["moment", "observer"], "a role with one call is not budgeted");
  assert.ok(Math.abs(s.roles.moment.usdPerCall - 0.0001) < 1e-9);
  assert.ok(Math.abs(s.roles.moment.usdPerHour - 0.001) < 1e-9, "10 calls in one hour");
  assert.equal(s.paths.direct.n, 6);
  assert.equal(s.paths.observer.p50 >= 2000, true);
  assert.equal(s.paths.other, undefined, "no card on the other paths");
  assert.equal(s.basis, "scripted");
  assert.equal(pathOf("q12"), "direct");
  assert.equal(pathOf("o3"), "observer");
  assert.equal(pathOf("bank-7"), "other");
});

test("budgets: +19 percent passes, +21 percent fails, per role and per path; a new role is reported, not failed", () => {
  const base = sample();
  const grow = (f: number, role = "moment"): Section => ({
    ...base,
    roles: { ...base.roles, [role]: { ...base.roles[role], usdPerCall: base.roles[role].usdPerCall * f, usdPerHour: base.roles[role].usdPerHour * f } },
  });
  assert.equal(checkBudgets(base, base).failed, 0);
  assert.equal(checkBudgets(grow(1 + BUDGET_TOLERANCE - 0.01), base).failed, 0, "+19 percent is inside");
  const over = checkBudgets(grow(1 + BUDGET_TOLERANCE + 0.01, "observer"), base);
  assert.equal(over.failed, 2, "the per-call and the per-hour row of the role");
  assert.ok(over.rows.filter((r) => r.verdict === "FAIL").every((r) => r.id.startsWith("observer")));
  // latency
  const slowPath: Section = { ...base, paths: { ...base.paths, direct: { ...base.paths.direct, p95: base.paths.direct.p95 * 1.21 } } };
  const lat = checkBudgets(slowPath, base);
  assert.deepEqual(
    lat.rows.filter((r) => r.verdict === "FAIL").map((r) => r.id),
    ["direct path: time to card p95"],
  );
  // a role the budget does not know
  const added: Section = { ...base, roles: { ...base.roles, newrole: { calls: 9, usdPerCall: 1, usdPerHour: 1 } } };
  const c = checkBudgets(added, base);
  assert.equal(c.rows.filter((r) => r.verdict === "new").length, 2);
  assert.equal(c.failed, 0);
  // no budget at all: nothing fails, everything is new
  assert.equal(checkBudgets(base, undefined).failed, 0);
});

test("budgets: the whole call fails over the $0.25 per hour release gate even when its own budget allows it", () => {
  const base = sample();
  const hot: Section = { ...base, perHour: COST_PER_HOUR_GATE + 0.01 };
  const r = checkBudgets(hot, hot);
  assert.equal(r.failed, 1);
  assert.match(r.notes.join(" "), /release gate/);
});

// ---------------------------------------------------------------- the committed numbers
test("budgets.json: has a scripted section with every number above zero, a cost per hour under the gate, and no recorded section until the owner records one", () => {
  const b = readBudgets();
  assert.ok(b.scripted, "scripted section");
  assert.equal(b.scripted!.basis, "scripted");
  assert.ok(b.scripted!.perHour > 0 && b.scripted!.perHour <= COST_PER_HOUR_GATE);
  for (const role of ["moment", "observer", "memory", "compact", "ask"]) {
    const r = b.scripted!.roles[role];
    assert.ok(r && r.usdPerCall > 0 && r.usdPerHour > 0 && r.calls >= 5, role);
  }
  for (const k of ["direct", "observer"]) assert.ok(b.scripted!.paths[k].p50 > 0 && b.scripted!.paths[k].p95 >= b.scripted!.paths[k].p50, k);
  assert.ok(b.oneShot!.digest > 0 && b.oneShot!.wrapup > 0);
  assert.equal(b.tolerance, BUDGET_TOLERANCE);
  assert.equal(b.recorded === undefined || b.recorded.basis === "recorded", true, "a recorded section is marked as such");
});

test("eval-baseline.json: the v2 section is marked scripted and holds no zero; a recorded section, when it exists, names its cassette", () => {
  const f = JSON.parse(readFileSync(join(ROOT, "qa", "eval-baseline.json"), "utf8")) as Record<
    string,
    { scripted: boolean; cassette?: string; metrics: Record<string, { value: number }> }
  >;
  assert.equal(f.v2.scripted, true);
  for (const [k, m] of Object.entries(f.v2.metrics)) assert.ok(m.value > 0, `${k} is zero: a gate that cannot fail`);
  if (f.v2Recorded) {
    assert.equal(f.v2Recorded.scripted, false);
    assert.ok(f.v2Recorded.cassette);
  }
});

// ---------------------------------------------------------------- record, judge, replay
test(
  "cassette-record --judge: the estimate counts the judge; the judge cassette is written next to the engine cassette; replay of the same meeting has no misses and the same cards",
  { timeout: 120_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "wm-gates-"));
    try {
      const metas = loadSplit("dev").filter((g) => g.id === "dev-silence-en");
      const plain = estimate(metas, 1, undefined, false);
      const withJudge = estimate(metas, 1, undefined, true);
      assert.ok(withJudge.usd > plain.usd && withJudge.judgeUsd > 0);
      assert.equal(
        parseArgs(["--suite", "dev", "--cap", "1", "--judge"]).valueOf() &&
          (parseArgs(["--suite", "dev", "--cap", "1", "--judge"]) as { judge: boolean }).judge,
        true,
      );
      const lines: string[] = [];
      const code = await recordMain(
        ["--suite", "dev", "--cap", "5", "--only", "dev-silence-en", "--judge"],
        {},
        { transport: "mock", log: (l) => void lines.push(l), dataDir: dir },
      );
      assert.equal(code, 0, lines.join("\n"));
      assert.match(lines[0], /^Cassette recording: estimate/);
      assert.match(lines.join("\n"), /of which the judge about/);
      const engineCassette = join(dir, "dev.cassette.json");
      assert.ok(existsSync(engineCassette));
      assert.equal(judgeCassettePath(engineCassette), join(dir, "dev.judge.cassette.json"));
      assert.ok(
        lines.some((l) => /^Judge: \d+ cards judged/.test(l)),
        lines.join("\n"),
      );
      // replay the same meeting from the cassette
      const live = await runMeeting("dev-silence-en", { asks: false, replay: { cassette: engineCassette } });
      assert.equal(live.cassetteMisses, 0, "every call of the replay was in the cassette");
      assert.ok(live.usage.length > 0, "the recorded usage is booked");
      const scripted = await runMeeting("dev-silence-en", { asks: false });
      assert.deepEqual(
        live.cards.map((c) => c.text),
        scripted.cards.map((c) => c.text),
        "the mock record is the scripted fake, so the replay gives the same cards",
      );
      // the judge reads the verdicts back
      const g = loadSplit("dev").find((x) => x.id === "dev-silence-en")!;
      const j = await modelJudgeSummary([{ golden: g, run: live }], judgeCassettePath(engineCassette));
      assert.equal(j.status, "ok");
      if (j.status === "ok") {
        assert.equal(j.unjudged, 0, "a card the recorder judged is found again");
        assert.equal(j.judged, live.cards.length);
      }
      // a cassette that is missing a call: the miss is counted, the engine survives
      const empty = join(dir, "empty.cassette.json");
      new Cassette(empty).save(empty);
      const missing = await runMeeting("dev-silence-en", { asks: false, replay: { cassette: empty } });
      assert.ok((missing.cassetteMisses ?? 0) > 0, "misses are counted");
      assert.equal(missing.error, undefined, "the engine did not crash on a miss");
      // no judge cassette: said, not failed
      assert.equal((await modelJudgeSummary([{ golden: g, run: live }], join(dir, "nope.judge.cassette.json"))).status, "no-cassette");
      assert.ok(JUDGE_USD_PER_CARD > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------- the eval itself
const evalCli = (args: string[]) => spawnSync(...tsx([join(ROOT, "scripts", "eval.ts"), ...args]), { cwd: ROOT, encoding: "utf8", timeout: 170_000 });

test(
  "pnpm eval: prints the basis, the per-role budgets, the memory eval and the judge line; --cassette needs a file; --final never takes --update",
  { timeout: 240_000 },
  () => {
    const bad = evalCli(["--cassette", "/nonexistent/x.cassette.json"]);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /no such file/);
    const fin = evalCli(["--final", "--update"]);
    assert.equal(fin.status, 2);
    const only = evalCli(["--only", "dev-silence-en", "--out", join(tmpdir(), "wm-gates-eval.json")]);
    const out = only.stdout;
    assert.match(out, /Basis: SCRIPTED model replies/);
    assert.match(out, /Budgets per role \(scripted; fail at \+20 percent/);
    assert.match(out, /Memory eval \(24 invented calls/);
    assert.match(out, /controls are under their limits/);
    assert.match(out, /Model judge: needs a recorded run/);
    assert.match(out, /Cost per hour: \$/);
    const none = evalCli(["--only", "no-such-meeting"]);
    assert.equal(none.status, 2);
  },
);

// ---------------------------------------------------------------- the snapshot command
// Behaviour, not text (r3): the script runs in a temporary tree with stub overlay/dashboard snapshot scripts, so each rule is seen by its effect.
const runSnapshotCheck = (o: { overlayLines?: string[]; dashboardOk?: boolean; overlayExit?: number }) => {
  const tmp = mkdtempSync(join(tmpdir(), "wm-snapcheck-"));
  try {
    mkdirSync(join(tmp, "scripts"));
    mkdirSync(join(tmp, "overlay"));
    mkdirSync(join(tmp, "dashboard"));
    copyFileSync(join(ROOT, "scripts", "snapshot-check.sh"), join(tmp, "scripts", "snapshot-check.sh"));
    const lines = o.overlayLines ?? Array.from({ length: 12 }, (_, i) => `{"spec":"s${i}","issues":[]}`);
    writeFileSync(
      join(tmp, "overlay", "snapshot.sh"),
      `echo "$WINGMAN_OVERLAY_LANG $*" >> "${join(tmp, "calls.txt")}"\ncat <<'EOF'\n${lines.join("\n")}\nEOF\nexit ${o.overlayExit ?? 0}\n`,
    );
    writeFileSync(join(tmp, "dashboard", "snapshot.sh"), o.dashboardOk === false ? 'echo "bad contrast"\nexit 1\n' : 'echo "all 24 ok"\n');
    const r = spawnSync("sh", [join(tmp, "scripts", "snapshot-check.sh"), join(tmp, "out")], { encoding: "utf8", timeout: 30_000 });
    const calls = existsSync(join(tmp, "calls.txt")) ? readFileSync(join(tmp, "calls.txt"), "utf8") : "";
    return { status: r.status, out: r.stdout, calls };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};
test(
  "snapshot-check.sh: valid shell and executable; runs the overlay checks in en and he and the dashboard matrix",
  { skip: process.platform === "win32" && "needs sh (not on Windows)" },
  () => {
    const f = join(ROOT, "scripts", "snapshot-check.sh");
    assert.ok(existsSync(f));
    assert.ok((statSync(f).mode & 0o111) !== 0, "executable");
    assert.equal(spawnSync("sh", ["-n", f]).status, 0, "sh -n");
    const ok = runSnapshotCheck({});
    assert.equal(ok.status, 0, ok.out);
    assert.match(ok.out, /snapshot-check: ok/);
    const calls = ok.calls.trim().split("\n");
    assert.deepEqual(
      calls.map((c) => c.split(" ")[0]),
      ["en", "he"],
      "the overlay check runs once per language",
    );
    assert.ok(
      calls.every((c) => /--check v2all/.test(c)),
      "with the v2all spec set and --check",
    );
    // each failure mode ends in exit 1 and a clear line
    const issue = runSnapshotCheck({
      overlayLines: Array.from({ length: 12 }, (_, i) => `{"spec":"s${i}","issues":${i === 3 ? '["clipped"]' : "[]"}}`),
      overlayExit: 1,
    });
    assert.equal(issue.status, 1, "an overlay check that finds a problem fails the script");
    assert.match(issue.out, /overlay en: the checks found problems/);
    const failing = runSnapshotCheck({ dashboardOk: false });
    assert.equal(failing.status, 1);
    assert.match(failing.out, /dashboard: the checks found problems/);
    const few = runSnapshotCheck({ overlayLines: ['{"spec":"s1","issues":[]}'] });
    assert.equal(few.status, 1);
    assert.match(few.out, /only 1 result lines/);
    const focused = runSnapshotCheck({ overlayLines: Array.from({ length: 12 }, (_, i) => `{"spec":"s${i}","focused":${i === 5},"issues":[]}`) });
    assert.equal(focused.status, 1);
    assert.match(focused.out, /a window had focus/);
  },
);

// Why static (kept): this is a security rule about the file text, not a behaviour. A snapshot tool that steals focus is dangerous on the owner's machine.
test("snapshot-check.sh never names a command that steals focus", () => {
  assert.doesNotMatch(readFileSync(join(ROOT, "scripts", "snapshot-check.sh"), "utf8"), /osascript|open -a|activate/);
});

// ---------------------------------------------------------------- review additions
test("pnpm eval: a flag without its value is an error, not a silent scripted run", () => {
  for (const f of ["--cassette", "--only", "--out"]) {
    const r = evalCli([f]);
    assert.equal(r.status, 2, f);
    assert.match(r.stderr, /needs a value/);
  }
  assert.equal(evalCli(["--cassette", "--update"]).status, 2);
});

test(
  "cassette-record --judge: a judge call that throws does not lose the verdicts already paid for, and the run still ends with a saved file",
  { timeout: 120_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "wm-gates-j-"));
    try {
      let n = 0;
      const lines: string[] = [];
      const code = await recordMain(
        ["--suite", "dev", "--cap", "5", "--only", "dev-sales-en", "--judge"],
        {},
        {
          transport: "mock",
          log: (l) => void lines.push(l),
          dataDir: dir,
          judgeTransport: async () => {
            if (++n === 1) throw new Error("network down");
            return { text: "VERDICT: good\nREASON: ok", ms: 1 };
          },
        },
      );
      assert.equal(code, 0, lines.join("\n"));
      assert.match(lines.join("\n"), /could not be judged \(network down\)/);
      assert.match(lines.join("\n"), /1 failed/);
      assert.ok(existsSync(join(dir, "dev.judge.cassette.json")), "the file is saved even when every call failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
