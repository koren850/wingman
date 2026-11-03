// Gladia live STT (EXPERIMENTAL: written from the public docs, never run against the live service).
// Protocol (docs.gladia.io live-stt, checked 2026-11-01): POST https://api.gladia.io/v2/live (header x-gladia-key) -> {id, url}
//   · connect to url · audio = binary frames matching init encoding/sample_rate · messages {type:"transcript", data:{id,is_final,utterance:{text,start,end,language}}}
//   · stop = {"type":"stop_recording"} · close code 1000 = intentional, anything else = reconnect to the same url.
// The WsStream base reconnects (with backoff) after a close we did not ask for, when the error is network-like or retryable.
import type WebSocket from "ws";
import { classifyHttp, classifySttError } from "../errors.ts";
import { speechEndWall, type SttOptions, type SttProvider, type SttResult, type Word } from "./types.ts";
import { WsStream } from "./ws-base.ts";

export const GLADIA_API = "https://api.gladia.io";

/** Gladia adapter on WsStream. connectUrl() does the init POST once; reconnects reuse the returned session url. */
export class GladiaStream extends WsStream {
  private url?: string;
  constructor(opts: SttOptions) { super("gladia", opts); }
  protected async connectUrl() {
    if (this.url) return this.url;                                   // reconnect resumes the same session url
    const lang = this.opts.language;
    const res = await fetch(`${this.opts.baseUrl ?? GLADIA_API}/v2/live`, {
      method: "POST", headers: { "x-gladia-key": this.opts.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        encoding: "wav/pcm", bit_depth: 16, sample_rate: 16000, channels: 1,
        ...(!this.opts.model || this.opts.model === "nova-3" ? {} : { model: this.opts.model }),
        language_config: lang && lang !== "auto" && lang !== "multi" ? { languages: [lang], code_switching: false } : { languages: [], code_switching: true },
        endpointing: Math.min(10, Math.max(0.01, (this.opts.endpointingMs ?? 350) / 1000)),
        messages_config: { receive_partial_transcripts: true },
        ...(this.opts.keyterms?.length ? { realtime_processing: { custom_vocabulary: true, custom_vocabulary_config: { vocabulary: this.opts.keyterms.slice(0, 100) } } } : {}),
      }),
    });
    if (!res.ok) throw classifyHttp("gladia", res.status, await res.text().catch(() => ""), { "retry-after": res.headers.get("retry-after") ?? undefined });
    const j = (await res.json()) as { url?: string };
    if (!j.url) throw classifySttError("gladia", new Error("init response had no url"));
    return (this.url = j.url);
  }
  protected onOpen(_ws: WebSocket) { /* the session is configured by the init POST: nothing to send */ }
  protected endFrame() { return JSON.stringify({ type: "stop_recording" }); }

  protected onMessage(m: any) {
    if (m.type === "error") { this.emit("error", classifySttError("gladia", new Error(String(m.data?.message ?? m.message ?? "error")))); return; }
    if (m.type !== "transcript") return;
    const u = m.data?.utterance; if (!u) return;
    const words: Word[] = (u.words ?? []).map((w: any) => ({ word: w.word, start: w.start, end: w.end, confidence: w.confidence }));
    const arrivedAt = Date.now(), endS = typeof u.end === "number" ? u.end : words.at(-1)?.end;
    const r: SttResult = { channel: this.opts.channel, text: String(u.text ?? "").trim(), isFinal: !!m.data.is_final, speechFinal: !!m.data.is_final, words, arrivedAt,
      confidence: typeof u.confidence === "number" ? u.confidence : undefined,
      speechEndWall: endS !== undefined ? speechEndWall(arrivedAt, this.connBytes / 32000, endS) : undefined };
    this.emit("result", r);
  }
}

export const gladia: SttProvider = {
  id: "gladia", experimental: true,
  capabilities: { keyterms: true, diarize: false, interim: true, maxKeyterms: 100 },
  create: (o) => new GladiaStream(o),
  async probe(o) {
    const s = new GladiaStream({ ...o, channel: "them" }); s.on("error", () => {});
    try { await s.open(); await s.close(); return { ok: true }; } catch (e) { return { ok: false, error: classifySttError("gladia", e) }; }
  },
};
