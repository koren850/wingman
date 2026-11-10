// Audio sources for the engine (run.ts). All emit 16 kHz mono s16le PCM chunks as "pcm" events.
//  - system: AudioTee (Core Audio tap, macOS 14.2+) -> "them"; or audio.system.source=device: an avfoundation input (e.g. BlackHole) through ffmpeg, same class as the mic
//  - mic:    ffmpeg avfoundation -> "me"
//  - file:   a stereo wav (L = me, R = them) paced in real time, for replay and tests ("pcm-me" / "pcm-them")
// Audio is never written to disk by the engine; only transcripts are saved. Child processes get childEnv() (no API keys).
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { AudioTee } from "audiotee";
import { childEnv } from "./env.ts";

export interface Source extends EventEmitter {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** The other side's audio: a system-wide Core Audio tap. `peak` = loudest sample seen so far (0-1). Emits "pcm" and "error". */
export class SystemSource extends EventEmitter implements Source {
  private tee = new AudioTee({ sampleRate: 16000, chunkDurationMs: 100 });
  peak = 0;
  async start() {
    this.tee.on("data", (c: { data: Buffer }) => {
      this.peak = Math.max(this.peak, peakOf(c.data));
      this.emit("pcm", c.data);
    });
    this.tee.on("error", (e: Error) => this.emit("error", e));
    await this.tee.start();
  }
  async stop() {
    await this.tee.stop();
  }
}

/** avfoundation input spec for an audio-only device: ":default", ":1", ":BlackHole 2ch". Bare names and indexes get the ":" prefix. */
export function avDevice(d: string): string {
  d = d.split("|")[0]; // a saved mic can carry its name after "|" (":2|MacBook Pro Microphone"), see resolveMicSetting
  return d.startsWith(":") ? d : `:${d}`;
}

/** The mic as saved by the setup window: ":2|Name" = index 2 when it was chosen, and the name of that device. Older settings are just ":2" or a name. */
export function parseMicSetting(v: string): { device: string; name?: string } {
  const i = v.indexOf("|");
  return i < 0 ? { device: v } : { device: v.slice(0, i), name: v.slice(i + 1).trim() || undefined };
}
const sameName = (a: string, b: string) => {
  const x = a.toLowerCase().trim(),
    y = b.toLowerCase().trim();
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};
/** Checks a saved mic against the devices that are plugged in now (ffmpeg's list, indexes as avfoundation numbers them today).
 *  Indexes move when AirPods or a USB mic connect, so the name wins: same name at another index = `moved` (the new index is used);
 *  name not there at all = `gone` (the default mic is used and the caller warns). No name saved, or an empty list (unreadable): the setting is used as it is. */
export function resolveMicSetting(v: string, inputs: { index: number; name: string }[]): { device: string; name?: string; moved?: boolean; gone?: boolean } {
  const { device, name } = parseMicSetting(v);
  if (!name || !inputs.length) return { device, name };
  const idx = /^:(\d+)$/.exec(device)?.[1];
  const atIndex = idx === undefined ? undefined : inputs.find((d) => d.index === Number(idx));
  if (atIndex && sameName(atIndex.name, name)) return { device, name };
  const found = inputs.find((d) => sameName(d.name, name));
  if (found) return { device: `:${found.index}`, name, moved: true };
  return { device: ":default", name, gone: true };
}

/**
 * s16le samples are 2 bytes. A pipe can split a sample across two reads; the level meters and the silence watchdog read samples in pairs,
 * so an odd chunk would shift every later sample by one byte. The returned function holds back a trailing odd byte and prepends it to the next chunk.
 * It returns null when there is nothing whole to emit yet.
 */
export function pcmAligner(): (b: Buffer) => Buffer | null {
  let spare: Buffer | undefined;
  return (b) => {
    const all = spare ? Buffer.concat([spare, b]) : b;
    spare = undefined;
    if (all.length % 2) {
      spare = Buffer.from(all.subarray(all.length - 1));
      const whole = all.subarray(0, all.length - 1);
      return whole.length ? whole : null;
    }
    return all.length ? all : null;
  };
}

// Audio children that are alive right now. A hard exit (the 10 s shutdown guard, the last-resort timer, a crash) must not leave an ffmpeg holding the mic:
// the exit hook kills them with SIGKILL, synchronously.
const liveChildren = new Set<ChildProcess>();
let exitHook = false;
function trackChild(p: ChildProcess) {
  liveChildren.add(p);
  p.once("exit", () => liveChildren.delete(p));
  if (!exitHook) {
    exitHook = true;
    process.once("exit", killAudioChildren);
  }
}
/** SIGKILL every audio child still alive. Synchronous, safe to call twice. Returns how many were signalled. */
export function killAudioChildren(): number {
  let n = 0;
  for (const p of liveChildren) {
    try {
      if (p.exitCode === null && p.signalCode === null && p.kill("SIGKILL")) n++;
    } catch {
      /* already gone */
    }
  }
  liveChildren.clear();
  return n;
}
/** How many audio children are alive (tests). */
export const liveAudioChildren = () => liveChildren.size;

/** Microphone (or any avfoundation input) via an ffmpeg child. Emits "pcm", "log" (ffmpeg stderr) and "error" (spawn failure or unexpected exit). */
export class MicSource extends EventEmitter implements Source {
  private p?: ChildProcess;
  private stopping = false;
  readonly device: string;
  /** device: avfoundation audio input, e.g. ":default", ":1" or "BlackHole 2ch" (settings audio.mic.device / audio.system.device). */
  constructor(device = ":default") {
    super();
    this.device = avDevice(device);
  }
  async start() {
    if (this.stopping) return; // stop() came first: never spawn after it
    // ":default" = default input device; list devices with: ffmpeg -f avfoundation -list_devices true -i ""
    // Set audio.mic.device (or WINGMAN_MIC) to ":1" (index) or a name. Avoid AirPods for the first calls.
    this.p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", this.device, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], {
      env: childEnv(),
    });
    trackChild(this.p);
    const align = pcmAligner();
    this.p.stdout!.on("data", (b: Buffer) => {
      const whole = align(b);
      if (whole) this.emit("pcm", whole);
    });
    this.p.stderr!.on("data", (b: Buffer) => this.emit("log", `mic: ${b.toString().trim()}`));
    this.p.on("error", (e) => this.emit("error", new Error(`ffmpeg mic: ${e.message}`)));
    // ffmpeg exits 255 on SIGINT; that is our own stop(), not an error.
    // Any exit we did not ask for is a drop (a vanished device can end ffmpeg with code 0 too). ffmpeg exits 255 on SIGINT: that is our own stop().
    this.p.on("exit", (code, sig) => {
      if (!this.stopping) this.emit("error", new Error(`ffmpeg mic exited ${code ?? sig}`));
    });
  }
  async stop() {
    this.stopping = true;
    const p = this.p;
    if (!p) return;
    p.kill("SIGINT");
    // A wedged ffmpeg can hold the mic and ignore SIGINT: escalate after 2 s.
    const t = setTimeout(() => {
      if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
    }, 2000);
    t.unref();
    p.once("exit", () => clearTimeout(t));
  }
}

/** Reconnect delay after the n-th failure in a row (n = 0 first): 1, 2, 4 s, then every 10 s. */
export const AUDIO_BACKOFF_MS = (n: number): number => (n < 3 ? 1000 * 2 ** n : 10_000);

/** The avfoundation spec to open on attempt `attempt`, given what is plugged in (names from system_profiler; [] = unknown).
 *  A named or numbered device that is gone (AirPods switched off) falls back to ":default" (the built-in mic or whatever macOS now defaults to).
 *  After two failed opens in a row an explicit device is given up on too, since the device list cannot always be read. */
export function pickMicDevice(configured: string, devices: { name: string }[], attempt: number): string {
  const want = avDevice(configured);
  if (want === ":default") return want;
  if (attempt >= 2) return ":default";
  const name = want.slice(1).toLowerCase();
  if (attempt === 0 || !devices.length || /^\d+$/.test(name)) return want;
  return devices.some((d) => d.name.toLowerCase().includes(name) || name.includes(d.name.toLowerCase())) ? want : ":default";
}

/** Options of SupervisedSource. `make(attempt)` builds a fresh inner source each time (re-resolving its device). */
export type SupervisedOpts = {
  name: string;
  make: (attempt: number) => Source | Promise<Source>;
  /** No frame for this long while running = the source hung (device vanished without the process exiting): restart it. 0 = off. */
  stallMs?: number;
  backoff?: (n: number) => number;
  /** A restarted source must deliver frames for this long before the failure count resets. */
  stableMs?: number;
};

/**
 * Keeps one audio source alive for the whole call. Events: "pcm", "log", "down" ({reason,n,delayMs,code}; code = the failing source's error code, e.g. "permission"), "up" ({after}: frames flow again after a "down"),
 * "retry" ({n,delayMs,attempt}), "restart" ({reason}). start() never rejects: a source that cannot start counts as down and is retried
 * (backoff 1, 2, 4 s, then every 10 s) until stop(). `restart(reason)` forces a fresh source (after sleep/wake).
 */
export class SupervisedSource extends EventEmitter implements Source {
  private inner?: Source;
  private stopped = false;
  private failures = 0; // consecutive failures (drives the backoff)
  private attempt = 0; // how many sources were built so far
  private isDown = false;
  private gen = 0; // generation: events of an older inner source are ignored
  private timer?: NodeJS.Timeout;
  private stallTimer?: NodeJS.Timeout;
  private stableTimer?: NodeJS.Timeout;
  private lastFrame = 0;
  private spawnedAt = 0;
  private watching = false; // a source was spawned and has not failed yet: the stall check applies, also while "down"
  private downSince = 0;
  private dropping?: Promise<void>; // the old source is still being stopped: the next one waits for it (two ffmpeg processes must not hold the mic together)
  frames = 0;
  constructor(private o: SupervisedOpts) {
    super();
  }
  get down() {
    return this.isDown;
  }
  get peak() {
    return (this.inner as { peak?: number } | undefined)?.peak ?? 0;
  }

  async start() {
    this.stopped = false;
    // A second start() replaces the first: one stall timer and one source, never two.
    clearInterval(this.stallTimer);
    clearTimeout(this.timer);
    if (this.inner) {
      this.gen++;
      await this.drop();
    }
    this.stallTimer = this.o.stallMs ? setInterval(() => this.checkStall(), Math.max(250, Math.min(2000, this.o.stallMs / 4))) : undefined;
    this.stallTimer?.unref();
    await this.spawn();
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.stallTimer);
    clearTimeout(this.stableTimer);
    this.gen++;
    await this.drop();
  }
  /** Replace the current source with a fresh one now (e.g. after the Mac woke up). */
  restart(reason: string) {
    if (this.stopped) return;
    this.emit("restart", { reason });
    this.fail(reason, true, true);
  }

  private async drop(): Promise<void> {
    const old = this.inner;
    this.inner = undefined;
    if (!old) return;
    old.removeAllListeners();
    old.on("error", () => {}); // a dying source must never raise an unhandled "error"
    try {
      await Promise.race([old.stop(), new Promise((r) => setTimeout(r, 3000).unref())]);
    } catch {
      /* already gone */
    }
  }
  private async spawn() {
    if (this.stopped) return;
    const gen = ++this.gen;
    if (this.dropping) {
      await this.dropping;
      if (this.stopped || gen !== this.gen) return;
    }
    const attempt = this.attempt++;
    this.spawnedAt = this.lastFrame = performance.now(); // per-spawn watchdog: a new source gets its own stall window
    this.watching = true;
    try {
      const src = await this.o.make(attempt);
      if (this.stopped || gen !== this.gen) {
        void src.stop().catch(() => {});
        return;
      }
      this.inner = src;
      src.on("pcm", (b: Buffer) => {
        if (gen === this.gen) this.onFrame(b);
      });
      src.on("log", (m: string) => {
        if (gen === this.gen) this.emit("log", m);
      });
      src.on("error", (e: Error) => {
        if (gen === this.gen) this.fail(e?.message ?? String(e), false, false, (e as { code?: string })?.code);
      });
      await src.start();
    } catch (e) {
      if (gen === this.gen) this.fail((e as Error)?.message ?? String(e), false, false, (e as { code?: string })?.code);
    }
  }
  private onFrame(b: Buffer) {
    this.lastFrame = performance.now();
    this.frames++;
    if (this.isDown) {
      this.isDown = false;
      this.emit("up", { after: performance.now() - this.downSince, attempt: this.attempt });
    }
    if (this.failures && !this.stableTimer)
      this.stableTimer = setTimeout(() => {
        this.failures = 0;
        this.stableTimer = undefined;
      }, this.o.stableMs ?? 5000);
    this.emit("pcm", b);
  }
  private checkStall() {
    if (this.stopped || !this.watching || !this.o.stallMs) return;
    // Also while down: a respawned source that never delivers frames is rebuilt again (with back-off) until frames flow.
    const since = performance.now() - Math.max(this.lastFrame, this.spawnedAt);
    if (since > this.o.stallMs) this.fail(`no audio for ${Math.round(since / 1000)} s`);
  }
  /** `quiet` = a planned restart (wake): no "down" event and no failure count, so no red bar. If the new source stays silent, the stall check fails it for real. */
  private fail(reason: string, immediate = false, quiet = false, code?: string) {
    if (this.stopped) return;
    this.watching = false;
    clearTimeout(this.timer);
    clearTimeout(this.stableTimer);
    this.stableTimer = undefined;
    this.gen++; // ignore whatever the old source still says
    const d = this.drop();
    this.dropping = d;
    void d.finally(() => {
      if (this.dropping === d) this.dropping = undefined;
    });
    if (quiet) {
      this.timer = setTimeout(() => {
        this.emit("retry", { n: 0, delayMs: 0, attempt: this.attempt });
        void this.spawn();
      }, 0);
      return;
    }
    if (!this.isDown) {
      this.isDown = true;
      this.downSince = performance.now();
    }
    const n = this.failures++;
    const delayMs = immediate ? 0 : (this.o.backoff ?? AUDIO_BACKOFF_MS)(n);
    this.emit("down", { reason, n: n + 1, delayMs, code });
    this.timer = setTimeout(() => {
      this.emit("retry", { n: n + 1, delayMs, attempt: this.attempt });
      void this.spawn();
    }, delayMs);
  }
}

/** Decodes any audio file to 16 kHz stereo s16le with ffmpeg and plays it out in real time as two channels. */
export class FileSource extends EventEmitter {
  private timer?: NodeJS.Timeout;
  constructor(
    private file: string,
    private speed = 1,
  ) {
    super();
  }
  async start() {
    const buf = await decode(this.file, 2);
    const frame = 1600 * 2 * 2; // 100 ms, 2 ch, 2 bytes
    let off = 0;
    this.timer = setInterval(() => {
      if (off >= buf.length) {
        clearInterval(this.timer);
        this.emit("end");
        return;
      }
      const chunk = buf.subarray(off, off + frame);
      off += frame;
      const me = Buffer.alloc(chunk.length / 2),
        them = Buffer.alloc(chunk.length / 2);
      for (let i = 0, j = 0; i + 3 < chunk.length; i += 4, j += 2) {
        chunk.copy(me, j, i, i + 2);
        chunk.copy(them, j, i + 2, i + 4);
      }
      this.emit("pcm-me", me);
      this.emit("pcm-them", them);
    }, 100 / this.speed);
  }
  async stop() {
    clearInterval(this.timer);
  }
}

/** Decodes any audio file with ffmpeg to raw 16 kHz s16le PCM (1 or 2 channels). Rejects if ffmpeg is missing or fails. */
export function decode(file: string, channels: 1 | 2): Promise<Buffer> {
  // A plain 16 kHz 16-bit PCM WAV with the wanted channel count (the practice call and `pnpm demo` write one) needs no ffmpeg.
  try {
    const b = readFileSync(file);
    const pcmWav =
      b.length >= 44 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 16) === "WAVEfmt " && b.toString("latin1", 36, 40) === "data";
    if (pcmWav && b.readUInt16LE(20) === 1 && b.readUInt16LE(22) === channels && b.readUInt32LE(24) === 16000 && b.readUInt16LE(34) === 16)
      return Promise.resolve(b.subarray(44));
  } catch {
    /* unreadable here: ffmpeg reports it below */
  }
  return new Promise((res, rej) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-ac", String(channels), "-ar", "16000", "-f", "s16le", "-"], {
      env: childEnv(),
    });
    const out: Buffer[] = [];
    p.stdout.on("data", (b) => out.push(b));
    p.on("error", (e) => rej(new Error(`ffmpeg not runnable: ${e.message}`)));
    p.on("close", (c) => (c ? rej(new Error(`ffmpeg decode failed (${c}) for ${file}`)) : res(Buffer.concat(out))));
  });
}

/** Loudest sample of an s16le buffer as 0-1. Used by the mic/tap watchdogs and the echo mic gate. */
export function peakOf(pcm: Buffer): number {
  let p = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) p = Math.max(p, Math.abs(pcm.readInt16LE(i)));
  return p / 32768;
}

/** Writes raw s16le PCM as a 44-byte-header WAV file (used by synth and tests). Returns a promise (fs is imported lazily). */
export function writeWav(path: string, pcm: Buffer, channels: number, rate = 16000) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return import("node:fs").then((fs) => fs.writeFileSync(path, Buffer.concat([h, pcm])));
}
