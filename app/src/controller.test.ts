// Shared call controller (tray/controller.cjs, used by menu bar + window), driven by a fake child process: no electron, no real call.
// fake() also injects spawn, kill and timer doubles so state changes run synchronously.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { ROOT } from "./env.ts";

const { createController, COMMANDS } = createRequire(import.meta.url)("../tray/controller.cjs");

function fake(extra: Record<string, unknown> = {}) {
  const spawned: any[] = [],
    kills: any[] = [],
    timers: { fn: () => void; ms: number }[] = [],
    notes: string[] = [];
  const spawn = (cmd: string, args: string[], opts: any) => {
    const c: any = new EventEmitter();
    c.pid = 4242;
    c.args = args;
    c.opts = opts;
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
    c.say = (ev: string, data: object = {}) => c.stdout.emit("data", Buffer.from(`\nsome log\n@@wingman ${JSON.stringify({ ev, ...data })}\n`));
    spawned.push(c);
    return c;
  };
  let changes = 0;
  const ctl = createController({
    spawn,
    root: ROOT,
    tmpDir: mkdtempSync(join(tmpdir(), "wm-ctl-")),
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
    kill: (pid: number, sig: string) => kills.push([pid, sig]),
    notify: (t: string) => notes.push(t),
    onChange: () => changes++,
    env: {},
    ...extra,
  });
  return { ctl, spawned, kills, timers, notes, changes: () => changes };
}

test("start spawns call.ts in control mode and statuses drive the state", () => {
  const { ctl, spawned } = fake();
  assert.equal(ctl.start({}), true);
  assert.equal(ctl.start({}), false, "a second start while running is refused");
  const c = spawned[0];
  // On Windows the command is node + the tsx CLI, so call.ts is the second argument.
  assert.ok(c.args[process.platform === "win32" ? 1 : 0].endsWith("call.ts"));
  assert.equal(c.opts.env.WINGMAN_CONTROL, "1");
  assert.equal(c.opts.detached, true);
  assert.equal(ctl.getState().phase, "starting");
  c.say("waiting", { id: "01ABC" });
  assert.equal(ctl.getState().phase, "waiting");
  assert.equal(ctl.getState().running, true);
  c.say("consented");
  assert.equal(ctl.getState().phase, "live");
  c.say("propose", { title: "Acme" });
  assert.equal(ctl.getState().proposed, "Acme");
  c.say("health", { id: "stt", level: "red", text: "Speech service down" });
  assert.equal(ctl.getState().health.stt.level, "red");
  c.emit("exit", 0);
  assert.equal(ctl.getState().running, false);
  assert.equal(ctl.getState().phase, "idle");
});

test("no-ai start passes --no-ai", () => {
  const { ctl, spawned } = fake();
  ctl.start({ noAi: true });
  assert.ok(spawned[0].args.includes("--no-ai"));
});

test("only the fixed commands reach stdin, and only in the right phase", () => {
  const { ctl, spawned } = fake();
  assert.equal(ctl.consent(), false, "no call yet");
  ctl.start({});
  const c = spawned[0];
  assert.equal(ctl.consent(), false, "not waiting yet");
  c.say("waiting", { id: "X" });
  assert.equal(ctl.setQuiet(true), false, "quiet only while live");
  assert.equal(ctl.consent(), true);
  c.say("consented");
  assert.equal(ctl.setQuiet(true), true);
  assert.equal(ctl.setQuiet(false), true);
  assert.equal(ctl.confirmClient(), false, "nothing proposed");
  c.say("propose", { title: "Acme" });
  assert.equal(ctl.confirmClient(), true);
  c.say("client", { title: "Acme" });
  assert.equal(ctl.confirmClient(), false, "already confirmed");
  assert.equal(ctl.note("  שיחה על\nמעבר\u0007 שרת "), true);
  assert.equal(ctl.note("   "), false);
  assert.equal(ctl.note("x".repeat(1000)), true);
  assert.deepEqual(c.written, ["consent\n", "quiet on\n", "quiet off\n", "client\n", "note שיחה על מעבר שרת\n", "note " + "x".repeat(300) + "\n"]);
  for (const w of c.written)
    assert.ok(
      COMMANDS.includes(w.trim()) ||
        /^note [^\n\r]{1,300}\n$/.test(w) ||
        /^speaker \d{1,2}( [^\n\r]{1,40})?\n$/.test(w) ||
        /^mode [a-z0-9][a-z0-9-]{0,23}\n$/.test(w),
      "unexpected stdin: " + JSON.stringify(w),
    );
});

test("speaker: renames call-local voices 1-20, empty name clears, bad input and no call refused", () => {
  const { ctl, spawned } = fake();
  assert.equal(ctl.speaker(2, "Dana"), false, "no call");
  ctl.start({});
  const c = spawned[0];
  c.say("waiting", { id: "X" });
  c.say("consented");
  assert.equal(ctl.speaker(2, " Dana\nLevi "), true);
  assert.equal(ctl.speaker(20, "Pierre"), true);
  assert.equal(ctl.speaker(3, ""), true);
  assert.equal(ctl.speaker(1, "x".repeat(100)), true);
  for (const bad of [
    [0, "a"],
    [21, "a"],
    [1.5, "a"],
    ["2", "a"],
    [2, 5],
    [2, undefined],
  ])
    assert.equal(ctl.speaker(...(bad as [any, any])), false, JSON.stringify(bad));
  assert.deepEqual(c.written, ["speaker 2 Dana Levi\n", "speaker 20 Pierre\n", "speaker 3\n", "speaker 1 " + "x".repeat(40) + "\n"]);
});

test("stop sends stop, marks stopping, escalates to SIGINT then SIGKILL on a stuck call", () => {
  const { ctl, spawned, kills, timers } = fake();
  ctl.start({});
  const c = spawned[0];
  c.say("waiting", { id: "X" });
  c.say("consented");
  assert.equal(ctl.stop(), true);
  assert.equal(ctl.stop(), false);
  assert.equal(c.written.at(-1), "stop\n");
  assert.equal(ctl.getState().phase, "stopping");
  assert.deepEqual(
    timers.map((t) => t.ms),
    [12000, 20000],
  );
  timers[0].fn();
  timers[1].fn();
  assert.deepEqual(kills, [
    [-4242, "SIGINT"],
    [-4242, "SIGKILL"],
  ]);
  c.emit("exit", 0);
  timers[0].fn(); // after exit nothing more is killed
  assert.equal(kills.length, 2);
});

test("stop and delete sends stop-delete and remembers the call was deleted", () => {
  const { ctl, spawned } = fake();
  ctl.start({});
  const c = spawned[0];
  c.say("waiting", { id: "X" });
  c.say("consented");
  ctl.stopDelete();
  assert.equal(c.written.at(-1), "stop-delete\n");
  c.say("ended", { id: "X", deleted: true });
  c.emit("exit", 0);
  const s = ctl.getState();
  assert.equal(s.deleted, true);
  assert.equal(s.phase, "idle");
});

test("a finished call keeps its id and summary flag for the 'summary ready' card", () => {
  const { ctl, spawned } = fake();
  ctl.start({});
  const c = spawned[0];
  c.say("waiting", { id: "01CALL" });
  c.say("consented");
  c.say("summary", { ok: true, id: "01CALL" });
  c.say("ended", { id: "01CALL", deleted: false });
  c.emit("exit", 0);
  const s = ctl.getState();
  assert.equal(s.callId, "01CALL");
  assert.equal(s.summaryOk, true);
  assert.equal(s.endedCleanly, true);
  assert.equal(s.deleted, false);
});

test("spawn error and crash return to idle with the error kept", () => {
  const { ctl, spawned, notes } = fake();
  ctl.start({});
  spawned[0].pid = undefined; // Node gives a child that never started no pid
  spawned[0].emit("error", new Error("ENOENT tsx"));
  assert.equal(ctl.isRunning(), false);
  assert.equal(ctl.getState().phase, "idle");
  assert.match(ctl.getState().lastError, /ENOENT/);
  assert.ok(notes.includes("Wingman could not start"));
  assert.equal(ctl.start({}), true, "can start again");
});

test("practice call uses the demo profile and scripted speech", () => {
  const { ctl, spawned } = fake();
  assert.equal(ctl.practice(), true);
  const c = spawned[0];
  assert.ok(c.args.includes("--profile") && c.args.includes("demo") && c.args.includes("--file"));
  assert.ok(c.opts.env.WINGMAN_STT_SCRIPT.endsWith("demo-call.json"));
  assert.equal(ctl.getState().practice, true);
});

test("practice call uses the English pretend call when the interface language is English", () => {
  const { ctl, spawned } = fake({ uiLanguage: () => "en" });
  assert.equal(ctl.practice(), true);
  const c = spawned[0];
  assert.ok(c.args.includes("demo-en") && !c.args.includes("demo"));
  assert.ok(c.opts.env.WINGMAN_STT_SCRIPT.endsWith("demo-call.en.json"));
});

test("doctor: refused during a call, summarised otherwise", async () => {
  const { ctl, spawned } = fake();
  ctl.start({});
  const busy = await ctl.runDoctor();
  assert.equal(busy.verdict, "BUSY");
  spawned[0].emit("exit", 0);
  const p = ctl.runDoctor();
  const d = spawned[1];
  d.stdout.emit(
    "data",
    "Wingman doctor\n  ✅ settings valid\n  ❌ DEEPGRAM_API_KEY missing (speech)\n     fix: add it to ~/.config/wingman/keys.env\n  ⚠️  only one screen: the answer window will NOT open\n     fix: connect the second screen\n\nNOT READY: DEEPGRAM_API_KEY missing\n",
  );
  d.emit("exit", 1);
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.verdict, "NOT READY");
  assert.equal(r.failing.length, 1);
  assert.match(r.failing[0].text, /DEEPGRAM_API_KEY/);
  assert.match(r.failing[0].fix, /keys\.env/);
  assert.equal(r.warnings.length, 1);
  assert.deepEqual(ctl.getState().doctor.failing, r.failing);
});

test("an engine killed by a signal is a crash: notification, error text, idle state", () => {
  const { ctl, spawned, notes } = fake();
  ctl.start({});
  const c = spawned[0];
  c.say("waiting", { id: "01ABC" });
  c.say("consented");
  c.emit("exit", null, "SIGKILL");
  const s = ctl.getState();
  assert.equal(s.running, false);
  assert.equal(s.phase, "idle");
  assert.match(s.lastError, /SIGKILL/);
  assert.ok(notes.includes("Wingman stopped unexpectedly"));
});

test("a signal after a clean end (the lingering answer window) does not notify", () => {
  const { ctl, spawned, notes } = fake();
  ctl.start({});
  const c = spawned[0];
  c.say("waiting", { id: "01ABC" });
  c.say("consented");
  c.say("ended", { id: "01ABC", crashed: false });
  c.emit("exit", null, "SIGTERM");
  assert.ok(!notes.includes("Wingman stopped unexpectedly"));
});

test("a Hebrew letter split across two stdout chunks is decoded intact", () => {
  const { ctl, spawned } = fake();
  ctl.start({});
  const c = spawned[0];
  c.say("waiting", { id: "01ABC" });
  c.say("consented");
  const bytes = Buffer.from(`@@wingman ${JSON.stringify({ ev: "propose", title: "דנה לוי" })}\n`);
  const cut = bytes.indexOf(Buffer.from("דנה")) + 1; // inside the first letter
  c.stdout.emit("data", bytes.subarray(0, cut));
  c.stdout.emit("data", bytes.subarray(cut));
  assert.equal(ctl.getState().proposed, "דנה לוי");
});

test("a Hebrew letter split across two stderr chunks is decoded intact", () => {
  const { ctl, spawned } = fake();
  ctl.start({});
  const c = spawned[0];
  const bytes = Buffer.from("שלום עולם\n");
  c.stderr.emit("data", bytes.subarray(0, 1));
  c.stderr.emit("data", bytes.subarray(1));
  assert.equal(ctl.getState().lastError, "שלום עולם");
});

test("uiLanguageOf: explicit language wins; auto is English only when the call language is English", () => {
  const { uiLanguageOf } = createRequire(import.meta.url)("../tray/lib.cjs");
  assert.equal(uiLanguageOf({ "ui.language": "en", "stt.language": "multi" }), "en");
  assert.equal(uiLanguageOf({ "ui.language": "he", "stt.language": "en" }), "he");
  assert.equal(uiLanguageOf({ "ui.language": "auto", "stt.language": "en" }), "en");
  assert.equal(uiLanguageOf({ "ui.language": "auto", "stt.language": "multi" }), "he");
  assert.equal(uiLanguageOf(null), "he");
});

// ---- Round 16: explicit state (tray/slot.cjs, the phase edges in tray/lib.cjs) ----

test("M4: a late consented after Stop does not bring the call back to live, and a second Stop sends nothing", () => {
  const { ctl, spawned, timers } = fake();
  ctl.start({});
  const c = spawned[0];
  c.say("waiting", { id: "01ABC" });
  assert.equal(ctl.consent(), true);
  assert.equal(ctl.stop(), true);
  assert.equal(ctl.getState().phase, "stopping");
  c.say("consented", { id: "01ABC" }); // the engine had taken "consent" before "stop"
  assert.equal(ctl.getState().phase, "stopping", "still stopping");
  assert.equal(ctl.getState().liveAt, 0);
  assert.equal(ctl.askWingman(), false, "Ask stays disabled");
  assert.equal(ctl.stop(), false, "a second plain Stop is refused");
  assert.deepEqual(c.written, ["consent\n", "stop\n"]);
  assert.equal(timers.length, 2, "one SIGINT and one SIGKILL timer, not two pairs");
  c.say("ended", { id: "01ABC" });
  assert.equal(ctl.getState().phase, "idle");
});

test("M4: a late waiting while live is ignored; the phase table allows only forward edges", () => {
  const lib = createRequire(import.meta.url)("../tray/lib.cjs");
  assert.equal(lib.canMove("live", "waiting"), false);
  assert.equal(lib.canMove("stopping", "live"), false);
  assert.equal(lib.canMove("starting", "live"), true, "a practice call has no waiting phase");
  assert.equal(lib.canMove("stopping", "idle"), true);
  const live = lib.reduce(lib.reduce(lib.initialState(), { ev: "starting" }), { ev: "consented" });
  assert.equal(lib.reduce(live, { ev: "waiting", id: "X" }), live, "the same object comes back for an ignored event");
});

test("H2: a call cannot start while the readiness check runs, and can after it", async () => {
  const { ctl, spawned } = fake();
  const p = ctl.runDoctor();
  assert.equal(ctl.getState().doctorRunning, true);
  assert.equal(ctl.start({}), false, "start refused during the check");
  assert.equal(ctl.practice(), false, "practice refused during the check");
  assert.equal(spawned.length, 1, "no call process was spawned");
  assert.equal(ctl.isRunning(), false);
  spawned[0].stdout.emit("data", "NOT READY: x\n");
  spawned[0].emit("exit", 1);
  await p;
  assert.equal(ctl.getState().doctorRunning, false);
  assert.equal(ctl.start({}), true);
  assert.equal(spawned.length, 2);
});

test("M6: a second readiness request gets the running check's result, never null", async () => {
  const { ctl, spawned } = fake();
  const a = ctl.runDoctor();
  const b = ctl.runDoctor({ offline: true });
  assert.equal(spawned.length, 1, "one check process");
  spawned[0].stdout.emit("data", "Wingman doctor\n  ✅ settings valid\n\nREADY\n");
  spawned[0].emit("exit", 0);
  const [ra, rb] = await Promise.all([a, b]);
  assert.ok(ra && rb);
  assert.equal(rb, ra);
  assert.equal(rb.verdict, "READY");
});

test("M5: lines and errors from an old call do not touch the new call", () => {
  const { ctl, spawned, timers, notes } = fake();
  ctl.start({});
  const a = spawned[0];
  a.say("waiting", { id: "A" });
  a.say("ended", { id: "A" }); // A saved and lingers for its answer window
  assert.equal(ctl.start({}), true, "B starts while A lingers");
  const b = spawned[1];
  assert.ok(timers.length > 0);
  a.stderr.emit("data", Buffer.from("answer window closed badly\n"));
  a.say("overlay", { reason: "closed" });
  a.say("health", { id: "stt", level: "red", text: "old" });
  assert.equal(ctl.getState().lastError, "", "A's stderr is not B's error");
  assert.equal(ctl.getState().overlayDown, "");
  assert.deepEqual(ctl.getState().health, {});
  a.emit("exit", 1, null);
  assert.equal(ctl.isRunning(), true, "A's exit does not end B");
  assert.equal(ctl.getState().phase, "starting");
  assert.ok(!notes.includes("Wingman stopped unexpectedly"));
  b.say("waiting", { id: "B" });
  assert.equal(ctl.getState().callId, "B");
});

test("M5: an error event on a running child (it has a pid) is logged, not a spawn failure", () => {
  const { ctl, spawned } = fake();
  ctl.start({});
  spawned[0].say("waiting", { id: "X" });
  spawned[0].emit("error", new Error("kill EPERM"));
  assert.equal(ctl.isRunning(), true);
  assert.equal(ctl.getState().phase, "waiting");
});

test("H3: a background summary is not reported as a failure, and the state says so", () => {
  const { ctl, spawned, notes } = fake();
  ctl.start({});
  const c = spawned[0];
  c.say("waiting", { id: "01ABC" });
  c.say("consented");
  c.say("stopping");
  c.say("summary", { ok: false, background: true, id: "01ABC" });
  assert.equal(ctl.getState().summaryState, "background");
  assert.ok(!notes.includes("No call summary"), "no false failure notice");
  assert.ok(notes.includes("Call summary is being written"));
  c.say("ended", { id: "01ABC" });
  c.say("summary", { ok: false }); // a real failure still says so
  assert.equal(ctl.getState().summaryState, "failed");
});

test("H3: the dashboard treats a summary.background event with no summary as still being written", () => {
  const { summaryPending } = createRequire(import.meta.url)("../dashboard/lib.cjs");
  const now = 1_000_000_000_000;
  const bg = { type: "summary.background", t: now - 60_000 };
  assert.equal(summaryPending([bg], false, now), true);
  assert.equal(summaryPending([bg], true, now), false, "a summary.json ends the wait");
  assert.equal(summaryPending([bg, { type: "summary.error", t: now - 1000 }], false, now), false);
  assert.equal(summaryPending([bg, { type: "summary.done", t: now - 1000 }], false, now), false);
  assert.equal(summaryPending([{ ...bg, t: now - 11 * 60_000 }], false, now), false, "a writer that is gone does not block forever");
  assert.equal(summaryPending([], false, now), false);
});

test("H3: Write summary is refused while the background writer runs", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(join(ROOT, "dashboard", "window.cjs"), "utf8");
  assert.match(src, /data\.callSummaryPending\(CALLS, id\)[\s\S]{0,120}still being written/);
});

test("M7: no call or practice call starts while the app is stopping the call to quit", () => {
  let quitting = false;
  const { ctl, spawned } = fake({ canStart: () => !quitting });
  assert.equal(ctl.start({}), true);
  spawned[0].say("waiting", { id: "A" });
  spawned[0].say("ended", { id: "A" });
  quitting = true;
  assert.equal(ctl.start({}), false);
  assert.equal(ctl.practice(), false);
  assert.equal(spawned.length, 1, "nothing was spawned");
  quitting = false; // the quit was cancelled
  assert.equal(ctl.start({}), true);
});
