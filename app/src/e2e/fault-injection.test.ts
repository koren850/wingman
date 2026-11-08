// Reliability, fault injection: real engine runs (src/run.ts as a child, scripted STT, temp folders) and in-process runs of the audio supervisor.
// Covers: a stray error at Stop, a 10 s hung close, Stop pressed while the STT sockets are still opening, a first channel that fails for good while
// the second is still opening, a hung respawn, and a wake with a vanished device. Nothing here touches real calls, keys or audio devices.
import "../test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeWav, SupervisedSource, type Source } from "../audio.ts";
import { sleep, until, scriptFile, readRows, callDir, runEngine, Q } from "./helpers.ts";

const meta = (dir: string) => JSON.parse(readFileSync(join(dir, "call.json"), "utf8"));

async function fixture(prefix: string) {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  const calls = join(tmp, "calls");
  mkdirSync(calls);
  const wav = join(tmp, "s.wav");
  await writeWav(wav, Buffer.alloc(16000 * 2 * 2 * 30), 2);
  return { tmp, calls, wav, script: scriptFile(tmp, [Q("them", "מה המחיר של האתר", 1500)]) };
}

test("stop with a stray error and a 10 s hung close still writes endedAt, phase ended and the usage row", { timeout: 60_000 }, async () => {
  const f = await fixture("wm-r2-hard-");
  const e = runEngine(["--file", f.wav], {
    WINGMAN_CALLS_DIR: f.calls,
    WINGMAN_STT_SCRIPT: f.script,
    WINGMAN_TEST_SLOW_STOPS: "1x60000", // closing the audio hangs: the 10 s hard timer ends the process
    WINGMAN_TEST_STRAY_AT_STOP: "1",
  });
  try {
    await until(() => !!callDir(f.calls) && !!readRows(callDir(f.calls), "events.jsonl").length, 20_000);
    await sleep(2500);
    const t0 = Date.now();
    e.p.kill("SIGINT");
    const code = await e.done;
    const dir = callDir(f.calls);
    assert.equal(code, 1, "the hard timer exits 1: " + e.out());
    assert.ok(Date.now() - t0 >= 9000, "the stray did not exit the process early: " + (Date.now() - t0));
    const m = meta(dir);
    assert.equal(m.phase, "ended", "call.json is not left at phase live");
    assert.ok(m.endedAt);
    const rows = readRows(dir, "events.jsonl");
    assert.ok(
      rows.some((r) => r.type === "error.survived"),
      "the stray was logged and survived",
    );
    assert.ok(!rows.some((r) => r.type === "crash"), "no crash was started by the stray");
    assert.ok(
      readRows(dir, "usage.jsonl").some((r) => r.role === "stt"),
      "usage row",
    );
  } finally {
    e.p.kill("SIGKILL");
    rmSync(f.tmp, { recursive: true, force: true });
  }
});

test("stop with a stray error at the stop (fast close) ends cleanly with exit 0 and no crash", { timeout: 60_000 }, async () => {
  const f = await fixture("wm-r2-stray-");
  const e = runEngine(["--file", f.wav], {
    WINGMAN_CALLS_DIR: f.calls,
    WINGMAN_STT_SCRIPT: f.script,
    WINGMAN_TEST_STRAY_AT_STOP: "1",
    WINGMAN_TEST_SLOW_STOPS: "1x300",
  });
  try {
    await until(() => !!callDir(f.calls) && !!readRows(callDir(f.calls), "events.jsonl").length, 20_000);
    await sleep(2500);
    e.p.kill("SIGINT");
    assert.equal(await e.done, 0, e.out());
    const dir = callDir(f.calls);
    assert.equal(meta(dir).phase, "ended");
    assert.equal(meta(dir).crashed, false);
    assert.ok(readRows(dir, "events.jsonl").some((r) => r.type === "error.survived" && /stray at stop/.test(r.error ?? "")));
  } finally {
    e.p.kill("SIGKILL");
    rmSync(f.tmp, { recursive: true, force: true });
  }
});

test("a 'stop' written during a slow STT start is handled at once, not after the SIGINT escalation", { timeout: 60_000 }, async () => {
  const f = await fixture("wm-r2-startstop-");
  const e = runEngine(["--file", f.wav], {
    WINGMAN_CALLS_DIR: f.calls,
    WINGMAN_STT_SCRIPT: f.script,
    WINGMAN_CONTROL: "1",
    WINGMAN_STT_HANG: "them", // the other side's socket never answers: startup waits on it
  });
  try {
    await until(() => !!callDir(f.calls), 20_000);
    await sleep(1500);
    const t0 = Date.now();
    e.p.stdin.write("stop\n");
    const code = await e.done;
    assert.equal(code, 0, e.out());
    assert.ok(Date.now() - t0 < 8000, `stop took ${Date.now() - t0} ms`);
    assert.equal(meta(callDir(f.calls)).phase, "ended");
  } finally {
    e.p.kill("SIGKILL");
    rmSync(f.tmp, { recursive: true, force: true });
  }
});

test("a terminal failure of the first channel while the second is still opening starts the retry loop and the red bar", { timeout: 60_000 }, async () => {
  const f = await fixture("wm-r2-slow2-");
  const e = runEngine(["--file", f.wav], {
    WINGMAN_CALLS_DIR: f.calls,
    WINGMAN_STT_SCRIPT: f.script,
    WINGMAN_STT_HANG: "them", // slow second channel
    WINGMAN_STT_FAIL: "me:401@2500", // the first channel's key is refused 2.5 s in (terminal)
  });
  try {
    await until(() => !!callDir(f.calls), 20_000);
    await until(() => readRows(callDir(f.calls), "events.jsonl").some((r) => r.type === "stt.exhausted" && r.ch === "me"), 15_000);
    await until(() => readRows(callDir(f.calls), "events.jsonl").some((r) => r.type === "stt.permanent" && r.ch === "me"), 5000);
    const rows = readRows(callDir(f.calls), "events.jsonl");
    assert.ok(
      rows.some((r) => r.type === "stt.permanent" && r.ch === "me"),
      "the red 'refused' bar path ran for the channel that opened first",
    );
  } finally {
    e.p.kill("SIGKILL");
    await e.done;
    rmSync(f.tmp, { recursive: true, force: true });
  }
});

// ---- audio supervisor, in process ----
class Hang extends EventEmitter implements Source {
  async start() {}
  async stop() {}
}
class Talk extends EventEmitter implements Source {
  t?: NodeJS.Timeout;
  async start() {
    this.t = setInterval(() => this.emit("pcm", Buffer.alloc(3200)), 20);
  }
  async stop() {
    clearInterval(this.t);
  }
}

test("a source that errors once and then hangs is rebuilt again and again until frames flow", { timeout: 20_000 }, async () => {
  let built = 0;
  const sup = new SupervisedSource({
    name: "mic",
    stallMs: 250,
    backoff: () => 20,
    make: () => {
      built++;
      if (built === 1) {
        const s = new Hang();
        s.start = async () => void setTimeout(() => s.emit("error", new Error("device lost")), 10);
        return s;
      }
      return built < 6 ? new Hang() : new Talk();
    },
  });
  const ups: unknown[] = [];
  sup.on("up", (d) => ups.push(d));
  await sup.start();
  try {
    await until(() => ups.length === 1, 15_000);
    assert.ok(built >= 6, `built ${built}`);
    assert.equal(sup.down, false);
  } finally {
    await sup.stop();
  }
});

test("wake with a vanished device: no red bar at the restart; a silent new source is then reported and rebuilt", { timeout: 20_000 }, async () => {
  let built = 0;
  const sup = new SupervisedSource({ name: "mic", stallMs: 250, backoff: () => 20, make: () => (++built === 1 ? new Talk() : new Hang()) });
  const downs: string[] = [];
  sup.on("down", (d) => downs.push(d.reason));
  await sup.start();
  try {
    await until(() => sup.frames > 3);
    sup.restart("wake");
    await sleep(100);
    assert.deepEqual(downs, [], "restart('wake') alone shows nothing");
    await until(() => downs.length > 0, 5000); // the device is gone: the new source never speaks
    await until(() => built >= 4, 5000);
  } finally {
    await sup.stop();
  }
});
void readdirSync;
