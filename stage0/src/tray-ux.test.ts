// Menu-bar app UX: tray/lib.cjs reducer (stop phases, ask state, AI mode), tray/controller.cjs (practice with the Plan, notifications,
// Start key, confirmations; Electron objects and spawn are injected), mic verdict, and run.ts phase wiring.
// Includes one real scripted engine run and a control-socket check, both with a temp calls folder.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ROOT } from "./env.ts";
import { micVerdict } from "./mic-check.ts";

const req = createRequire(import.meta.url);
const lib = req("../tray/lib.cjs");
const { createController } = req("../tray/controller.cjs");

// ---- reducer: stop phases, ask, mode ----
test("reducer: stopphase is stored, unknown phases ignored, cleared on start and exit", () => {
  let s = lib.reduce(lib.initialState(), { ev: "starting" });
  s = lib.reduce(s, { ev: "consented", id: "A" });
  assert.equal(s.stopPhase, "");
  s = lib.reduce(s, { ev: "stopping" });
  for (const p of ["saving", "summary", "done"]) { s = lib.reduce(s, { ev: "stopphase", phase: p }); assert.equal(s.stopPhase, p); }
  s = lib.reduce(s, { ev: "stopphase", phase: "bogus" }); assert.equal(s.stopPhase, "done");
  assert.equal(lib.reduce(s, { ev: "exit" }).stopPhase, "");
  assert.equal(lib.reduce(s, { ev: "starting" }).stopPhase, "");
});

test("reducer: askArmed follows the ask event, clears on timeout, stop and exit", () => {
  let s = lib.reduce(lib.initialState(), { ev: "consented" });
  s = lib.reduce(s, { ev: "ask", on: true, until: 1 }); assert.equal(s.askArmed, true);
  assert.equal(lib.reduce(s, { ev: "ask", on: false }).askArmed, false);
  assert.equal(lib.reduce(s, { ev: "stopping" }).askArmed, false);
  assert.equal(lib.reduce(s, { ev: "exit" }).askArmed, false);
  assert.notEqual(lib.menuKey(s, true), lib.menuKey(lib.reduce(s, { ev: "ask", on: false }), true), "the menu is rebuilt when ask arms");
});

test("reducer: mode event and --no-ai set the effective AI mode", () => {
  let s = lib.reduce(lib.initialState(), { ev: "starting", noAi: true }); assert.equal(s.noAi, true);
  s = lib.reduce(s, { ev: "mode", noAi: false }); assert.equal(s.noAi, false);
  assert.equal(lib.reduce(s, { ev: "mode", noAi: true }).noAi, true);
});

test("reducer: going live no longer clears the prepared-meeting flag (several meetings; the controller marks the used one)", () => {
  const ready = { ...lib.initialState(), briefReady: true };
  assert.equal(lib.reduce(lib.reduce(ready, { ev: "starting", practice: true }), { ev: "consented" }).briefReady, true);
  const real = lib.reduce(lib.reduce(ready, { ev: "starting", planId: "mabc123" }), { ev: "consented" });
  assert.equal(real.briefReady, true); assert.equal(real.planId, "mabc123", "the live call remembers which meeting it uses");
  assert.equal(lib.reduce(lib.reduce(ready, { ev: "starting" }), { ev: "consented" }).planId, "", "a quick call has no meeting");
  assert.equal(lib.reduce(ready, { ev: "boot", briefReady: true, plansKey: "k1" }).plansKey, "k1");
});

// ---- controller: practice uses the Plan, exposes new state ----
// Fake child process: emits `@@wingman {json}` status lines on stdout like the engine; spawn, notify and setTimeout are injected into the controller.
function fake(extra: object = {}) {
  const spawned: any[] = [];
  const spawn = (_c: string, args: string[], opts: any) => {
    const c: any = new EventEmitter();
    c.pid = 1; c.args = args; c.opts = opts;
    c.stdin = Object.assign(new EventEmitter(), { writable: true, write: () => true });
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {};
    c.say = (ev: string, data: object = {}) => c.stdout.emit("data", Buffer.from(`\n@@wingman ${JSON.stringify({ ev, ...data })}\n`));
    spawned.push(c); return c;
  };
  const notes: string[][] = [];
  const dir = mkdtempSync(join(tmpdir(), "wm-ux-"));
  const ctl = createController({ spawn, root: ROOT, tmpDir: dir, setTimeout: () => 0, kill: () => {}, notify: (t: string, b: string) => notes.push([t, b]), env: {}, ...extra });
  return { ctl, spawned, dir, notes };
}

const { createPlanStore } = createRequire(import.meta.url)("../tray/plans.cjs");
function withStore() {
  const bdir = mkdtempSync(join(tmpdir(), "wm-plan-")), plans = createPlanStore({ dir: bdir, pdftotext: "" });
  return { bdir, plans, ...fake({ plans }) };
}

test("practice: uses the next prepared meeting (--brief <its file>, its files folder), is not used up", () => {
  const { ctl, spawned, notes, plans } = withStore();
  const m = plans.create({ who: "Dana, Acme", mustCover: ["price"], at: Date.now() + 3600_000 }).meeting;
  plans.create({ who: "Noam, Beta" });
  assert.equal(ctl.practice(), true);
  const a = spawned[0].args;
  assert.ok(!a.includes("--no-brief")); assert.equal(a[a.indexOf("--brief") + 1], plans.dirOf(m.id) + "/brief.yaml");
  assert.equal(spawned[0].opts.env.WINGMAN_ATTACH_DIR, plans.dirOf(m.id) + "/files");
  assert.ok(a.includes("--file") && a.includes("demo"), "still the offline file mode with the demo profile");
  assert.match(notes.find((n) => n[0] === "Practice call")![1], /Dana, Acme.*in use/);
  spawned[0].say("consented", { id: "P1" });
  assert.equal(plans.get(m.id).status, "ready", "a practice call does not use up the meeting");
});

test("practice: --quick or no meetings means --no-brief; a named meeting that is gone refuses", () => {
  const a = withStore(); a.plans.create({ who: "Dana" }); assert.equal(a.ctl.practice({ quick: true }), true);
  assert.ok(a.spawned[0].args.includes("--no-brief") && !a.spawned[0].args.includes("--brief"));
  const b = withStore(); assert.equal(b.ctl.practice(), true); assert.ok(b.spawned[0].args.includes("--no-brief"), "no meetings");
  const c = withStore(); c.plans.create({ who: "A" }); c.plans.create({ who: "B" }); c.ctl.practice(); assert.ok(c.spawned[0].args.includes("--no-brief"), "two meetings and none is next: no guessing");
  const d = withStore(); assert.equal(d.ctl.practice({ planId: "mnope0000" }), false); assert.equal(d.spawned.length, 0);
  const e = fake(); e.ctl.practice(); assert.ok(e.spawned[0].args.includes("--no-brief"), "no store at all");
});

test("start: a quick call passes --no-brief and touches no meeting; a chosen meeting passes --brief and is used up only when the call goes live", () => {
  const { ctl, spawned, plans } = withStore();
  const a = plans.create({ who: "Dana", at: Date.now() + 3600_000 }).meeting, b = plans.create({ who: "Noam" }).meeting;
  assert.equal(ctl.start({}), true);
  assert.ok(spawned[0].args.includes("--no-brief") && !spawned[0].args.includes("--brief"));
  assert.equal(spawned[0].opts.env.WINGMAN_ATTACH_DIR, undefined);
  spawned[0].say("consented", { id: "Q1" });
  assert.equal(plans.list().length, 2, "a quick call uses up nothing");
  spawned[0].emit("exit", 0);
  assert.equal(ctl.start({ planId: b.id, noAi: true }), true);
  const args = spawned[1].args;
  assert.equal(args[args.indexOf("--brief") + 1], plans.dirOf(b.id) + "/brief.yaml"); assert.ok(args.includes("--no-ai") && !args.includes("--no-brief"));
  assert.equal(ctl.getState().planId, b.id);
  spawned[1].say("waiting", { id: "R1" });
  assert.equal(plans.get(b.id).status, "ready", "not used up before the call is live");
  spawned[1].say("consented");
  assert.equal(plans.get(b.id).status, "used"); assert.equal(plans.get(b.id, { includeUsed: true }).callId, "R1");
  assert.equal(plans.get(a.id).status, "ready", "the other meeting is untouched");
  assert.deepEqual(plans.list().map((m: any) => m.id), [a.id]);
  assert.equal(ctl.getState().briefReady, true);
  spawned[1].emit("exit", 0);
  assert.equal(ctl.start({ planId: b.id }), false, "a used meeting cannot start a call again");
  assert.equal(ctl.start({ planId: "mnope0000" }), false);
});

test("start: a failed or stopped-before-live call does not use the meeting up; refreshPlans redraws only on a change", () => {
  const { ctl, spawned, plans } = withStore();
  const m = plans.create({ who: "Dana" }).meeting;
  ctl.start({ planId: m.id }); spawned[0].emit("exit", 1);
  assert.equal(plans.get(m.id).status, "ready");
  let changes = 0; const c2 = fake({ plans: plans, onChange: () => changes++ });
  c2.ctl.refreshPlans(); const n = changes; c2.ctl.refreshPlans();
  assert.equal(changes, n, "no change, no redraw"); assert.equal(c2.ctl.getState().briefReady, true);
  plans.create({ who: "Another" }); c2.ctl.refreshPlans(); assert.equal(changes, n + 1);
  assert.notEqual(c2.ctl.getState().plansKey, "");
});

test("controller state carries stopPhase, askArmed and the AI mode", () => {
  const { ctl, spawned } = fake();
  ctl.start({ noAi: true });
  assert.equal(ctl.getState().noAi, true);
  const c = spawned[0];
  c.say("consented", { id: "X" }); c.say("ask", { on: true }); assert.equal(ctl.getState().askArmed, true);
  c.say("ask", { on: false }); assert.equal(ctl.getState().askArmed, false);
  c.say("stopphase", { phase: "saving" }); assert.equal(ctl.getState().stopPhase, "saving");
  c.say("stopphase", { phase: "summary" }); assert.equal(ctl.getState().stopPhase, "summary");
});

test("notifications for crashes and start failures say what to do next", () => {
  const { ctl, spawned, notes } = fake();
  ctl.start({}); spawned[0].emit("error", new Error("ENOENT tsx"));
  assert.match(notes[0][1], /Quit Wingman.*open it again/);
  ctl.start({}); spawned[1].stderr.emit("data", Buffer.from("boom")); spawned[1].emit("exit", 1);
  assert.match(notes[notes.length - 1][0], /stopped unexpectedly/); assert.match(notes[notes.length - 1][1], /Start a new call/);
});

// ---- tray: conditional Start listening key ----
function fakeShortcuts(registerOk = true) {
  const reg = new Map<string, () => void>(); const log: string[] = [];
  return { reg, log, gs: { register: (k: string, f: () => void) => { log.push("register " + k); if (registerOk) reg.set(k, f); return registerOk; }, unregister: (k: string) => { log.push("unregister " + k); reg.delete(k); } } };
}
test("Start listening key: registered only while waiting, removed otherwise, handler fires", () => {
  const f = fakeShortcuts(); let pressed = 0; const msgs: string[] = [];
  const k = lib.createStartKey({ globalShortcut: f.gs, key: lib.KEYS.consent, onPress: () => pressed++, log: (m: string) => msgs.push(m) });
  assert.equal(f.reg.size, 0, "nothing at launch");
  k.sync(false); assert.deepEqual(f.log, [], "not waiting: nothing to unregister");
  k.sync(true); k.sync(true); assert.equal(f.log.filter((x: string) => x.startsWith("register")).length, 1, "registered once");
  f.reg.get("Control+Alt+Return")!(); assert.equal(pressed, 1);
  k.sync(false); assert.equal(f.reg.size, 0); assert.equal(k.isOn(), false);
  k.sync(true); assert.equal(f.reg.size, 1, "can come back for the next call");
  assert.deepEqual(msgs, []);
});
test("Start listening key: a refused registration is logged and retried at the next sync", () => {
  const f = fakeShortcuts(false); const msgs: string[] = [];
  const k = lib.createStartKey({ globalShortcut: f.gs, key: "Control+Alt+Return", onPress: () => {}, log: (m: string) => msgs.push(m) });
  k.sync(true); assert.equal(k.isOn(), false); assert.match(msgs[0], /could not register/);
  k.sync(true); assert.equal(f.log.length, 2, "tries again");
  const t = lib.createStartKey({ globalShortcut: { register() { throw new Error("x"); }, unregister() {} }, key: "k", onPress: () => {} });
  assert.doesNotThrow(() => t.sync(true));
});
test("the menu-bar app never uses the answer window's keys (C/P/R/K/L and 1-3)", () => {
  for (const k of Object.values(lib.KEYS)) assert.ok(!lib.OVERLAY_KEYS.includes(k as string), `${k} collides`);
  for (const n of ["1", "2", "3"]) assert.ok(lib.OVERLAY_KEYS.includes(`Control+Alt+${n}`));
  const src = readFileSync(join(ROOT, "tray", "main.cjs"), "utf8");
  assert.ok(!/Control\+Alt\+[123]\b/.test(src), "main.cjs registers no Ctrl+Opt+1-3");
});

// ---- tray: confirmations ----
test("Stop and delete: Cancel (default), Escape and closing do nothing; only the second button deletes", () => {
  const run = (answer: number) => { const seen: any[] = []; let deleted = 0; const ok = lib.confirmStopDelete({ dialog: { showMessageBoxSync: (o: any) => { seen.push(o); return answer; } }, stopDelete: () => deleted++ }); return { ok, deleted, opt: seen[0] }; };
  const c = run(0); assert.equal(c.deleted, 0); assert.equal(c.ok, false);
  assert.equal(c.opt.defaultId, 0, "Cancel is the default"); assert.equal(c.opt.cancelId, 0, "Escape cancels");
  assert.deepEqual(c.opt.buttons, ["Cancel", "Stop and delete"]);
  assert.equal(run(-1).deleted, 0);
  const d = run(1); assert.equal(d.deleted, 1); assert.equal(d.ok, true);
});

test("Quit: nothing running quits at once; during a call it asks, Keep is the default, Stop waits for the save", async () => {
  const mk = (running: boolean, answer: number) => {
    const ev: string[] = []; let stopped = false;
    return { ev, o: { isRunning: () => running, dialog: { showMessageBoxSync: (d: any) => { ev.push("dialog " + d.defaultId + d.cancelId); return answer; } }, stop: () => { ev.push("stop"); stopped = true; }, quit: () => ev.push("quit"), whenStopped: async () => { ev.push("waited " + stopped); } } };
  };
  const a = mk(false, 0); assert.equal(await lib.requestQuit(a.o), "quit"); assert.deepEqual(a.ev, ["quit"]);
  const b = mk(true, 0); assert.equal(await lib.requestQuit(b.o), "kept"); assert.deepEqual(b.ev, ["dialog 00"]);
  const c = mk(true, -1); assert.equal(await lib.requestQuit(c.o), "kept");
  const d = mk(true, 1); assert.equal(await lib.requestQuit(d.o), "quit"); assert.deepEqual(d.ev, ["dialog 00", "stop", "waited true", "quit"]);
});

test("waitUntil resolves true as soon as the predicate holds, false at the deadline", async () => {
  let n = 0; assert.equal(await lib.waitUntil(() => ++n >= 3, 1000, { every: 1 }), true);
  assert.equal(await lib.waitUntil(() => false, 20, { every: 5 }), false);
});

// ---- doctor: mic verdict ----
test("mic check: 0 peak fails (blocked), 0.017 warns (quiet voice), 0.05 is ok", () => {
  assert.equal(micVerdict(300, 0), "fail");
  assert.equal(micVerdict(0, 0.5), "fail", "no audio at all");
  assert.equal(micVerdict(300, 0.017), "warn");
  assert.equal(micVerdict(300, 0.02), "warn", "exactly the threshold is still quiet");
  assert.equal(micVerdict(300, 0.05), "ok");
  assert.equal(micVerdict(300, NaN), "fail");
});

// ---- run.ts: phases and stop steps are wired in order ----
test("run.ts writes call.json phases and emits stop steps in order", () => {
  const src = readFileSync(join(ROOT, "src", "run.ts"), "utf8");
  for (const p of ['setPhase("starting")', 'setPhase("waiting")', 'setPhase("live", { liveAt']) assert.ok(src.includes(p), p);
  const at = (t: string) => src.indexOf(t);
  assert.ok(at('status("stopphase", { phase: "saving" })') < at('status("stopphase", { phase: "summary" })'));
  assert.ok(at('status("stopphase", { phase: "summary" })') < at('status("stopphase", { phase: "done" })'));
  assert.ok(at('status("stopphase", { phase: "done" })') < at('status("ended"'));
  assert.match(src, /phase: "ended"/);
  assert.match(src, /loadAttachments\(S\.attachments\.maxChars, \{ consume: !fileArg \}\)/, "a practice call never deletes the real call's files");
});

// ---- real engine run (offline, scripted, temp calls folder): statuses and call.json phases ----
test("engine: control-mode run emits mode + stop steps in order and call.json ends at phase ended", { timeout: 60_000 }, async () => {
  const { spawnSync } = await import("node:child_process");
  const { writeWav } = await import("./audio.ts");
  const { readdirSync } = await import("node:fs");
  const tmp = mkdtempSync(join(tmpdir(), "wingman-ux-run-")), calls = join(tmp, "calls"), wav = join(tmp, "silence.wav");
  await writeWav(wav, Buffer.alloc(16000 * 2 * 2 * 8), 2);
  const r = spawnSync(join(ROOT, "node_modules", ".bin", "tsx"), [join(ROOT, "src", "run.ts"), "--profile", "e2e", "--file", wav, "--no-brief"], {
    cwd: ROOT, encoding: "utf8", timeout: 50_000, input: "",
    env: { ...process.env, WINGMAN_CALLS_DIR: calls, WINGMAN_CONTROL: "1", WINGMAN_STT_SCRIPT: join(ROOT, "data", "test", "e2e-call.json"), WINGMAN_SCRIPT_GAP_MS: "800" },
  });
  const evs = r.stdout.split("\n").filter((l) => l.startsWith("@@wingman ")).map((l) => JSON.parse(l.slice(10)));
  const names = evs.map((e) => e.ev);
  assert.ok(names.includes("mode") && evs.find((e) => e.ev === "mode").noAi === false, `mode event: ${names}`);
  const phases = evs.filter((e) => e.ev === "stopphase").map((e) => e.phase);
  assert.deepEqual(phases, ["saving", "summary", "done"]);
  assert.ok(names.indexOf("stopphase") < names.indexOf("ended") && names.lastIndexOf("stopphase") < names.indexOf("ended"));
  const id = readdirSync(calls).find((d) => d !== "latest")!;
  const meta = JSON.parse(readFileSync(join(calls, id, "call.json"), "utf8"));
  assert.equal(meta.phase, "ended"); assert.ok(meta.endedAt); assert.ok(meta.liveAt > 0, "liveAt was written when listening started");
  // the reducer fed with the real stream ends with a clean stop
  let s = lib.initialState(); for (const e of evs) s = lib.reduce(s, e);
  assert.equal(s.stopPhase, "done"); assert.equal(s.phase, "stopping");
});

test("control socket status exposes stopPhase, askArmed and the AI mode; the CLI prints the stop step", async () => {
  const { createControlServer } = req("../tray/control-socket.cjs");
  const { ctl, spawned } = fake();
  ctl.start({ noAi: true }); spawned[0].say("consented", { id: "C1" }); spawned[0].say("ask", { on: true });
  const srv = createControlServer({ controller: ctl, lib, socketPath: join(tmpdir(), "x.sock") });
  let r = await srv.handle(JSON.stringify({ v: 1, cmd: "status" }));
  assert.equal(r.state.askArmed, true); assert.equal(r.state.noAi, true); assert.equal(r.state.stopPhase, "");
  spawned[0].say("stopping"); spawned[0].say("stopphase", { phase: "summary" });
  r = await srv.handle(JSON.stringify({ v: 1, cmd: "status" }));
  assert.equal(r.state.phase, "stopping"); assert.equal(r.state.stopPhase, "summary"); assert.equal(r.state.askArmed, false);
});

test("reducer: macOS Electron chatter on stderr is not kept as the last error", () => {
  let s = lib.initialState();
  s = lib.reduce(s, { ev: "stderr", text: "2026-11-03 10:45:03.730 Electron[72437:801406] ApplePersistenceIgnoreState: Existing state will not be touched." });
  assert.equal(s.lastError, "");
  s = lib.reduce(s, { ev: "stderr", text: "Error: real failure" });
  assert.equal(s.lastError, "Error: real failure");
});

test("menu bar: Start prepared meeting lists ready meetings soonest first; the menu is rebuilt when the list changes", () => {
  const now = new Date(2026, 10, 3, 9, 0).getTime(), at = (h: number) => new Date(2026, 10, 3, h).getTime();
  const m = (id: string, who: string, atMs = 0, extra: object = {}) => ({ id, who, title: "", goal: "", topic: "", at: atMs, createdAt: now, updatedAt: now, usedAt: 0, ...extra });
  const menu = lib.planMenu([m("c", "No time"), m("b", "Noam, Beta", at(16)), m("a", "Dana, Acme", at(14)), m("u", "Used", at(11), { usedAt: now })], now);
  assert.deepEqual(menu.map((x: any) => x.planId), ["a", "b", "c"]);
  assert.equal(menu[0].label, "Dana, Acme (Today 14:00)"); assert.equal(menu[2].label, "No time");
  assert.deepEqual(lib.planMenu([], now), []);
  const s1 = lib.reduce(lib.initialState(), { ev: "boot", briefReady: true, plansKey: "one" });
  assert.notEqual(lib.menuKey(s1, false), lib.menuKey(lib.reduce(s1, { ev: "boot", briefReady: true, plansKey: "two" }), false));
});

test("CLI confirmations: only the second button says yes; no answer in time, Escape, or a dialog error is no", async () => {
  const dlg = (response: number | "never" | "throw") => ({ showMessageBox: () => (response === "never" ? new Promise(() => {}) : response === "throw" ? Promise.reject(new Error("x")) : Promise.resolve({ response })) });
  assert.equal(await lib.confirmCliStart({ dialog: dlg(1) }), true);
  assert.equal(await lib.confirmCliStart({ dialog: dlg(0) }), false);
  assert.equal(await lib.confirmCliStopDelete({ dialog: dlg(1) }), true);
  assert.equal(await lib.confirmCliStopDelete({ dialog: dlg(0) }), false);
  assert.equal(await lib.confirmCliStopDelete({ dialog: dlg("throw") }), false);
  assert.equal(await lib.confirmCliStart({ dialog: dlg("never"), timeoutMs: 20 }), false);
});

test("CLI start question setting: default and unreadable mean ask; only an explicit false skips it", async () => {
  assert.equal(await lib.askBeforeCliStart({ run: async () => ({ ok: true, values: { "privacy.askBeforeCliStart": true } }) }), true);
  assert.equal(await lib.askBeforeCliStart({ run: async () => ({ ok: true, values: { "privacy.askBeforeCliStart": false } }) }), false);
  assert.equal(await lib.askBeforeCliStart({ run: async () => null }), true);
  assert.equal(await lib.askBeforeCliStart({ run: async () => { throw new Error("x"); } }), true);
});
