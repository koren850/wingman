// The capture window's audio helpers (tray/capture/dsp.js) and the wire format (shared/capture-wire.cjs). Plain functions, no browser.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dsp = require("../tray/capture/dsp.js");
const wire = require("../shared/capture-wire.cjs");

test("dsp: floats become little-endian s16 and are clipped", () => {
  const b: Buffer = dsp.toPcm16(Float32Array.from([0, 1, -1, 0.5, 2, -2]));
  assert.equal(b.length, 12);
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((i) => b.readInt16LE(i * 2)),
    [0, 32767, -32768, 16384, 32767, -32768],
  );
});

test("dsp: mixToMono averages channels", () => {
  const m = dsp.mixToMono([Float32Array.from([1, 0]), Float32Array.from([0, 1])]);
  assert.deepEqual(Array.from(m), [0.5, 0.5]);
  const one = Float32Array.from([0.1]);
  assert.equal(dsp.mixToMono([one]), one);
});

test("dsp: the chunker emits whole 100 ms chunks and keeps the rest", () => {
  const out: Buffer[] = [];
  const push = dsp.createChunker((b: Buffer) => out.push(b));
  push(new Float32Array(1000));
  assert.equal(out.length, 0);
  push(new Float32Array(2300));
  assert.equal(out.length, 2, "3300 samples = 2 chunks and 100 left");
  assert.ok(out.every((b) => b.length === 3200));
  push(new Float32Array(1500));
  assert.equal(out.length, 3);
});

test("dsp: the resampler keeps 16 kHz as it is and brings 48 kHz and 44.1 kHz down to 16 kHz, in any block size", () => {
  const same = dsp.createResampler(16000);
  const f = new Float32Array(10);
  assert.equal(same(f), f);
  for (const rate of [48000, 44100, 32000]) {
    const r = dsp.createResampler(rate);
    let total = 0,
      peak = 0;
    const seconds = 2;
    const all = new Float32Array(rate * seconds).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate));
    for (let off = 0; off < all.length; off += 777) {
      const out: Float32Array = r(all.subarray(off, off + 777));
      total += out.length;
      for (const v of out) peak = Math.max(peak, Math.abs(v));
    }
    assert.ok(Math.abs(total - 16000 * seconds) <= 2, `${rate}: ${total} samples`);
    assert.ok(peak > 0.45 && peak <= 0.5, `${rate}: the 440 Hz tone keeps its level (${peak})`);
  }
});

test("dsp: pickDevice finds a saved name (exact first, then part of the label) and never picks the virtual default entries", () => {
  const list = [
    { deviceId: "default", label: "Default - MacBook Pro Microphone" },
    { deviceId: "communications", label: "Communications - Headset" },
    { deviceId: "a", label: "MacBook Pro Microphone" },
    { deviceId: "b", label: "USB Audio Device (046d:0825)" },
    { deviceId: "c", label: "USB Audio Device 2" },
  ];
  assert.equal(dsp.pickDevice(list, "MacBook Pro Microphone").deviceId, "a");
  assert.equal(dsp.pickDevice(list, "usb audio device").deviceId, "b");
  assert.equal(dsp.pickDevice(list, "USB Audio Device").deviceId, "b", "an exact label wins over a partial match");
  assert.equal(dsp.pickDevice(list, "Headset"), undefined, "the virtual entry is not chosen by name");
  assert.equal(dsp.pickDevice(list, "Nothing like it"), undefined);
  assert.equal(dsp.pickDevice(list, ""), undefined);
  assert.equal(dsp.pickDevice([{ deviceId: "x", label: "" }], "something"), undefined, "unlabelled devices (no permission yet) never match");
});

test("wire: frames survive any split of the byte stream and keep their order", () => {
  const pcm = Buffer.from(Array.from({ length: 3200 }, (_, i) => i % 251));
  const stream = Buffer.concat([
    wire.encodeJson({ op: "hello", token: "x" }),
    wire.encodePcm("mic", pcm),
    wire.encodePcm("system", pcm.subarray(0, 10)),
    wire.encodeJson({ ev: "ended", reason: "שלום" }),
  ]);
  for (const step of [1, 7, 1000, stream.length]) {
    const dec = wire.createDecoder();
    const got: any[] = [];
    for (let i = 0; i < stream.length; i += step) got.push(...dec.push(stream.subarray(i, i + step)));
    assert.equal(got.length, 4, `step ${step}`);
    assert.deepEqual(got[0].json, { op: "hello", token: "x" });
    assert.equal(got[1].ch, "mic");
    assert.ok(got[1].pcm.equals(pcm));
    assert.equal(got[2].ch, "system");
    assert.equal(got[2].pcm.length, 10);
    assert.equal(got[3].json.reason, "שלום");
  }
});

test("wire: an unknown type, an oversized length and broken JSON are errors", () => {
  assert.throws(() => wire.createDecoder().push(Buffer.from([9, 0, 0, 0, 0])), /unknown/);
  const big = Buffer.alloc(5);
  big.writeUInt8(2, 0);
  big.writeUInt32LE(wire.MAX_FRAME + 1, 1);
  assert.throws(() => wire.createDecoder().push(big), /too large/);
  const bad = Buffer.concat([Buffer.from([1, 3, 0, 0, 0]), Buffer.from("{{{")]);
  assert.throws(() => wire.createDecoder().push(bad));
});

test("dsp: pickDevice handles Hebrew labels, empty labels and a name that is not listed", () => {
  const list = [
    { deviceId: "default", label: "Default - מיקרופון (Realtek)" },
    { deviceId: "a", label: "מיקרופון (Realtek)" },
    { deviceId: "b", label: "" },
  ];
  assert.equal(dsp.pickDevice(list, "מיקרופון (Realtek)")?.deviceId, "a");
  assert.equal(dsp.pickDevice(list, "USB Mic"), undefined);
  assert.equal(dsp.pickDevice(list, ""), undefined);
  assert.equal(dsp.pickDevice([{ deviceId: "b", label: "" }], "x"), undefined, "an empty label never matches");
});

test("dsp: toPcm16 turns NaN into silence and the chunker ignores an empty push", () => {
  const b: Buffer = dsp.toPcm16(Float32Array.from([NaN, 0.25]));
  assert.equal(b.readInt16LE(0), 0);
  const out: number[] = [];
  const chunk = dsp.createChunker((x: Buffer) => out.push(x.length));
  chunk(new Float32Array(0));
  assert.deepEqual(out, []);
});
