// SttChannel recovery from one terminal stream error, and from a socket that never comes back. Fake provider streams; no sockets.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { SttChannel } from "./providers/stt/channel.ts";
import { ProviderError } from "./providers/errors.ts";
import type { SttProvider, SttStreamLike } from "./providers/stt/types.ts";

class Fake extends EventEmitter implements SttStreamLike {
  dropped = 0;
  audioSeconds = 0;
  isOpen = true;
  async open() {}
  send() {
    return this.isOpen;
  }
  async close() {
    this.isOpen = false;
  }
}
const provider = (streams: Fake[]): SttProvider => ({
  id: "deepgram",
  experimental: false,
  capabilities: { keyterms: true, diarize: false, interim: true, maxKeyterms: 100 },
  create: () => {
    const s = new Fake();
    streams.push(s);
    return s;
  },
  probe: async () => ({ ok: true }),
});
const tick = () => new Promise((r) => setTimeout(r, 20));

test("one terminal error with no fallback emits exhausted (starts the retry loop)", async () => {
  const a: Fake[] = [];
  const ch = new SttChannel({ channel: "them", chain: [provider(a)], keyOf: () => "k", base: {}, circuit: { failures: 3, windowMs: 10_000 } });
  const events: string[] = [];
  ch.on("exhausted", () => events.push("exhausted"));
  await ch.open();
  a[0].emit("error", new ProviderError("network", "deepgram", "gave up"), { terminal: true });
  await tick();
  assert.deepEqual(events, ["exhausted"]);
});

test("a non-terminal error alone does not trip the circuit", async () => {
  const a: Fake[] = [];
  const ch = new SttChannel({ channel: "them", chain: [provider(a)], keyOf: () => "k", base: {}, circuit: { failures: 3, windowMs: 10_000 } });
  let exhausted = 0;
  ch.on("exhausted", () => exhausted++);
  await ch.open();
  a[0].emit("error", new ProviderError("network", "deepgram", "blip"));
  await tick();
  assert.equal(exhausted, 0);
});

test("a socket that stays disconnected is treated as dead after deadAfterMs", async () => {
  const a: Fake[] = [];
  const ch = new SttChannel({ channel: "them", chain: [provider(a)], keyOf: () => "k", base: {}, circuit: { failures: 3, windowMs: 10_000 }, deadAfterMs: 50 });
  let exhausted = 0;
  ch.on("exhausted", () => exhausted++);
  await ch.open();
  a[0].isOpen = false;
  a[0].emit("disconnected", { channel: "them", error: new ProviderError("network", "deepgram", "closed") });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(exhausted, 1);
  await ch.close();
});

test("a reconnect before deadAfterMs cancels the dead-socket check", async () => {
  const a: Fake[] = [];
  const ch = new SttChannel({ channel: "them", chain: [provider(a)], keyOf: () => "k", base: {}, circuit: { failures: 3, windowMs: 10_000 }, deadAfterMs: 80 });
  let exhausted = 0;
  ch.on("exhausted", () => exhausted++);
  await ch.open();
  a[0].emit("disconnected", { channel: "them", error: new ProviderError("network", "deepgram", "closed") });
  a[0].emit("reconnected", { channel: "them" });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(exhausted, 0);
  await ch.close();
});
