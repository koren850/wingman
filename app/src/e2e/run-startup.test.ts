// End-to-end (subprocess): run.ts start-up and context. An unusable calls folder is one clear line with exit 2, and typed notes are capped in the
// context sent to the AI. Scripted STT, offline.
import "../test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../env.ts";
import { tsx } from "../test-platform.ts";
import { writeWav } from "../audio.ts";

test("run.ts: unusable calls folder = one clear line and exit 2, no stack trace", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "wm-nodisk-"));
  const wav = join(tmp, "s.wav");
  await writeWav(wav, Buffer.alloc(16000 * 4 * 2), 2);
  writeFileSync(join(tmp, "afile"), "x");
  const r = spawnSync(...tsx([join(ROOT, "src", "run.ts"), "--profile", "e2e", "--file", wav, "--no-brief"]), {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 40_000,
    env: { ...process.env, WINGMAN_CALLS_DIR: join(tmp, "afile", "calls"), WINGMAN_STT_SCRIPT: join(ROOT, "data", "test", "e2e-call.json") },
  });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /cannot create the calls folder/);
  assert.ok(!/\n\s+at /.test(r.stderr), "no stack trace");
  rmSync(tmp, { recursive: true, force: true });
});

// ---- notes cap, WINGMAN_USER_SETTINGS ----
test("run.ts: typed notes are capped (last 20 notes) in the context sent to the AI", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "wm-notes-")),
    calls = join(tmp, "calls");
  const wav = join(tmp, "s.wav");
  await writeWav(wav, Buffer.alloc(16000 * 4 * 12), 2);
  const c = spawn(...tsx([join(ROOT, "src", "run.ts"), "--profile", "e2e", "--file", wav, "--no-brief"]), {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      WINGMAN_CONTROL: "1",
      WINGMAN_CALLS_DIR: calls,
      WINGMAN_STT_SCRIPT: join(ROOT, "data", "test", "e2e-call.json"),
      WINGMAN_SCRIPT_GAP_MS: "1500",
    },
  });
  let out = "";
  c.stdout.on("data", (d) => (out += d));
  c.stderr.on("data", (d) => (out += d));
  await new Promise<void>((res) => {
    const t = setInterval(() => {
      if (/@@wingman .*"waiting"|@@wingman .*"consented"/.test(out)) {
        clearInterval(t);
        res();
      }
    }, 100);
  });
  for (let i = 0; i < 30; i++) c.stdin.write(`note note-number-${i}\n`);
  const code = await new Promise<number | null>((res) => c.on("exit", res));
  try {
    assert.equal(code, 0, out);
    const dir = join(
      calls,
      readdirSync(calls).find((d) => d !== "latest")!,
    );
    const ev = readFileSync(join(dir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const snap = ev.find((e) => e.type === "context.snapshot");
    const typed = (snap.contextNotes as string[]).filter((n) => /^note-number-/.test(n));
    assert.equal(typed.length, 20);
    assert.equal(typed[0], "note-number-10");
    assert.equal(typed.at(-1), "note-number-29");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
