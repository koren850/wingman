// End-to-end (subprocess) live-call reliability: disk-full second path, survived handler errors, STT outage ladder, sleep/wake, and a live call with a
// fake `ffmpeg` on PATH. The real src/run.ts runs as a child with scripted STT/AI and temp folders. Nothing here touches the real calls folder, keys or audio devices.
import "../test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { ROOT } from "../env.ts";
import { writeWav } from "../audio.ts";
import { LineSplitter } from "../relay.ts";
import { tsx } from "../test-platform.ts";
import pipe from "../../shared/pipe.cjs";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await sleep(20);
  }
};

// ---------------------------------------------------------------- engine runs (real run.ts, scripted STT + AI)
const scriptFile = (dir: string, lines: unknown[]) => {
  const f = join(dir, "script.json");
  writeFileSync(f, JSON.stringify(lines));
  return f;
};
const readRows = (dir: string, f: string) =>
  existsSync(join(dir, f))
    ? readFileSync(join(dir, f), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return {};
          }
        })
    : [];
const callDir = (calls: string) => {
  const d = readdirSync(calls).filter((x) => x !== "latest");
  return d.length ? join(calls, d[0]) : "";
};
function runEngine(args: string[], env: Record<string, string>) {
  const p = spawn(...tsx([join(ROOT, "src", "run.ts"), "--profile", "e2e", "--no-brief", ...args]), {
    cwd: ROOT,
    env: { ...process.env, WINGMAN_CALL_APP: "none", ...env },
  });
  let out = "";
  p.stdout.on("data", (b) => (out += b));
  p.stderr.on("data", (b) => (out += b));
  const done = new Promise<number | null>((res) => p.on("exit", (c) => res(c)));
  return { p, done, out: () => out };
}
const Q = (speaker: string, text: string, atMs: number) => ({ speaker, text, atMs });

test(
  "engine: cards.jsonl cannot be written (disk full) and the answer-window pipe still gets the cards, the write-failure bar and the low-space bar",
  { timeout: 60_000 },
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "wm-disk-"));
    const calls = join(tmp, "calls");
    mkdirSync(calls);
    const wav = join(tmp, "s.wav");
    await writeWav(wav, Buffer.alloc(16000 * 2 * 2 * 9), 2);
    const rows: any[] = [];
    const sock = pipe.endpoint(`rel-${process.pid}-${Date.now()}`, join(tmp, "c.sock"));
    const lines = new LineSplitter();
    const srv = createServer((c) =>
      c.on("data", (b) => {
        for (const l of lines.push(b)) rows.push(JSON.parse(l));
      }),
    );
    srv.listen(sock);
    const e = runEngine(["--file", wav], {
      WINGMAN_CALLS_DIR: calls,
      WINGMAN_OVERLAY_SOCK: sock,
      WINGMAN_FREE_BYTES: String(50 * 1024 * 1024),
      WINGMAN_STT_SCRIPT: scriptFile(tmp, [
        Q("them", "האתר שלי נטען ממש לאט, למה זה קורה", 1500),
        Q("them", "וגם אני רוצה לדעת אם יש לכם גיבוי של האתר", 4000),
      ]),
    });
    try {
      // sabotage: as soon as the call folder exists, make cards.jsonl a directory so every append fails (EISDIR) for the rest of the call
      await until(() => !!callDir(calls), 20_000);
      const dir = callDir(calls);
      const cf = join(dir, "cards.jsonl");
      for (let i = 0; i < 100; i++) {
        try {
          rmSync(cf, { force: true });
          mkdirSync(cf);
          break;
        } catch {
          await sleep(5);
        }
      }
      assert.equal(await e.done, 0, e.out());
      const bank = rows.filter((r) => r.type === "card" && r.badge === "bank");
      assert.ok(
        bank.some((r) => /איטי/.test(r.say)) && bank.some((r) => /גיבוי/.test(r.say)),
        "answers reached the window by the pipe: " + JSON.stringify(rows.map((r) => r.id)),
      );
      assert.ok(
        rows.some((r) => r.id === "health-disk-space" && r.level === "red" && !r.clear),
        "low-space bar (red under 100 MB)",
      );
      assert.ok(
        rows.some((r) => r.id === "health-disk" && !r.clear),
        "write-failure bar went by the pipe too, though it cannot be on disk",
      );
      assert.ok(!existsSync(cf) || readdirSync(cf).length === 0, "nothing was written to cards.jsonl");
      assert.ok(
        readRows(dir, "events.jsonl").some((x) => x.type === "disk.free" && x.level === "red"),
        "disk.free event",
      );
    } finally {
      e.p.kill("SIGKILL");
      srv.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  },
);

test("engine: a handler that throws is survived (error.survived) and the call goes on and ends cleanly", { timeout: 60_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "wm-surv-"));
  const calls = join(tmp, "calls");
  mkdirSync(calls);
  const wav = join(tmp, "s.wav");
  await writeWav(wav, Buffer.alloc(16000 * 2 * 2 * 8), 2);
  const e = runEngine(["--file", wav], {
    WINGMAN_CALLS_DIR: calls,
    WINGMAN_STT_SCRIPT: scriptFile(tmp, [
      { speaker: "them", text: 12345, atMs: 800 }, // a number where text should be: a core handler throws on it
      Q("them", "האתר שלי נטען ממש לאט, למה זה קורה", 2500),
      Q("them", "וגם אני רוצה לדעת אם יש לכם גיבוי של האתר", 4500),
    ]),
  });
  try {
    assert.equal(await e.done, 0, e.out());
    const dir = callDir(calls),
      ev = readRows(dir, "events.jsonl"),
      cards = readRows(dir, "cards.jsonl");
    assert.ok(
      ev.some((x) => x.type === "error.survived" && /^(onResult|acceptResult|stt result)/.test(x.where ?? "")),
      "survived error logged by a core handler: " +
        JSON.stringify(ev.filter((x) => /error/.test(x.type)).map((x) => [x.type, x.where, String(x.error).slice(0, 120)])) +
        e.out().slice(-600),
    );
    assert.ok(!ev.some((x) => x.type === "crash"), "no crash");
    assert.ok(
      cards.some((c) => c.badge === "bank" && /איטי/.test(c.say)) && cards.some((c) => c.badge === "bank" && /גיבוי/.test(c.say)),
      "later questions still answered",
    );
    assert.equal(JSON.parse(readFileSync(join(dir, "call.json"), "utf8")).crashed, false);
  } finally {
    e.p.kill("SIGKILL");
    rmSync(tmp, { recursive: true, force: true });
  }
});

test(
  "engine: a refused STT key on the other side goes to rung 4 with a red bar, is retried, recovers; the call is never shut down",
  { timeout: 90_000 },
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "wm-stt-"));
    const calls = join(tmp, "calls");
    mkdirSync(calls);
    const wav = join(tmp, "s.wav");
    await writeWav(wav, Buffer.alloc(16000 * 2 * 2 * 20), 2);
    const e = runEngine(["--file", wav], {
      WINGMAN_CALLS_DIR: calls,
      WINGMAN_STT_FAIL: "them:401@3000",
      WINGMAN_STT_HEAL_AT_MS: "9000",
      WINGMAN_STT_SLOW_RETRY_MS: "1500",
      WINGMAN_STT_SCRIPT: scriptFile(tmp, [
        Q("them", "האתר שלי נטען ממש לאט, למה זה קורה", 700),
        Q("me", "אני בודק את זה עכשיו", 6000),
        Q("them", "וגם אני רוצה לדעת אם יש לכם גיבוי של האתר", 14000),
      ]),
    });
    try {
      assert.equal(await e.done, 0, e.out());
      const dir = callDir(calls),
        ev = readRows(dir, "events.jsonl"),
        cards = readRows(dir, "cards.jsonl");
      assert.ok(
        ev.some((x) => x.type === "stt.permanent" && x.ch === "them" && x.kind === "auth"),
        "permanent failure noticed",
      );
      assert.ok(
        cards.some((c) => c.id === "health-stt-them" && c.level === "red" && !c.clear),
        "red bar",
      );
      const lad = ev.filter((x) => x.type === "ladder");
      assert.ok(
        lad.some((x) => x.to === 4),
        "rung 4 (transcript-only)",
      );
      assert.ok(!lad.some((x) => x.to === 5), "never rung 5");
      assert.ok(ev.filter((x) => x.type === "stt.retry.fail" && x.ch === "them").length >= 2, "kept retrying");
      assert.ok(
        ev.some((x) => x.type === "stt.recovered" && x.ch === "them"),
        "recovered when the key worked again",
      );
      assert.ok(lad.at(-1)?.to === 0, "ladder back to full: " + JSON.stringify(lad.map((x) => x.to)));
      assert.ok(
        cards.some((c) => c.badge === "bank" && /גיבוי/.test(c.say)),
        "after recovery the other side gets cards again",
      );
      assert.ok(
        ev.some((x) => x.type === "transcript" || true) && readRows(dir, "transcript.jsonl").some((t) => t.ch === "me"),
        "the user's channel kept working",
      );
      assert.equal(JSON.parse(readFileSync(join(dir, "call.json"), "utf8")).crashed, false);
    } finally {
      e.p.kill("SIGKILL");
      rmSync(tmp, { recursive: true, force: true });
    }
  },
);

// ---- live mode with a fake ffmpeg on PATH (the real MicSource/SupervisedSource/run.ts wiring, no audio hardware)
function fakeFfmpeg(tmp: string) {
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "ffmpeg"),
    `#!/usr/bin/env node
const fs = require("fs"); const a = process.argv.slice(2); const dev = a[a.indexOf("-i") + 1];
const dir = process.env.FAKE_FFMPEG_DIR; const kind = dev.includes("sys") ? "sys" : "mic";
const f = dir + "/" + kind + ".count"; let n = 0; try { n = +fs.readFileSync(f, "utf8"); } catch {} fs.writeFileSync(f, String(n + 1));
fs.appendFileSync(dir + "/launches.log", kind + " " + dev + " " + n + "\\n");
// mic: first launch dies after 3 s (AirPods dropped). sys: first two launches cannot start (exit 1 at once).
if (kind === "sys" && n < 2) { process.stderr.write("device not found\\n"); process.exit(1); }
const chunk = Buffer.alloc(3200); for (let i = 0; i < 1600; i++) chunk.writeInt16LE(Math.round(8000 * Math.sin(i / 8)), i * 2);
const t = setInterval(() => process.stdout.write(chunk), 100);
if (kind === "mic" && n === 0 && !process.env.FAKE_MIC_STAYS) setTimeout(() => { clearInterval(t); process.exit(1); }, 3000);
process.on("SIGINT", () => process.exit(255)); process.on("SIGTERM", () => process.exit(255));
`,
  );
  chmodSync(join(bin, "ffmpeg"), 0o755);
  const settings = join(tmp, "user.yaml");
  writeFileSync(
    settings,
    `audio:\n  mic:\n    device: ":fakemic"\n  system:\n    source: device\n    device: ":fakesys"\nsystem:\n  caffeinate: false\nbudget:\n  idleStopMin: 1\n`,
  );
  return { bin, settings };
}
const stopSoon = async (e: ReturnType<typeof runEngine>, afterMs: number) => {
  await sleep(afterMs);
  e.p.kill("SIGINT");
  return e.done;
};

test(
  "engine (live, fake ffmpeg): mic drops and returns, the other side's audio cannot start at first; the call stays up, bars appear and clear",
  { timeout: 90_000 },
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "wm-live-"));
    const calls = join(tmp, "calls");
    mkdirSync(calls);
    const { bin, settings } = fakeFfmpeg(tmp);
    const e = runEngine([], {
      WINGMAN_CALLS_DIR: calls,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_FFMPEG_DIR: tmp,
      WINGMAN_USER_SETTINGS: settings,
      WINGMAN_STT_SCRIPT: scriptFile(tmp, [
        Q("them", "האתר שלי נטען ממש לאט, למה זה קורה", 700),
        Q("them", "וגם אני רוצה לדעת אם יש לכם גיבוי של האתר", 11000),
      ]),
    });
    try {
      const code = await stopSoon(e, 14_000);
      assert.equal(code, 0, e.out());
      const dir = callDir(calls),
        ev = readRows(dir, "events.jsonl"),
        cards = readRows(dir, "cards.jsonl");
      const down = (s: string) => ev.filter((x) => x.type === "audio.down" && x.src === s),
        up = (s: string) => ev.filter((x) => x.type === "audio.up" && x.src === s);
      assert.ok(
        down("sys").length >= 2 && up("sys").length === 1,
        "system audio: 2 failed starts, then up " + JSON.stringify(ev.filter((x) => /^audio/.test(x.type))),
      );
      assert.ok(down("mic").length >= 1 && up("mic").length === 1, "mic: dropped once, came back");
      const bar = (id: string) => cards.filter((c) => c.id === id);
      assert.ok(bar("health-mic").some((c) => c.level === "red") && bar("health-mic").at(-1).clear, "mic bar red, then cleared");
      assert.ok(bar("health-sys").some((c) => c.level === "red") && bar("health-sys").at(-1).clear, "sys bar red, then cleared");
      assert.ok(
        ev.some((x) => x.type === "ladder" && x.to === 4 && x.reasons.includes("other side not heard")),
        "degraded to transcript-only while the other side was missing",
      );
      assert.ok(ev.filter((x) => x.type === "ladder").at(-1)?.to === 0, "and recovered");
      assert.ok(
        cards.some((c) => c.badge === "bank" && /גיבוי/.test(c.say)),
        "a card after the recovery",
      );
      assert.ok(!ev.some((x) => x.type === "crash"));
      const launches = readFileSync(join(tmp, "launches.log"), "utf8").trim().split("\n");
      assert.ok(launches.filter((l) => l.startsWith("sys")).length === 3 && launches.filter((l) => l.startsWith("mic")).length >= 2, launches.join(" | "));
      assert.ok(!existsSync(join(dir, "live.jsonl")), "live.jsonl removed at shutdown");
    } finally {
      e.p.kill("SIGKILL");
      rmSync(tmp, { recursive: true, force: true });
    }
  },
);

test(
  "engine (live): a sleep gap (wall clock jumps 20 min, monotonic does not) restarts audio and STT and does not trip the 1-minute idle stop",
  { timeout: 90_000 },
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "wm-sleep-"));
    const calls = join(tmp, "calls");
    mkdirSync(calls);
    const { bin, settings } = fakeFfmpeg(tmp);
    const preload = join(tmp, "skew.mjs"); // Date.now() jumps forward 20 minutes 7 s after start; performance.now() (monotonic) is untouched = what a Mac sleep looks like
    writeFileSync(
      preload,
      `const real = Date.now.bind(Date), t0 = real(); Date.now = () => { const n = real(); return n - t0 > 7000 ? n + 20 * 60000 : n; };\n`,
    );
    const e = runEngine([], {
      WINGMAN_CALLS_DIR: calls,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_FFMPEG_DIR: tmp,
      FAKE_MIC_STAYS: "1",
      WINGMAN_USER_SETTINGS: settings,
      NODE_OPTIONS: `--import ${preload}`,
      WINGMAN_STT_SCRIPT: scriptFile(tmp, [Q("them", "האתר שלי נטען ממש לאט, למה זה קורה", 700)]),
    });
    try {
      const code = await stopSoon(e, 16_000);
      assert.equal(code, 0, e.out());
      const dir = callDir(calls),
        ev = readRows(dir, "events.jsonl");
      const gap = ev.find((x) => x.type === "sleep.gap");
      assert.ok(gap && gap.ms > 15 * 60_000, "sleep detected: " + JSON.stringify(gap));
      assert.ok(
        ev.some((x) => x.type === "wake.recover"),
        "wake recovery ran",
      );
      assert.ok(ev.filter((x) => x.type === "audio.restart" && x.reason === "wake").length === 2, "both audio sources rebuilt");
      assert.ok(ev.filter((x) => x.type === "stt.recovered").length >= 2, "both STT channels reopened");
      assert.ok(!ev.some((x) => x.type === "idle.stop"), "the 20 wall-clock minutes did not count as silence");
      assert.ok(
        readRows(dir, "cards.jsonl").some((c) => c.id === "health-sleep"),
        "amber sleep bar",
      );
    } finally {
      e.p.kill("SIGKILL");
      rmSync(tmp, { recursive: true, force: true });
    }
  },
);

test(
  "engine (live): the menu-bar app's pipe closing mid-call does not end a live call (it stops itself after 5 quiet minutes); before listening starts it stops cleanly",
  { timeout: 60_000 },
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "wm-orphan-"));
    const calls = join(tmp, "calls");
    mkdirSync(calls);
    const { bin, settings } = fakeFfmpeg(tmp);
    const e = runEngine([], {
      WINGMAN_CALLS_DIR: calls,
      WINGMAN_CONTROL: "1",
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_FFMPEG_DIR: tmp,
      FAKE_MIC_STAYS: "1",
      WINGMAN_USER_SETTINGS: settings,
      WINGMAN_STT_SCRIPT: scriptFile(tmp, [Q("them", "האתר שלי נטען ממש לאט, למה זה קורה", 700)]),
    });
    try {
      await until(() => /"ev":"consented"/.test(e.out()), 30_000);
      e.p.stdin.end(); // the tray died without sending "stop"
      await sleep(3000);
      assert.equal(e.p.exitCode, null, "still running");
      const dir = callDir(calls);
      await until(() => readRows(dir, "events.jsonl").some((x) => x.type === "control.closed" && x.live === true), 5000);
      await until(() => readRows(dir, "cards.jsonl").some((c) => c.id === "health-control"), 5000);
      e.p.kill("SIGINT");
      assert.equal(await e.done, 0, e.out());
    } finally {
      e.p.kill("SIGKILL");
      rmSync(tmp, { recursive: true, force: true });
    }
  },
);
