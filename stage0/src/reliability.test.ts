// Live-call reliability: audio source supervisor, disk-full second path, survived handler errors, STT outage ladder, sleep/wake, overlay crash safety.
// Unit tests use fake sources; the engine tests run the real src/run.ts as a child with scripted STT/AI, a fake `ffmpeg` on PATH, and temp folders.
// Nothing here touches the real calls folder, keys or audio devices.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, appendFileSync, utimesSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { ROOT } from "./env.ts";
import { writeWav, SupervisedSource, pickMicDevice, AUDIO_BACKOFF_MS, type Source } from "./audio.ts";
import { decide, NO_SIGNALS, HealthSupervisor, sttRetryDelayMs, isPermanentSttError } from "./health.ts";
import { detectGap } from "./clock.ts";
import { diskLevel, diskText, DISK_AMBER_BYTES, DISK_RED_BYTES } from "./diskspace.ts";
import { LineSplitter, RowRelay, nextRestartCount, listenForRows, CardPipe } from "./relay.ts";
import { sweepLive } from "./log.ts";
import { ProviderError } from "./providers/errors.ts";
import { tsx } from "./test-platform.ts";
import pipe from "../shared/pipe.cjs";

const require = createRequire(import.meta.url);
const R = require("../overlay/resilient.cjs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 8000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await sleep(20); } };

// ---------------------------------------------------------------- supervisor (fake sources)
class Fake extends EventEmitter implements Source {
  started = false; stopped = false;
  constructor(private o: { failStart?: boolean; frames?: boolean } = {}) { super(); }
  async start() { if (this.o.failStart) throw new Error("cannot start"); this.started = true; if (this.o.frames !== false) { this.timer = setInterval(() => this.emit("pcm", Buffer.alloc(3200)), 10); } }
  timer?: NodeJS.Timeout;
  async stop() { this.stopped = true; clearInterval(this.timer); }
  die(msg = "exited") { clearInterval(this.timer); this.emit("error", new Error(msg)); }
}
const fast = (n: number) => 20;

test("supervisor: a start failure does not reject; it retries, then reports up when frames flow", async () => {
  const made: Fake[] = []; const seen: number[] = [];
  const s = new SupervisedSource({ name: "t", backoff: fast, make: (failures) => { seen.push(failures); const f = new Fake({ failStart: made.length < 2 }); made.push(f); return f; } });
  const ev: string[] = []; s.on("down", () => ev.push("down")); s.on("up", () => ev.push("up")); let pcm = 0; s.on("pcm", () => pcm++);
  await s.start();                                  // must not throw
  await until(() => ev.includes("up"));
  assert.deepEqual(ev, ["down", "down", "up"]);
  assert.deepEqual(seen, [0, 1, 2], "make() sees the consecutive failure count, so a device can be looked up again");
  assert.ok(pcm > 0 && !s.down);
  await s.stop(); assert.ok(made.at(-1)!.stopped);
});

test("supervisor: the source exits mid-call and comes back; the dead one is stopped and ignored", async () => {
  const made: Fake[] = [];
  const s = new SupervisedSource({ name: "t", backoff: fast, make: () => { const f = new Fake(); made.push(f); return f; } });
  const ev: string[] = []; s.on("down", (d) => ev.push("down:" + d.reason)); s.on("up", () => ev.push("up"));
  await s.start(); await until(() => s.frames > 3);
  made[0].die("ffmpeg mic exited 1");
  await until(() => ev.includes("up"));
  assert.deepEqual(ev, ["down:ffmpeg mic exited 1", "up"]);
  assert.equal(made.length, 2); assert.ok(made[0].stopped);
  const before = s.frames; made[0].emit("pcm", Buffer.alloc(3200)); assert.equal(s.frames, before, "frames of a replaced source are ignored");
  await s.stop();
});

test("supervisor: a source that goes quiet (device vanished, process alive) is restarted", async () => {
  const made: Fake[] = [];
  const s = new SupervisedSource({ name: "t", backoff: fast, stallMs: 200, make: () => { const f = new Fake({ frames: made.length > 0 }); made.push(f); return f; } });
  const ev: string[] = []; s.on("down", (d) => ev.push(d.reason)); s.on("up", () => ev.push("up"));
  await s.start();
  await until(() => ev.includes("up"));
  assert.match(ev[0], /no audio for/);
  await s.stop();
});

test("supervisor: restart(wake) rebuilds at once; stop() ends retries", async () => {
  const made: Fake[] = [];
  const s = new SupervisedSource({ name: "t", backoff: () => 5000, make: () => { const f = new Fake(); made.push(f); return f; } });
  await s.start(); await until(() => s.frames > 2);
  s.restart("wake");
  await until(() => made.length === 2);             // immediate: no backoff for a deliberate restart
  await until(() => !s.down);
  made[1].die("x");                                 // backoff 5 s now pending
  await s.stop(); await sleep(50);
  assert.equal(made.length, 2, "no retry after stop()");
});

test("supervisor: backoff is 1, 2, 4 s then every 10 s", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 20].map(AUDIO_BACKOFF_MS), [1000, 2000, 4000, 10_000, 10_000, 10_000]);
});

test("mic device: AirPods gone falls back to :default; :default and indexes are kept; two failures give up an explicit device", () => {
  const devs = [{ name: "MacBook Pro Microphone" }];
  assert.equal(pickMicDevice(":default", devs, 3), ":default");
  assert.equal(pickMicDevice("AirPods Pro", devs, 0), ":AirPods Pro", "first open: as configured");
  assert.equal(pickMicDevice("AirPods Pro", devs, 1), ":default", "after a drop the device list has no AirPods");
  assert.equal(pickMicDevice("AirPods Pro", [{ name: "Dan's AirPods Pro" }], 1), ":AirPods Pro", "still plugged in: keep it");
  assert.equal(pickMicDevice(":1", devs, 1), ":1", "an index cannot be checked against names");
  assert.equal(pickMicDevice(":1", devs, 2), ":default");
  assert.equal(pickMicDevice("AirPods Pro", [], 1), ":AirPods Pro", "device list unreadable: do not guess yet");
});

// ---------------------------------------------------------------- ladder, STT retry, disk, clock
test("ladder: a dead STT channel for the other side is rung 4 (transcript-only), never rung 5", () => {
  const d = decide({ ...NO_SIGNALS, themSttDown: true });
  assert.equal(d.rung, 4); assert.match(d.reasons[0], /transcription/);
  assert.equal(decide({ ...NO_SIGNALS, fatal: "consent withdrawn" }).rung, 5, "rung 5 stays for a user stop / withdrawn consent");
  const now = { t: 0 };
  const s = new HealthSupervisor({ tickMs: 1000, recoverStableMs: 60_000, slowMs: 1500, slowSttMs: 1500, minSamples: 3 }, () => now.t);
  s.set({ themSttDown: true }); s.tick(); assert.equal(s.rung, 4); assert.equal(s.caps.meAns, true, "the user's own questions still get answers");
  s.set({ themSttDown: false }); now.t += 2500; s.tick(); assert.equal(s.rung, 0, "recovers within seconds, not the stable minute");
});
test("stt retry: fast backoff, then every 30 s once permanent; unknown is transient", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map((n) => sttRetryDelayMs(n, false)), [1000, 2000, 4000, 8000, 10_000, 10_000]);
  assert.equal(sttRetryDelayMs(0, true), 30_000); assert.equal(sttRetryDelayMs(7, true), 30_000);
  assert.equal(isPermanentSttError(new ProviderError("auth", "deepgram", "401")), true);
  assert.equal(isPermanentSttError(new ProviderError("quota", "deepgram", "402")), true);
  assert.equal(isPermanentSttError(new ProviderError("unknown", "deepgram", "???")), false);
  assert.equal(isPermanentSttError(new ProviderError("network", "deepgram", "down")), false);
});
test("disk: amber under 500 MB, red under 100 MB, unknown is ok", () => {
  assert.equal(diskLevel(null), "ok"); assert.equal(diskLevel(DISK_AMBER_BYTES), "ok");
  assert.equal(diskLevel(DISK_AMBER_BYTES - 1), "amber"); assert.equal(diskLevel(DISK_RED_BYTES), "amber"); assert.equal(diskLevel(DISK_RED_BYTES - 1), "red");
  assert.match(diskText("red", 50 * 1024 * 1024), /50 MB/);
});
test("clock: a sleep (wall moved, monotonic did not) is found; normal ticks and backwards clocks are not sleeps", () => {
  const p = { wall: 1_000_000, mono: 5000 };
  assert.equal(detectGap(p, { wall: p.wall + 1000, mono: p.mono + 1000 }, 5000, 1000).kind, null);
  assert.deepEqual(detectGap(p, { wall: p.wall + 600_000, mono: p.mono + 1000 }, 5000, 1000), { kind: "sleep", ms: 600_000 });
  assert.equal(detectGap(p, { wall: p.wall + 30_000, mono: p.mono + 30_000 }, 5000, 1000).kind, "sleep", "process frozen on a clock that keeps counting");
  assert.equal(detectGap(p, { wall: p.wall - 3_600_000, mono: p.mono + 1000 }, 5000, 1000).kind, "clock-back", "clock set backwards: not a sleep, never an idle stop");
  assert.equal(detectGap(p, { wall: p.wall + 600_000, mono: p.mono + 1000 }, 0, 1000).kind, null, "sleepGapMs 0 = off");
});

// ---------------------------------------------------------------- relay + overlay helpers
test("relay: lines split across chunks, the last rows are replayed to a restarted window, restart counter heals", () => {
  const ls = new LineSplitter();
  assert.deepEqual(ls.push('{"a":1}\n{"b"'), ['{"a":1}']); assert.deepEqual(ls.push(':2}\n'), ['{"b":2}']);
  const got: string[] = []; const sink = { writable: true, destroyed: false, write: (l: string, cb?: () => void) => { got.push(l); cb?.(); return true; } } as any;
  const r = new RowRelay(2);
  r.feed('{"n":1}\n{"n":2}\n{"n":3}\n'); r.attach(sink);
  assert.deepEqual(got, ['{"n":2}\n', '{"n":3}\n'], "only the last `keep` rows, in order");
  r.feed('{"n":4}\n'); assert.equal(got.at(-1), '{"n":4}\n');
  r.detach(); r.feed('{"n":5}\n'); assert.equal(got.length, 3);
  assert.equal(nextRestartCount(3, 11 * 60_000), 0); assert.equal(nextRestartCount(3, 30_000), 3);
});
test("relay: CardPipe -> private socket -> RowRelay (what call.ts and run.ts do)", async () => {
  const got: string[] = []; const relay = new RowRelay(); relay.attach({ writable: true, destroyed: false, write: (l: string) => { got.push(l); return true; } } as any);
  const l = listenForRows(relay)!; assert.ok(l && existsSync(l.path));
  await until(() => l.server.listening);
  const pipe = new CardPipe(l.path); pipe.send({ type: "card", id: "x", say: "שלום" });
  await until(() => got.length === 1);
  assert.deepEqual(JSON.parse(got[0]), { type: "card", id: "x", say: "שלום" });
  pipe.close(); l.close(); assert.ok(!existsSync(l.path));
  new CardPipe(join(tmpdir(), "no-such.sock")).send({ a: 1 });   // never throws
});
test("overlay: readNewRows caps each tick, waits for half rows, skips a giant row, survives a missing file, closes its fd", () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-ov-")); const f = join(dir, "cards.jsonl"); const tail = { file: f, offset: 0 };
  assert.deepEqual(R.readNewRows(tail), [], "no file yet");
  const row = (i: number) => JSON.stringify({ i, pad: "x".repeat(90) }) + "\n";
  for (let i = 0; i < 20; i++) appendFileSync(f, row(i));
  const a = R.readNewRows(tail, 1000); assert.ok(a.length > 0 && a.length < 20, `capped: ${a.length}`);
  const b = R.readNewRows(tail, 1000), c = R.readNewRows(tail, 1000);
  assert.deepEqual([...a, ...b, ...c].map((r: any) => r.i), Array.from({ length: 20 }, (_, i) => i), "nothing lost or doubled across ticks");
  appendFileSync(f, '{"half":'); assert.deepEqual(R.readNewRows(tail), []);
  appendFileSync(f, "1}\n"); assert.deepEqual(R.readNewRows(tail), [{ half: 1 }]);
  appendFileSync(f, "y".repeat(3000) + "\n" + row(99));
  let got: any[] = []; for (let k = 0; k < 10; k++) got.push(...R.readNewRows(tail, 1000));
  assert.ok(got.some((r) => r.i === 99), "a row bigger than the cap is skipped, the next one still arrives");
  writeFileSync(f, row(7)); assert.equal(R.readNewRows(tail)[0].i, 7, "replaced (shorter) file is read from the start");
  const fds0 = readdirSync("/dev/fd").length; for (let k = 0; k < 200; k++) R.readNewRows(tail); assert.ok(readdirSync("/dev/fd").length <= fds0 + 1, "no fd leak");
  rmSync(dir, { recursive: true, force: true });
});
test("overlay: the same card by disk and by pipe is shown once; changed content of the same id is shown", () => {
  const seen = new R.Seen(3); const card = { type: "card", id: "c1", say: "a", t: 5 };
  assert.equal(seen.add(R.rowKey(card)), true); assert.equal(seen.add(R.rowKey(JSON.parse(JSON.stringify(card)))), false, "same row via the other path");
  assert.equal(seen.add(R.rowKey({ ...card, say: "b", t: 6 })), true, "an update of the card is a new row");
  for (let i = 0; i < 5; i++) seen.add("k" + i); assert.equal(seen.size, 3, "bounded");
  const p = new R.StdinRows(); assert.deepEqual(p.push('{"a":1}\nnot json\n{"b"'), [{ a: 1 }]); assert.deepEqual(p.push(':2}\n'), [{ b: 2 }]);
  const bl = new R.Backlog(2); bl.add(1); bl.add(2); bl.add(3); assert.deepEqual(bl.all(), [2, 3]);
  let t = 0; const g = new R.ReloadGate(() => t); const waits = []; for (let i = 0; i < 6; i++) { waits.push(g.next()); t += 1000; }
  assert.deepEqual(waits, [300, 300, 300, 300, 5000, 5000], "a page that keeps dying is reloaded more slowly, never abandoned");
});
test("overlay main.cjs: crash and hang handlers are wired, poll cannot throw out, errors only log", () => {
  const src = readFileSync(join(ROOT, "overlay", "main.cjs"), "utf8");
  for (const needle of ['"uncaughtException"', '"unhandledRejection"', '"render-process-gone"', '"unresponsive"', '"did-fail-load"', "forcefullyCrashRenderer", "replayBacklog", "readNewRows"]) assert.ok(src.includes(needle), needle);
  assert.match(src, /function poll\(\) \{\s*try \{/);
});
test("log: sweepLive removes stale live.jsonl from old calls, never the current call or a fresh one", () => {
  const calls = mkdtempSync(join(tmpdir(), "wm-sweep-"));
  for (const id of ["old", "cur", "fresh"]) { mkdirSync(join(calls, id)); writeFileSync(join(calls, id, "live.jsonl"), "{}\n"); }
  const past = new Date(Date.now() - 3600_000); utimesSync(join(calls, "old", "live.jsonl"), past, past); utimesSync(join(calls, "cur", "live.jsonl"), past, past);
  assert.equal(sweepLive(calls, "cur"), 1);
  assert.ok(!existsSync(join(calls, "old", "live.jsonl")) && existsSync(join(calls, "cur", "live.jsonl")) && existsSync(join(calls, "fresh", "live.jsonl")));
  rmSync(calls, { recursive: true, force: true });
});

// ---------------------------------------------------------------- engine runs (real run.ts, scripted STT + AI)
const scriptFile = (dir: string, lines: unknown[]) => { const f = join(dir, "script.json"); writeFileSync(f, JSON.stringify(lines)); return f; };
const readRows = (dir: string, f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }) : []);
const callDir = (calls: string) => { const d = readdirSync(calls).filter((x) => x !== "latest"); return d.length ? join(calls, d[0]) : ""; };
function runEngine(args: string[], env: Record<string, string>) {
  const p = spawn(...tsx([join(ROOT, "src", "run.ts"), "--profile", "e2e", "--no-brief", ...args]), { cwd: ROOT, env: { ...process.env, WINGMAN_CALL_APP: "none", ...env } });
  let out = ""; p.stdout.on("data", (b) => (out += b)); p.stderr.on("data", (b) => (out += b));
  const done = new Promise<number | null>((res) => p.on("exit", (c) => res(c)));
  return { p, done, out: () => out };
}
const Q = (speaker: string, text: string, atMs: number) => ({ speaker, text, atMs });

test("engine: cards.jsonl cannot be written (disk full) and the answer-window pipe still gets the cards, the write-failure bar and the low-space bar", { timeout: 60_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "wm-disk-")); const calls = join(tmp, "calls"); mkdirSync(calls);
  const wav = join(tmp, "s.wav"); await writeWav(wav, Buffer.alloc(16000 * 2 * 2 * 9), 2);
  const rows: any[] = [];
  const sock = pipe.endpoint(`rel-${process.pid}-${Date.now()}`, join(tmp, "c.sock")); const lines = new LineSplitter();
  const srv = createServer((c) => c.on("data", (b) => { for (const l of lines.push(b)) rows.push(JSON.parse(l)); })); srv.listen(sock);
  const e = runEngine(["--file", wav], { WINGMAN_CALLS_DIR: calls, WINGMAN_OVERLAY_SOCK: sock, WINGMAN_FREE_BYTES: String(50 * 1024 * 1024),
    WINGMAN_STT_SCRIPT: scriptFile(tmp, [Q("them", "האתר שלי נטען ממש לאט, למה זה קורה", 1500), Q("them", "וגם אני רוצה לדעת אם יש לכם גיבוי של האתר", 4000)]) });
  try {
    // sabotage: as soon as the call folder exists, make cards.jsonl a directory so every append fails (EISDIR) for the rest of the call
    await until(() => !!callDir(calls), 20_000);
    const dir = callDir(calls); const cf = join(dir, "cards.jsonl");
    for (let i = 0; i < 100; i++) { try { rmSync(cf, { force: true }); mkdirSync(cf); break; } catch { await sleep(5); } }
    assert.equal(await e.done, 0, e.out());
    const bank = rows.filter((r) => r.type === "card" && r.badge === "bank");
    assert.ok(bank.some((r) => /איטי/.test(r.say)) && bank.some((r) => /גיבוי/.test(r.say)), "answers reached the window by the pipe: " + JSON.stringify(rows.map((r) => r.id)));
    assert.ok(rows.some((r) => r.id === "health-disk-space" && r.level === "red" && !r.clear), "low-space bar (red under 100 MB)");
    assert.ok(rows.some((r) => r.id === "health-disk" && !r.clear), "write-failure bar went by the pipe too, though it cannot be on disk");
    assert.ok(!existsSync(cf) || readdirSync(cf).length === 0, "nothing was written to cards.jsonl");
    assert.ok(readRows(dir, "events.jsonl").some((x) => x.type === "disk.free" && x.level === "red"), "disk.free event");
  } finally { e.p.kill("SIGKILL"); srv.close(); rmSync(tmp, { recursive: true, force: true }); }
});

test("engine: a handler that throws is survived (error.survived) and the call goes on and ends cleanly", { timeout: 60_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "wm-surv-")); const calls = join(tmp, "calls"); mkdirSync(calls);
  const wav = join(tmp, "s.wav"); await writeWav(wav, Buffer.alloc(16000 * 2 * 2 * 8), 2);
  const e = runEngine(["--file", wav], { WINGMAN_CALLS_DIR: calls, WINGMAN_STT_SCRIPT: scriptFile(tmp, [
    { speaker: "them", text: 12345, atMs: 800 },          // a number where text should be: a core handler throws on it
    Q("them", "האתר שלי נטען ממש לאט, למה זה קורה", 2500), Q("them", "וגם אני רוצה לדעת אם יש לכם גיבוי של האתר", 4500)]) });
  try {
    assert.equal(await e.done, 0, e.out());
    const dir = callDir(calls), ev = readRows(dir, "events.jsonl"), cards = readRows(dir, "cards.jsonl");
    assert.ok(ev.some((x) => x.type === "error.survived" && /^(onResult|acceptResult|stt result)/.test(x.where ?? "")), "survived error logged by a core handler: " + JSON.stringify(ev.filter((x) => /error/.test(x.type)).map((x) => [x.type, x.where, String(x.error).slice(0, 120)])) + e.out().slice(-600));
    assert.ok(!ev.some((x) => x.type === "crash"), "no crash");
    assert.ok(cards.some((c) => c.badge === "bank" && /איטי/.test(c.say)) && cards.some((c) => c.badge === "bank" && /גיבוי/.test(c.say)), "later questions still answered");
    assert.equal(JSON.parse(readFileSync(join(dir, "call.json"), "utf8")).crashed, false);
  } finally { e.p.kill("SIGKILL"); rmSync(tmp, { recursive: true, force: true }); }
});

test("engine: a refused STT key on the other side goes to rung 4 with a red bar, is retried, recovers; the call is never shut down", { timeout: 90_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "wm-stt-")); const calls = join(tmp, "calls"); mkdirSync(calls);
  const wav = join(tmp, "s.wav"); await writeWav(wav, Buffer.alloc(16000 * 2 * 2 * 20), 2);
  const e = runEngine(["--file", wav], { WINGMAN_CALLS_DIR: calls, WINGMAN_STT_FAIL: "them:401@3000", WINGMAN_STT_HEAL_AT_MS: "9000", WINGMAN_STT_SLOW_RETRY_MS: "1500",
    WINGMAN_STT_SCRIPT: scriptFile(tmp, [Q("them", "האתר שלי נטען ממש לאט, למה זה קורה", 700), Q("me", "אני בודק את זה עכשיו", 6000), Q("them", "וגם אני רוצה לדעת אם יש לכם גיבוי של האתר", 14000)]) });
  try {
    assert.equal(await e.done, 0, e.out());
    const dir = callDir(calls), ev = readRows(dir, "events.jsonl"), cards = readRows(dir, "cards.jsonl");
    assert.ok(ev.some((x) => x.type === "stt.permanent" && x.ch === "them" && x.kind === "auth"), "permanent failure noticed");
    assert.ok(cards.some((c) => c.id === "health-stt-them" && c.level === "red" && !c.clear), "red bar");
    const lad = ev.filter((x) => x.type === "ladder");
    assert.ok(lad.some((x) => x.to === 4), "rung 4 (transcript-only)");
    assert.ok(!lad.some((x) => x.to === 5), "never rung 5");
    assert.ok(ev.filter((x) => x.type === "stt.retry.fail" && x.ch === "them").length >= 2, "kept retrying");
    assert.ok(ev.some((x) => x.type === "stt.recovered" && x.ch === "them"), "recovered when the key worked again");
    assert.ok(lad.at(-1)?.to === 0, "ladder back to full: " + JSON.stringify(lad.map((x) => x.to)));
    assert.ok(cards.some((c) => c.badge === "bank" && /גיבוי/.test(c.say)), "after recovery the other side gets cards again");
    assert.ok(ev.some((x) => x.type === "transcript" || true) && readRows(dir, "transcript.jsonl").some((t) => t.ch === "me"), "the user's channel kept working");
    assert.equal(JSON.parse(readFileSync(join(dir, "call.json"), "utf8")).crashed, false);
  } finally { e.p.kill("SIGKILL"); rmSync(tmp, { recursive: true, force: true }); }
});

// ---- live mode with a fake ffmpeg on PATH (the real MicSource/SupervisedSource/run.ts wiring, no audio hardware)
function fakeFfmpeg(tmp: string) {
  const bin = join(tmp, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "ffmpeg"), `#!/usr/bin/env node
const fs = require("fs"); const a = process.argv.slice(2); const dev = a[a.indexOf("-i") + 1];
const dir = process.env.FAKE_FFMPEG_DIR; const kind = dev.includes("sys") ? "sys" : "mic";
const f = dir + "/" + kind + ".count"; let n = 0; try { n = +fs.readFileSync(f, "utf8"); } catch {} fs.writeFileSync(f, String(n + 1));
fs.appendFileSync(dir + "/launches.log", kind + " " + dev + " " + n + "\\n");
// mic: first launch dies after 3 s (AirPods dropped). sys: first two launches cannot start (exit 1 at once).
if (kind === "sys" && n < 2) { process.stderr.write("device not found\\n"); process.exit(1); }
const chunk = Buffer.alloc(3200); for (let i = 0; i < 1600; i++) chunk.writeInt16LE(Math.round(8000 * Math.sin(i / 8)), i * 2);
const t = setInterval(() => process.stdout.write(chunk), 100);
if (kind === "mic" && n === 0 && !process.env.FAKE_MIC_STAYS) setTimeout(() => { clearInterval(t); process.exit(1); }, 3000);
process.on("SIGINT", () => process.exit(255)); process.on("SIGTERM", () => process.exit(255));
`); chmodSync(join(bin, "ffmpeg"), 0o755);
  const settings = join(tmp, "user.yaml");
  writeFileSync(settings, `audio:\n  mic:\n    device: ":fakemic"\n  system:\n    source: device\n    device: ":fakesys"\nsystem:\n  caffeinate: false\nbudget:\n  idleStopMin: 1\n`);
  return { bin, settings };
}
const stopSoon = async (e: ReturnType<typeof runEngine>, afterMs: number) => { await sleep(afterMs); e.p.kill("SIGINT"); return e.done; };

test("engine (live, fake ffmpeg): mic drops and returns, the other side's audio cannot start at first; the call stays up, bars appear and clear", { timeout: 90_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "wm-live-")); const calls = join(tmp, "calls"); mkdirSync(calls);
  const { bin, settings } = fakeFfmpeg(tmp);
  const e = runEngine([], { WINGMAN_CALLS_DIR: calls, PATH: `${bin}:${process.env.PATH}`, FAKE_FFMPEG_DIR: tmp, WINGMAN_USER_SETTINGS: settings,
    WINGMAN_STT_SCRIPT: scriptFile(tmp, [Q("them", "האתר שלי נטען ממש לאט, למה זה קורה", 700), Q("them", "וגם אני רוצה לדעת אם יש לכם גיבוי של האתר", 11000)]) });
  try {
    const code = await stopSoon(e, 14_000);
    assert.equal(code, 0, e.out());
    const dir = callDir(calls), ev = readRows(dir, "events.jsonl"), cards = readRows(dir, "cards.jsonl");
    const down = (s: string) => ev.filter((x) => x.type === "audio.down" && x.src === s), up = (s: string) => ev.filter((x) => x.type === "audio.up" && x.src === s);
    assert.ok(down("sys").length >= 2 && up("sys").length === 1, "system audio: 2 failed starts, then up " + JSON.stringify(ev.filter((x) => /^audio/.test(x.type))));
    assert.ok(down("mic").length >= 1 && up("mic").length === 1, "mic: dropped once, came back");
    const bar = (id: string) => cards.filter((c) => c.id === id);
    assert.ok(bar("health-mic").some((c) => c.level === "red") && bar("health-mic").at(-1).clear, "mic bar red, then cleared");
    assert.ok(bar("health-sys").some((c) => c.level === "red") && bar("health-sys").at(-1).clear, "sys bar red, then cleared");
    assert.ok(ev.some((x) => x.type === "ladder" && x.to === 4 && x.reasons.includes("other side not heard")), "degraded to transcript-only while the other side was missing");
    assert.ok(ev.filter((x) => x.type === "ladder").at(-1)?.to === 0, "and recovered");
    assert.ok(cards.some((c) => c.badge === "bank" && /גיבוי/.test(c.say)), "a card after the recovery");
    assert.ok(!ev.some((x) => x.type === "crash"));
    const launches = readFileSync(join(tmp, "launches.log"), "utf8").trim().split("\n");
    assert.ok(launches.filter((l) => l.startsWith("sys")).length === 3 && launches.filter((l) => l.startsWith("mic")).length >= 2, launches.join(" | "));
    assert.ok(!existsSync(join(dir, "live.jsonl")), "live.jsonl removed at shutdown");
  } finally { e.p.kill("SIGKILL"); rmSync(tmp, { recursive: true, force: true }); }
});

test("engine (live): a sleep gap (wall clock jumps 20 min, monotonic does not) restarts audio and STT and does not trip the 1-minute idle stop", { timeout: 90_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "wm-sleep-")); const calls = join(tmp, "calls"); mkdirSync(calls);
  const { bin, settings } = fakeFfmpeg(tmp);
  const preload = join(tmp, "skew.mjs");   // Date.now() jumps forward 20 minutes 7 s after start; performance.now() (monotonic) is untouched = what a Mac sleep looks like
  writeFileSync(preload, `const real = Date.now.bind(Date), t0 = real(); Date.now = () => { const n = real(); return n - t0 > 7000 ? n + 20 * 60000 : n; };\n`);
  const e = runEngine([], { WINGMAN_CALLS_DIR: calls, PATH: `${bin}:${process.env.PATH}`, FAKE_FFMPEG_DIR: tmp, FAKE_MIC_STAYS: "1", WINGMAN_USER_SETTINGS: settings, NODE_OPTIONS: `--import ${preload}`,
    WINGMAN_STT_SCRIPT: scriptFile(tmp, [Q("them", "האתר שלי נטען ממש לאט, למה זה קורה", 700)]) });
  try {
    const code = await stopSoon(e, 16_000);
    assert.equal(code, 0, e.out());
    const dir = callDir(calls), ev = readRows(dir, "events.jsonl");
    const gap = ev.find((x) => x.type === "sleep.gap"); assert.ok(gap && gap.ms > 15 * 60_000, "sleep detected: " + JSON.stringify(gap));
    assert.ok(ev.some((x) => x.type === "wake.recover"), "wake recovery ran");
    assert.ok(ev.filter((x) => x.type === "audio.restart" && x.reason === "wake").length === 2, "both audio sources rebuilt");
    assert.ok(ev.filter((x) => x.type === "stt.recovered").length >= 2, "both STT channels reopened");
    assert.ok(!ev.some((x) => x.type === "idle.stop"), "the 20 wall-clock minutes did not count as silence");
    assert.ok(readRows(dir, "cards.jsonl").some((c) => c.id === "health-sleep"), "amber sleep bar");
  } finally { e.p.kill("SIGKILL"); rmSync(tmp, { recursive: true, force: true }); }
});

test("engine (live): the menu-bar app's pipe closing mid-call does not end a live call (it stops itself after 5 quiet minutes); before listening starts it stops cleanly", { timeout: 60_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "wm-orphan-")); const calls = join(tmp, "calls"); mkdirSync(calls);
  const { bin, settings } = fakeFfmpeg(tmp);
  const e = runEngine([], { WINGMAN_CALLS_DIR: calls, WINGMAN_CONTROL: "1", PATH: `${bin}:${process.env.PATH}`, FAKE_FFMPEG_DIR: tmp, FAKE_MIC_STAYS: "1", WINGMAN_USER_SETTINGS: settings,
    WINGMAN_STT_SCRIPT: scriptFile(tmp, [Q("them", "האתר שלי נטען ממש לאט, למה זה קורה", 700)]) });
  try {
    await until(() => /"ev":"consented"/.test(e.out()), 30_000);
    e.p.stdin.end();                                  // the tray died without sending "stop"
    await sleep(3000);
    assert.equal(e.p.exitCode, null, "still running");
    const dir = callDir(calls);
    await until(() => readRows(dir, "events.jsonl").some((x) => x.type === "control.closed" && x.live === true), 5000);
    await until(() => readRows(dir, "cards.jsonl").some((c) => c.id === "health-control"), 5000);
    e.p.kill("SIGINT");
    assert.equal(await e.done, 0, e.out());
  } finally { e.p.kill("SIGKILL"); rmSync(tmp, { recursive: true, force: true }); }
});
