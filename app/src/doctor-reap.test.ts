// The readiness check opens the microphone for five seconds and then calls MicSource.stop(). The ffmpeg child it started must be gone
// afterwards, even when ffmpeg ignores SIGINT. A fake ffmpeg on PATH stands in: no real microphone, no HOME, no keys.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MicSource } from "./audio.ts";
import { FAKE_BIN } from "./test-platform.ts";

const alive = (pid: number) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (cond: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return cond();
};

async function withFakeFfmpeg(body: string, run: (pid: () => number) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "wm-reap-"));
  const pidFile = join(dir, "pid");
  writeFileSync(join(dir, "ffmpeg"), `#!/bin/sh\necho $$ > "${pidFile}"\n${body}\n`);
  chmodSync(join(dir, "ffmpeg"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  try {
    await run(() => {
      try {
        return Number(readFileSync(pidFile, "utf8").trim()) || 0;
      } catch {
        return 0; // not written yet
      }
    });
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("mic check: a well-behaved ffmpeg is gone after stop()", FAKE_BIN, async () => {
  await withFakeFfmpeg("exec sleep 30", async (pid) => {
    const mic = new MicSource(":default");
    mic.on("error", () => {});
    await mic.start();
    assert.ok(await until(() => alive(pid()), 3000), "the fake ffmpeg started");
    const p = pid();
    await mic.stop();
    assert.ok(await until(() => !alive(p), 3000), "ffmpeg exited after SIGINT");
  });
});

test("mic check: an ffmpeg that ignores SIGINT is killed within a few seconds", FAKE_BIN, async () => {
  await withFakeFfmpeg("trap '' INT\nwhile :; do sleep 1; done", async (pid) => {
    const mic = new MicSource(":default");
    mic.on("error", () => {});
    await mic.start();
    assert.ok(await until(() => alive(pid()), 3000), "the fake ffmpeg started");
    const p = pid();
    await mic.stop();
    assert.ok(alive(p), "it ignored the first signal");
    assert.ok(await until(() => !alive(p), 4000), "SIGKILL after 2 s reaped it");
  });
});

test("mic check: stop() before start() never spawns ffmpeg", FAKE_BIN, async () => {
  await withFakeFfmpeg("exec sleep 30", async () => {
    const mic = new MicSource(":default");
    await mic.stop();
    await mic.start();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((mic as unknown as { p?: unknown }).p, undefined);
  });
});
