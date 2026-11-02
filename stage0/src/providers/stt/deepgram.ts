// Deepgram Nova-3 live socket, one per channel ("me" = mic, "them" = system audio). Moved from src/stt.ts, behaviour kept.
import { DeepgramClient } from "@deepgram/sdk";
import { EventEmitter } from "node:events";
import { classifySttError } from "../errors.ts";
import { speechEndWall, type SttOptions, type SttResult, type SttStreamLike, type SttProvider, type Word } from "./types.ts";

export class DeepgramStream extends EventEmitter implements SttStreamLike {
  private conn: any;
  private connBytes = 0;   // bytes successfully sent on the CURRENT socket (re-anchored on every (re)open)
  private totalBytes = 0;  // bytes successfully sent overall (cost)
  private opens = 0;
  private closing = false;
  dropped = 0;             // chunks dropped because the socket was not open
  private keepAlive?: NodeJS.Timeout;
  keytermsDropped = false; // true when the open had to be retried without keyterms
  // Stall guard (measured 2 Nov): on language=multi Deepgram sometimes never sends speech_final / a final after an utterance
  // (the transcript sits on an unresolved last word) until ~5.4 s later. We watch the audio we send: when voiced audio is
  // followed by finalizeSilenceMs of near-silence and no speech_final has come, send {"type":"Finalize"}. The reply
  // (from_finalize) is reported as speechFinal. 0 = off. Normal speech_final (endpointing, 100-700 ms) always wins, so this only fires on a stall.
  private voicedSince = false;     // voiced audio sent since the last speech_final / Finalize
  private silentBytes = 0;         // consecutive near-silent bytes sent
  private finalizeSent = false;
  constructor(private opts: SttOptions) { super(); }

  /** The query string the connection will use (for debugging and the local probe). */
  static keytermParams(keyterms: string[] = []) { return keyterms.slice(0, 100); }

  async open() {
    try { await this.openOnce(this.opts.keyterms ?? []); }
    catch (e) {
      const err = classifySttError("deepgram", e);
      // S8: a 400 while keyterms were sent may be the keyterm param itself: retry once without and say so.
      if (err.kind === "bad_request" && this.opts.keyterms?.length && this.opts.keytermRetry !== false) {
        this.keytermsDropped = true; this.emit("keyterms_off", err);
        this.dropConn();
        await this.openOnce([]).catch((e2) => { this.dropConn(); throw classifySttError("deepgram", e2); });
      } else { this.dropConn(); throw err; }
    }
  }

  /** A failed open must close its client, or the SDK keeps reconnecting it in the background (one leaked socket per retry). */
  private dropConn() { try { this.conn?.close?.(); } catch {} this.conn = undefined as any; }

  private async openOnce(keyterms: string[]) {
    this.opens = 0;
    const client = new DeepgramClient({ apiKey: this.opts.apiKey, ...(this.opts.baseUrl ? { baseUrl: this.opts.baseUrl } : {}) } as any);
    // keyterm goes through queryParams: the SDK's own `keyterm` arg JSON-encodes an array into one bad param,
    // while queryParams are serialized as repeated keyterm=... params.
    this.conn = await client.listen.v1.connect({
      model: this.opts.model && this.opts.model !== "default" ? this.opts.model : "nova-3",
      language: this.opts.language === "auto" ? "multi" : this.opts.language ?? "he",
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
      queryParams: keyterms.length ? { keyterm: DeepgramStream.keytermParams(keyterms) } : {},
      Authorization: `Token ${this.opts.apiKey}`,
      debug: this.opts.debug ?? false,
      // reconnectAttempts left at the SDK default (30)
    } as any);
    this.conn.on("message", (m: any) => this.onMessage(m));
    this.conn.on("error", (e: unknown) => this.emit("error", classifySttError("deepgram", e)));
    this.conn.on("open", () => {
      this.connBytes = 0; this.opens++;
      if (this.opens > 1) this.emit("reconnected", { channel: this.opts.channel, opens: this.opens });
    });
    this.conn.on("close", (ev: any) => {
      if (!this.closing) this.emit("disconnected", { channel: this.opts.channel, code: ev?.code, reason: ev?.reason, error: classifySttError("deepgram", Object.assign(new Error(ev?.reason ?? ""), { code: ev?.code })) });
      this.emit("close");
    });
    this.conn.connect();
    await this.conn.waitForOpen();
    clearInterval(this.keepAlive);
    this.keepAlive = setInterval(() => { try { if (this.conn.readyState === 1) this.conn.sendKeepAlive({ type: "KeepAlive" }); } catch {} }, this.opts.keepAliveMs ?? 5000);
  }

  get isOpen() { return this.conn?.readyState === 1; }

  /** Returns false when the chunk was dropped (socket not open or send failed). Never throws. */
  send(pcm: Buffer): boolean {
    if (!this.conn || this.conn.readyState !== 1) { this.dropped++; return false; }
    try { this.conn.sendMedia(pcm); } catch { this.dropped++; return false; }
    this.connBytes += pcm.length; this.totalBytes += pcm.length;
    this.watchSilence(pcm);
    return true;
  }

  private watchSilence(pcm: Buffer) {
    const ms = this.opts.finalizeSilenceMs ?? 900;
    if (!(ms > 0)) return;
    let peak = 0;
    for (let i = 0; i + 1 < pcm.length; i += 8) { const v = Math.abs(pcm.readInt16LE(i)); if (v > peak) peak = v; }
    if (peak >= 1500) { this.voicedSince = true; this.silentBytes = 0; this.finalizeSent = false; return; }
    this.silentBytes += pcm.length;
    if (this.voicedSince && !this.finalizeSent && this.silentBytes / 32 >= ms) {
      this.finalizeSent = true;
      try { if (this.conn?.readyState === 1) this.conn.sendFinalize({ type: "Finalize" }); } catch {}
    }
  }

  /** seconds of audio sent so far (for cost) */
  get audioSeconds() { return this.totalBytes / 32000; }

  private onMessage(m: any) {
    if (m?.type === "UtteranceEnd") { this.emit("utteranceEnd", { channel: this.opts.channel, at: Date.now() }); return; }
    if (m?.type !== "Results") return;
    const alt = m.channel?.alternatives?.[0];
    const text: string = alt?.transcript ?? "";
    const words: Word[] = (alt?.words ?? []).map((w: any) => ({ word: w.punctuated_word ?? w.word, start: w.start, end: w.end, speaker: w.speaker, confidence: w.confidence }));
    const last = words.at(-1);
    const arrivedAt = Date.now();
    const speechFinal = !!m.speech_final || (!!m.is_final && !!m.from_finalize);
    if (speechFinal) this.voicedSince = false;
    const r: SttResult = {
      channel: this.opts.channel, text, isFinal: !!m.is_final, speechFinal, words, confidence: alt?.confidence,
      speechEndWall: last ? speechEndWall(arrivedAt, this.connBytes / 32000, last.end) : undefined, arrivedAt,
    };
    this.emit("result", r);
  }

  async close() {
    this.closing = true;
    clearInterval(this.keepAlive);
    try { this.conn.sendCloseStream({ type: "CloseStream" }); } catch {}
    await new Promise((r) => setTimeout(r, this.opts.baseUrl ? 100 : 1500));
    try { this.conn.close(); } catch {}
  }
}

export const deepgram: SttProvider = {
  id: "deepgram", experimental: false,
  capabilities: { keyterms: true, diarize: true, interim: true, maxKeyterms: 100 },
  create: (o) => new DeepgramStream(o),
  async probe(o) {
    const s = new DeepgramStream({ ...o, channel: "them" });
    s.on("error", () => {});
    try { await Promise.race([s.open(), new Promise((_, rej) => setTimeout(() => rej(classifySttError("deepgram", new Error("open timed out after 10 s"))), 10_000))]); await s.close(); return { ok: true }; }
    catch (e) { try { await s.close(); } catch {} return { ok: false, error: classifySttError("deepgram", e) }; }
  },
};
