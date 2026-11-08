// Reliability: STT side. Speaker epochs, ring before the first open, failback bookkeeping, Soniox pending finals.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { SttChannel } from "./providers/stt/channel.ts";
import { ProviderError } from "./providers/errors.ts";
import { SpeakerBook } from "./speakers.ts";
import type { SttProvider, SttStreamLike, SttResult } from "./providers/stt/types.ts";

const w = (speaker?: number) => ({ word: "x", start: 0, end: 0.1, ...(speaker === undefined ? {} : { speaker }) });

// ---- speaker epochs ----
test("speakers: the same raw id after a rebase is a different person", () => {
  const b = new SpeakerBook();
  assert.deepEqual(b.of([w(0)]), { spk: 1 }); // Dana
  assert.deepEqual(b.of([w(1)]), { spk: 2 }); // Eli
  b.rebase("them"); // socket dropped and reopened: the provider numbers voices from 0 again
  assert.deepEqual(b.of([w(0)]), { spk: 3 }, "Eli is raw 0 now; he must not become Dana");
  assert.deepEqual(b.of([w(1)]), { spk: 4 });
  assert.deepEqual(b.of([w(0)]), { spk: 3 }, "stable inside one epoch");
});

test("speakers: a name given before the rebase does not follow the raw id", () => {
  const b = new SpeakerBook();
  b.of([w(0)]);
  b.setName(1, "Dana");
  b.rebase("them");
  assert.deepEqual(b.of([w(0)]), { spk: 2 }, "no name carried over");
});

test("speakers: a matching introduced name maps the new voice to the existing person", () => {
  const b = new SpeakerBook();
  b.of([w(0)]);
  b.of([w(1)]);
  b.setName(1, "Dana");
  b.rebase("them");
  const eli = b.of([w(0)])!.spk;
  assert.equal(eli, 3);
  b.setName(eli, "Eli"); // a different name: stays separate
  assert.equal(b.of([w(0)])?.spk, 3);
  const dana = b.of([w(1)])!.spk;
  b.setName(dana, "dana"); // same name, any case: same person
  assert.deepEqual(b.of([w(1)]), { spk: 1, name: "Dana" });
  assert.equal(b.name(dana), "Dana", "old numbers resolve to the person");
  assert.equal(b.count, 3, "Dana, the first epoch's second voice and Eli: the merged number counts once");
});

test("speakers: two rebases with no voice in between are one", () => {
  const b = new SpeakerBook();
  b.of([w(0)]);
  b.rebase("them");
  b.rebase("them");
  b.rebase("them");
  assert.deepEqual(b.of([w(0)]), { spk: 2 });
  b.rebase("me"); // the book is the other side's: no effect
  assert.deepEqual(b.of([w(0)]), { spk: 2 });
});

test("speakers: peek follows the epoch and never takes a number", () => {
  const b = new SpeakerBook();
  b.of([w(0)]);
  b.rebase("them");
  assert.equal(b.peek([w(0)]), undefined);
  assert.equal(b.count, 1);
});

// ---- fakes ----
class Fake extends EventEmitter implements SttStreamLike {
  dropped = 0;
  got: Buffer[] = [];
  isOpen = true;
  opened = false;
  gate?: Promise<void>;
  async open() {
    await this.gate;
    this.opened = true;
  }
  send(b: Buffer) {
    if (!this.isOpen) {
      this.dropped++;
      return false;
    }
    this.got.push(b);
    return true;
  }
  async close() {
    this.isOpen = false;
  }
  get audioSeconds() {
    return this.got.reduce((a, b) => a + b.length, 0) / 32000;
  }
}
const fake = (id: string, streams: Fake[], gate?: Promise<void>): SttProvider => ({
  id: id as any,
  experimental: false,
  capabilities: { keyterms: true, diarize: false, interim: true, maxKeyterms: 100 },
  create: () => {
    const s = new Fake();
    s.gate = gate;
    streams.push(s);
    return s;
  },
  probe: async () => ({ ok: true }),
});
const mk = (chain: SttProvider[], ringMs?: number, extra: object = {}) =>
  new SttChannel({ channel: "them", chain, keyOf: () => "k", base: {}, circuit: { failures: 3, windowMs: 10_000 }, ringMs, ...extra });
const chunk = (tag: number, ms = 100) => Buffer.alloc(ms * 32, tag);

// ---- ring before the first open ----
test("ring: 50 chunks sent before the first open are all delivered in order after it", async () => {
  const a: Fake[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const ch = mk([fake("deepgram", a, gate)], 10_000);
  const opening = ch.open();
  for (let i = 0; i < 50; i++) assert.equal(ch.send(chunk(i + 1)), false);
  assert.equal(ch.dropped, 0);
  release();
  await opening;
  assert.deepEqual(
    a[0].got.map((b) => b[0]),
    Array.from({ length: 50 }, (_, i) => i + 1),
  );
  assert.equal(ch.send(chunk(99)), true);
  assert.equal(a[0].got.at(-1)![0], 99, "live audio after the replay");
});

test("ring: before the first open the oldest chunks go first, only beyond ringMs", async () => {
  const a: Fake[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const ch = mk([fake("deepgram", a, gate)], 1000); // 10 chunks of 100 ms
  const opening = ch.open();
  for (let i = 0; i < 25; i++) ch.send(chunk(i + 1));
  assert.equal(ch.dropped, 15);
  assert.equal(ch.ringedMs, 1000);
  release();
  await opening;
  assert.deepEqual(
    a[0].got.map((b) => b[0]),
    Array.from({ length: 10 }, (_, i) => i + 16),
  );
  assert.equal(ch.ringedMs, 0);
});

test("ring: a first open that fails keeps the audio for the retry", async () => {
  const a: Fake[] = [];
  let fail = true;
  const p = fake("deepgram", a);
  const create = p.create;
  p.create = (o) => {
    const s = create(o) as Fake;
    if (fail) s.open = async () => Promise.reject(new ProviderError("network", "deepgram", "down"));
    return s;
  };
  const ch = mk([p], 5000);
  await assert.rejects(ch.open());
  for (let i = 0; i < 5; i++) ch.send(chunk(i + 1));
  fail = false;
  await ch.reopen();
  assert.deepEqual(
    a[1].got.map((b) => b[0]),
    [1, 2, 3, 4, 5],
  );
});

test("ring: ringMs 0 still drops, as before", () => {
  const ch = mk([fake("deepgram", [])], 0);
  assert.equal(ch.send(chunk(1)), false);
  assert.equal(ch.dropped, 1);
});

// ---- failback bookkeeping ----
test("failback: while the primary is opening, audio seconds and errors stay with the fallback", async () => {
  const a: Fake[] = [],
    b: Fake[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const primary = fake("deepgram", a);
  const fb = fake("soniox", b);
  const ch = mk([primary, fb], 2000, { failbackAfterMs: 0 });
  await ch.open();
  a[0].isOpen = false;
  await ch.switchNext(new ProviderError("quota", "deepgram", "no credit"));
  assert.equal(ch.provider, "soniox");
  ch.send(chunk(1, 1000)); // 1 s on the fallback
  // make the primary slow to open, then start the failback by hand
  const orig = primary.create;
  primary.create = (o) => {
    const s = orig(o) as Fake;
    s.gate = gate;
    return s;
  };
  const errors: string[] = [];
  ch.on("stt_error", (e: ProviderError) => errors.push(e.provider));
  const fbp = (ch as any).tryFailback() as Promise<void>;
  assert.equal(ch.provider, "soniox", "the fallback stays current until the primary is open");
  assert.equal(ch.audioSecondsByProvider().deepgram ?? 0, 0);
  assert.equal(ch.audioSecondsByProvider().soniox, 1);
  b[0].emit("error", Object.assign(new Error("x"), { statusCode: 503 }));
  assert.deepEqual(errors, ["soniox"]);
  release();
  await fbp;
  assert.equal(ch.provider, "deepgram");
  assert.equal(ch.audioSecondsByProvider().soniox, 1);
});

// ---- Soniox ----
test("soniox: pending final tokens are flushed, not dropped, when the socket reopens", async () => {
  const { SonioxStream } = await import("./providers/stt/soniox.ts");
  const s: any = new SonioxStream({ channel: "them", apiKey: "k" } as any);
  const got: SttResult[] = [];
  s.on("result", (r: SttResult) => got.push(r));
  s.onMessage({
    tokens: [
      { text: "hello ", is_final: true, start_ms: 0, end_ms: 400 },
      { text: "wor", is_final: true, start_ms: 400, end_ms: 600 },
    ],
  });
  assert.equal(got.length, 0);
  s.onOpen({ send() {} });
  assert.equal(got.length, 1);
  assert.equal(got[0].text, "hello wor");
  assert.equal(got[0].isFinal, true);
  assert.equal(got[0].speechFinal, false);
  assert.equal(got[0].speechEndWall, undefined);
  s.onOpen({ send() {} });
  assert.equal(got.length, 1, "nothing pending, nothing emitted");
});

// ---- wiring (engine/stt.ts needs the whole engine to import, so this guards the three call sites) ----
test("engine wiring: reconnected, switched and failback each rebase the speaker book", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./engine/stt.ts", import.meta.url), "utf8");
  for (const [ev, why] of [
    ["reconnected", "reconnect"],
    ["switched", "provider switch"],
    ["failback", "failback"],
  ])
    assert.match(src, new RegExp(`"${ev}",[\\s\\S]{0,260}rebaseSpeakers\\(ch, "${why}"\\)`), ev);
});
