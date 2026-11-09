// Recording and evaluation tools: the real key survives boot, the judge set and options, the held-out locks, the pace of a recording, voices for mixed scenarios, and a mock recording that replays without a miss.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./env.ts";
import { tsx } from "./test-platform.ts";
import { checkLock } from "../qa/golden-load.ts";
import { main as recordMain, judgeCallOptions } from "../scripts/cassette-record.ts";
import { Cassette, cassettePaceOf } from "./providers/cassette.ts";
import { mergeParts } from "../qa/cassette-merge.ts";
import { gradeCase, isJudgeTag, loadJudgeSet, scoreJudge } from "../qa/judge-set.ts";
import { voiceFor } from "../qa/render.ts";
import { runMeeting } from "./e2e/v2-kit.ts";

const url = (f: string) => JSON.stringify(pathToFileURL(join(ROOT, f)).href);

// boot.ts removes the key variables at import, the real recording worker used to read the key afterwards and got undefined.
test("real recording: the worker keeps the Anthropic key it was started with, although boot.ts removes it from the environment", () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-rk-"));
  const r = spawnSync(
    ...tsx([
      "-e",
      `
    (async () => {
      const { REAL_ANTHROPIC_KEY } = await import(${url("src/testkit/real-key.ts")});
      await import(${url("src/test-setup.ts")});
      await import(${url("src/engine/boot.ts")});
      console.log(JSON.stringify({ kept: REAL_ANTHROPIC_KEY === "sk-ant-fake-for-test", env: process.env.ANTHROPIC_API_KEY ?? null }));
      process.exit(0);
    })();
  `,
    ]),
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-fake-for-test", DEEPGRAM_API_KEY: "dg-fake", WINGMAN_DATA_DIR: dir },
      timeout: 60_000,
    },
  );
  const line = (r.stdout || "").split("\n").find((l) => l.startsWith("{"));
  assert.ok(line, `no result line: ${r.stdout} ${r.stderr}`);
  assert.deepEqual(JSON.parse(line), { kept: true, env: null });
});

// eval:judge --record crashed while scoring when a verdict tag was not in the table (BANK).
test("judge set: a verdict outside the table (BANK) is a wrong answer, not a crash in the scorer", () => {
  const cases = loadJudgeSet().slice(0, 2);
  assert.equal(isJudgeTag("BANK"), false);
  const results = cases.map((c) => gradeCase(c, { tag: "BANK" as never, say: "x" }));
  assert.ok(results.every((r) => !r.ok));
  const s = scoreJudge(cases, results);
  assert.equal(s.accuracy, 0);
});

// the model judge returned an empty text because thinking used up the 80 output tokens.
test("model judge: a judge call turns thinking off and leaves room for the answer", () => {
  const o = judgeCallOptions("anthropic:claude-haiku-5-5");
  assert.deepEqual(o.providerOptions, { anthropic: { thinking: { type: "disabled" }, effort: "low" } });
  assert.ok(o.maxOutputTokens >= 100);
});

// the held-out lock files must match the meetings (cassette-record --final and eval --final stop otherwise). Hashes only, no content is read as an eval.
test("held-out splits: test.lock and test-b.lock match the meetings", () => {
  checkLock("test");
  checkLock("test-b");
});

// recording at --pace above 1 stretches the recorded model times. Refuse it, store the pace, and never let a gate read such a cassette.
test("cassette-record: the real transport refuses a pace above 1 unless --fast-ok", async () => {
  const lines: string[] = [];
  const code = await recordMain(
    ["--suite", "dev", "--cap", "1", "--pace", "4", "--only", "dev-silence-en"],
    { ANTHROPIC_API_KEY: "k" },
    { transport: "real", log: (l) => void lines.push(l) },
  );
  assert.equal(code, 2);
  assert.match(lines.join("\n"), /too long/);
});

test("cassette: the pace is stored in the file and survives a merge", () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-pace-"));
  const part = join(dir, "a.part.json"),
    out = join(dir, "a.json");
  new Cassette().save(part);
  assert.equal(cassettePaceOf(part), undefined);
  mergeParts(out, [part], 4);
  assert.equal(cassettePaceOf(out), 4);
  assert.equal(new Cassette(out).pace, 4);
});

test("eval: a cassette recorded at pace 4 is refused for --ship, --final and --update", () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-pace-e-"));
  const f = join(dir, "dev.cassette.json");
  writeFileSync(f, JSON.stringify({ v: 1, pace: 4, entries: [] }));
  const r = spawnSync(...tsx(["scripts/eval.ts", "--ship", "--cassette", f]), {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, WINGMAN_DATA_DIR: dir },
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /recorded at pace 4/);
});

// mixed-language speech tests need one voice per language.
test("qa render: a voice speaks only text in its own language; a mixed scenario gets one voice per language", () => {
  assert.equal(voiceFor("כמה זה עולה?", "them", "Samantha"), "Carmit");
  assert.equal(voiceFor("How much does it cost?", "them", "Carmit"), "Samantha");
  assert.equal(voiceFor("How much does it cost?", "me", undefined), "Daniel");
  assert.equal(voiceFor("אני אבדוק", "me", undefined), "Carmit");
  assert.equal(voiceFor("How much", "them", "Samantha"), "Samantha");
  assert.equal(voiceFor("שלום", "them", "Samantha", "Daniel"), "Daniel", "an explicit voice on the turn wins");
});

// 126 of 984 calls were missing on replay. The classifier for the user's own lines used the profile's scripted fake, so it was never recorded.
test("recording: a mock recording holds no call on the scripted fake model, and the same recording replays without a miss", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-rec-"));
  const file = join(dir, "c.json");
  await runMeeting("dev-sales-en", { split: "dev", asks: false, record: { cassette: file, transport: "mock" } }, 120_000);
  const c = new Cassette(file);
  assert.ok(c.size > 0);
  assert.deepEqual(
    c.entries().filter((e) => e.model.startsWith("scripted:")),
    [],
  );
  const again = await runMeeting("dev-sales-en", { split: "dev", asks: false, replay: { cassette: file } }, 120_000);
  assert.equal(again.cassetteMisses, 0);
});
