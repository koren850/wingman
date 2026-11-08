// Contract tests for the AudioSource interface (src/audio-platform.ts), run on the file/WAV source so no hardware is needed.
// The macOS backend is checked for shape only (it needs a microphone and a tap); the stub backends must fail loudly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeWav, SupervisedSource } from "./audio.ts";
import { FileAudioSource, backendFor, macBackend, unsupportedBackend, type AudioSource } from "./audio-platform.ts";

const haveFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

/** The AudioSource contract. `make` builds a fresh, unstarted source. */
async function checkContract(make: () => AudioSource, expectChunks: boolean) {
  const src = make();
  const chunks: Buffer[] = [];
  const errors: Error[] = [];
  src.on("pcm", (b: Buffer) => chunks.push(b));
  src.on("error", (e: Error) => errors.push(e));
  await src.start();
  if (expectChunks) await new Promise((r) => setTimeout(r, 400));
  await src.stop();
  const seen = chunks.length;
  if (expectChunks) assert.ok(seen > 0, "pcm chunks arrive after start()");
  for (const c of chunks) {
    assert.ok(Buffer.isBuffer(c));
    assert.equal(c.length % 2, 0, "whole s16le samples only");
  }
  await src.stop(); // a second stop() is fine
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(chunks.length, seen, "no pcm after stop()");
  assert.deepEqual(errors, []);
  if (src.peak !== undefined) assert.ok(src.peak >= 0 && src.peak <= 1);
}

async function makeWav(dir: string): Promise<string> {
  // 1.2 s stereo, 16 kHz: L = loud sine-ish ramp (me), R = quiet (them)
  const n = 16000 * 1.2;
  const pcm = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    pcm.writeInt16LE(Math.round(Math.sin(i / 20) * 12000), i * 4);
    pcm.writeInt16LE(Math.round(Math.sin(i / 35) * 2000), i * 4 + 2);
  }
  const path = join(dir, "contract.wav");
  await writeWav(path, pcm, 2);
  return path;
}

test("audio source contract: the file source follows it on both channels", { skip: !haveFfmpeg && "ffmpeg not installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "wingman-audio-contract-"));
  try {
    const path = await makeWav(dir);
    await checkContract(() => new FileAudioSource(path, "me", 4), true);
    await checkContract(() => new FileAudioSource(path, "them", 4), true);
    const me = new FileAudioSource(path, "me", 4);
    const them = new FileAudioSource(path, "them", 4);
    for (const s of [me, them]) {
      await s.start();
      await new Promise((r) => setTimeout(r, 500));
      await s.stop();
    }
    assert.ok(me.peak > them.peak, "the left channel is louder in the test file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audio source contract: a SupervisedSource around the file source keeps it", { skip: !haveFfmpeg && "ffmpeg not installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "wingman-audio-contract-"));
  try {
    const path = await makeWav(dir);
    await checkContract(() => new SupervisedSource({ name: "file", make: () => new FileAudioSource(path, "me", 4) }) as unknown as AudioSource, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audio backends: macOS builds both sources; other platforms use the same processes until a native backend exists", () => {
  assert.equal(backendFor("darwin"), macBackend);
  if (process.platform === "darwin")
    for (const s of [macBackend.createMic(":default"), macBackend.createSystem("audiotee", "")]) assert.equal(typeof s.start, "function"); // AudioTee loads its macOS binary here
  for (const p of ["win32", "linux"] as const) {
    const b = backendFor(p);
    assert.equal(b.platform, p);
    assert.equal(b.createMic, macBackend.createMic);
    assert.equal(b.createSystem, macBackend.createSystem);
  }
  assert.throws(() => unsupportedBackend("win32").createMic(":default"), /not implemented on win32/);
  assert.throws(() => unsupportedBackend("freebsd").createMic(""), /freebsd/);
});
