// Chaos test: one scripted live call (real src/run.ts, scripted STT and AI, fake ffmpeg on PATH, no network, no audio hardware) with faults injected on a timeline:
//   1-3 s   the AI times out on the first questions (HTTP 504)
//   3 s     the mic stream dies twice (an AirPods drop or a default-input change); the engine looks for a device again
//   4-24 s  the other side's speech-to-text socket is down for 20 s (HTTP 503, retried with backoff)
//   ~36 s   the Mac sleeps and wakes (the wall clock jumps 20 minutes, the monotonic clock does not)
// It checks the health, ladder and recovery events, that cards come back, and that the call ends cleanly. About 45 s. Run alone:
//   ./node_modules/.bin/tsx --import ./src/test-setup.ts --test src/e2e/chaos.test.ts
import "../test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_BIN } from "../test-platform.ts";
import { scriptFile, readRows, callDir, runEngine, Q, fakeFfmpeg, stopSoon } from "./helpers.ts";

test(
  "chaos: AI timeouts, mic drops, a 20 s speech-to-text outage and a sleep/wake in one call; the ladder follows and the call recovers",
  { timeout: 90_000, ...FAKE_BIN },
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "wm-chaos-"));
    const calls = join(tmp, "calls");
    mkdirSync(calls);
    const { bin, settings } = fakeFfmpeg(tmp);
    // Date.now() jumps forward 20 minutes 36 s after start; performance.now() does not = what a Mac sleep looks like.
    const preload = join(tmp, "skew.mjs");
    writeFileSync(
      preload,
      `const real = Date.now.bind(Date), t0 = real(); Date.now = () => { const n = real(); return n - t0 > 36000 ? n + 20 * 60000 : n; };\n`,
    );
    const e = runEngine([], {
      WINGMAN_CALLS_DIR: calls,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_FFMPEG_DIR: tmp,
      FAKE_MIC_DROPS: "2",
      FAKE_SYS_FAILS: "0",
      WINGMAN_USER_SETTINGS: settings,
      NODE_OPTIONS: `--import ${preload}`,
      WINGMAN_LLM_FAIL: "2:504",
      WINGMAN_STT_FAIL: "them:503@4000",
      WINGMAN_STT_HEAL_AT_MS: "24000",
      WINGMAN_STT_SCRIPT: scriptFile(tmp, [
        Q("them", "האתר שלי נטען ממש לאט, למה זה קורה", 700),
        Q("them", "וגם אני רוצה לדעת אם יש לכם גיבוי של האתר", 3000),
        Q("them", "וכמה זה עולה בסך הכל", 31000), // sent after the outage, so it only arrives if the channel really recovered
      ]),
    });
    try {
      const code = await stopSoon(e, 42_000);
      assert.equal(code, 0, e.out());
      const dir = callDir(calls),
        ev = readRows(dir, "events.jsonl"),
        cards = readRows(dir, "cards.jsonl");
      const types = (t: string) => ev.filter((x) => x.type === t);
      const at = (x: { t?: number }) => x.t ?? 0;

      // AI timeouts: logged as timeouts, the amber bar shows and the ladder steps down, then the model answers again and both clear.
      const llmErr = types("llm.error");
      assert.ok(llmErr.length === 2 && llmErr.every((x) => x.kind === "timeout"), "two AI timeouts logged: " + JSON.stringify(llmErr));
      assert.ok(
        readRows(dir, "usage.jsonl").some((u) => u.role === "reflex" && u.model && u.prompt),
        "a model call succeeded after the timeouts (usage row has the model and prompt ids)",
      );
      const bar = (id: string) => cards.filter((c) => c.id === id);
      assert.ok(
        bar("health-ai").length >= 2 && bar("health-ai").at(-1).clear,
        "AI bar shown, then cleared: " + JSON.stringify(bar("health-ai").map((c) => !!c.clear)),
      );

      // Mic: dropped, looked for a device again, came back.
      assert.ok(
        ev.filter((x) => x.type === "audio.down" && x.src === "mic").length >= 1,
        "mic went down: " + JSON.stringify(ev.filter((x) => /^audio/.test(String(x.type)))),
      );
      assert.ok(types("audio.mic.device").length >= 1, "device looked up again after the failure");
      assert.ok(
        ev.some((x) => x.type === "audio.up" && x.src === "mic"),
        "mic came back",
      );
      assert.ok(bar("health-mic").length >= 2 && bar("health-mic").at(-1).clear, "mic bar shown, then cleared");

      // Speech to text: the other side is down for about 20 s, retried, then recovers; the ladder drops and comes back to full.
      const retry = types("stt.retry.fail").filter((x) => x.ch === "them");
      assert.ok(retry.length >= 2, "kept retrying: " + retry.length);
      const rec = types("stt.recovered").filter((x) => x.ch === "them");
      assert.ok(rec.length >= 1, "the other side's speech-to-text recovered");
      assert.ok(bar("health-stt-them").some((c) => c.level === "red") && bar("health-stt-them").at(-1).clear, "red speech-to-text bar, then cleared");
      const lad = types("ladder");
      assert.ok(
        lad.some((x) => (x.to as number) >= 1),
        "ladder stepped down during the faults: " + JSON.stringify(lad.map((x) => x.to)),
      );
      const firstRec = rec[0];
      const outageMs = at(firstRec) - at(retry[0]);
      assert.ok(outageMs > 12_000 && outageMs < 40_000, `outage lasted about 20 s, was ${outageMs} ms`);
      assert.ok(
        cards.some((c) => c.badge === "stall" || (c.badge === "bank" && /המחיר תלוי|הצעה/.test(c.say ?? ""))),
        "the question asked after the outage got its price answer",
      );

      // Sleep and wake: both sources rebuilt, healthy STT sockets left alone, no idle stop, an amber bar.
      const gap = ev.find((x) => x.type === "sleep.gap");
      assert.ok(gap && (gap.ms as number) > 15 * 60_000, "sleep detected: " + JSON.stringify(gap));
      assert.ok(types("wake.recover").length === 1, "wake recovery ran once");
      assert.ok(ev.filter((x) => x.type === "audio.restart" && x.reason === "wake").length === 2, "both audio sources rebuilt");
      // The sockets were healthy at the wake, so they are left alone (no reopen, no dropped finals); the last question still arrives.
      assert.equal(ev.filter((x) => x.type === "stt.recovered" && at(x) >= at(gap)).length, 0, "healthy STT sockets were not reopened by the wake");
      assert.ok(!types("idle.stop").length, "the 20 wall-clock minutes did not count as silence");
      assert.ok(
        cards.some((c) => c.id === "health-sleep"),
        "amber sleep bar",
      );

      // The end state: full service, no crash, a clean finish.
      // A wake no longer flashes "other side not heard" (rung 4), which used to reset the AI recovery clock. The AI trouble from the first seconds then
      // needs its own 15 s of calm after the wake, so a call that ends 4 s after the wake may still be at rung 1 for that one reason.
      const last = lad.at(-1) as { to: number; reasons: string[] };
      assert.ok(
        last.to === 0 || (last.to === 1 && last.reasons.every((r) => /AI/.test(r))),
        "ladder back to full, or only the AI reason left: " + JSON.stringify(lad),
      );
      assert.ok(!types("crash").length && !types("shutdown.error").length, "no crash");
      assert.equal(JSON.parse(readFileSync(join(dir, "call.json"), "utf8")).crashed, false);
      assert.ok(types("speed.summary").length === 1, "closed cleanly");
      assert.ok(!existsSync(join(dir, "live.jsonl")), "live.jsonl removed at shutdown");
    } finally {
      e.p.kill("SIGKILL");
      rmSync(tmp, { recursive: true, force: true });
    }
  },
);
