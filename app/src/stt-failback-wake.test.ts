// Reliability, unit level: STT failback and the open race, wake without reopening a healthy socket, the tray controller's stdout buffer and
// spawn failure, and the supervisor's wake restart. The fault-injection runs with the real engine are in e2e/fault-injection.test.ts.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SttChannel } from "./providers/stt/channel.ts";
import { ProviderError } from "./providers/errors.ts";
import { SttRetryRegistry } from "./engine/stt-retry.ts";
import { ROOT } from "./env.ts";
import type { SttProvider, SttStreamLike } from "./providers/stt/types.ts";

const { createController } = createRequire(import.meta.url)("../tray/controller.cjs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Fake extends EventEmitter implements SttStreamLike {
  dropped = 0;
  sent = 0;
  isOpen = false;
  closed = false;
  constructor(private openFn: (s: Fake) => Promise<void> | void) {
    super();
  }
  async open() {
    await this.openFn(this);
    this.isOpen = true;
  }
  send(b: Buffer) {
    this.sent += b.length;
    return this.isOpen;
  }
  async close() {
    this.closed = true;
    this.isOpen = false;
  }
  get audioSeconds() {
    return this.sent / 32000;
  }
}
const provider = (id: string, openFn: (s: Fake, n: number) => Promise<void> | void, made: Fake[]): SttProvider => ({
  id: id as never,
  experimental: false,
  capabilities: { keyterms: true, diarize: false, interim: true, maxKeyterms: 100 },
  create: () => {
    const n = made.length;
    const s = new Fake((x) => openFn(x, n));
    made.push(s);
    return s;
  },
  probe: async () => ({ ok: true }),
});
const auth = (id: string) => new ProviderError("auth", id as never, "401");

test("failback: after a 2 s primary outage the channel returns to the primary after the stable period", async () => {
  const a: Fake[] = [],
    b: Fake[] = [];
  let primaryDown = false;
  const ch = new SttChannel({
    channel: "them",
    chain: [
      provider(
        "deepgram",
        () => {
          if (primaryDown) throw new ProviderError("network", "deepgram", "down");
        },
        a,
      ),
      provider("soniox", () => {}, b),
    ],
    keyOf: () => "k",
    base: {},
    circuit: { failures: 1, windowMs: 10_000 },
    failbackAfterMs: 80,
  });
  await ch.open();
  assert.equal(ch.provider, "deepgram");
  primaryDown = true;
  const sw = new Promise((r) => ch.once("switched", r));
  a[0].emit("disconnected", { channel: "them", error: new ProviderError("network", "deepgram", "net") });
  await sw;
  assert.equal(ch.provider, "soniox");
  await sleep(150); // primary still down: stays on the fallback and tries again later
  assert.equal(ch.provider, "soniox");
  primaryDown = false;
  const fb = new Promise<{ from: string; to: string }>((r) => ch.once("failback", r));
  const d = await fb;
  assert.deepEqual(d, { from: "soniox", to: "deepgram" });
  assert.equal(ch.provider, "deepgram");
  assert.equal(ch.isOpen, true);
  assert.equal(b[0].closed, true, "the fallback socket is closed");
  await ch.close();
});

test("failback: a refused key (non-retryable) does not go back to the primary", async () => {
  const a: Fake[] = [],
    b: Fake[] = [];
  const ch = new SttChannel({
    channel: "them",
    chain: [provider("deepgram", () => {}, a), provider("soniox", () => {}, b)],
    keyOf: () => "k",
    base: {},
    circuit: { failures: 3, windowMs: 10_000 },
    failbackAfterMs: 30,
  });
  await ch.open();
  const sw = new Promise((r) => ch.once("switched", r));
  a[0].emit("error", auth("deepgram"), {});
  await sw;
  await sleep(150);
  assert.equal(ch.provider, "soniox");
  assert.equal(a.length, 1, "the primary was not opened again");
  await ch.close();
});

test("open race: an error event during the first open() does not start a second fallback socket", async () => {
  const a: Fake[] = [],
    b: Fake[] = [];
  const ch = new SttChannel({
    channel: "them",
    chain: [
      provider(
        "deepgram",
        async (s) => {
          // like the SDK on a refused handshake: an "error" event first, then the open promise rejects
          queueMicrotask(() => s.emit("error", auth("deepgram"), {}));
          await sleep(20);
          throw auth("deepgram");
        },
        a,
      ),
      provider("soniox", async () => void (await sleep(10)), b),
    ],
    keyOf: () => "k",
    base: {},
    circuit: { failures: 1, windowMs: 10_000 },
  });
  await ch.open();
  await sleep(80);
  assert.equal(b.length, 1, "exactly one fallback socket was created");
  assert.equal(b.filter((s) => !s.closed).length, 1);
  assert.equal(ch.provider, "soniox");
  await ch.close();
});

test("retry registry: a wake-up reopen is skipped when the channel is healthy, and runs when it is not", async () => {
  const reg = new SttRetryRegistry();
  let reopened = 0,
    recovered = 0,
    healthy = true;
  const hooks = () => ({
    reopen: async () => void reopened++,
    stopped: () => false,
    sleep: async () => {},
    slowMs: 1000,
    healthy: () => healthy,
    onPermanent: () => {},
    onFail: () => {},
    onRecovered: () => void recovered++,
  });
  await reg.run("them", hooks(), false, 0);
  assert.equal(reopened, 0, "a healthy socket is not replaced, so finals in flight are not dropped");
  healthy = false;
  await reg.run("them", hooks(), false, 0);
  assert.equal(reopened, 1);
  assert.equal(recovered, 1);
});

test("retry registry: a permanent request takes over a wake loop, which then keeps retrying with the new hooks", async () => {
  const reg = new SttRetryRegistry();
  const calls: string[] = [];
  let release: () => void = () => {};
  let gate = new Promise<void>((r) => (release = r));
  const mk = (name: string, o: { healthy?: () => boolean; slow?: boolean } = {}) => ({
    reopen: async () => void calls.push(`${name}.reopen`),
    stopped: () => false,
    sleep: async () => void (o.slow && (await gate)),
    slowMs: 1000,
    healthy: o.healthy,
    onPermanent: () => {},
    onFail: () => {},
    onRecovered: () => void calls.push(`${name}.recovered`),
  });
  // The wake loop is waiting; the old socket still looks open, so its `healthy` says true.
  const wake = reg.run("them", mk("wake", { healthy: () => true, slow: true }), false, 0);
  await sleep(5);
  // A permanent error arrives (revive on the silent socket failed with a refused key): this request is stronger.
  await reg.run("them", mk("perm"), true);
  assert.equal(reg.has("them"), true, "still one loop");
  release();
  await wake;
  assert.deepEqual(calls, ["perm.reopen", "perm.recovered"], "the wake loop did not leave on `healthy`; it reopened and recovered with the new hooks");
  assert.equal(reg.has("them"), false);
  // A weaker request never replaces a stronger loop.
  const calls2: string[] = [];
  gate = new Promise<void>((r) => (release = r));
  const slowPerm = reg.run("me", { ...mk("p2", { slow: true }), reopen: async () => void calls2.push("p2") }, true);
  await sleep(5);
  await reg.run("me", { ...mk("w2", { healthy: () => true }), reopen: async () => void calls2.push("w2") }, false, 0);
  release();
  await slowPerm;
  assert.deepEqual(calls2, ["p2"]);
});

// ---- tray controller ----
function ctl(spawnImpl?: () => unknown) {
  const spawned: any[] = [];
  const notes: string[] = [];
  const spawn =
    spawnImpl ??
    (() => {
      const c: any = new EventEmitter();
      c.pid = 4242;
      c.stdin = Object.assign(new EventEmitter(), { writable: true, write: () => true });
      c.stdout = new EventEmitter();
      c.stderr = new EventEmitter();
      c.kill = () => {};
      spawned.push(c);
      return c;
    });
  const c = createController({
    spawn,
    root: ROOT,
    tmpDir: mkdtempSync(join(tmpdir(), "wm-r2-ctl-")),
    setTimeout: () => {},
    kill: () => {},
    notify: (t: string) => notes.push(t),
    onChange: () => {},
    env: {},
  });
  return { c, spawned, notes };
}

test("controller: a last status line without a newline is parsed when stdout ends", () => {
  const { c, spawned } = ctl();
  c.start({});
  spawned[0].stdout.emit("data", Buffer.from('@@wingman {"ev":"waiting","id":"01ABC"}'));
  assert.equal(c.getState().phase, "starting", "not complete yet");
  spawned[0].stdout.emit("end");
  assert.equal(c.getState().phase, "waiting");
});

test("controller: an oversized line without a newline is dropped, later lines still work", () => {
  const { c, spawned } = ctl();
  c.start({});
  const out = spawned[0].stdout;
  for (let i = 0; i < 6; i++) out.emit("data", Buffer.alloc(300 * 1024, 120)); // 1.8 MB of "x" with no newline
  out.emit("data", Buffer.from('tail of the long line\n@@wingman {"ev":"waiting","id":"01ABC"}\n'));
  assert.equal(c.getState().phase, "waiting", "the long line is skipped up to its newline; the next line is read");
});

test("controller: a synchronous spawn throw leaves the state idle and tells the user", () => {
  const { c, notes } = ctl(() => {
    throw Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" });
  });
  assert.equal(c.start({}), false);
  assert.notEqual(c.getState().phase, "starting");
  assert.equal(c.getState().phase, "idle");
  assert.ok(notes.some((n) => /could not start/i.test(n)));
  // and a second start works once spawn works again (no stale child)
});

test("failback: close() while waiting for the stable period opens no new socket", async () => {
  const a: Fake[] = [],
    b: Fake[] = [];
  const ch = new SttChannel({
    channel: "them",
    chain: [provider("deepgram", () => {}, a), provider("soniox", () => {}, b)],
    keyOf: () => "k",
    base: {},
    circuit: { failures: 1, windowMs: 10_000 },
    failbackAfterMs: 60,
  });
  await ch.open();
  const sw = new Promise((r) => ch.once("switched", r));
  a[0].emit("disconnected", { channel: "them", error: new ProviderError("network", "deepgram", "net") });
  await sw;
  await ch.close();
  await sleep(150);
  assert.equal(a.length, 1, "no primary socket after close");
});

// A channel runs one socket operation at a time (first open, switch, failback, reopen). These tests start a second one while the first is slow.
const twoProviders = (a: Fake[], b: Fake[], slow: { b: number; a: number }, extra: Partial<ConstructorParameters<typeof SttChannel>[0]> = {}) =>
  new SttChannel({
    channel: "them",
    chain: [
      provider("deepgram", async (_s, n) => void (n > 0 && (await sleep(slow.a))), a),
      provider("soniox", async (_s, n) => void (n > 0 && (await sleep(slow.b))), b),
    ],
    keyOf: () => "k",
    base: {},
    circuit: { failures: 1, windowMs: 10_000 },
    ...extra,
  });
const openCount = (...l: Fake[][]) => l.flat().filter((s) => s.isOpen).length;

test("channel ops: a failback timer that fires during a reopen does not open a second socket", async () => {
  const a: Fake[] = [],
    b: Fake[] = [];
  const slow = { a: 0, b: 0 };
  const ch = twoProviders(a, b, slow, { failbackAfterMs: 40 });
  await ch.open();
  const sw = new Promise((r) => ch.once("switched", r));
  a[0].emit("error", auth("deepgram"), { terminal: true }); // permanent: no failback armed from the switch
  await sw;
  assert.equal(ch.provider, "soniox");
  await sleep(5); // the switch has ended
  (ch as unknown as { armFailback(): void }).armFailback(); // as if the switch had been transient
  slow.b = 200; // the reopen of the fallback is slow
  const re = ch.reopen();
  await sleep(120); // the failback timer fired in the middle of it
  assert.equal(a.length, 1, "no primary socket was opened while the reopen ran");
  await re;
  await sleep(250); // the refused failback was armed again and has gone through now
  assert.equal(ch.provider, "deepgram");
  assert.equal(openCount(a, b), 1, "exactly one socket is open, none leaked");
  await ch.close();
});

test("channel ops: two reopen() calls share one socket", async () => {
  const a: Fake[] = [],
    b: Fake[] = [];
  const ch = twoProviders(a, b, { a: 60, b: 0 });
  await ch.open();
  let reconnected = 0;
  ch.on("reconnected", () => reconnected++);
  await Promise.all([ch.reopen(), ch.reopen()]);
  assert.equal(a.length, 2, "one new socket, not two");
  assert.equal(openCount(a), 1);
  assert.equal(reconnected, 1);
  await ch.close();
});

test("channel ops: a terminal error during a reopen does not start a switch", async () => {
  const a: Fake[] = [],
    b: Fake[] = [];
  const ch = twoProviders(a, b, { a: 80, b: 0 });
  await ch.open();
  const switched: unknown[] = [];
  ch.on("switched", (d) => switched.push(d));
  const re = ch.reopen();
  a[0].emit("error", new ProviderError("network", "deepgram", "gone"), { terminal: true }); // the dead stream's own last words
  await re;
  await sleep(50);
  assert.equal(switched.length, 0);
  assert.equal(b.length, 0, "the fallback was not opened");
  assert.equal(ch.provider, "deepgram");
  assert.equal(openCount(a, b), 1);
  await ch.close();
});

test("channel ops: close() while every fallback fails to open closes the old stream", async () => {
  const a: Fake[] = [];
  const b: Fake[] = [];
  const ch = new SttChannel({
    channel: "them",
    chain: [
      provider("deepgram", () => {}, a),
      provider(
        "soniox",
        async () => {
          await sleep(60);
          throw new ProviderError("network", "soniox", "down");
        },
        b,
      ),
    ],
    keyOf: () => "k",
    base: {},
    circuit: { failures: 1, windowMs: 10_000 },
  });
  await ch.open();
  a[0].emit("error", new ProviderError("network", "deepgram", "gone"), { terminal: true });
  await sleep(10);
  await ch.close(); // the switch is mid-attempt; the old stream is not this.stream right now
  await sleep(120);
  assert.equal(a[0].closed, true, "the old stream is closed after the failed switch");
  assert.equal(openCount(a, b), 0);
});
