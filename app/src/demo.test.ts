import { test } from "node:test";
import assert from "node:assert/strict";
import { silentWav } from "../scripts/demo.ts";

test("demo: silentWav writes a valid stereo 16-bit PCM header and only zeros", () => {
  const w = silentWav(2, 16000, 2);
  assert.equal(w.length, 44 + 2 * 16000 * 2 * 2);
  assert.equal(w.toString("ascii", 0, 4), "RIFF");
  assert.equal(w.toString("ascii", 8, 16), "WAVEfmt ");
  assert.equal(w.readUInt16LE(22), 2, "channels");
  assert.equal(w.readUInt32LE(24), 16000, "sample rate");
  assert.equal(w.readUInt32LE(40), w.length - 44, "data size");
  assert.equal(w.readUInt32LE(4), w.length - 8, "riff size");
  assert.ok(w.subarray(44).every((b) => b === 0));
});
