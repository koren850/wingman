// Platform seam for audio capture. The engine asks an AudioBackend for a microphone source and a system-audio source and does not care how
// they are made. macOS is the only real backend. win32 and linux are stubs with a clear error and a TODO list, so adding a platform means
// implementing two classes (see AudioSource) and registering one backend in `backends` below.
//
// Contract of an AudioSource (checked by audio-platform.test.ts for the file source):
//  - start() resolves once capture runs (or rejects if it cannot); stop() resolves, may be called twice, and no "pcm" comes after it.
//  - "pcm" events carry 16 kHz mono signed 16-bit little-endian chunks with a whole number of samples (an even number of bytes).
//  - "error" is emitted (never thrown) when capture breaks while running. "log" carries one line of tool output.
//  - `peak` (optional) is the loudest sample seen so far, 0-1.
import { EventEmitter } from "node:events";
import { SystemSource, MicSource, FileSource, type Source } from "./audio.ts";

/** A running audio input (microphone, system audio or a file). See the contract above. */
export interface AudioSource extends Source {
  readonly peak?: number;
}

/** How the system-audio side is captured: a Core Audio tap, or an input device (a loopback such as BlackHole) read like a microphone. */
export type SystemAudioKind = "audiotee" | "device";

/** The sources a platform can offer. Constructors only: nothing starts until start() is called. */
export interface AudioBackend {
  readonly platform: NodeJS.Platform | "file";
  /** The microphone ("me"). `device` is the platform's input spec (macOS avfoundation: ":default", ":1", "BlackHole 2ch"). */
  createMic(device: string): AudioSource;
  /** The other side's audio ("them"). */
  createSystem(kind: SystemAudioKind, device: string): AudioSource;
}

/** macOS: ffmpeg + avfoundation for inputs, AudioTee (Core Audio tap, macOS 14.2+) for system audio. */
export const macBackend: AudioBackend = {
  platform: "darwin",
  createMic: (device) => new MicSource(device),
  createSystem: (kind, device) => (kind === "audiotee" ? new SystemSource() : new MicSource(device)),
};

/**
 * Stub for platforms without capture code. The error is raised when a source is requested, so the supervisor reports it as "audio down"
 * instead of the engine crashing.
 * TODO win32: mic = WASAPI capture (e.g. ffmpeg -f dshow, or a native module); system = WASAPI loopback; device listing for audio.mic.device.
 * TODO linux: mic and system = PulseAudio / PipeWire (ffmpeg -f pulse; system audio = a "monitor" source).
 */
export function unsupportedBackend(platform: NodeJS.Platform): AudioBackend {
  const fail = (what: string): never => {
    throw new Error(`${what} capture is not implemented on ${platform} yet (macOS only). See src/audio-platform.ts.`);
  };
  return { platform, createMic: () => fail("Microphone"), createSystem: () => fail("System audio") };
}

/** The backend for a platform. Unknown platforms get the stub. */
export function backendFor(platform: NodeJS.Platform = process.platform): AudioBackend {
  return platform === "darwin" ? macBackend : unsupportedBackend(platform);
}

/**
 * One channel of a stereo file (L = me, R = them) as an AudioSource, paced in real time. For replay and for contract tests of the
 * AudioSource interface without real hardware. Needs ffmpeg to decode.
 */
export class FileAudioSource extends EventEmitter implements AudioSource {
  peak = 0;
  private file: FileSource;
  private stopped = false;
  constructor(
    path: string,
    private channel: "me" | "them",
    speed = 1,
  ) {
    super();
    this.file = new FileSource(path, speed);
  }
  async start() {
    this.stopped = false;
    this.file.on(this.channel === "me" ? "pcm-me" : "pcm-them", (b: Buffer) => {
      if (this.stopped) return;
      for (let i = 0; i + 1 < b.length; i += 2) this.peak = Math.max(this.peak, Math.abs(b.readInt16LE(i)) / 32768);
      this.emit("pcm", b);
    });
    this.file.on("end", () => this.emit("end"));
    await this.file.start();
  }
  async stop() {
    this.stopped = true;
    await this.file.stop();
  }
}
