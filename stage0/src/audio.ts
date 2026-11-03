// Audio sources for the engine (run.ts). All emit 16 kHz mono s16le PCM chunks as "pcm" events.
//  - system: AudioTee (Core Audio tap, macOS 14.2+) -> "them"; or audio.system.source=device: an avfoundation input (e.g. BlackHole) through ffmpeg, same class as the mic
//  - mic:    ffmpeg avfoundation -> "me"
//  - file:   a stereo wav (L = me, R = them) paced in real time, for replay and tests ("pcm-me" / "pcm-them")
// Audio is never written to disk by the engine; only transcripts are saved. Child processes get childEnv() (no API keys).
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { AudioTee } from "audiotee";
import { childEnv } from "./env.ts";

export interface Source extends EventEmitter { start(): Promise<void>; stop(): Promise<void>; }

/** The other side's audio: a system-wide Core Audio tap. `peak` = loudest sample seen so far (0-1). Emits "pcm" and "error". */
export class SystemSource extends EventEmitter implements Source {
  private tee = new AudioTee({ sampleRate: 16000, chunkDurationMs: 100 });
  peak = 0;
  async start() {
    this.tee.on("data", (c: { data: Buffer }) => { this.peak = Math.max(this.peak, peakOf(c.data)); this.emit("pcm", c.data); });
    this.tee.on("error", (e: Error) => this.emit("error", e));
    await this.tee.start();
  }
  async stop() { await this.tee.stop(); }
}

/** avfoundation input spec for an audio-only device: ":default", ":1", ":BlackHole 2ch". Bare names and indexes get the ":" prefix. */
export function avDevice(d: string): string { return d.startsWith(":") ? d : `:${d}`; }

/** Microphone (or any avfoundation input) via an ffmpeg child. Emits "pcm", "log" (ffmpeg stderr) and "error" (spawn failure or unexpected exit). */
export class MicSource extends EventEmitter implements Source {
  private p?: ChildProcess;
  private stopping = false;
  readonly device: string;
  /** device: avfoundation audio input, e.g. ":default", ":1" or "BlackHole 2ch" (settings audio.mic.device / audio.system.device). */
  constructor(device = ":default") { super(); this.device = avDevice(device); }
  async start() {
    // ":default" = default input device; list devices with: ffmpeg -f avfoundation -list_devices true -i ""
    // Set audio.mic.device (or WINGMAN_MIC) to ":1" (index) or a name. Avoid AirPods for the first calls.
    this.p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", this.device, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], { env: childEnv() });
    this.p.stdout!.on("data", (b: Buffer) => this.emit("pcm", b));
    this.p.stderr!.on("data", (b: Buffer) => this.emit("log", `mic: ${b.toString().trim()}`));
    this.p.on("error", (e) => this.emit("error", new Error(`ffmpeg mic: ${e.message}`)));
    // ffmpeg exits 255 on SIGINT; that is our own stop(), not an error.
    this.p.on("exit", (code) => { if (code && !(this.stopping && code === 255)) this.emit("error", new Error(`ffmpeg mic exited ${code}`)); });
  }
  async stop() { this.stopping = true; this.p?.kill("SIGINT"); }
}

/** Decodes any audio file to 16 kHz stereo s16le with ffmpeg and plays it out in real time as two channels. */
export class FileSource extends EventEmitter {
  private timer?: NodeJS.Timeout;
  constructor(private file: string, private speed = 1) { super(); }
  async start() {
    const buf = await decode(this.file, 2);
    const frame = 1600 * 2 * 2; // 100 ms, 2 ch, 2 bytes
    let off = 0;
    this.timer = setInterval(() => {
      if (off >= buf.length) { clearInterval(this.timer); this.emit("end"); return; }
      const chunk = buf.subarray(off, off + frame); off += frame;
      const me = Buffer.alloc(chunk.length / 2), them = Buffer.alloc(chunk.length / 2);
      for (let i = 0, j = 0; i + 3 < chunk.length; i += 4, j += 2) { chunk.copy(me, j, i, i + 2); chunk.copy(them, j, i + 2, i + 4); }
      this.emit("pcm-me", me); this.emit("pcm-them", them);
    }, 100 / this.speed);
  }
  async stop() { clearInterval(this.timer); }
}

/** Decodes any audio file with ffmpeg to raw 16 kHz s16le PCM (1 or 2 channels). Rejects if ffmpeg is missing or fails. */
export function decode(file: string, channels: 1 | 2): Promise<Buffer> {
  return new Promise((res, rej) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-ac", String(channels), "-ar", "16000", "-f", "s16le", "-"], { env: childEnv() });
    const out: Buffer[] = [];
    p.stdout.on("data", (b) => out.push(b));
    p.on("error", (e) => rej(new Error(`ffmpeg not runnable: ${e.message}`)));
    p.on("exit", (c) => (c ? rej(new Error(`ffmpeg decode failed (${c}) for ${file}`)) : res(Buffer.concat(out))));
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
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return import("node:fs").then((fs) => fs.writeFileSync(path, Buffer.concat([h, pcm])));
}
