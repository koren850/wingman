// Shared call controller (menu bar + window), driven by a fake child process: no electron, no real call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { ROOT } from "./env.ts";

const { createController, COMMANDS } = createRequire(import.meta.url)("../tray/controller.cjs");

function fake() {
  const spawned: any[] = [], kills: any[] = [], timers: { fn: () => void; ms: number }[] = [], notes: string[] = [];
  const spawn = (cmd: string, args: string[], opts: any) => {
    const c: any = new EventEmitter();
    c.pid = 4242; c.args = args; c.opts = opts; c.written = [] as string[];
    c.stdin = Object.assign(new EventEmitter(), { writable: true, write: (s: string) => { c.written.push(s); return true; } });
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = (sig: string) => kills.push(["child", sig]);
    c.say = (ev: string, data: object = {}) => c.stdout.emit("data", Buffer.from(`\nsome log\n@@wingman ${JSON.stringify({ ev, ...data })}\n`));
    spawned.push(c); return c;
  };
  let changes = 0;
  const ctl = createController({ spawn, root: ROOT, tmpDir: mkdtempSync(join(tmpdir(), "wm-ctl-")), setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }), kill: (pid: number, sig: string) => kills.push([pid, sig]), notify: (t: string) => notes.push(t), onChange: () => changes++, env: {} });
  return { ctl, spawned, kills, timers, notes, changes: () => changes };
}

test("start spawns call.ts in control mode and statuses drive the state", () => {
  const { ctl, spawned } = fake();
  assert.equal(ctl.start({}), true);
  assert.equal(ctl.start({}), false, "a second start while running is refused");
  const c = spawned[0];
  assert.ok(c.args[0].endsWith("call.ts")); assert.equal(c.opts.env.WINGMAN_CONTROL, "1"); assert.equal(c.opts.detached, true);
  assert.equal(ctl.getState().phase, "starting");
  c.say("waiting", { id: "01ABC" });
  assert.equal(ctl.getState().phase, "waiting"); assert.equal(ctl.getState().running, true);
  c.say("consented"); assert.equal(ctl.getState().phase, "live");
  c.say("propose", { title: "Acme" }); assert.equal(ctl.getState().proposed, "Acme");
  c.say("health", { id: "stt", level: "red", text: "Speech service down" }); assert.equal(ctl.getState().health.stt.level, "red");
  c.emit("exit", 0); assert.equal(ctl.getState().running, false); assert.equal(ctl.getState().phase, "idle");
});

test("no-ai start passes --no-ai", () => {
  const { ctl, spawned } = fake(); ctl.start({ noAi: true });
  assert.ok(spawned[0].args.includes("--no-ai"));
});

test("only the fixed commands reach stdin, and only in the right phase", () => {
  const { ctl, spawned } = fake();
  assert.equal(ctl.consent(), false, "no call yet");
  ctl.start({}); const c = spawned[0];
  assert.equal(ctl.consent(), false, "not waiting yet");
  c.say("waiting", { id: "X" });
  assert.equal(ctl.setQuiet(true), false, "quiet only while live");
  assert.equal(ctl.consent(), true);
  c.say("consented");
  assert.equal(ctl.setQuiet(true), true); assert.equal(ctl.setQuiet(false), true);
  assert.equal(ctl.confirmClient(), false, "nothing proposed");
  c.say("propose", { title: "Acme" }); assert.equal(ctl.confirmClient(), true);
  c.say("client", { title: "Acme" }); assert.equal(ctl.confirmClient(), false, "already confirmed");
  assert.equal(ctl.note("  שיחה על\nמעבר\u0007 שרת "), true);
  assert.equal(ctl.note("   "), false);
  assert.equal(ctl.note("x".repeat(1000)), true);
  assert.deepEqual(c.written, ["consent\n", "quiet on\n", "quiet off\n", "client\n", "note שיחה על מעבר שרת\n", "note " + "x".repeat(300) + "\n"]);
  for (const w of c.written) assert.ok(COMMANDS.includes(w.trim()) || /^note [^\n\r]{1,300}\n$/.test(w), "unexpected stdin: " + JSON.stringify(w));
});

test("stop sends stop, marks stopping, escalates to SIGINT then SIGKILL on a stuck call", () => {
  const { ctl, spawned, kills, timers } = fake();
  ctl.start({}); const c = spawned[0]; c.say("waiting", { id: "X" }); c.say("consented");
  assert.equal(ctl.stop(), true); assert.equal(ctl.stop(), false);
  assert.equal(c.written.at(-1), "stop\n"); assert.equal(ctl.getState().phase, "stopping");
  assert.deepEqual(timers.map((t) => t.ms), [12000, 20000]);
  timers[0].fn(); timers[1].fn();
  assert.deepEqual(kills, [[-4242, "SIGINT"], [-4242, "SIGKILL"]]);
  c.emit("exit", 0);
  timers[0].fn();   // after exit nothing more is killed
  assert.equal(kills.length, 2);
});

test("stop and delete sends stop-delete and remembers the call was deleted", () => {
  const { ctl, spawned } = fake();
  ctl.start({}); const c = spawned[0]; c.say("waiting", { id: "X" }); c.say("consented");
  ctl.stopDelete(); assert.equal(c.written.at(-1), "stop-delete\n");
  c.say("ended", { id: "X", deleted: true }); c.emit("exit", 0);
  const s = ctl.getState(); assert.equal(s.deleted, true); assert.equal(s.phase, "idle");
});

test("a finished call keeps its id and summary flag for the 'summary ready' card", () => {
  const { ctl, spawned } = fake();
  ctl.start({}); const c = spawned[0]; c.say("waiting", { id: "01CALL" }); c.say("consented"); c.say("summary", { ok: true, id: "01CALL" }); c.say("ended", { id: "01CALL", deleted: false });
  c.emit("exit", 0);
  const s = ctl.getState(); assert.equal(s.callId, "01CALL"); assert.equal(s.summaryOk, true); assert.equal(s.endedCleanly, true); assert.equal(s.deleted, false);
});

test("spawn error and crash return to idle with the error kept", () => {
  const { ctl, spawned, notes } = fake();
  ctl.start({}); spawned[0].emit("error", new Error("ENOENT tsx"));
  assert.equal(ctl.isRunning(), false); assert.equal(ctl.getState().phase, "idle"); assert.match(ctl.getState().lastError, /ENOENT/);
  assert.ok(notes.includes("Wingman could not start"));
  assert.equal(ctl.start({}), true, "can start again");
});

test("practice call uses the demo profile and scripted speech", () => {
  const { ctl, spawned } = fake();
  assert.equal(ctl.practice(), true);
  const c = spawned[0]; assert.ok(c.args.includes("--profile") && c.args.includes("demo") && c.args.includes("--file"));
  assert.ok(c.opts.env.WINGMAN_STT_SCRIPT.endsWith("demo-call.json")); assert.equal(ctl.getState().practice, true);
});

test("doctor: refused during a call, summarised otherwise", async () => {
  const { ctl, spawned } = fake();
  ctl.start({});
  const busy = await ctl.runDoctor(); assert.equal(busy.verdict, "BUSY");
  spawned[0].emit("exit", 0);
  const p = ctl.runDoctor(); const d = spawned[1];
  d.stdout.emit("data", "Wingman doctor\n  ✅ settings valid\n  ❌ DEEPGRAM_API_KEY missing (speech)\n     fix: add it to ~/.config/wingman/keys.env\n  ⚠️  only one screen: the answer window will NOT open\n     fix: connect the second screen\n\nNOT READY: DEEPGRAM_API_KEY missing\n");
  d.emit("exit", 1);
  const r = await p;
  assert.equal(r.ok, false); assert.equal(r.verdict, "NOT READY");
  assert.equal(r.failing.length, 1); assert.match(r.failing[0].text, /DEEPGRAM_API_KEY/); assert.match(r.failing[0].fix, /keys\.env/);
  assert.equal(r.warnings.length, 1);
  assert.deepEqual(ctl.getState().doctor.failing, r.failing);
});
