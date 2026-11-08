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
