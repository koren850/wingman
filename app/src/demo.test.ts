import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentWav } from "../scripts/demo.ts";
import { decode } from "./audio.ts";

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

test("decode: a plain 16 kHz WAV is read directly, without ffmpeg", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wingman-wav-"));
  const oldPath = process.env.PATH;
  try {
    const f = join(dir, "s.wav");
    writeFileSync(f, silentWav(1, 16000, 2));
    process.env.PATH = dir; // no ffmpeg here: a spawn would reject with ENOENT
    const pcm = await decode(f, 2);
    assert.equal(pcm.length, 16000 * 2 * 2);
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("demo profiles: no role is left on a real model, so the practice call is offline with a key saved", async () => {
  const { parse } = await import("yaml");
  for (const name of ["demo", "demo-en"]) {
    const p = parse(readFileSync(new URL(`../profiles/${name}.yaml`, import.meta.url), "utf8")) as Record<string, any>;
    for (const [k, v] of [
      ["memory", p.memory?.model],
      ["assist", p.assist?.model],
      ["flow", p.flow?.model],
      ["notes", p.notes?.model],
      ["summary", p.summary?.model],
      ["tips", p.tips?.model],
      ["reflex", p.llm?.reflex?.model],
    ]) {
      assert.match(String(v), /^scripted:/, `${name}: ${k}.model`);
    }
  }
});
