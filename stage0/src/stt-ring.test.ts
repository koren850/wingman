// S4: ring buffer in SttChannel. Audio sent while the socket is down is kept (last ringMs) and replayed in order on reopen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { SttChannel } from "./providers/stt/channel.ts";
import { ProviderError } from "./providers/errors.ts";
import type { SttProvider, SttStreamLike, SttResult } from "./providers/stt/types.ts";

class Fake extends EventEmitter implements SttStreamLike {
  dropped = 0; got: Buffer[] = []; isOpen = true; closed = false;
  async open() {}
  send(b: Buffer) { if (!this.isOpen) { this.dropped++; return false; } this.got.push(b); return true; }
  async close() { this.closed = true; }
  get audioSeconds() { return this.got.reduce((a, b) => a + b.length, 0) / 32000; }
}
const fake = (id: string, streams: Fake[]): SttProvider => ({
  id: id as any, experimental: false, capabilities: { keyterms: true, diarize: false, interim: true, maxKeyterms: 100 },
  create: () => { const s = new Fake(); streams.push(s); return s; }, probe: async () => ({ ok: true }),
});
const mk = (chain: SttProvider[], ringMs?: number) => new SttChannel({ channel: "them", chain, keyOf: () => "k", base: {}, circuit: { failures: 3, windowMs: 10_000 }, ringMs });
const chunk = (tag: number, ms = 100) => Buffer.alloc(ms * 32, tag);   // 100 ms = 3200 bytes
const tags = (s: Fake) => s.got.map((b) => b[0]);

test("ring: chunks sent while closed are delivered in order after reconnect, before new audio", async () => {
  const a: Fake[] = []; const ch = mk([fake("deepgram", a)], 2000); await ch.open();
  ch.send(chunk(1)); a[0].isOpen = false; a[0].emit("disconnected", { channel: "them", error: new ProviderError("network", "deepgram", "closed") });
  assert.equal(ch.send(chunk(2)), false); ch.send(chunk(3)); ch.send(chunk(4));
  assert.equal(ch.dropped, 0); assert.equal(a[0].dropped, 0);
  a[0].isOpen = true; a[0].emit("reconnected", {});
  ch.send(chunk(5));
  assert.deepEqual(tags(a[0]), [1, 2, 3, 4, 5]);
  assert.equal(ch.flushedMs, 300); assert.equal(ch.dropped, 0);
});

test("ring: cap respected, oldest dropped and counted", async () => {
  const a: Fake[] = []; const ch = mk([fake("deepgram", a)], 500); await ch.open();
  a[0].isOpen = false;
  for (let i = 1; i <= 8; i++) ch.send(chunk(i));          // 800 ms into a 500 ms ring
  assert.equal(ch.dropped, 3);
  a[0].isOpen = true; a[0].emit("reconnected", {});
  assert.deepEqual(tags(a[0]), [4, 5, 6, 7, 8]); assert.equal(ch.flushedMs, 500); assert.equal(ch.dropped, 3);
});

test("ring: ringMs 0 or unset keeps the old behaviour (everything dropped while closed, nothing replayed)", async () => {
  for (const ringMs of [0, undefined]) {
    const a: Fake[] = []; const ch = mk([fake("deepgram", a)], ringMs); await ch.open();
    a[0].isOpen = false; ch.send(chunk(1)); ch.send(chunk(2));
    assert.equal(ch.dropped, 2);
    a[0].isOpen = true; a[0].emit("reconnected", {}); ch.send(chunk(3));
    assert.deepEqual(tags(a[0]), [3]); assert.equal(ch.flushedMs, 0); assert.equal(ch.dropped, 2);
  }
});

test("ring: audio buffered during a provider switch is flushed to the fallback first", async () => {
  const a: Fake[] = [], b: Fake[] = []; const ch = mk([fake("deepgram", a), fake("soniox", b)], 2000); await ch.open();
  a[0].isOpen = false;
  ch.send(chunk(1)); ch.send(chunk(2));
  const sw = new Promise((r) => ch.once("switched", r));
  a[0].emit("error", new ProviderError("quota", "deepgram", "credit finished")); await sw;
  assert.equal(ch.provider, "soniox"); assert.deepEqual(tags(b[0]), [1, 2]); assert.equal(ch.flushedMs, 200);
  ch.send(chunk(3)); assert.deepEqual(tags(b[0]), [1, 2, 3]);
});

test("ring: results ending inside flushed audio lose speechEndWall (burst send would inflate lag); later ones keep it", async () => {
  const a: Fake[] = []; const ch = mk([fake("deepgram", a)], 2000); await ch.open();
  const got: SttResult[] = []; ch.on("result", (r) => got.push(r));
  a[0].isOpen = false; ch.send(chunk(1, 1000)); a[0].isOpen = true; a[0].emit("reconnected", {});   // 1 s flushed
  const r = (end: number): SttResult => ({ channel: "them", text: "x", isFinal: true, speechFinal: true, words: [{ word: "x", start: end - 0.3, end }], speechEndWall: 5000, arrivedAt: 6000 });
  a[0].emit("result", r(0.8)); a[0].emit("result", r(1.6));
  assert.equal(got[0].speechEndWall, undefined); assert.equal(got[1].speechEndWall, 5000);
});
