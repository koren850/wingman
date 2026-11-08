// The judgement set (qa/judge-set.ts) and its command (scripts/eval-judge.ts): the set is valid, the labels are honest, the controls fall under their limits,
// scoring is right, and recording works with a mock transport only. Offline.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JUDGE_CONTROL_LIMITS,
  JUDGE_FLOORS,
  JUDGE_TAGS,
  controlBreaches,
  floorBreaches,
  formatJudge,
  gradeCase,
  judgeContext,
  loadJudgeSet,
  replyFor,
  runJudgeSet,
  scoreJudge,
  validateJudgeCase,
  validateJudgeSet,
} from "../qa/judge-set.ts";
import { denylistHits } from "../qa/denylist.ts";
import { main, estimateRecord } from "../scripts/eval-judge.ts";
import { Cassette } from "./providers/cassette.ts";

const cases = loadJudgeSet();

test("judgement set: 120 cases, 60 English and 60 Hebrew, every verdict in both, schema valid, invented data only", () => {
  assert.equal(cases.length, 120);
  assert.deepEqual(validateJudgeSet(cases), []);
  for (const l of ["en", "he"] as const) {
    const mine = cases.filter((c) => c.lang === l);
    assert.equal(mine.length, 60);
    for (const t of JUDGE_TAGS)
      assert.ok(
        mine.some((c) => c.expected.tag === t),
        `${l} has a ${t} case`,
      );
    assert.ok(mine.filter((c) => c.tags.includes("noq")).length >= 3, `${l}: cards for lines with no question mark`);
    assert.ok(mine.filter((c) => c.tags.includes("noisy")).length >= 3, `${l}: noisy speech-to-text`);
    assert.ok(mine.filter((c) => c.tags.includes("mixed")).length >= 3, `${l}: mixed languages`);
    assert.ok(mine.filter((c) => c.expected.tag === "SKIP").length / 60 <= 0.4, `${l}: silence is the normal answer but not the only one`);
  }
  assert.ok(cases.every((c) => c.lines.length >= 1 && c.lines.length <= 6));
  for (const c of cases) assert.deepEqual(denylistHits(JSON.stringify(c)), [], c.id);
});

test("validateJudgeCase finds a fact that is not in the case, a SKIP with a required word and a wrong language", () => {
  const ans = structuredClone(cases.find((c) => c.expected.tag === "ANS" && c.lang === "en")!);
  ans.expected.mustMention = ["zebra"];
  assert.ok(validateJudgeCase(ans).some((p) => p.includes("zebra")));
  const skip = structuredClone(cases.find((c) => c.expected.tag === "SKIP" && c.lang === "en")!);
  skip.expected.mustMention = ["x"];
  assert.ok(validateJudgeCase(skip).some((p) => p.includes("SKIP has no card text")));
  const he = structuredClone(cases.find((c) => c.lang === "he")!);
  he.id = he.id.replace("-he-", "-en-");
  he.lang = "en";
  assert.ok(validateJudgeCase(he).length > 0);
  const named = structuredClone(ans);
  named.lines[0].text = "Write to me at someone@example.com";
  assert.ok(validateJudgeCase(named).some((p) => p.startsWith("denylist")));
});

test("the context of a case is the real moment context: memory block, last lines, the trigger", () => {
  const c = cases.find((x) => x.expected.tag === "CHECK" && x.lang === "en")!;
  const ctx = judgeContext(c);
  const sys = ctx.system.map((b) => b.text).join("\n");
  assert.match(sys, /You are Wingman, a private voice/);
  assert.ok(ctx.messages[0].content.includes(c.lines.at(-1)!.text));
  assert.ok(
    ctx.system.some((b) => b.name === "memory"),
    "the memory block is there",
  );
  assert.ok(sys.includes("1200") || ctx.messages[0].content.includes("1200") || JSON.stringify(c.memory).includes(String(c.expected.mustMention?.[0])));
});

test("grading: the verdict, an accepted second verdict, and the required words", () => {
  const ans = cases.find((c) => c.expected.tag === "ANS" && c.expected.accept?.includes("REPLY"))!;
  const need = ans.expected.mustMention![0];
  assert.equal(gradeCase(ans, { tag: "ANS", say: `It is ${need}.` }).ok, true);
  assert.equal(gradeCase(ans, { tag: "ANS", say: "I do not know" }).ok, false, "right kind, missing fact");
  assert.equal(gradeCase(ans, { tag: "ANS", say: "I do not know" }).sayMiss, true);
  assert.equal(gradeCase(ans, { tag: "REPLY", say: "anything" }).ok, true, "accepted second verdict");
  assert.equal(gradeCase(ans, { tag: "SKIP", say: "" }).ok, false);
  assert.equal(gradeCase(ans, { tag: "ERROR", say: "", error: "x" }).ok, false);
});

test("controls: always-SKIP and always-ANS fall under the limits, and a lenient grader would be caught", async () => {
  for (const mode of ["always-skip", "always-ans"] as const) {
    const r = await runJudgeSet({ mode });
    console.log(formatJudge(r));
    assert.deepEqual(controlBreaches(mode, r.score), [], mode);
    assert.ok(r.score.accuracy <= JUDGE_CONTROL_LIMITS.accuracyMax && r.score.macroF1 <= JUDGE_CONTROL_LIMITS.macroF1Max);
  }
  // a set where silence is right for most cases would let always-SKIP through; the check fires
  const skippy = cases.map((c) => ({ ...c, expected: { tag: "SKIP" as const } }));
  const r = await runJudgeSet({ mode: "always-skip", cases: skippy });
  assert.ok(controlBreaches("always-skip", r.score).length >= 2);
  assert.deepEqual(controlBreaches("fake", r.score), [], "only controls are held to control limits");
});

test("fake model through the real moment role: per-kind precision, recall and F1 print; no noise is perfect; the same seed is the same table", async () => {
  const clean = await runJudgeSet({ mode: "fake", noise: 0 });
  assert.equal(clean.score.accuracy, 1);
  assert.equal(clean.score.errors, 0);
  const noisy = await runJudgeSet({ mode: "fake", noise: 0.3, seed: 3 });
  assert.ok(noisy.score.accuracy < 0.9 && noisy.score.accuracy > 0.4);
  const again = await runJudgeSet({ mode: "fake", noise: 0.3, seed: 3 });
  assert.deepEqual(again.score, noisy.score);
  const text = formatJudge(noisy);
  for (const t of JUDGE_TAGS) assert.match(text, new RegExp(`^${t}\\s+n\\s+\\d+\\s+precision\\s+\\d+%\\s+recall\\s+\\d+%\\s+F1\\s+\\d+%`, "m"), t);
  assert.match(text, /English\s+\d+% \(60\)\s+Hebrew\s+\d+% \(60\)/);
  assert.match(text, /noisy\s+\d+%/);
});

test("floors hold a recorded run only", async () => {
  const bad = await runJudgeSet({ mode: "fake", noise: 0.8, seed: 2 });
  assert.deepEqual(floorBreaches("fake", bad.score), []);
  assert.ok(floorBreaches("model", bad.score).length >= 3);
  const good = await runJudgeSet({ mode: "fake", noise: 0 });
  assert.deepEqual(floorBreaches("model", good.score), []);
  assert.ok(JUDGE_FLOORS.accuracy > JUDGE_CONTROL_LIMITS.accuracyMax, "a recorded run has to beat what a control can reach");
});

test("scoreJudge counts an accepted verdict as the gold one and errors as wrong", () => {
  const two = cases
    .filter((c) => c.expected.accept?.length)
    .slice(0, 1)
    .concat(cases.filter((c) => c.expected.tag === "SKIP").slice(0, 1));
  const acc = two[0].expected.accept![0];
  const results = [gradeCase(two[0], { tag: acc, say: replyFor(acc, "") }), gradeCase(two[1], { tag: "ERROR", say: "" })];
  const s = scoreJudge(two, results);
  assert.equal(s.accuracy, 0.5);
  assert.equal(s.errors, 1);
  assert.equal(s.byKind[acc].tp >= 1, true);
});

test("eval-judge: all modes pass offline and print the table; a bad flag is refused", async () => {
  const out: string[] = [];
  assert.equal(await main([], {}, { transport: "mock", log: (l) => out.push(l) }), 0);
  assert.match(out.join("\n"), /mode always-skip[\s\S]*mode always-ans[\s\S]*mode fake[\s\S]*controls are under their limits/);
  assert.equal(await main(["--limit", "0"], {}, { transport: "mock", log: () => {} }), 2);
});

test("eval-judge --record: refuses in CI and without a key and a cap; records with a mock transport; then the replay reads it, and a changed prompt is reported as stale", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wingman-judge-"));
  try {
    const out = join(dir, "judge.cassette.json");
    const sub = cases.filter((_, i) => i % 10 === 3); // a spread: every verdict kind is in it
    const logs: string[] = [];
    const run = (argv: string[], env: NodeJS.ProcessEnv, transport: "mock" | "real" = "mock") =>
      main(argv, env, { transport, log: (l) => logs.push(l), cases: sub });
    assert.equal(await run(["--record", "--cap", "1", "--out", out], { CI: "true" }), 2);
    assert.equal(await run(["--record", "--cap", "1", "--out", out], { GITHUB_ACTIONS: "true" }), 2);
    assert.equal(await run(["--record", "--cap", "1", "--out", out], {}, "real"), 2, "no key");
    assert.equal(await run(["--record", "--out", out], {}), 2, "no cap");
    assert.equal(await run(["--record", "--cap", "0.000001", "--out", out], {}), 2, "estimate above the cap");
    assert.ok(!existsSync(out), "nothing was written by a refusal");
    assert.ok(estimateRecord(cases).usd < 0.5, "the whole recording is cheap");
    logs.length = 0;
    assert.equal(await run(["--record", "--cap", "1", "--out", out], {}), 0);
    assert.match(logs.join("\n"), /Judgement set recording: estimate/);
    assert.match(logs.join("\n"), /Recorded 12 of 12 cases/);
    assert.equal(new Cassette(out).size, 12);
    // replay: every case is found
    logs.length = 0;
    const rc = await run(["--mode", "model", "--cassette", out], {});
    assert.ok(rc === 0 || rc === 1, "floors may or may not hold on 12 cases");
    assert.doesNotMatch(logs.join("\n"), /STALE|no recorded answer/);
    assert.match(logs.join("\n"), /mode model, 12 cases/);
    // a prompt change: same cases, other prompt text (simulate by rewriting the system text of every stored entry)
    const c = new Cassette(out);
    for (const e of c.entries()) {
      e.request.system = e.request.system + "\nold line";
      e.promptHash = undefined;
      c.put(e);
    }
    // keys are hashes of the old text, so the entries no longer match the current prompt; the input hash still does
    const edited = new Cassette();
    for (const e of c.entries()) edited.put({ ...e, key: e.key + "x" });
    edited.save(join(dir, "old.cassette.json"));
    logs.length = 0;
    await run(["--mode", "model", "--cassette", join(dir, "old.cassette.json")], {});
    assert.match(logs.join("\n"), /12 case\(s\) STALL|12 case\(s\) STALE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the memory command: record with a mock transport, then replay
import { main as memoryMain, estimateRecord as memoryEstimate } from "../scripts/eval-memory.ts";
import { loadCases } from "../qa/memory-eval.ts";

test("eval-memory --record: refusals, then a mock recording, then the replay scores it from the cassette", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wingman-memrec-"));
  try {
    const out = join(dir, "memory.cassette.json");
    const sub = loadCases().filter((c) => ["mem-en-1", "mem-he-7", "mem-en-10"].includes(c.id));
    const logs: string[] = [];
    const run = (argv: string[], env: NodeJS.ProcessEnv, transport: "mock" | "real" = "mock") =>
      memoryMain(argv, env, { transport, log: (l) => logs.push(l), cases: sub });
    assert.equal(await run(["--record", "--cap", "1", "--cassette", out], { CI: "1" }), 2);
    assert.equal(await run(["--record", "--cap", "1", "--cassette", out], {}, "real"), 2, "no key");
    assert.equal(await run(["--record", "--cassette", out], {}), 2, "no cap");
    assert.equal(await run(["--record", "--cap", "0.0000001", "--cassette", out], {}), 2, "estimate above the cap");
    assert.ok(!existsSync(out));
    assert.ok(memoryEstimate(loadCases()).usd < 0.5, "24 calls are cheap");
    logs.length = 0;
    const report = { spentUsd: 0, stopped: false, cassette: "", calls: 0 };
    const code = await memoryMain(
      ["--record", "--cap", "1", "--cassette", out, "--noise", "0"],
      {},
      { transport: "mock", log: (l) => logs.push(l), cases: sub, report },
    );
    assert.ok(code === 0 || code === 1, "the floors may or may not hold on 3 calls; the recording worked");
    assert.match(logs.join("\n"), /Memory recording: estimate/);
    assert.match(logs.join("\n"), /Recorded 3 of 3 calls/);
    assert.equal(report.calls, 3);
    assert.ok(new Cassette(out).size >= 6, "memory and compact calls are in the file");
    assert.match(logs.join("\n"), /memory eval, mode model, 3 calls/);
    // the replay alone reads it back
    logs.length = 0;
    await memoryMain(["--mode", "model", "--cassette", out], {}, { transport: "mock", log: (l) => logs.push(l), cases: sub });
    assert.match(logs.join("\n"), /mode model, 3 calls/);
    assert.equal(await memoryMain(["--mode", "model", "--cassette", join(dir, "none.json")], {}, { transport: "mock", log: () => {}, cases: sub }), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
