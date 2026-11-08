// End to end: the real engine (src/run.ts) takes its microphone from the app's capture bridge (a fake capture window behind the real
// tray/capture-bridge.cjs) and never starts ffmpeg. Covers a normal start, a lost device that comes back, a missing saved microphone
// and a blocked microphone permission that is fixed during the call. No hardware, no Electron, no network.
import "../test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_BIN } from "../test-platform.ts";
import { fakeCaptureHost } from "../testkit/fake-capture-host.ts";
import { sleep, until, scriptFile, readRows, callDir, runEngine, Q, fakeFfmpeg, stopSoon } from "./helpers.ts";

const { createCaptureBridge } = createRequire(import.meta.url)("../../tray/capture-bridge.cjs");

async function rig(micSetting: string) {
  const tmp = mkdtempSync(join(tmpdir(), "wm-appcap-"));
  const calls = join(tmp, "calls");
  mkdirSync(calls);
  const { bin } = fakeFfmpeg(tmp); // on PATH to prove it is never started
  const settings = join(tmp, "user.yaml");
  writeFileSync(
    settings,
    `audio:\n  mic:\n    device: "${micSetting}"\n  system:\n    source: "off"\nsystem:\n  caffeinate: false\nbudget:\n  idleStopMin: 1\n`,
  );
  const host = fakeCaptureHost({ devices: ["Fake Microphone", "Fake Headset"] });
  const bridge = createCaptureBridge({ host });
  await bridge.listen();
  const engine = (extra: Record<string, string> = {}) =>
    runEngine([], {
      WINGMAN_CALLS_DIR: calls,
      PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
      FAKE_FFMPEG_DIR: tmp,
      WINGMAN_USER_SETTINGS: settings,
      ...bridge.env(),
      WINGMAN_STT_SCRIPT: scriptFile(tmp, [Q("them", "האתר שלי נטען ממש לאט, למה זה קורה", 700)]),
      ...extra,
    });
  const clean = async () => {
    await bridge.close();
    host.destroy();
    rmSync(tmp, { recursive: true, force: true });
  };
  return { tmp, calls, host, engine, clean };
}

test(
  "app capture (engine): the mic comes from the app by its saved name, a lost device comes back, ffmpeg is never started",
  { timeout: 60_000, ...FAKE_BIN },
  async () => {
    const r = await rig(":2|Fake Headset");
    const e = r.engine();
    try {
      await until(() => r.host.calls.some((c) => c === "start mic Fake Headset"), 20_000);
      await sleep(1500);
      r.host.drop("mic", "headset unplugged");
      await until(() => r.host.calls.filter((c) => c.startsWith("start mic")).length >= 2, 10_000);
      await sleep(2500);
      const code = await stopSoon(e, 0);
      assert.equal(code, 0, e.out());
      const dir = callDir(r.calls),
        ev = readRows(dir, "events.jsonl"),
        cards = readRows(dir, "cards.jsonl");
      assert.ok(
        ev.some((x) => x.type === "audio.down" && x.src === "mic" && /headset unplugged/.test(x.reason)),
        "the drop is logged",
      );
      assert.ok(
        ev.some((x) => x.type === "audio.up" && x.src === "mic"),
        "and the mic comes back",
      );
      assert.ok(
        cards.some((c) => c.id === "health-mic" && c.level === "red"),
        "a red bar while it was down",
      );
      assert.equal(cards.filter((c) => c.id === "health-mic").at(-1).clear, true, "which is cleared");
      assert.ok(!ev.some((x) => x.type === "audio.mic.gone"), "a microphone that is there raises no warning");
      assert.ok(r.host.calls.at(-1) === "stop mic", "the capture is stopped at the end: " + r.host.calls.join(","));
      assert.ok(!existsSync(join(r.tmp, "launches.log")), "ffmpeg was never launched");
      assert.ok(!ev.some((x) => x.type === "crash"));
    } finally {
      e.p.kill("SIGKILL");
      await r.clean();
    }
  },
);

test("app capture (engine): a saved microphone that is gone uses the default and warns", { timeout: 60_000, ...FAKE_BIN }, async () => {
  const r = await rig(":3|Old Bluetooth Headset");
  const e = r.engine();
  try {
    await until(() => r.host.calls.includes("start mic Old Bluetooth Headset"), 20_000);
    await sleep(1500);
    const code = await stopSoon(e, 0);
    assert.equal(code, 0, e.out());
    const dir = callDir(r.calls);
    assert.ok(readRows(dir, "events.jsonl").some((x) => x.type === "audio.mic.gone" && x.name === "Old Bluetooth Headset"));
    const bars = readRows(dir, "cards.jsonl").filter((c) => c.id === "health-mic-device");
    assert.ok(
      bars.some((c) => c.level === "amber" && c.say.includes("Old Bluetooth Headset")),
      "an amber bar names the missing microphone",
    );
  } finally {
    e.p.kill("SIGKILL");
    await r.clean();
  }
});

test(
  "app capture (engine): a blocked microphone shows the permission text, and the call recovers once it is allowed",
  { timeout: 60_000, ...FAKE_BIN },
  async () => {
    const r = await rig(":default");
    r.host.failNext.mic = { code: "permission", message: "microphone access is denied", keep: true };
    const e = r.engine();
    try {
      await until(() => r.host.calls.length >= 1, 20_000);
      await sleep(1200);
      delete r.host.failNext.mic; // the user allowed it in the system settings
      await until(() => r.host.running("mic"), 15_000);
      await sleep(2500);
      const code = await stopSoon(e, 0);
      assert.equal(code, 0, e.out());
      const dir = callDir(r.calls),
        ev = readRows(dir, "events.jsonl"),
        bars = readRows(dir, "cards.jsonl").filter((c) => c.id === "health-mic");
      assert.ok(ev.some((x) => x.type === "audio.down" && x.src === "mic" && /denied/.test(x.reason)));
      // The call language decides the text; both say what to do: allow the microphone in the privacy settings.
      assert.ok(
        bars.some((c) => c.level === "red" && /(אין הרשאה למיקרופון|not allowed to use the microphone)/.test(c.say)),
        JSON.stringify(bars),
      );
      assert.ok(ev.some((x) => x.type === "audio.up" && x.src === "mic"));
      assert.equal(bars.at(-1).clear, true);
    } finally {
      e.p.kill("SIGKILL");
      await r.clean();
    }
  },
);
