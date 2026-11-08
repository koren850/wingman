// Engine e2e (real src/run.ts as a child, scripted STT and AI, no network): a failing model never leaves an empty screen.
//   an ask by the user + a model error (529)  -> a card with the "could not get an answer" text, and the "AI not answering" bar at once
//   a question from the other side + an error (network, 529, 429)  -> the "buy time" line before reflex.stallAfterMs (1.8 s), the bar after 2 failures
//   one final with several questions          -> every part gets its own model answer
// Run alone: ./node_modules/.bin/tsx --import ./src/test-setup.ts --test src/e2e/model-failure.test.ts
import "../test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeWav } from "../audio.ts";
import { ht } from "../htext.ts";
import { sleep, scriptFile, readRows, callDir, runEngine, Q, stopSoon } from "./helpers.ts";

async function run(script: unknown[], env: Record<string, string>, opts: { ask?: boolean; secs?: number; en?: boolean } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "wm-r1-"));
  const calls = join(tmp, "calls");
  mkdirSync(calls);
  const wav = join(tmp, "s.wav");
  await writeWav(wav, Buffer.alloc(16000 * 2 * 2 * (opts.secs ?? 8)), 2);
  const settings = join(tmp, "user.yaml");
  writeFileSync(settings, `ui:\n  language: ${opts.en ? "en" : "he"}\nreflex:\n  stall: true\n`); // the generic stall line is off by default
  const e = runEngine(["--file", wav], {
    WINGMAN_CALLS_DIR: calls,
    WINGMAN_USER_SETTINGS: settings,
    WINGMAN_CONTROL: "1",
    WINGMAN_STT_SCRIPT: scriptFile(tmp, script),
    ...env,
  });
  if (opts.ask) {
    await sleep(2500);
    e.p.stdin?.write("ask\n");
  }
  const code = await e.done;
  assert.equal(code, 0, e.out());
  const dir = callDir(calls);
  return { cards: readRows(dir, "cards.jsonl"), events: readRows(dir, "events.jsonl"), lat: readRows(dir, "latency.jsonl"), out: e.out() };
}

test("e2e: an ask by the user and a model error (529) shows a card and raises the bar at once", { timeout: 60_000 }, async () => {
  const r = await run([Q("me", "what is the difference between a CDN and DNS", 4500)], { WINGMAN_LLM_FAIL: "1:529" }, { ask: true, en: true });
  const card = r.cards.find((c) => c.type === "card" && c.badge === "me" && !c.withdraw);
  assert.ok(card, "a card for the failed ask\n" + r.out);
  // the ask falls back to the notes when the model fails (ask and digest package); with nothing to quote it says the plain error
  assert.ok(card.say === ht("en", "ask.error") || card.say.startsWith(ht("en", "ask.offline")), card.say);
  const bar = r.events.find((x) => x.type === "health" && x.id === "ai" && x.level === "amber");
  assert.ok(bar, "bar after the first failure of an ask");
  assert.ok(r.events.some((x) => x.type === "me.decision" && x.why === "forced-error"));
});

for (const [name, fail] of [
  ["network error", "1:net"],
  ["5xx", "1:503"],
  ["rate limit (429)", "1:429"],
] as const) {
  test(`e2e: a question from the other side and a ${name} shows the buy-time line before the stall timer`, { timeout: 60_000 }, async () => {
    const r = await run([Q("them", "אתם עושים גם אתרים בוורדפרס לעסקים קטנים?", 1500)], { WINGMAN_LLM_FAIL: fail });
    const err = r.events.find((x) => x.type === "reflex.error");
    assert.ok(err, "the model error is logged\n" + r.out);
    const stall = r.cards.find((c) => c.type === "card" && c.badge === "stall" && !c.withdraw);
    assert.ok(stall, "a stall card\n" + r.out);
    const lat = r.lat.find((x) => x.turnId === stall.turnId);
    assert.ok(lat?.stallAt, "stallAt recorded");
    assert.ok(lat.stallAt - lat.speechEnd < 1800, `stall line after ${lat.stallAt - lat.speechEnd} ms`);
    assert.ok(!r.events.some((x) => x.type === "health" && x.id === "ai"), "one failure from the other side's question: no bar yet");
  });
}

test("e2e: one final with several questions gives every part its own model answer", { timeout: 60_000 }, async () => {
  const r = await run([Q("them", "יש לכם גיבוי כמה זה עולה האתר איטי מה עושים", 1500)], {});
  const multi = r.events.find((x) => x.type === "split.multi");
  assert.ok(multi && multi.parts.length >= 2, "the final is split\n" + JSON.stringify(r.events.filter((x) => /split|detect/.test(x.type))));
  const raw = new Set(r.events.filter((x) => x.type === "reflex.raw").map((x) => x.turnId));
  assert.equal(raw.size, multi.parts.length, `a model answer per part: ${[...raw]}`);
});

test("e2e: a black-hole open times out at 8 s, retries, and the 30 s start-anyway path runs (red bar, call goes on)", { timeout: 90_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "wm-r1-hole-"));
  const calls = join(tmp, "calls");
  mkdirSync(calls);
  const wav = join(tmp, "s.wav");
  await writeWav(wav, Buffer.alloc(16000 * 2 * 2 * 4), 2);
  const e = runEngine(["--file", wav], {
    WINGMAN_CALLS_DIR: calls,
    WINGMAN_STT_HANG: "them",
    WINGMAN_STT_SCRIPT: scriptFile(tmp, [Q("them", "hello", 500)]),
  });
  const code = await stopSoon(e, 50_000);
  assert.equal(code, 0, e.out());
  const ev = readRows(callDir(calls), "events.jsonl");
  const retries = ev.filter((x) => x.type === "stt.open.retry" && x.ch === "them");
  assert.ok(retries.length >= 3 && retries.every((x) => x.kind === "timeout"), "open attempts time out: " + JSON.stringify(retries));
  assert.ok(
    ev.some((x) => x.type === "health" && x.id === "stt-them" && x.level === "red"),
    "the red bar of the start-anyway path\n" + e.out(),
  );
  assert.ok(
    ev.some((x) => x.type === "stt.open.retry" && x.ch === "them" && x.n >= 4),
    "the engine went on after 30 s and the retry loop took over",
  );
});

test("e2e: a crash with two slow sources still writes call.json with phase ended", { timeout: 60_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "wm-r1-crash-"));
  const calls = join(tmp, "calls");
  mkdirSync(calls);
  const wav = join(tmp, "s.wav");
  await writeWav(wav, Buffer.alloc(16000 * 2 * 2 * 20), 2);
  const e = runEngine(["--file", wav], {
    WINGMAN_CALLS_DIR: calls,
    WINGMAN_STT_SCRIPT: scriptFile(tmp, [Q("them", "hello", 500)]),
    WINGMAN_TEST_SLOW_STOPS: "2x3000", // two sources that need 3 s each to stop: 6 s one after the other
    WINGMAN_TEST_CRASH_MS: "4000",
  });
  const code = await e.done;
  assert.equal(code, 1, "a crash exits with 1\n" + e.out());
  const call = JSON.parse(readFileSync(join(callDir(calls), "call.json"), "utf8"));
  assert.equal(call.phase, "ended", "call.json reached ended\n" + e.out());
  assert.equal(call.crashed, true);
});
