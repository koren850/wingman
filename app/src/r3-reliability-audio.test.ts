// r3-reliability: audio start order. The mic watch arms after the mic has started, stoppers exist before the starts are awaited, a start has a timeout.
import "./test-setup.ts";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { MicWatch } from "./engine/mic-watch.ts";
import { startSources } from "./engine/start-sources.ts";
import { MicSource, liveAudioChildren, killAudioChildren } from "./audio.ts";

/** mock timers jump the clock to the end of one tick(), so advance in 1 s steps like real time. */
const adv = (ms: number) => {
  for (let t = 0; t < ms; t += 1000) mock.timers.tick(Math.min(1000, ms - t));
};
const mkWatch = (log: string[], stopping = () => false) =>
  new MicWatch({
    intervalMs: 1000,
    micPeak: 0.01,
    longSilentMs: 5000,
    shuttingDown: stopping,
    onNever: () => log.push("never"),
    onLong: () => log.push("long"),
    onHeard: () => log.push("heard"),
  });

test("mic watch: a slow mic start raises no 'never heard' bar", () => {
  mock.timers.enable({ apis: ["setInterval", "Date"] });
  try {
    const log: string[] = [];
    const w = mkWatch(log);
    w.consent(); // the user is listening at once, but audiotee needs 20 s to come up
    adv(20_000);
    assert.deepEqual(log, [], "the clock has not started");
    assert.equal(w.armed, false);
    w.micStarted();
    assert.equal(w.armed, true);
    adv(900);
    assert.deepEqual(log, []);
    adv(200);
    assert.deepEqual(log, ["never"], "a mic that is silent after it started is still reported");
    w.stop();
  } finally {
    mock.timers.reset();
  }
});

test("mic watch: heard frames clear the bar; the order consent/micStarted does not matter", () => {
  mock.timers.enable({ apis: ["setInterval", "Date"] });
  try {
    const log: string[] = [];
    const w = mkWatch(log);
    w.micStarted();
    adv(5000);
    assert.deepEqual(log, [], "not listening yet: nothing is sent, nothing is expected");
    w.consent();
    adv(1000);
    assert.deepEqual(log, ["never"]);
    w.frame(0.2);
    assert.deepEqual(log, ["never", "heard"]);
    adv(10_000);
    assert.deepEqual(log, ["never", "heard", "long"].slice(0, 3), "long silence after it was heard gives the calm line");
    w.stop();
    adv(10_000);
    assert.equal(log.length, 3);
  } finally {
    mock.timers.reset();
  }
});

test("mic watch: stop() before the arm keeps it off", () => {
  const w = mkWatch([]);
  w.stop();
  w.consent();
  w.micStarted();
  assert.equal(w.armed, false);
});

const never = () => new Promise<void>(() => {});

test("startSources: stoppers are registered before the starts are awaited", async () => {
  const stops: (() => Promise<unknown>)[] = [];
  let seen = -1;
  const mic = {
    start: () => {
      seen = stops.length;
      return Promise.resolve();
    },
  };
  const ok = await startSources({ mic, stoppers: [async () => {}, async () => {}], stops, isStopping: () => false, timeoutMs: 1000 });
  assert.equal(ok, true);
  assert.equal(seen, 2);
});

test("startSources: Stop during a hung start finds the stoppers and closes both sources", async () => {
  const stops: (() => Promise<unknown>)[] = [];
  let stopping = false,
    sysStops = 0,
    micStops = 0,
    micStarted = 0;
  const p = startSources({
    sys: { start: never }, // AudioTee.start() never returns
    mic: { start: () => new Promise<void>((r) => setTimeout(r, 30)) },
    stoppers: [async () => void sysStops++, async () => void micStops++],
    stops,
    isStopping: () => stopping,
    timeoutMs: 50,
    onMicStarted: () => micStarted++,
  });
  await new Promise((r) => setTimeout(r, 5));
  stopping = true;
  await Promise.all(stops.map((s) => s())); // what shutdown() does
  assert.equal(sysStops, 1);
  assert.equal(micStops, 1);
  assert.equal(await p, false, "the start sees the Stop after its timeout and closes again (idempotent stoppers)");
  assert.equal(micStarted, 0, "no mic watch is armed for a call that is ending");
});

test("startSources: sys.start has a timeout, the mic still starts, the call goes on", async () => {
  const slow: string[] = [];
  let micStarted = 0;
  const t0 = Date.now();
  const ok = await startSources({
    sys: { start: never },
    mic: { start: () => new Promise<void>((r) => setTimeout(r, 10)) },
    stoppers: [],
    stops: [],
    isStopping: () => false,
    timeoutMs: 80,
    onTimeout: (n) => slow.push(n),
    onMicStarted: () => micStarted++,
  });
  assert.equal(ok, true);
  assert.deepEqual(slow, ["sys"]);
  assert.equal(micStarted, 1);
  assert.ok(Date.now() - t0 < 1000);
});

test("startSources: a start that throws is reported, not raised", async () => {
  const errs: string[] = [];
  const ok = await startSources({
    mic: { start: () => Promise.reject(new Error("boom")) },
    stoppers: [],
    stops: [],
    isStopping: () => false,
    timeoutMs: 100,
    onError: (n, e) => errs.push(`${n}:${(e as Error).message}`),
  });
  assert.equal(ok, true);
  assert.deepEqual(errs, ["mic:boom"]);
});

test("MicSource: a stop that came first means start() spawns no child", async () => {
  const m = new MicSource(":default");
  await m.stop();
  await m.start();
  assert.equal(liveAudioChildren(), 0);
  assert.equal(killAudioChildren(), 0);
});
