// Audio input: the replay file (--file) or the supervised mic and system-audio sources, with the echo gate for the mic.
import { spawn } from "node:child_process";
import { childEnv } from "../env.ts";
import { FileSource, SupervisedSource, pickMicDevice, avDevice, peakOf, parseMicSetting, resolveMicSetting } from "../audio.ts";
import { backendFor } from "../audio-platform.ts";
import { resolveEchoMode, type EchoMode } from "../echo.ts";
import { readAudioDevices, listInputDevices, bluetoothInUse } from "../devices.ts";
import { stopConsentTimer } from "./consent.ts";
import { startTapWatchdog, stopTapWatchdog, noteMicFrame, micBack, stopMicWatch, micStarted } from "./watchdogs.ts";
import { startSources } from "./start-sources.ts";
import { eventError } from "../errtext.ts";
import { stops, lifecycle } from "./lifecycle.ts";
import { sup, log, PHONE, gate, phone, S, ECHO, UI_LANG } from "./boot.ts";
import { ht } from "../htext.ts";
import { chans, st } from "./state.ts";
import { safe, healthClear, health } from "./out.ts";

/** One audio start gets this long before the call goes on without it (the source keeps retrying in the background). Under the 10 s hard shutdown timer. */
export const SOURCE_START_TIMEOUT_MS = 8000;

/** Mic + system audio, restarted after a sleep gap. */
export const liveSources: SupervisedSource[] = [];

function setEchoMode(m: EchoMode) {
  if (PHONE) m = "off";
  st.echo.mode = m;
  st.echo.useGate = m === "gate" || m === "both";
  st.echo.useFilter = m === "filter" || m === "both";
}

/** Mic audio passes through the gate: while the client is voiced, the mic sends silence (keeps the stream timing). */
function gateMic(b: Buffer): Buffer {
  if (!st.echo.useGate || !gate.closed()) return b;
  st.echo.gatedMs += (b.length / 32000) * 1000;
  return Buffer.alloc(b.length);
}

/** Supervisor events -> log + health bars. The bar appears at the first failure and goes when frames flow again. */
const wireSource = (src: SupervisedSource, name: "mic" | "sys", id: string, downText: (code?: string) => string, onDown: () => void, onUp: () => void) => {
  let shown = false;
  src.on(
    "down",
    safe(`${name} down`, (d: { reason: string; n: number; delayMs: number; code?: string }) => {
      log.write("events", { type: "audio.down", src: name, reason: d.reason, n: d.n, retryInMs: d.delayMs });
      console.error(`${name} audio down (${d.reason}); retry ${d.n} in ${Math.round(d.delayMs / 1000)} s`);
      if (!shown) {
        shown = true;
        health(id, "red", downText(d.code), d.reason);
        onDown();
      }
    }),
  );
  src.on(
    "up",
    safe(`${name} up`, (d: { after: number }) => {
      log.write("events", { type: "audio.up", src: name, downMs: d.after });
      console.log(`${name} audio is back (down ${Math.round(d.after / 1000)} s)`);
      if (shown) {
        shown = false;
        healthClear(id);
        onUp();
      }
    }),
  );
  src.on("restart", (d: { reason: string }) => log.write("events", { type: "audio.restart", src: name, reason: d.reason }));
  src.on("log", (m: string) => console.log(m));
};

/** Replay of a stereo file (--file): L = me, R = them. */
/** Replay mix gain of the other side relative to the user: a phone speaker across the desk is about 16 dB below a voice next to the mic. */
export const PHONE_FAR_GAIN = 0.15;

export async function startFileSource(file: string) {
  const f = new FileSource(file);
  if (PHONE) {
    // Phone replay: the Mac mic hears both. Mix L (me) + R (them, quieter: a phone speaker further away) into one mono stream.
    let themBuf: Buffer | undefined;
    f.on("pcm-them", (b) => {
      themBuf = b;
    });
    f.on("pcm-me", (b) => {
      const t = themBuf;
      themBuf = undefined;
      const out = Buffer.alloc(b.length);
      for (let i = 0; i + 1 < b.length; i += 2)
        out.writeInt16LE(Math.max(-32768, Math.min(32767, b.readInt16LE(i) + (t && i + 1 < t.length ? Math.round(t.readInt16LE(i) * PHONE_FAR_GAIN) : 0))), i);
      phone!.recordMic(out);
      chans.me.send(out);
    });
  } else {
    f.on("pcm-them", (b) => {
      gate.noteThemPeak(peakOf(b));
      chans.them.send(b);
    });
    f.on("pcm-me", (b) => chans.me.send(gateMic(b)));
  }
  f.on("end", () => setTimeout(() => void lifecycle.shutdown(), 4000));
  await f.start();
  const stop = () => f.stop();
  stops.push(stop);
  if (st.call.shuttingDown) await stop().catch(() => {}); // Stop came while the source was starting: shutdown ran with nothing to stop yet
}

/** Live capture: starts the supervised mic and system-audio sources and the watchdogs around them. */
/** The saved mic against the microphones ffmpeg lists now (re-resolved at every start of the mic source). Logs a moved index; warns when the name is gone. */
async function resolveMic(saved: string) {
  const r = resolveMicSetting(saved, await listInputDevices(3000));
  if (r.moved) log.write("events", { type: "audio.mic.moved", name: r.name, using: r.device });
  if (r.gone) {
    log.write("events", { type: "audio.mic.gone", name: r.name });
    health("mic-device", "amber", ht(UI_LANG, "mic.gone", { name: r.name ?? "" }));
  } else healthClear("mic-device");
  return r;
}

export async function startLiveSources() {
  if (st.call.shuttingDown) return;
  if (S.system.caffeinate && process.platform === "darwin")
    spawn("caffeinate", ["-dis", "-w", String(process.pid)], { stdio: "ignore", env: childEnv() })
      .on("error", () => {})
      .unref();
  // Client audio: audiotee (macOS tap) | device (avfoundation input such as BlackHole, via ffmpeg) | off.
  const backend = backendFor();
  const srcKind = S.audio.system.source;
  const W = S.audio.watchdog;
  const deadFrameMs = Math.max(W.silentThemMs, 8000);
  // Both sources are supervised: a source that cannot start, exits, or goes quiet (AirPods dropped, default input changed, ffmpeg/audiotee died)
  // is rebuilt with backoff 1, 2, 4 s, then every 10 s, with the device looked up again each time. The call degrades (no mic / no other side) instead of ending.
  const sys =
    !PHONE && (srcKind === "audiotee" || srcKind === "device")
      ? new SupervisedSource({
          name: "sys",
          stallMs: deadFrameMs + 4000,
          make: () => backend.createSystem(srcKind, S.audio.system.device),
        })
      : undefined;
  const micDevice = S.audio.mic.device;
  const mic = new SupervisedSource({
    name: "mic",
    stallMs: 10_000,
    make: async (failures) => {
      if (backend.resolvesDevices) {
        // The app backend finds the saved microphone by its name in the capture window (no ffmpeg list); it says when the name is gone.
        return backend.createMic(micDevice, (name) => {
          if (!name) return healthClear("mic-device");
          log.write("events", { type: "audio.mic.gone", name });
          health("mic-device", "amber", ht(UI_LANG, "mic.gone", { name }));
        });
      }
      const devs = failures ? await readAudioDevices() : []; // asked only after a failure; system_profiler takes ~0.3 s
      // A saved name is checked against what is plugged in at every start: indexes move when a headset or a USB mic connects.
      const want = parseMicSetting(micDevice).name ? await resolveMic(micDevice) : { device: avDevice(micDevice) };
      const dev = pickMicDevice(want.device, devs, failures);
      if (failures) {
        log.write("events", { type: "audio.mic.device", configured: micDevice, using: dev, failures });
        console.log(`mic: trying ${dev}`);
      }
      return backend.createMic(dev);
    },
  });
  liveSources.push(mic);
  if (sys) liveSources.push(sys);
  const devsP = readAudioDevices();
  if (ECHO.mode === "auto" && !PHONE)
    void devsP.then((devs) => {
      const m = resolveEchoMode("auto", devs);
      setEchoMode(m);
      log.write("events", { type: "echo.mode", mode: m, output: devs.find((d) => d.defaultOutput)?.name ?? "" });
      console.log(`Speakers mode auto: ${m} (output: ${devs.find((d) => d.defaultOutput)?.name ?? "unknown"})`);
    });
  if (S.audio.warnBluetooth)
    void devsP.then((devs) => {
      const bt = bluetoothInUse(devs);
      if (!bt || st.call.shuttingDown) return;
      log.write("events", { type: "audio.bluetooth", role: bt.role, device: bt.device.name });
      health("bluetooth", "amber", bt.role === "mic" ? ht(UI_LANG, "bt.mic", { dev: bt.device.name }) : ht(UI_LANG, "bt.out", { dev: bt.device.name }));
    });
  console.log(
    `Mic device: ${avDevice(micDevice)} (audio.mic.device / WINGMAN_MIC) · client audio: ${srcKind}${srcKind === "device" ? ` (${S.audio.system.device})` : ""}`,
  );
  mic.on(
    "pcm",
    safe("mic pcm", (b: Buffer) => {
      if (!st.call.consented) return;
      noteMicFrame(peakOf(b));
      phone?.recordMic(b);
      chans.me.send(gateMic(b));
    }),
  );
  // Supervisor events -> log + health bars. The bar appears at the first failure and goes when frames flow again.
  wireSource(
    mic,
    "mic",
    "mic",
    (code) => ht(UI_LANG, code === "permission" ? "mic.denied" : code === "busy" ? "mic.busy" : "mic.down"),
    () => {},
    micBack,
  );
  if (sys) {
    sys.on(
      "pcm",
      safe("sys pcm", (b: Buffer) => {
        gate.noteThemPeak(peakOf(b));
        if (st.call.consented) chans.them.send(b);
      }),
    );
    wireSource(
      sys,
      "sys",
      "sys",
      (code) => ht(UI_LANG, code === "permission" ? "sys.denied" : "sys.down"),
      () => sup.set({ themDead: true }),
      () => sup.set({ themDead: false }),
    );
  } else if (PHONE) {
    console.log("Phone mode: one microphone hears both of you (phone on speaker). The louder voice is you.");
    log.write("events", { type: "phone.mode", on: true });
  } else {
    console.log("audio.system.source is off: no audio from the other side, so only your own questions get answers (Ctrl+Opt+A).");
    sup.set({ themDead: true });
  }
  // Neither start() can fail the call: a source that will not start is retried in the background. The stoppers are registered before the starts are
  // awaited (a Stop during a slow start finds them), and each start has a timeout (a hung audiotee start must not hang the engine).
  const stoppers = [
    async () => {
      stopMicWatch();
      stopConsentTimer();
      stopTapWatchdog();
    },
    async () => {
      await sys?.stop();
    },
    () => mic.stop(),
  ];
  const go = await startSources({
    sys,
    mic,
    stoppers,
    stops,
    isStopping: () => st.call.shuttingDown,
    timeoutMs: SOURCE_START_TIMEOUT_MS,
    onTimeout: (name) => {
      log.write("events", { type: "audio.start.timeout", source: name, ms: SOURCE_START_TIMEOUT_MS });
      console.log(`${name}: start is slow (over ${SOURCE_START_TIMEOUT_MS / 1000} s); the source keeps trying in the background`);
    },
    onError: (name, e) => log.write("events", { type: "audio.start.error", source: name, error: eventError(e) }),
    onMicStarted: micStarted,
  });
  if (!go) return;
  startTapWatchdog(sys, deadFrameMs);
}
