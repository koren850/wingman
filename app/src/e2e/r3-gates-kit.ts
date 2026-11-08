// Shared fakes of the r3 gate tests: a speech-to-text stream that can be told to open, hang, drop and reconnect, a provider that makes them, and a
// result builder with speaker numbers. Nothing here touches the network, a key, audio hardware or a real screen.
import { EventEmitter } from "node:events";
import type { SttProvider, SttResult, SttStreamLike, Word, Channel } from "../providers/stt/types.ts";

/** How the next open() of a FakeStream behaves: "ok" resolves at once, "hang" never resolves (a black hole) until `release()`, "fail" rejects. */
export type OpenMode = "ok" | "hang" | "fail";

export class FakeStream extends EventEmitter implements SttStreamLike {
  dropped = 0;
  isOpen = false;
  sent = 0;
  chunks: Buffer[] = [];
  private gate?: () => void;
  constructor(public mode: OpenMode = "ok") {
    super();
  }
  async open() {
    if (this.mode === "fail") throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    if (this.mode === "hang") await new Promise<void>((res) => (this.gate = res));
    this.isOpen = true;
  }
  /** Lets a hanging open() finish. */
  release() {
    this.gate?.();
  }
  send(b: Buffer) {
    if (!this.isOpen) {
      this.dropped++;
      return false;
    }
    this.sent += b.length;
    this.chunks.push(b);
    return true;
  }
  async close() {
    this.isOpen = false;
  }
  get audioSeconds() {
    return this.sent / 32000;
  }
  /** The socket drops by itself (the channel decides what to do). */
  drop() {
    this.isOpen = false;
    this.emit("disconnected", { code: 1006, reason: "gone" });
  }
  /** The adapter reconnected by itself. */
  back() {
    this.isOpen = true;
    this.emit("reconnected", { channel: "them" });
  }
}

/** A provider whose streams are collected in `made`. `modes` gives the open behaviour of the 1st, 2nd... stream (the last one repeats). */
export function fakeProvider(id: string, made: FakeStream[], modes: OpenMode[] = ["ok"]): SttProvider {
  return {
    id: id as never,
    experimental: false,
    capabilities: { keyterms: true, diarize: true, interim: true, maxKeyterms: 100 },
    create: () => {
      const s = new FakeStream(modes[Math.min(made.length, modes.length - 1)]);
      made.push(s);
      return s;
    },
    probe: async () => ({ ok: true }),
  };
}

/** A final result of the other side, said by raw provider speaker `raw` (the provider numbers voices from 0 on every connection). */
export function said(text: string, raw: number | undefined, at = Date.now(), channel: Channel = "them"): SttResult {
  const ws = text.split(/\s+/).filter(Boolean);
  const words: Word[] = ws.map((w, i) => ({ word: w, start: i * 0.3, end: i * 0.3 + 0.25, ...(raw === undefined ? {} : { speaker: raw }) }));
  return { channel, text, isFinal: true, speechFinal: true, words, arrivedAt: at, speechEndWall: at };
}

/** Rows of a call log file (events.jsonl, usage.jsonl ...). */
export type Row = Record<string, unknown>;
