// Reliability: the menu-bar app. No sync dialogs, a wedged engine is killed at quit, and the control socket nits.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { join } from "node:path";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { ROOT } from "./env.ts";
import { POSIX } from "./test-platform.ts";

const req = createRequire(import.meta.url);
const { createController } = req("../tray/controller.cjs");
const { createControlServer, RATE } = req("../tray/control-socket.cjs");
const lib = req("../tray/lib.cjs");

function fake(extra: Record<string, unknown> = {}) {
  const spawned: any[] = [],
    kills: any[] = [],
    timers: { fn: () => void; ms: number }[] = [];
  const spawn = () => {
    const c: any = new EventEmitter();
    c.pid = 4242;
    c.written = [] as string[];
    c.stdin = Object.assign(new EventEmitter(), {
      writable: true,
      write: (s: string) => {
        c.written.push(s);
        return true;
      },
    });
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.kill = (sig: string) => kills.push(["child", sig]);
    c.say = (ev: string, data: object = {}) => c.stdout.emit("data", Buffer.from(`\n@@wingman ${JSON.stringify({ ev, ...data })}\n`));
    spawned.push(c);
    return c;
  };
  let clock = 1_000_000;
  const ctl = createController({
    spawn,
    root: ROOT,
    tmpDir: mkdtempSync(join(tmpdir(), "wm-r3-")),
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
    kill: (pid: number, sig: string) => kills.push([pid, sig]),
    now: () => clock,
    env: {},
    ...extra,
  });
  return { ctl, spawned, kills, timers, advance: (ms: number) => (clock += ms) };
}

// ---- quit with a wedged engine ----
test("quit: an engine asked to stop more than 3 s ago and still alive gets a synchronous SIGKILL to its group", () => {
  const { ctl, spawned, kills, advance } = fake();
  ctl.start({});
  spawned[0].say("consented", { id: "c1" });
  assert.equal(ctl.stop(), true);
  assert.deepEqual(spawned[0].written.at(-1), "stop\n");
  advance(5000); // the engine is wedged: no "ended" line, no exit
  kills.length = 0;
  ctl.shutdown(); // before-quit; the app exits right after, so no timer may be needed
  assert.deepEqual(kills, [[-4242, "SIGKILL"]]);
});

test("quit: a call that was not asked to stop yet gets the stop command first", () => {
  const { ctl, spawned, kills, advance } = fake();
  ctl.start({});
  advance(100);
  ctl.shutdown();
  assert.equal(spawned[0].written.at(-1), "stop\n");
  assert.deepEqual(kills, [], "not killed yet: it gets its time to save");
  advance(4000);
  ctl.shutdown(); // a second quit call (the app asked again): now it is wedged
  assert.deepEqual(kills, [[-4242, "SIGKILL"]]);
});

test("quit: a call that stopped 1 s ago is not killed yet", () => {
  const { ctl, spawned, kills, advance } = fake();
  ctl.start({});
  ctl.stop();
  advance(1000);
  ctl.shutdown();
  assert.deepEqual(kills, []);
  assert.ok(spawned[0].written.includes("stop\n"));
});

test("quit: a Stop from an earlier call does not make a quit kill the next call at once", () => {
  const { ctl, spawned, kills, advance } = fake();
  ctl.start({});
  ctl.stop();
  spawned[0].say("ended", { crashed: false });
  spawned[0].emit("exit", 0, null);
  advance(60_000);
  ctl.start({});
  kills.length = 0;
  ctl.shutdown();
  assert.ok(spawned[1].written.includes("stop\n"), "the new call gets the stop command and its time to save");
  assert.ok(!kills.some((k) => k[1] === "SIGKILL" && k[0] === -4242), "not killed synchronously");
});

test("quit: a lingering finished call is killed at once, not on a timer", () => {
  const { ctl, spawned, kills } = fake();
  ctl.start({});
  spawned[0].say("ended", { crashed: false });
  assert.equal(ctl.isRunning(), false);
  kills.length = 0;
  ctl.shutdown();
  assert.deepEqual(kills, [[-4242, "SIGKILL"]]);
});

// ---- dialogs ----
test("dialogs: a confirmation that never resolves does not stop the controller from reading engine lines", async () => {
  const { ctl, spawned } = fake();
  ctl.start({});
  const never = new Promise(() => {});
  let opened = 0;
  const dialog = {
    showMessageBox: () => {
      opened++;
      return never;
    },
    showMessageBoxSync: () => {
      throw new Error("a sync dialog blocks the main process");
    },
  };
  void lib.confirmStopDelete({ dialog, stopDelete: () => {} }); // the user walks away from the dialog
  void lib.requestQuit({ isRunning: () => true, dialog, stop: () => {}, quit: () => {}, whenStopped: async () => true });
  assert.equal(opened, 2);
  // the event loop is free: engine output is still consumed and changes the state
  spawned[0].say("consented", { id: "c9" });
  assert.equal(ctl.getState().phase, "live");
  spawned[0].say("card", {});
  assert.equal(ctl.getState().callId, "c9");
});

test("dialogs: no showMessageBoxSync call is left in tray/ or dashboard/", () => {
  const files = [
    ...readdirSync(join(ROOT, "tray")).map((f) => join(ROOT, "tray", f)),
    ...readdirSync(join(ROOT, "dashboard")).map((f) => join(ROOT, "dashboard", f)),
  ];
  const hits = files.filter((f) => /\.(cjs|js|mjs)$/.test(f) && statSync(f).isFile() && /showMessageBoxSync\s*\(/.test(readFileSync(f, "utf8")));
  assert.deepEqual(hits, []);
});

// ---- control socket ----
function server(opts: { startOk?: () => boolean } = {}) {
  let t = 10_000_000;
  const started: string[] = [];
  const ctl: any = {
    getState: () => ({ running: false, phase: "idle" }),
    isRunning: () => false,
    start: () => {
      started.push("start");
      return opts.startOk ? opts.startOk() : true;
    },
  };
  const s = createControlServer({
    controller: ctl,
    lib,
    socketPath: join(mkdtempSync(join(tmpdir(), "wm-sock-")), "c.sock"),
    now: () => t,
    askCliStart: async () => false,
    info: () => ({}),
  });
  const send = (cmd: string) => s.handle(JSON.stringify({ v: 1, cmd, args: { quick: true } }));
  return { s, send, started, tick: (ms: number) => (t += ms) };
}

test("control socket: a start the app refuses does not use up the rate budget", async () => {
  let ok = false;
  const { send, tick, started } = server({ startOk: () => ok });
  for (let i = 0; i < RATE.perMinute + 3; i++) {
    const r = await send("start");
    assert.equal(r.ok, false);
    assert.notEqual(r.code, "rate_limited", `refused start ${i} must not be rate limited`);
    tick(RATE.minGapMs + 1);
  }
  ok = true;
  assert.equal((await send("start")).ok, true, "a real start still works after many refused ones");
  assert.ok(started.length > RATE.perMinute);
});

test("control socket: accepted starts are still limited", async () => {
  const { send, tick } = server();
  assert.equal((await send("start")).ok, true);
  const fast = await send("start");
  assert.equal(fast.code, "rate_limited", "too fast");
  tick(RATE.minGapMs + 1);
  assert.equal((await send("start")).ok, true);
});

test("control socket: listening does not change the process umask, and the socket ends up 600", { skip: !POSIX }, async () => {
  const before = process.umask();
  const { s } = server();
  const p = s.start();
  const during = process.umask();
  const path = await p;
  assert.equal(during, before, "umask untouched while the server starts");
  assert.equal(process.umask(), before);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  await s.stop();
});
