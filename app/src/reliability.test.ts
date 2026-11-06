// Live-call reliability, unit level: audio source supervisor (fake sources), STT retry and ladder, disk and clock checks, row relay, overlay resilience.
// The engine runs of the same features (a real run.ts child) are in e2e/engine-reliability.test.ts.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, appendFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./env.ts";
import { SupervisedSource, pickMicDevice, AUDIO_BACKOFF_MS, type Source } from "./audio.ts";
import { decide, NO_SIGNALS, HealthSupervisor, sttRetryDelayMs, isPermanentSttError } from "./health.ts";
import { detectGap } from "./clock.ts";
import { diskLevel, diskText, DISK_AMBER_BYTES, DISK_RED_BYTES } from "./diskspace.ts";
import { LineSplitter, RowRelay, nextRestartCount, listenForRows, CardPipe } from "./relay.ts";
import { sweepLive } from "./log.ts";
import { ProviderError } from "./providers/errors.ts";

const require = createRequire(import.meta.url);
const R = require("../overlay/resilient.cjs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await sleep(20);
  }
};

// ---------------------------------------------------------------- supervisor (fake sources)
class Fake extends EventEmitter implements Source {
  started = false;
  stopped = false;
  constructor(private o: { failStart?: boolean; frames?: boolean } = {}) {
    super();
  }
  async start() {
    if (this.o.failStart) throw new Error("cannot start");
    this.started = true;
    if (this.o.frames !== false) {
      this.timer = setInterval(() => this.emit("pcm", Buffer.alloc(3200)), 10);
    }
  }
  timer?: NodeJS.Timeout;
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
  }
  die(msg = "exited") {
    clearInterval(this.timer);
    this.emit("error", new Error(msg));
  }
}
const fast = () => 20;

test("supervisor: a start failure does not reject; it retries, then reports up when frames flow", async () => {
  const made: Fake[] = [];
  const seen: number[] = [];
  const s = new SupervisedSource({
    name: "t",
    backoff: fast,
    make: (failures) => {
      seen.push(failures);
      const f = new Fake({ failStart: made.length < 2 });
      made.push(f);
      return f;
    },
  });
  const ev: string[] = [];
  s.on("down", () => ev.push("down"));
  s.on("up", () => ev.push("up"));
  let pcm = 0;
  s.on("pcm", () => pcm++);
  await s.start(); // must not throw
  await until(() => ev.includes("up"));
  assert.deepEqual(ev, ["down", "down", "up"]);
  assert.deepEqual(seen, [0, 1, 2], "make() sees the consecutive failure count, so a device can be looked up again");
  assert.ok(pcm > 0 && !s.down);
  await s.stop();
  assert.ok(made.at(-1)!.stopped);
});

test("supervisor: the source exits mid-call and comes back; the dead one is stopped and ignored", async () => {
  const made: Fake[] = [];
  const s = new SupervisedSource({
    name: "t",
    backoff: fast,
    make: () => {
      const f = new Fake();
      made.push(f);
      return f;
    },
  });
  const ev: string[] = [];
  s.on("down", (d) => ev.push("down:" + d.reason));
  s.on("up", () => ev.push("up"));
  await s.start();
  await until(() => s.frames > 3);
  made[0].die("ffmpeg mic exited 1");
  await until(() => ev.includes("up"));
  assert.deepEqual(ev, ["down:ffmpeg mic exited 1", "up"]);
  assert.equal(made.length, 2);
  assert.ok(made[0].stopped);
  const before = s.frames;
  made[0].emit("pcm", Buffer.alloc(3200));
  assert.equal(s.frames, before, "frames of a replaced source are ignored");
  await s.stop();
});

test("supervisor: a source that goes quiet (device vanished, process alive) is restarted", async () => {
  const made: Fake[] = [];
  const s = new SupervisedSource({
    name: "t",
    backoff: fast,
    stallMs: 200,
    make: () => {
      const f = new Fake({ frames: made.length > 0 });
      made.push(f);
      return f;
    },
  });
  const ev: string[] = [];
  s.on("down", (d) => ev.push(d.reason));
  s.on("up", () => ev.push("up"));
  await s.start();
  await until(() => ev.includes("up"));
  assert.match(ev[0], /no audio for/);
  await s.stop();
});

test("supervisor: restart(wake) rebuilds at once; stop() ends retries", async () => {
  const made: Fake[] = [];
  const s = new SupervisedSource({
    name: "t",
    backoff: () => 5000,
    make: () => {
      const f = new Fake();
      made.push(f);
      return f;
    },
  });
  await s.start();
  await until(() => s.frames > 2);
  s.restart("wake");
  await until(() => made.length === 2); // immediate: no backoff for a deliberate restart
  await until(() => !s.down);
  made[1].die("x"); // backoff 5 s now pending
  await s.stop();
  await sleep(50);
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
  assert.equal(d.rung, 4);
  assert.match(d.reasons[0], /transcription/);
  assert.equal(decide({ ...NO_SIGNALS, fatal: "consent withdrawn" }).rung, 5, "rung 5 stays for a user stop / withdrawn consent");
  const now = { t: 0 };
  const s = new HealthSupervisor({ tickMs: 1000, recoverStableMs: 60_000, slowMs: 1500, slowSttMs: 1500, minSamples: 3 }, () => now.t);
  s.set({ themSttDown: true });
  s.tick();
  assert.equal(s.rung, 4);
  assert.equal(s.caps.meAns, true, "the user's own questions still get answers");
  s.set({ themSttDown: false });
  now.t += 2500;
  s.tick();
  assert.equal(s.rung, 0, "recovers within seconds, not the stable minute");
});
test("stt retry: fast backoff, then every 30 s once permanent; unknown is transient", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 9].map((n) => sttRetryDelayMs(n, false)),
    [1000, 2000, 4000, 8000, 10_000, 10_000],
  );
  assert.equal(sttRetryDelayMs(0, true), 30_000);
  assert.equal(sttRetryDelayMs(7, true), 30_000);
  assert.equal(isPermanentSttError(new ProviderError("auth", "deepgram", "401")), true);
  assert.equal(isPermanentSttError(new ProviderError("quota", "deepgram", "402")), true);
  assert.equal(isPermanentSttError(new ProviderError("unknown", "deepgram", "???")), false);
  assert.equal(isPermanentSttError(new ProviderError("network", "deepgram", "down")), false);
});
test("disk: amber under 500 MB, red under 100 MB, unknown is ok", () => {
  assert.equal(diskLevel(null), "ok");
  assert.equal(diskLevel(DISK_AMBER_BYTES), "ok");
  assert.equal(diskLevel(DISK_AMBER_BYTES - 1), "amber");
  assert.equal(diskLevel(DISK_RED_BYTES), "amber");
  assert.equal(diskLevel(DISK_RED_BYTES - 1), "red");
  assert.match(diskText("red", 50 * 1024 * 1024), /50 MB/);
});
test("clock: a sleep (wall moved, monotonic did not) is found; normal ticks and backwards clocks are not sleeps", () => {
  const p = { wall: 1_000_000, mono: 5000 };
  assert.equal(detectGap(p, { wall: p.wall + 1000, mono: p.mono + 1000 }, 5000, 1000).kind, null);
  assert.deepEqual(detectGap(p, { wall: p.wall + 600_000, mono: p.mono + 1000 }, 5000, 1000), { kind: "sleep", ms: 600_000 });
  assert.equal(detectGap(p, { wall: p.wall + 30_000, mono: p.mono + 30_000 }, 5000, 1000).kind, "sleep", "process frozen on a clock that keeps counting");
  assert.equal(
    detectGap(p, { wall: p.wall - 3_600_000, mono: p.mono + 1000 }, 5000, 1000).kind,
    "clock-back",
    "clock set backwards: not a sleep, never an idle stop",
  );
  assert.equal(detectGap(p, { wall: p.wall + 600_000, mono: p.mono + 1000 }, 0, 1000).kind, null, "sleepGapMs 0 = off");
});

// ---------------------------------------------------------------- relay + overlay helpers
test("relay: lines split across chunks, the last rows are replayed to a restarted window, restart counter heals", () => {
  const ls = new LineSplitter();
  assert.deepEqual(ls.push('{"a":1}\n{"b"'), ['{"a":1}']);
  assert.deepEqual(ls.push(":2}\n"), ['{"b":2}']);
  const got: string[] = [];
  const sink = {
    writable: true,
    destroyed: false,
    write: (l: string, cb?: () => void) => {
      got.push(l);
      cb?.();
      return true;
    },
  } as any;
  const r = new RowRelay(2);
  r.feed('{"n":1}\n{"n":2}\n{"n":3}\n');
  r.attach(sink);
  assert.deepEqual(got, ['{"n":2}\n', '{"n":3}\n'], "only the last `keep` rows, in order");
  r.feed('{"n":4}\n');
  assert.equal(got.at(-1), '{"n":4}\n');
  r.detach();
  r.feed('{"n":5}\n');
  assert.equal(got.length, 3);
  assert.equal(nextRestartCount(3, 11 * 60_000), 0);
  assert.equal(nextRestartCount(3, 30_000), 3);
});
test("relay: CardPipe -> private socket -> RowRelay (what call.ts and run.ts do)", async () => {
  const got: string[] = [];
  const relay = new RowRelay();
  relay.attach({
    writable: true,
    destroyed: false,
    write: (l: string) => {
      got.push(l);
      return true;
    },
  } as any);
  const l = listenForRows(relay)!;
  assert.ok(l && existsSync(l.path));
  await until(() => l.server.listening);
  const pipe = new CardPipe(l.path);
  pipe.send({ type: "card", id: "x", say: "שלום" });
  await until(() => got.length === 1);
  assert.deepEqual(JSON.parse(got[0]), { type: "card", id: "x", say: "שלום" });
  pipe.close();
  l.close();
  assert.ok(!existsSync(l.path));
  new CardPipe(join(tmpdir(), "no-such.sock")).send({ a: 1 }); // never throws
});
test("overlay: readNewRows caps each tick, waits for half rows, skips a giant row, survives a missing file, closes its fd", () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-ov-"));
  const f = join(dir, "cards.jsonl");
  const tail = { file: f, offset: 0 };
  assert.deepEqual(R.readNewRows(tail), [], "no file yet");
  const row = (i: number) => JSON.stringify({ i, pad: "x".repeat(90) }) + "\n";
  for (let i = 0; i < 20; i++) appendFileSync(f, row(i));
  const a = R.readNewRows(tail, 1000);
  assert.ok(a.length > 0 && a.length < 20, `capped: ${a.length}`);
  const b = R.readNewRows(tail, 1000),
    c = R.readNewRows(tail, 1000);
  assert.deepEqual(
    [...a, ...b, ...c].map((r: any) => r.i),
    Array.from({ length: 20 }, (_, i) => i),
    "nothing lost or doubled across ticks",
  );
  appendFileSync(f, '{"half":');
  assert.deepEqual(R.readNewRows(tail), []);
  appendFileSync(f, "1}\n");
  assert.deepEqual(R.readNewRows(tail), [{ half: 1 }]);
  appendFileSync(f, "y".repeat(3000) + "\n" + row(99));
  const got: any[] = [];
  for (let k = 0; k < 10; k++) got.push(...R.readNewRows(tail, 1000));
  assert.ok(
    got.some((r) => r.i === 99),
    "a row bigger than the cap is skipped, the next one still arrives",
  );
  writeFileSync(f, row(7));
  assert.equal(R.readNewRows(tail)[0].i, 7, "replaced (shorter) file is read from the start");
  const fds0 = readdirSync("/dev/fd").length;
  for (let k = 0; k < 200; k++) R.readNewRows(tail);
  assert.ok(readdirSync("/dev/fd").length <= fds0 + 1, "no fd leak");
  rmSync(dir, { recursive: true, force: true });
});
test("overlay: the same card by disk and by pipe is shown once; changed content of the same id is shown", () => {
  const seen = new R.Seen(3);
  const card = { type: "card", id: "c1", say: "a", t: 5 };
  assert.equal(seen.add(R.rowKey(card)), true);
  assert.equal(seen.add(R.rowKey(JSON.parse(JSON.stringify(card)))), false, "same row via the other path");
  assert.equal(seen.add(R.rowKey({ ...card, say: "b", t: 6 })), true, "an update of the card is a new row");
  for (let i = 0; i < 5; i++) seen.add("k" + i);
  assert.equal(seen.size, 3, "bounded");
  const p = new R.StdinRows();
  assert.deepEqual(p.push('{"a":1}\nnot json\n{"b"'), [{ a: 1 }]);
  assert.deepEqual(p.push(":2}\n"), [{ b: 2 }]);
  // A Hebrew letter split across two pipe reads stays whole.
  const row = Buffer.from(JSON.stringify({ text: "שלום עולם" }) + "\n");
  const cut = row.indexOf(Buffer.from("ש")) + 1;
  const q = new R.StdinRows();
  assert.deepEqual(q.push(row.subarray(0, cut)), []);
  assert.deepEqual(q.push(row.subarray(cut)), [{ text: "שלום עולם" }]);
  const bl = new R.Backlog(2);
  bl.add(1);
  bl.add(2);
  bl.add(3);
  assert.deepEqual(bl.all(), [2, 3]);
  let t = 0;
  const g = new R.ReloadGate(() => t);
  const waits = [];
  for (let i = 0; i < 6; i++) {
    waits.push(g.next());
    t += 1000;
  }
  assert.deepEqual(waits, [300, 300, 300, 300, 5000, 5000], "a page that keeps dying is reloaded more slowly, never abandoned");
});
test("overlay main.cjs: crash and hang handlers are wired, poll cannot throw out, errors only log", () => {
  const src = readFileSync(join(ROOT, "overlay", "main.cjs"), "utf8");
  for (const needle of [
    '"uncaughtException"',
    '"unhandledRejection"',
    '"render-process-gone"',
    '"unresponsive"',
    '"did-fail-load"',
    "forcefullyCrashRenderer",
    "replayBacklog",
    "readNewRows",
  ])
    assert.ok(src.includes(needle), needle);
  assert.match(src, /function poll\(\) \{\s*try \{/);
});
test("log: sweepLive removes stale live.jsonl from old calls, never the current call or a fresh one", () => {
  const calls = mkdtempSync(join(tmpdir(), "wm-sweep-"));
  for (const id of ["old", "cur", "fresh"]) {
    mkdirSync(join(calls, id));
    writeFileSync(join(calls, id, "live.jsonl"), "{}\n");
  }
  const past = new Date(Date.now() - 3600_000);
  utimesSync(join(calls, "old", "live.jsonl"), past, past);
  utimesSync(join(calls, "cur", "live.jsonl"), past, past);
  assert.equal(sweepLive(calls, "cur"), 1);
  assert.ok(!existsSync(join(calls, "old", "live.jsonl")) && existsSync(join(calls, "cur", "live.jsonl")) && existsSync(join(calls, "fresh", "live.jsonl")));
  rmSync(calls, { recursive: true, force: true });
});
