// Speed of answers for Dan on a SOLO call (nobody else on the line), run through the real src/run.ts as a child process.
// Scripted STT replays the shape of a live call: the final arrives ~0.9 s after the end of speech with speechFinal=false.
// A "?" or a sum flushes at once, a sum is computed locally, a solo call skips the classifier, "you / can you" is for Wingman.
// Without those, the card took about 4 s (STT, join-window wait, classifier, then the answer).
import "../test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../env.ts";
import { writeWav } from "../audio.ts";
import { tsx } from "../test-platform.ts";
import { loadSettings } from "../settings.ts";

test("solo call: second-person question answered, sum computed locally, and the card does not wait for the join window", { timeout: 60_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "wingman-me-lat-"));
  const wav = join(tmp, "silence.wav"),
    CALLS = join(tmp, "calls");
  await writeWav(wav, Buffer.alloc(16000 * 2 * 2 * 12), 2);
  const child = spawn(...tsx([join(ROOT, "src", "run.ts"), "--profile", "e2e-me", "--file", wav, "--no-brief"]), {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WINGMAN_STT_SCRIPT: join(ROOT, "data", "test", "e2e-me-solo.json"), WINGMAN_CALL_APP: "none", WINGMAN_CALLS_DIR: CALLS },
  });
  let out = "",
    err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const code: number | null = await new Promise((res) => child.on("exit", res));
  assert.equal(code, 0, `${out}\n${err}`);
  try {
    const dir = join(CALLS, readlinkSync(join(CALLS, "latest")));
    const rows = (f: string) =>
      existsSync(join(dir, f))
        ? readFileSync(join(dir, f), "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [];
    const cards = rows("cards.jsonl").filter((c) => c.badge === "me"),
      events = rows("events.jsonl");
    assert.ok(
      cards.some((c) => /פורטוגל/.test(c.say)),
      "the 'what do you think' question got an answer on a solo call",
    );
    const calc = cards.find((c) => c.source === "calc");
    assert.ok(calc && /7 × 350 = 2,450/.test(calc.say), "וכמה איזה 7 כפול 350 is computed locally");
    const lat = events.filter((e) => e.type === "me.latency");
    assert.equal(lat.length, 2);
    const m = lat.find((e) => e.source === "calc");
    assert.ok(m.stt >= 800, `stt stage reflects the 0.9 s lag: ${m.stt}`);
    // No wall-clock budget: the card must not have waited for the join window (1500 ms by default) or a model. The bound is half of that
    // window, so a slow CI runner does not trip it, while a regression back to "wait for the window" (>= 1500 ms) always does.
    const joinMs = loadSettings({ argv: [], env: {} }).settings.stt.joinWindowMs;
    assert.ok(joinMs >= 1000, "the default join window is long enough to tell waiting from not waiting");
    assert.ok(m.detect < joinMs / 2, `no join-window wait: detect ${m.detect} ms of ${joinMs} ms`);
    assert.ok(m.detect + m.decide + m.firstCard < joinMs / 2, `final -> card without the window or a model: ${JSON.stringify(m)}`);
    console.log(
      "me.latency (ms)",
      JSON.stringify(lat.map(({ source, stt, detect, decide, firstCard, total }) => ({ source, stt, detect, decide, firstCard, total }))),
    );
    assert.match(out, /For you 2 answers \(speech end to card p50/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
