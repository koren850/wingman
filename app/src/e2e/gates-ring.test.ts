// r3 gate: no audio is lost before the first open of a speech channel. The real SttChannel and the engine's own open loop (engine/stt.ts openChannel) run on
// the virtual clock; the stream is a fake whose open() can be a black hole (it never answers). A feeder sends one 100 ms chunk every 100 ms from the first
// moment, as a microphone would, and every chunk carries its number. Nothing here touches the network or audio hardware.
import "../test-setup.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupEngine, type Engine } from "../testkit/engine-inproc.ts";
import { SttChannel } from "../providers/stt/channel.ts";
import { FakeStream, fakeProvider, type OpenMode } from "./gates-kit.ts";

let e: Engine;
let openChannel: typeof import("../engine/stt.ts").openChannel;
before(async () => {
  e = await setupEngine();
  openChannel = (await import("../engine/stt.ts")).openChannel;
});
after(() => e?.stop());

const CHUNK_MS = 100;
const RING_MS = 2000;
const seqOf = (b: Buffer) => b.readUInt32LE(0);
const chunk = (n: number) => {
  const b = Buffer.alloc(CHUNK_MS * 32);
  b.writeUInt32LE(n, 0);
  return b;
};
function rig(modes: OpenMode[]) {
  const made: FakeStream[] = [];
  const ch = new SttChannel({
    channel: "them",
    chain: [fakeProvider("deepgram", made, modes)],
    keyOf: () => "k",
    base: {},
    circuit: { failures: 99, windowMs: 10_000 },
    ringMs: RING_MS,
  });
  let n = 0;
  const feed = setInterval(() => void ch.send(chunk(n++)), CHUNK_MS);
  return { ch, made, sent: () => n, stop: () => clearInterval(feed) };
}

test("a slow first open (black hole for 1.5 s): every chunk spoken meanwhile arrives, once, in order, before the live ones", async () => {
  const r = rig(["hang"]);
  try {
    const opening = openChannel(r.ch, "them");
    await e.vc.advance(1500);
    assert.equal(r.ch.isOpen, false, "still opening");
    assert.ok(r.ch.ringedMs > 0 && r.ch.ringedMs <= RING_MS, `ring holds ${r.ch.ringedMs} ms`);
    r.made[0].release();
    await opening;
    await e.vc.advance(1000);
    const got = r.made[0].chunks.map(seqOf);
    assert.equal(got[0], 0, "the very first chunk was kept");
    assert.deepEqual(
      got,
      got.map((_, i) => i),
      "no gap, no repeat, no reorder",
    );
    assert.ok(got.length >= r.sent() - 1, `all ${r.sent()} chunks arrived (${got.length})`);
    assert.equal(r.ch.ringDroppedChunks, 0);
    assert.equal(r.ch.ringedMs, 0);
  } finally {
    r.stop();
    await r.ch.close();
  }
});

test("an open that never answers (8 s timeout, then the engine retries): the newest 2 s are kept in order, the older chunks are counted as dropped", async () => {
  const r = rig(["hang", "ok"]);
  try {
    const opening = openChannel(r.ch, "them");
    await e.vc.advance(9000); // the black hole is given up at 8 s, the engine waits 1 s and opens again
    await opening;
    await e.vc.advance(500);
    assert.equal(r.made.length, 2, "a second stream was opened by the engine loop");
    assert.ok(r.made[1].isOpen);
    const got = r.made[1].chunks.map(seqOf);
    const ringChunks = RING_MS / CHUNK_MS;
    assert.ok(got.length > ringChunks, "the ring was replayed and live audio followed");
    const first = got[0];
    assert.deepEqual(
      got,
      got.map((_, i) => first + i),
      "contiguous from the oldest kept chunk: no gap, no reorder",
    );
    const lost = first; // chunks 0..first-1 fell off the ring, oldest first
    assert.ok(lost > 0, "a 9 s outage is longer than the 2 s ring");
    assert.equal(r.ch.ringDroppedChunks, lost, "every lost chunk is counted");
    assert.ok(r.made[0].chunks.length === 0, "nothing reached the black-hole stream");
    // the ring kept at least its size: the replayed part is ringMs long (give or take one chunk)
    const replayed = r.ch.flushedMs;
    assert.ok(replayed >= RING_MS - CHUNK_MS && replayed <= RING_MS + CHUNK_MS, `replayed ${replayed} ms`);
  } finally {
    r.stop();
    await r.ch.close();
  }
});
