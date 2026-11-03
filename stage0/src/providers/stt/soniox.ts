// Soniox real-time STT (EXPERIMENTAL: written from the public docs, never run against the live service).
// Protocol (docs.soniox.com/stt/api-reference/websocket-api, checked 2026-11-01):
//   wss://stt-rt.soniox.com/transcribe-websocket · key in the Authorization: Bearer header · first frame = JSON config
//   · audio = binary frames · responses {tokens:[{text,start_ms,end_ms,confidence,is_final}], finished?} · end = empty text frame
//   · keepalive {"type":"keepalive"} · errors {error_code,error_type,error_message} then close.
import type WebSocket from "ws";
import { classifyHttp, classifySttError } from "../errors.ts";
import { speechEndWall, type SttOptions, type SttProvider, type SttResult, type Word } from "./types.ts";
import { WsStream } from "./ws-base.ts";

export const SONIOX_URL = "wss://stt-rt.soniox.com/transcribe-websocket";

/** Soniox adapter on WsStream. Final tokens are collected and emitted as one final result at an endpoint marker. */
export class SonioxStream extends WsStream {
  private finals: { text: string; start: number; end: number; conf?: number; speaker?: number }[] = [];
  constructor(opts: SttOptions) { super("soniox", opts); }
  protected async connectUrl() { return this.opts.baseUrl ?? SONIOX_URL; }
  protected connectHeaders() { return { Authorization: `Bearer ${this.opts.apiKey}` }; }
  protected onOpen(ws: WebSocket) {
    this.finals = [];
    const lang = this.opts.language;
    ws.send(JSON.stringify({
      model: !this.opts.model || this.opts.model === "nova-3" ? "stt-rt-v5" : this.opts.model,
      audio_format: "pcm_s16le", sample_rate: 16000, num_channels: 1,
      ...(lang && lang !== "auto" && lang !== "multi" ? { language_hints: [lang] } : {}),
      enable_endpoint_detection: true,
      max_endpoint_delay_ms: Math.min(3000, Math.max(500, this.opts.endpointingMs ?? 500)),   // docs: 500-3000
      enable_speaker_diarization: !!this.opts.diarize,
      ...(this.opts.keyterms?.length ? { context: { terms: this.opts.keyterms.slice(0, 100) } } : {}),
    }));
  }
  protected keepAliveFrame() { return JSON.stringify({ type: "keepalive" }); }
  protected endFrame() { return ""; }

  protected onMessage(m: any) {
    if (m.error_code) { this.emit("error", classifyHttp("soniox", Number(m.error_code), `${m.error_type ?? ""} ${m.error_message ?? ""}`)); return; }
    const interim: string[] = [];
    for (const t of m.tokens ?? []) {
      if (t.text === "<end>") { this.flushFinals(true); continue; }     // endpoint marker (assumed from the docs' endpoint detection; unverified)
      if (t.is_final) this.finals.push({ text: t.text, start: t.start_ms / 1000, end: t.end_ms / 1000, conf: t.confidence, speaker: t.speaker });
      else interim.push(t.text);
    }
    if (interim.length) this.emitResult(this.finals.map((f) => f.text).join("") + interim.join(""), false, false);
    if (m.finished) this.flushFinals(true);
  }
  private flushFinals(speechFinal: boolean) {
    if (!this.finals.length) return;
    const f = this.finals; this.finals = [];
    this.emitResult(f.map((x) => x.text).join("").trim(), true, speechFinal, f);
  }
  private emitResult(text: string, isFinal: boolean, speechFinal: boolean, toks: typeof this.finals = []) {
    const words: Word[] = toks.map((t) => ({ word: t.text.trim(), start: t.start, end: t.end, speaker: t.speaker, confidence: t.conf }));
    const arrivedAt = Date.now(), last = words.at(-1);
    const confs = toks.map((t) => t.conf).filter((c): c is number => typeof c === "number");
    const r: SttResult = { channel: this.opts.channel, text, isFinal, speechFinal, words, arrivedAt,
      confidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : undefined,
      speechEndWall: last ? speechEndWall(arrivedAt, this.connBytes / 32000, last.end) : undefined };
    this.emit("result", r);
  }
}

export const soniox: SttProvider = {
  id: "soniox", experimental: true,
  capabilities: { keyterms: true, diarize: true, interim: true, maxKeyterms: 100 },
  create: (o) => new SonioxStream(o),
  async probe(o) {
    const s = new SonioxStream({ ...o, channel: "them" }); s.on("error", () => {});
    try { await s.open(); await s.close(); return { ok: true }; } catch (e) { return { ok: false, error: classifySttError("soniox", e) }; }
  },
};
