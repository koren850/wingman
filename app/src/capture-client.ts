// Engine side of the app's audio capture. The Wingman app records the microphone (and, on Windows, the system audio) in a hidden window
// (tray/capture-host.cjs) and serves it on a local socket (tray/capture-bridge.cjs). This file connects to it and offers each channel as an
// AudioSource, so the engine needs no ffmpeg. The wire format is shared/capture-wire.cjs. The bridge address comes from the environment
// (WINGMAN_CAPTURE_ENDPOINT, WINGMAN_CAPTURE_TOKEN), which only the app sets: a terminal run falls back to ffmpeg (see audio-platform.ts).
import { EventEmitter } from "node:events";
import net from "node:net";
import wire from "../shared/capture-wire.cjs";
import { peakOf } from "./audio.ts";
import type { AudioSource } from "./audio-platform.ts";

export type CaptureChannel = "mic" | "system";
/** Why a capture failed: permission = blocked by the system; no-device = nothing to record; busy = another app holds the device. */
export type CaptureCode = "permission" | "no-device" | "busy" | "unsupported" | "failed";
const CODES: readonly string[] = ["permission", "no-device", "busy", "unsupported", "failed"];

export class CaptureError extends Error {
  constructor(
    readonly code: CaptureCode,
    message: string,
  ) {
    super(message);
    this.name = "CaptureError";
  }
}
const asCode = (c: unknown): CaptureCode => (typeof c === "string" && CODES.includes(c) ? (c as CaptureCode) : "failed");

type Reply = {
  id?: number;
  ev: string;
  ch?: CaptureChannel;
  code?: string;
  message?: string;
  fellBack?: boolean;
  devices?: { index: number; name: string }[];
  defaultName?: string;
};

export const CONNECT_TIMEOUT_MS = 3000;
/** A start can wait for the system's microphone prompt, so it gets longer than a plain request. */
export const REQUEST_TIMEOUT_MS = 25_000;

/**
 * One connection to the app. Events: "pcm" (channel, Buffer), "ended" (channel, reason), "closed".
 * Requests are answered in order by id. connect() is safe to call again after "closed".
 */
export class CaptureLink extends EventEmitter {
  private sock?: net.Socket;
  private connecting?: Promise<void>;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private nextSeq = 1;
  constructor(
    readonly endpoint: string,
    private token: string,
  ) {
    super();
  }
  get connected(): boolean {
    return !!this.sock && !this.sock.destroyed;
  }
  /** A number for one source's start; its stop carries the same number (see tray/capture-bridge.cjs). */
  seq(): number {
    return this.nextSeq++;
  }
  connect(): Promise<void> {
    if (this.sock && !this.sock.destroyed && !this.connecting) return Promise.resolve();
    this.connecting ??= this.open().finally(() => (this.connecting = undefined));
    return this.connecting;
  }
  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.endpoint);
      const dec = wire.createDecoder();
      const timer = setTimeout(() => fail(new CaptureError("failed", "the Wingman app did not answer")), CONNECT_TIMEOUT_MS);
      timer.unref();
      let hello = false;
      const fail = (e: Error) => {
        clearTimeout(timer);
        sock.destroy();
        reject(e);
      };
      sock.once("error", (e) => fail(new CaptureError("failed", `cannot reach the Wingman app audio capture: ${e.message}`)));
      sock.on("connect", () => sock.write(wire.encodeJson({ op: "hello", token: this.token })));
      sock.on("data", (chunk) => {
        let frames;
        try {
          frames = dec.push(chunk);
        } catch {
          return sock.destroy();
        }
        for (const f of frames) {
          if ("pcm" in f) this.emit("pcm", f.ch, f.pcm);
          else if (!hello) {
            if (f.json?.ev !== "hello") return fail(new CaptureError("failed", "the Wingman app refused the audio capture connection"));
            hello = true;
            clearTimeout(timer);
            this.sock = sock;
            sock.removeAllListeners("error");
            sock.on("error", () => {});
            resolve();
          } else this.onJson(f.json as Reply);
        }
      });
      sock.on("close", () => {
        clearTimeout(timer);
        if (this.sock === sock) this.sock = undefined;
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new CaptureError("failed", "the audio capture connection closed"));
          this.pending.delete(id);
        }
        if (hello) this.emit("closed");
        else reject(new CaptureError("failed", "the Wingman app closed the audio capture connection"));
      });
    });
  }
  private onJson(m: Reply) {
    if (m.ev === "ended" && m.ch) return void this.emit("ended", m.ch, m.message ?? (m as { reason?: string }).reason ?? "the audio device stopped");
    const p = m.id !== undefined ? this.pending.get(m.id) : undefined;
    if (!p) return;
    this.pending.delete(m.id!);
    clearTimeout(p.timer);
    if (m.ev === "error") p.reject(new CaptureError(asCode(m.code), String(m.message ?? "capture failed")));
    else p.resolve(m);
  }
  async request(msg: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Reply> {
    await this.connect();
    const sock = this.sock;
    if (!sock || sock.destroyed) throw new CaptureError("failed", "the audio capture connection is closed");
    const id = this.nextId++;
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CaptureError("failed", `the Wingman app did not answer ${String(msg.op)}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      sock.write(wire.encodeJson({ ...msg, id }));
    });
  }
  /** The microphones the app can see. */
  async devices(): Promise<{ devices: { index: number; name: string }[]; defaultName: string }> {
    const r = await this.request({ op: "devices" });
    return { devices: r.devices ?? [], defaultName: r.defaultName ?? "" };
  }
  close() {
    this.sock?.destroy();
  }
}

let shared: CaptureLink | undefined;
/** The link to the app's capture bridge named in env, or undefined when the engine does not run under the app (or the app has no bridge). */
export function captureLinkFromEnv(env: NodeJS.ProcessEnv = process.env): CaptureLink | undefined {
  const endpoint = env.WINGMAN_CAPTURE_ENDPOINT,
    token = env.WINGMAN_CAPTURE_TOKEN;
  if (!endpoint || !token || env.WINGMAN_MIC_ENGINE === "ffmpeg") return undefined;
  if (!shared || shared.endpoint !== endpoint) shared = new CaptureLink(endpoint, token);
  return shared;
}

/** One channel of the app's capture as an AudioSource (contract: audio-platform.ts). */
export class BridgeSource extends EventEmitter implements AudioSource {
  peak = 0;
  private stopped = false;
  private running = false;
  private seq = 0;
  private unhooks: (() => void)[] = [];
  /**
   * @param name the saved microphone name, or "" for the default one (mic only)
   * @param onDevice called after every start of a microphone: with the saved name when that microphone was not found and the default one is used, else with undefined
   */
  constructor(
    private link: CaptureLink,
    private ch: CaptureChannel,
    private name = "",
    private onDevice?: (missing?: string) => void,
  ) {
    super();
  }
  async start() {
    if (this.stopped) return;
    const label = this.ch === "mic" ? "mic" : "system audio";
    const onPcm = (ch: CaptureChannel, b: Buffer) => {
      if (ch !== this.ch || this.stopped || !this.running) return;
      const whole = b.length % 2 ? b.subarray(0, b.length - 1) : b;
      if (!whole.length) return;
      this.peak = Math.max(this.peak, peakOf(whole));
      this.emit("pcm", whole);
    };
    const onEnded = (ch: CaptureChannel, reason: string) => {
      if (ch === this.ch && !this.stopped && this.running) this.fail(new CaptureError("failed", `${label}: ${reason}`));
    };
    const onClosed = () => {
      if (!this.stopped && this.running) this.fail(new CaptureError("failed", `${label}: the Wingman app audio capture closed`));
    };
    this.link.on("pcm", onPcm);
    this.link.on("ended", onEnded);
    this.link.on("closed", onClosed);
    this.unhooks = [() => this.link.off("pcm", onPcm), () => this.link.off("ended", onEnded), () => this.link.off("closed", onClosed)];
    const seq = (this.seq = this.link.seq());
    this.running = true; // pcm can arrive right behind the "started" reply
    try {
      const r = await this.link.request({ op: "start", ch: this.ch, name: this.name, seq });
      if (this.ch === "mic") this.onDevice?.(r.fellBack && this.name ? this.name : undefined);
      this.emit("log", `${label}: capture started in the Wingman app`);
      // stop() came while the start was on its way: release() found no connection to send "stop" on, so the stop goes out now.
      if (this.stopped) await this.link.request({ op: "stop", ch: this.ch, seq }, 3000).catch(() => {});
    } catch (e) {
      this.running = false;
      this.unhook();
      throw e;
    }
  }
  private fail(e: Error) {
    this.running = false;
    this.emit("error", e);
  }
  private unhook() {
    for (const f of this.unhooks) f();
    this.unhooks = [];
  }
  private async release() {
    this.unhook();
    if (!this.seq) return;
    const seq = this.seq;
    this.seq = 0;
    if (this.link.connected) await this.link.request({ op: "stop", ch: this.ch, seq }, 3000).catch(() => {});
  }
  async stop() {
    this.stopped = true;
    this.running = false;
    await this.release();
  }
}
