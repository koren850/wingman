// Final pass: an open that failed on the primary must try the primary again, and a fallback taken at open must fail back.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { SttChannel } from "./providers/stt/channel.ts";
import { ProviderError } from "./providers/errors.ts";
import type { SttProvider, SttStreamLike } from "./providers/stt/types.ts";

class Fake extends EventEmitter implements SttStreamLike {
  dropped = 0;
  sent = 0;
  isOpen = true;
  closed = false;
  constructor(private fail?: ProviderError) {
    super();
  }
  async open() {
    if (this.fail) throw this.fail;
  }
  send(b: Buffer) {
    this.sent += b.length;
    return true;
  }
  async close() {
    this.closed = true;
  }
  get audioSeconds() {
    return this.sent / 32000;
  }
}
/** A provider whose first `failures` opens fail with a network error, then it works. */
const flaky = (id: string, failures: number): SttProvider & { opens: number } => {
  const p = {
    opens: 0,
    id: id as never,
    experimental: false,
    capabilities: { keyterms: true, diarize: false, interim: true, maxKeyterms: 100 },
    create: () => new Fake(++p.opens <= failures ? new ProviderError("network", id as never, "closed") : undefined),
    probe: async () => ({ ok: true }),
  };
  return p as never;
};
const mk = (chain: SttProvider[], failbackAfterMs = 0) =>
  new SttChannel({ channel: "them", chain, keyOf: () => "k", base: {}, circuit: { failures: 3, windowMs: 10_000 }, failbackAfterMs });

test("channel: a retry of open() starts at the primary again after every provider failed", async () => {
  const a = flaky("deepgram", 1),
    b = flaky("soniox", 1);
  const ch = mk([a, b]);
  await assert.rejects(ch.open());
  await ch.open();
  assert.equal(a.opens, 2, "the primary was tried again");
  assert.equal(ch.provider, "deepgram");
});

test("channel: a fallback taken at open (network failure) fails back to the primary later", async () => {
  const a = flaky("deepgram", 1),
    b = flaky("soniox", 0);
  const ch = mk([a, b], 30);
  const back = new Promise<void>((res) => ch.on("failback", () => res()));
  await ch.open();
  assert.equal(ch.provider, "soniox");
  await Promise.race([back, new Promise((_, rej) => setTimeout(() => rej(new Error("no failback")), 1500))]);
  assert.equal(ch.provider, "deepgram");
  await ch.close();
});

// ---- receive liveness: audio goes out, nothing comes back ----
class Live extends Fake {
  readonly rxLiveness = true;
  lastRxAt = 0;
}
test("channel: audio sent and no answer for the silence limit reopens the socket", async () => {
  const made: Live[] = [];
  const now = { t: 1000 };
  const p = {
    id: "deepgram" as never,
    experimental: false,
    capabilities: { keyterms: true, diarize: false, interim: true, maxKeyterms: 100 },
    create: () => {
      const s = new Live();
      s.lastRxAt = now.t;
      made.push(s);
      return s;
    },
    probe: async () => ({ ok: true }),
  } as SttProvider;
  const ch = new SttChannel({
    channel: "them",
    chain: [p],
    keyOf: () => "k",
    base: {},
    circuit: { failures: 3, windowMs: 10_000 },
    now: () => now.t,
    rxSilenceMs: 1000,
    rxCheckMs: 5,
  });
  let reopened = 0;
  ch.on("reconnected", (d: { reopened?: boolean }) => d.reopened && reopened++);
  await ch.open();
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // 1) answers keep coming: nothing happens
  for (let i = 0; i < 5; i++) {
    now.t += 400;
    made[0].lastRxAt = now.t;
    ch.send(Buffer.alloc(320));
    await wait(8);
  }
  assert.equal(made.length, 1);
  // 2) no audio is sent (paused): silence is fine
  now.t += 5000;
  await wait(20);
  assert.equal(made.length, 1, "no audio out, no verdict");
  // 3) audio goes out and the service says nothing for 1 s of clock
  ch.send(Buffer.alloc(320));
  now.t += 1500;
  ch.send(Buffer.alloc(320));
  await wait(40);
  assert.equal(made.length, 2, "a fresh socket was opened");
  assert.equal(reopened, 1);
  assert.equal(made[0].closed, true, "the dead one was closed");
  ch.send(Buffer.alloc(320));
  assert.ok(made[1].sent > 0, "audio goes to the new socket");
  await ch.close();
});
