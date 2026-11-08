// SttChannel reliability (providers/stt/channel.ts): no stream survives close(), a failed open closes its stream, unsent ring audio is kept,
// the dead timer is not restarted by repeated disconnects, and every open has a time limit. Fake streams only; no sockets.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { SttChannel } from "./providers/stt/channel.ts";
import { SttRetryRegistry } from "./engine/stt-retry.ts";
import { ProviderError } from "./providers/errors.ts";
import { STT_OPEN_TIMEOUT_MS, type SttProvider, type SttStreamLike } from "./providers/stt/types.ts";

type Mode = "ok" | "fail" | "slow" | "blackhole";
class F extends EventEmitter implements SttStreamLike {
  isOpen = false;
  dropped = 0;
  audioSeconds = 0;
  closeCalls = 0;
  got: Buffer[] = [];
  acceptSends = true;
  constructor(private mode: Mode) {
    super();
  }
  async open() {
    if (this.mode === "fail") throw Object.assign(new Error("x"), { statusCode: 503 });
    if (this.mode === "blackhole") return new Promise<void>(() => {});
    if (this.mode === "slow") await new Promise((r) => setTimeout(r, 40));
    this.isOpen = true;
  }
  send(b: Buffer) {
    if (!this.isOpen || !this.acceptSends) return false;
    this.got.push(b);
    return true;
  }
  async close() {
    this.closeCalls++;
    this.isOpen = false;
  }
}
const setup = (mode: Mode | (() => Mode), extra: Partial<ConstructorParameters<typeof SttChannel>[0]> = {}) => {
  const streams: F[] = [];
  const p = {
    id: "deepgram",
    experimental: false,
    capabilities: { keyterms: true, diarize: false, interim: true, maxKeyterms: 100 },
    create: () => {
      const s = new F(typeof mode === "function" ? mode() : mode);
      streams.push(s);
      return s;
    },
    probe: async () => ({ ok: true }),
  } as unknown as SttProvider;
  const ch = new SttChannel({ channel: "them", chain: [p], keyOf: () => "k", base: {}, circuit: { failures: 3, windowMs: 1000 }, ...extra });
  return { ch, streams };
};

test("a failed open closes its stream (3 failed reopens, 3 streams closed)", async () => {
  const { ch, streams } = setup("fail");
  for (let i = 0; i < 3; i++) await ch.reopen().catch(() => {});
  assert.equal(streams.length, 3);
  assert.deepEqual(
    streams.map((s) => s.closeCalls),
    [1, 1, 1],
  );
});

test("reopen that finishes after close() leaves no open stream", async () => {
  const { ch, streams } = setup("slow");
  const p = ch.reopen();
  await ch.close();
  await p;
  assert.equal(ch.isOpen, false);
  assert.ok(streams.every((s) => !s.isOpen && s.closeCalls >= 1));
});

test("open after close() creates no stream at all", async () => {
  const { ch, streams } = setup("ok");
  await ch.close();
  await ch.open();
  assert.equal(streams.length, 0);
  assert.equal(ch.isOpen, false);
});

test("a black-hole open times out at the shared limit and closes the stream", async () => {
  assert.equal(STT_OPEN_TIMEOUT_MS, 8000);
  const { ch, streams } = setup("blackhole", { openTimeoutMs: 50 });
  const t0 = Date.now();
  await assert.rejects(ch.reopen(), (e: { kind?: string }) => e.kind === "timeout");
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(streams[0].closeCalls, 1);
});

test("flushRing keeps the unsent chunks when the socket dies mid-flush", async () => {
  const { ch, streams } = setup("ok", { ringMs: 10_000 });
  await ch.open();
  streams[0].isOpen = false; // socket down: audio goes to the ring
  const chunks = [1, 2, 3, 4].map((n) => Buffer.alloc(3200, n));
  for (const c of chunks) ch.send(c);
  // reopen: the new stream accepts two chunks, then dies
  const second = new F("ok");
  let accepted = 0;
  const orig = second.send.bind(second);
  second.send = (b) => (accepted++ < 2 ? orig(b) : false);
  (ch as unknown as { o: { chain: { create: () => SttStreamLike }[] } }).o.chain[0].create = () => second;
  await ch.reopen();
  assert.deepEqual(
    second.got.map((b) => b[0]),
    [1, 2],
  );
  // the rest is still in the ring and goes out, in order, on the next flush
  second.acceptSends = true;
  accepted = -100;
  ch.send(Buffer.alloc(3200, 9));
  assert.deepEqual(
    second.got.map((b) => b[0]),
    [1, 2, 3, 4, 9],
  );
});

test("repeated disconnected events do not restart the dead timer", async () => {
  const { ch, streams } = setup("ok", { deadAfterMs: 120, circuit: { failures: 1000, windowMs: 1000 } });
  await ch.open();
  const exhausted = new Promise<number>((res) => {
    const t0 = Date.now();
    ch.once("exhausted", () => res(Date.now() - t0));
    setTimeout(() => res(9999), 600).unref();
  });
  streams[0].isOpen = false;
  const iv = setInterval(() => streams[0].emit("disconnected", { channel: "them", code: 1006, reason: "x" }), 30);
  iv.unref();
  const ms = await exhausted;
  clearInterval(iv);
  assert.ok(ms < 300, `exhausted after ${ms} ms`);
  await ch.close();
});

// ---- the reopen loop (engine/stt-retry.ts)

test("a permanent error that arrives while a transient loop runs upgrades that loop (no second loop)", async () => {
  const reg = new SttRetryRegistry();
  const delays: number[] = [];
  let calls = 0;
  const marked: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const loop = reg.run("them", {
    slowMs: 30_000,
    stopped: () => false,
    sleep: async (ms) => {
      delays.push(ms);
      if (delays.length === 1) await gate; // the first wait is where the permanent error arrives
    },
    reopen: async () => {
      calls++;
      if (calls < 3) throw new ProviderError("network", "deepgram", "down");
    },
    onPermanent: (e) => marked.push(e.message),
    onFail: () => {},
    onRecovered: () => {},
  });
  await reg.run("them", {} as never, true); // the "exhausted" handler of a later permanent error
  release();
  await loop;
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 30_000, 30_000], "after the upgrade the loop waits the slow time");
});

test("a reopen that fails with a permanent error switches the running loop to the slow schedule and marks it once", async () => {
  const reg = new SttRetryRegistry();
  const delays: number[] = [];
  const marked: string[] = [];
  let calls = 0;
  await reg.run("them", {
    slowMs: 30_000,
    stopped: () => false,
    sleep: async (ms) => void delays.push(ms),
    reopen: async () => {
      if (++calls < 3) throw new ProviderError(calls === 1 ? "network" : "auth", "deepgram", "x");
    },
    onPermanent: (e) => marked.push(e.message),
    onFail: () => {},
    onRecovered: () => {},
  });
  assert.deepEqual(delays, [1000, 2000, 30_000]);
  assert.equal(marked.length, 1);
});
