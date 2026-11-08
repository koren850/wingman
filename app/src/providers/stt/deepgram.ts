// Deepgram Nova-3 live socket, one per channel ("me" = mic, "them" = system audio), built on the Deepgram SDK.
// The SDK reconnects its own socket; SttChannel (channel.ts) decides when to give up and switch provider.
import { DeepgramClient } from "@deepgram/sdk";
import { EventEmitter } from "node:events";
import { classifySttError, ProviderError } from "../errors.ts";
import { speechEndWall, STT_OPEN_TIMEOUT_MS, type SttOptions, type SttResult, type SttStreamLike, type SttProvider, type Word } from "./types.ts";

/** One word of a Deepgram "Results" message. */
interface DgWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  speaker?: number;
  confidence?: number;
}
/** A Deepgram socket message: only the fields read here. */
interface DgMessage {
  type?: string;
  speech_final?: boolean;
  is_final?: boolean;
  from_finalize?: boolean;
  channel?: { alternatives?: { transcript?: string; confidence?: number; words?: DgWord[] }[] };
}
/** The part of the SDK socket Wingman uses. The SDK's own types lag behind its runtime (query params, Finalize), so it is typed here. */
interface DgSocket {
  readyState: number;
  on<T = unknown>(event: string, fn: (arg: T) => void): void;
  connect(): void;
  waitForOpen(): Promise<unknown>;
  close(): void;
  sendMedia(pcm: Buffer): void;
  sendKeepAlive(m: object): void;
  sendFinalize(m: object): void;
  sendCloseStream(m: object): void;
}

/** See the stall guard note below for the one non-obvious behaviour (an extra Finalize after silence). */
export class DeepgramStream extends EventEmitter implements SttStreamLike {
  private conn: DgSocket | undefined;
  private connBytes = 0; // bytes successfully sent on the CURRENT socket (re-anchored on every (re)open)
  private totalBytes = 0; // bytes successfully sent overall (cost)
  private opens = 0;
  private closing = false;
  dropped = 0; // chunks dropped because the socket was not open
  private keepAlive?: NodeJS.Timeout;
  keytermsDropped = false; // true when the open had to be retried without keyterms
  // Stall guard: on language=multi Deepgram sometimes never sends speech_final / a final after an utterance
  // (the transcript sits on an unresolved last word) until ~5.4 s later. We watch the audio we send: when voiced audio is
  // followed by finalizeSilenceMs of near-silence and no speech_final has come, send {"type":"Finalize"}. The reply
  // (from_finalize) is reported as speechFinal. 0 = off. Normal speech_final (endpointing, 100-700 ms) always wins, so this only fires on a stall.
  private voicedSince = false; // voiced audio sent since the last speech_final / Finalize
  private silentBytes = 0; // consecutive near-silent bytes sent
  private finalizeSent = false;
  constructor(private opts: SttOptions) {
    super();
  }

  /** The keyterms sent as repeated keyterm= query params (first 100 only). */
  static keytermParams(keyterms: string[] = []) {
    return keyterms.slice(0, 100);
  }
  /** Extra query params for the connect call: repeated keyterm=... and, when opted out, mip_opt_out=true (Deepgram's model improvement program). */
  static queryParams(keyterms: string[] = [], mipOptOut = false): Record<string, string | string[]> {
    return { ...(keyterms.length ? { keyterm: DeepgramStream.keytermParams(keyterms) } : {}), ...(mipOptOut ? { mip_opt_out: "true" } : {}) };
  }

  async open() {
    try {
      await this.openOnce(this.opts.keyterms ?? []);
    } catch (e) {
      const err = classifySttError("deepgram", e);
      // A 400 while keyterms were sent may be the keyterm param itself: retry once without and say so.
      if (err.kind === "bad_request" && this.opts.keyterms?.length && this.opts.keytermRetry !== false) {
        this.keytermsDropped = true;
        this.emit("keyterms_off", err);
        this.dropConn();
        await this.openOnce([]).catch((e2) => {
          this.dropConn();
          throw classifySttError("deepgram", e2);
        });
      } else {
        this.dropConn();
        throw err;
      }
    }
  }

  /** A failed open must close its client, or the SDK keeps reconnecting it in the background (one leaked socket per retry). */
  private dropConn() {
    try {
      this.conn?.close?.();
    } catch {
      /* best effort: the socket may already be closed */
    }
    this.conn = undefined;
  }

  private async openOnce(keyterms: string[]) {
    this.opens = 0;
    const client = new DeepgramClient({ apiKey: this.opts.apiKey, ...(this.opts.baseUrl ? { baseUrl: this.opts.baseUrl } : {}) });
    // keyterm goes through queryParams: the SDK's own `keyterm` arg JSON-encodes an array into one bad param,
    // while queryParams are serialized as repeated keyterm=... params.
    // (`as never` below: the SDK's option type omits queryParams / Authorization, which its runtime accepts.)
    const conn = (await client.listen.v1.connect({
      model: this.opts.model && this.opts.model !== "default" ? this.opts.model : "nova-3",
      language: this.opts.language === "auto" ? "multi" : (this.opts.language ?? "he"),
      encoding: "linear16",
      sample_rate: 16000,
      channels: 1,
      interim_results: "true",
      smart_format: "true",
      punctuate: "true",
      endpointing: this.opts.endpointingMs ?? 350,
      utterance_end_ms: this.opts.utteranceEndMs ?? 1000,
      vad_events: "true",
      diarize: this.opts.diarize ? "true" : "false",
      queryParams: DeepgramStream.queryParams(keyterms, this.opts.mipOptOut),
      Authorization: `Token ${this.opts.apiKey}`,
      debug: this.opts.debug ?? false,
      // reconnectAttempts left at the SDK default (30)
    } as never)) as unknown as DgSocket;
    this.conn = conn;
    conn.on<DgMessage>("message", (m) => this.onMessage(m));
    conn.on("error", (e: unknown) => this.emit("error", classifySttError("deepgram", e)));
    conn.on("open", () => {
      this.connBytes = 0;
      this.opens++;
      if (this.opens > 1) this.emit("reconnected", { channel: this.opts.channel, opens: this.opens });
    });
    conn.on<{ code?: number; reason?: string } | undefined>("close", (ev) => {
      if (!this.closing)
        this.emit("disconnected", {
          channel: this.opts.channel,
          code: ev?.code,
          reason: ev?.reason,
          error: classifySttError("deepgram", Object.assign(new Error(ev?.reason ?? ""), { code: ev?.code })),
        });
      this.emit("close");
    });
    conn.connect();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        conn.waitForOpen(),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new ProviderError("timeout", "deepgram", "deepgram: open timed out")), STT_OPEN_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    clearInterval(this.keepAlive);
    this.keepAlive = setInterval(() => {
      try {
        if (this.conn?.readyState === 1) this.conn.sendKeepAlive({ type: "KeepAlive" });
      } catch {
        /* best effort: a keep-alive on a dropping socket may throw; the disconnect handler recovers */
      }
    }, this.opts.keepAliveMs ?? 5000);
  }

  get isOpen() {
    return this.conn?.readyState === 1;
  }

  /** Returns false when the chunk was dropped (socket not open or send failed). Never throws. Also feeds the stall guard. */
  send(pcm: Buffer): boolean {
    if (!this.conn || this.conn.readyState !== 1) {
      this.dropped++;
      return false;
    }
    try {
      this.conn.sendMedia(pcm);
    } catch {
      this.dropped++;
      return false;
    }
    this.connBytes += pcm.length;
    this.totalBytes += pcm.length;
    this.watchSilence(pcm);
    return true;
  }

  // Peak over every 4th sample (stride 8 bytes) is enough to tell speech (>= 1500 of 32768) from silence; cheap on the audio path.
  private watchSilence(pcm: Buffer) {
    const ms = this.opts.finalizeSilenceMs ?? 900;
    if (!(ms > 0)) return;
    let peak = 0;
    for (let i = 0; i + 1 < pcm.length; i += 8) {
      const v = Math.abs(pcm.readInt16LE(i));
      if (v > peak) peak = v;
    }
    if (peak >= 1500) {
      this.voicedSince = true;
      this.silentBytes = 0;
      this.finalizeSent = false;
      return;
    }
    this.silentBytes += pcm.length;
    if (this.voicedSince && !this.finalizeSent && this.silentBytes / 32 >= ms) {
      this.finalizeSent = true;
      try {
        if (this.conn?.readyState === 1) this.conn.sendFinalize({ type: "Finalize" });
      } catch {
        /* best effort: finalize on a closing socket */
      }
    }
  }

  /** seconds of audio sent so far (for cost) */
  get audioSeconds() {
    return this.totalBytes / 32000;
  }

  private onMessage(m: DgMessage) {
    if (m?.type === "UtteranceEnd") {
      this.emit("utteranceEnd", { channel: this.opts.channel, at: Date.now() });
      return;
    }
    if (m?.type !== "Results") return;
    const alt = m.channel?.alternatives?.[0];
    const text: string = alt?.transcript ?? "";
    const words: Word[] = (alt?.words ?? []).map((w) => ({
      word: w.punctuated_word ?? w.word,
      start: w.start,
      end: w.end,
      speaker: w.speaker,
      confidence: w.confidence,
    }));
    const last = words.at(-1);
    const arrivedAt = Date.now();
    const speechFinal = !!m.speech_final || (!!m.is_final && !!m.from_finalize);
    if (speechFinal) this.voicedSince = false;
    const r: SttResult = {
      channel: this.opts.channel,
      text,
      isFinal: !!m.is_final,
      speechFinal,
      words,
      confidence: alt?.confidence,
      speechEndWall: last ? speechEndWall(arrivedAt, this.connBytes / 32000, last.end) : undefined,
      arrivedAt,
    };
    this.emit("result", r);
  }

  async close() {
    this.closing = true;
    clearInterval(this.keepAlive);
    try {
      this.conn?.sendCloseStream({ type: "CloseStream" });
    } catch {
      /* best effort: the socket may already be closed */
    }
    await new Promise((r) => setTimeout(r, this.opts.baseUrl ? 100 : 1500));
    try {
      this.conn?.close();
    } catch {
      /* best effort: the socket may already be closed */
    }
  }
}

/** probe() opens a real socket (10 s limit) and closes it; used by the doctor. */
export const deepgram: SttProvider = {
  id: "deepgram",
  experimental: false,
  capabilities: { keyterms: true, diarize: true, interim: true, maxKeyterms: 100 },
  create: (o) => new DeepgramStream(o),
  async probe(o) {
    const s = new DeepgramStream({ ...o, channel: "them" });
    s.on("error", () => {});
    try {
      await Promise.race([
        s.open(),
        new Promise((_, rej) => setTimeout(() => rej(classifySttError("deepgram", new Error("open timed out after 10 s"))), 10_000)),
      ]);
      await s.close();
      return { ok: true };
    } catch (e) {
      try {
        await s.close();
      } catch {
        /* best effort: the socket may already be closed */
      }
      return { ok: false, error: classifySttError("deepgram", e) };
    }
  },
};
