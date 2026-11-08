// Platform seam for audio capture. The engine asks an AudioBackend for a microphone source and a system-audio source and does not care how
// they are made. Two backends exist (see backendFor):
//  - app backend: the Wingman app records in a hidden window and the engine reads it over a local socket (src/capture-client.ts). The
//    microphone on macOS and Windows, the system audio on Windows (Electron loopback). macOS system audio stays AudioTee (bundled).
//    Nothing to install: no ffmpeg, no Homebrew.
//  - ffmpeg backend: ffmpeg + avfoundation for inputs, AudioTee for macOS system audio. Used when the engine runs from a terminal
//    (no app, so no bridge) or when WINGMAN_MIC_ENGINE=ffmpeg is set. It is a developer fallback.
//
// Contract of an AudioSource (checked by audio-platform.test.ts for the file source):
//  - start() resolves once capture runs (or rejects if it cannot); stop() resolves, may be called twice, and no "pcm" comes after it.
//  - "pcm" events carry 16 kHz mono signed 16-bit little-endian chunks with a whole number of samples (an even number of bytes).
//  - "error" is emitted (never thrown) when capture breaks while running. "log" carries one line of tool output.
//  - `peak` (optional) is the loudest sample seen so far, 0-1.
import { EventEmitter } from "node:events";
import { SystemSource, MicSource, FileSource, parseMicSetting, type Source } from "./audio.ts";
import { BridgeSource, captureLinkFromEnv, type CaptureLink } from "./capture-client.ts";

/** A running audio input (microphone, system audio or a file). See the contract above. */
export interface AudioSource extends Source {
  readonly peak?: number;
}

/** How the system-audio side is captured: a Core Audio tap, or an input device (a loopback such as BlackHole) read like a microphone. */
export type SystemAudioKind = "audiotee" | "device";

/** The sources a platform can offer. Constructors only: nothing starts until start() is called. */
export interface AudioBackend {
  readonly platform: NodeJS.Platform | "file";
  /**
   * True when the backend picks the microphone by the saved name itself (the app backend). The engine then passes the saved setting as it is
   * and does not look the device up with ffmpeg first.
   */
  readonly resolvesDevices?: boolean;
  /**
   * The microphone ("me"). `device` is the platform's input spec (macOS avfoundation: ":default", ":1", "BlackHole 2ch"); the app backend takes
   * the saved setting (":2|Name") and uses the name. `onDevice(missing)` runs after each start: with the saved name when that microphone is not there (the default one is used), else with undefined.
   */
  createMic(device: string, onDevice?: (missing?: string) => void): AudioSource;
  /** The other side's audio ("them"). */
  createSystem(kind: SystemAudioKind, device: string): AudioSource;
}

/** Developer fallback on every platform: ffmpeg + avfoundation for inputs, AudioTee (Core Audio tap, macOS 14.2+) for system audio. */
export const macBackend: AudioBackend = {
  platform: "darwin",
  createMic: (device) => new MicSource(device),
  createSystem: (kind, device) => (kind === "audiotee" ? new SystemSource() : new MicSource(device)),
};

/**
 * Stub for platforms without capture code. The error is raised when a source is requested, so the supervisor reports it as "audio down"
 * instead of the engine crashing.
 * Windows is served by the app backend. TODO linux: mic and system = PulseAudio / PipeWire (ffmpeg -f pulse; system audio = a "monitor" source).
 */
export function unsupportedBackend(platform: NodeJS.Platform): AudioBackend {
  const fail = (what: string): never => {
    throw new Error(`${what} capture is not implemented on ${platform} yet (macOS only). See src/audio-platform.ts.`);
  };
  return { platform, createMic: () => fail("Microphone"), createSystem: () => fail("System audio") };
}

/**
 * The microphone name inside a saved audio.mic.device: ":2|Name" gives "Name"; a bare name ("USB Mic", WINGMAN_MIC) is the name itself;
 * ":default" and a bare index (":1", which means something else here than in ffmpeg) give "" = the default microphone.
 */
export function micNameOf(setting: string): string {
  const p = parseMicSetting(setting);
  if (p.name) return p.name;
  const d = p.device.replace(/^:/, "").trim();
  return /^(default)?\d*$/i.test(d) ? "" : d;
}

/**
 * The app backend: capture through the Wingman app's hidden window. Needs the link from captureLinkFromEnv().
 *  - mic: always the app (getUserMedia).
 *  - system, Windows: the app (Electron loopback audio). Any "kind" means the same there: there is no AudioTee on Windows.
 *  - system, macOS: AudioTee as before; a "device" kind (BlackHole and similar) is an input read with ffmpeg.
 */
export function appBackend(link: CaptureLink, platform: NodeJS.Platform = process.platform): AudioBackend {
  return {
    platform,
    resolvesDevices: true,
    createMic: (device, onDevice) => new BridgeSource(link, "mic", micNameOf(device), onDevice),
    createSystem: (kind, device) =>
      platform === "win32" ? new BridgeSource(link, "system") : kind === "audiotee" ? new SystemSource() : new MicSource(device),
  };
}

/**
 * The backend for a platform. Under the Wingman app (the environment names the capture bridge) it is the app backend. From a terminal it
 * is the ffmpeg backend: those processes fail to start where the tools are missing (reported as "audio down"), and the end-to-end tests run
 * them with fake binaries on Linux and Windows CI. `unsupportedBackend` is the place to start a native port to another platform.
 */
export function backendFor(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): AudioBackend {
  const link = captureLinkFromEnv(env);
  if (link) return appBackend(link, platform);
  return platform === "darwin" ? macBackend : { ...macBackend, platform };
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
