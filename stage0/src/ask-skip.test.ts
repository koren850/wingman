// Ask countdown (pure parts, tray text, controller state) and "Skip summary" (controller commands, run.ts wiring, summary abort, dashboard helpers).
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./env.ts";
import { runSummary } from "./summary.ts";
import { ModelRegistry } from "./providers/llm.ts";
import { CostMeter } from "./cost.ts";
import { loadSettings } from "./settings.ts";

const req = createRequire(import.meta.url);
const ask = req("../shared/ask.js");
const trayLib = req("../tray/lib.cjs");
const HL = req("../dashboard/homelib.js");
const { createController } = req("../tray/controller.cjs");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

test("askSecondsLeft / askClock: whole seconds rounded up, nothing when not armed or already past", () => {
  const now = 1_000_000;
  assert.equal(ask.askSecondsLeft(now + 8000, now), 8);
  assert.equal(ask.askSecondsLeft(now + 7001, now), 8);
  assert.equal(ask.askSecondsLeft(now + 1, now), 1);
  for (const u of [0, now, now - 5, undefined, null, "x", NaN]) assert.equal(ask.askSecondsLeft(u, now), null);
  assert.equal(ask.askClock(now + 42_000, now), "42 s");
  assert.equal(ask.askClock(now + 65_000, now), "1:05");
  assert.equal(ask.askClock(0, now), null);
});

test("tray reducer keeps the real armed deadline and drops it on disarm, stop and exit", () => {
  let s = trayLib.reduce(trayLib.initialState(), { ev: "consented" });
  s = trayLib.reduce(s, { ev: "ask", on: true, until: 123456 });
  assert.equal(s.askArmed, true); assert.equal(s.askUntil, 123456);
  assert.equal(trayLib.reduce(s, { ev: "ask", on: false }).askUntil, 0);
  assert.equal(trayLib.reduce(s, { ev: "stopping" }).askUntil, 0);
  assert.equal(trayLib.reduce(s, { ev: "exit", code: 0 }).askUntil, 0);
});

test("tray status, title and menu key show the seconds left while armed, and only then", () => {
  const now = 10_000_000;
  let s = trayLib.reduce(trayLib.initialState(), { ev: "consented" }); s = { ...s, liveAt: now - 5000 };
  const idle = trayLib.view(s, now);
  assert.doesNotMatch(idle.statusLine, /question/);
  const armed = { ...s, askArmed: true, askUntil: now + 9000 };
  const v = trayLib.view(armed, now);
  assert.match(v.statusLine, /^Listening for your question · 9 s left/);
  assert.match(v.title, /ask 9s/);
  assert.match(trayLib.view(armed, now + 4000).statusLine, /5 s left/);
  assert.notEqual(trayLib.menuKey(armed, true, now), trayLib.menuKey(armed, true, now + 1000), "menu rebuilds each second while armed");
  assert.equal(trayLib.menuKey(s, true, now), trayLib.menuKey(s, true, now + 1000), "and not otherwise");
  // past the window (grace period): still listening, no number
  assert.match(trayLib.view(armed, now + 20_000).statusLine, /^Listening for your question · Listening/);
});

function fakeSpawn() {
  const spawned: any[] = [];
  const spawnFn = () => {
    const c: any = new EventEmitter(); c.pid = 4243; c.written = [] as string[];
    c.stdin = Object.assign(new EventEmitter(), { writable: true, write: (s: string) => { c.written.push(s); return true; } });
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {};
    c.say = (ev: string, data: object = {}) => c.stdout.emit("data", Buffer.from(`\n@@wingman ${JSON.stringify({ ev, ...data })}\n`));
    spawned.push(c); return c;
  };
  return { spawnFn, spawned };
}
const rig = () => { const f = fakeSpawn(); const ctl = createController({ spawn: f.spawnFn, root: ROOT, tmpDir: tmpdir(), setTimeout: () => 0, kill: () => {}, logPath: "" }); return { ...f, ctl }; };

test("controller: skipSummary only while the summary is being written; sends the fixed command once", () => {
  const { ctl, spawned } = rig();
  assert.equal(ctl.skipSummary(), false, "no call");
  ctl.start({}); const c = spawned[0]; c.say("consented", { id: "S1" });
  assert.equal(ctl.skipSummary(), false, "live call: nothing to skip");
  assert.equal(ctl.stop(), true); assert.deepEqual(c.written, ["stop\n"]);
  c.say("stopphase", { phase: "saving" });
  c.say("stopphase", { phase: "summary" });
  assert.equal(ctl.skipSummary(), true);
  assert.deepEqual(c.written, ["stop\n", "skip-summary\n"]);
  assert.equal(ctl.getState().summarySkipped, true);
  assert.equal(ctl.skipSummary(), false, "not twice");
});

test("controller: stopNoSummary sends stop-no-summary, never plain stop, and marks the summary skipped", () => {
  const { ctl, spawned } = rig();
  ctl.start({}); const c = spawned[0]; c.say("consented", { id: "S2" });
  assert.equal(ctl.stopNoSummary(), true);
  assert.deepEqual(c.written, ["stop-no-summary\n"]);
  assert.equal(ctl.getState().summarySkipped, true); assert.equal(ctl.getState().phase, "stopping");
  assert.equal(ctl.stopNoSummary(), false, "already stopping");
});

test("a skipped summary gives no 'No call summary' notification", () => {
  const s0 = trayLib.initialState();
  assert.equal(trayLib.notifications(s0, s0, { ev: "summary", ok: false, skipped: true }).length, 0);
  assert.equal(trayLib.notifications(s0, s0, { ev: "summary", ok: false }).length, 1);
});

test("run.ts: fixed stdin commands stop-no-summary and skip-summary, abort signal passed to the summary call", () => {
  const t = read("src/run.ts");
  assert.match(t, /cmd === "stop-no-summary"\) \{ skipSummaryNow\(\); void shutdown\(\); \}/);
  assert.match(t, /cmd === "skip-summary"\) \{ if \(shuttingDown\) skipSummaryNow\(\); \}/);
  assert.match(t, /signal: summaryAbort\.signal/);
  assert.match(t, /Promise\.race\(\[postCallSummary\(\), summarySkipWait,/);
  assert.match(t, /reason: "user"/);
  assert.match(read("tray/controller.cjs"), /COMMANDS = Object\.freeze\(\[[^\]]*"stop-no-summary", "skip-summary"\]/);
});

test("runSummary: aborted by Skip summary writes no summary.json and no error row", async () => {
  const S = loadSettings({ env: {}, userFile: "/nonexistent/x.yaml" }).settings;
  const dir = mkdtempSync(join(tmpdir(), "wingman-skip-")); const rows: any[] = []; const ac = new AbortController();
  const words = Array.from({ length: 200 }, (_, i) => `מילה${i}`).join(" ");
  const generate: any = async () => { ac.abort(); throw new Error("aborted"); };
  try {
    const r = await runSummary({ dir, callId: "C9", S: { ...S, summary: { ...S.summary, model: "anthropic:claude-haiku-5-5" } }, registry: { resolve: async () => ({}) } as any, cost: new CostMeter(S.budget.prices, S.budget), data: { lines: [{ ch: "them", text: words }], contextNotes: [], aiNotes: [] }, write: (s, row) => rows.push({ s, ...row }), generate, signal: ac.signal });
    assert.equal(r.ok, false); assert.equal(r.skipped, "user");
    assert.equal(existsSync(join(dir, "summary.json")), false);
    assert.ok(!rows.some((x) => x.type === "summary.error"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("main window helpers: stop steps say Summary skipped, the Skip control only shows during the summary, ask strip has the countdown", () => {
  const stop = { phase: "stopping", stopPhase: "summary" };
  assert.equal(HL.canSkipSummary(stop), true);
  assert.equal(HL.canSkipSummary({ ...stop, stopPhase: "saving" }), false);
  assert.equal(HL.canSkipSummary({ ...stop, summarySkipped: true }), false);
  assert.equal(HL.canSkipSummary({ ...stop, summaryOk: true }), false);
  assert.equal(HL.canSkipSummary({ phase: "live" }), false);
  assert.equal(HL.stopSteps(stop)[2].label, "Writing the summary");
  const sk = HL.stopSteps({ ...stop, summarySkipped: true })[2];
  assert.deepEqual([sk.label, sk.state], ["Summary skipped", "done"]);
  const now = 5_000_000;
  assert.equal(HL.askStatus({ askArmed: true, askUntil: now + 7000 }, now), "Listening for your question. Say it now. 7 s left");
  assert.equal(HL.askStatus({ askArmed: true, askUntil: 0 }, now), "Listening for your question. Say it now.");
  assert.equal(HL.askStatus({ askArmed: false, askUntil: now + 7000 }, now), "");
});

test("pages wired: Skip summary button + fixed IPC, Write summary in Calls, countdown in the answer window", () => {
  assert.match(read("dashboard/home.js"), /btn\("Skip summary", \{ id: "skip-summary"/);
  assert.match(read("dashboard/preload.cjs"), /skipSummary: \(\) => ipcRenderer\.invoke\("call:cmd", "skipSummary"\)/);
  assert.match(read("dashboard/window.cjs"), /case "skipSummary": return \{ ok: controller\.skipSummary\(\) \}/);
  assert.match(read("dashboard/app.js"), /btn\("Write summary"/);
  assert.match(read("dashboard/window.cjs"), /handle\("calls:writeSummary"/);
  assert.match(read("overlay/app.js"), /WingmanAsk\.askSecondsLeft/);
  assert.match(read("overlay/index.html"), /src="\.\.\/shared\/ask\.js"/);
  assert.match(read("dashboard/index.html"), /src="\.\.\/shared\/ask\.js"/);
});
