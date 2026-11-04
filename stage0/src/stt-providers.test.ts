// Contract tests for the STT adapters (providers/stt/) against LOCAL mock WebSocket servers (no network, no keys),
// plus SttChannel fallback with fake streams.
// Soniox and Gladia are experimental: these tests prove the adapters follow the documented protocol, not that the live services agree.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { EventEmitter } from "node:events";
import { WebSocketServer, type WebSocket as WS } from "ws";
import { SonioxStream } from "./providers/stt/soniox.ts";
import { GladiaStream } from "./providers/stt/gladia.ts";
import { SttChannel } from "./providers/stt/channel.ts";
import { getSttProvider, STT_PROVIDERS, sttChain, loadKeyterms } from "./providers/stt/index.ts";
import { ProviderError } from "./providers/errors.ts";
import { loadSettings } from "./settings.ts";
import type { SttProvider, SttStreamLike, SttResult } from "./providers/stt/types.ts";

const S = loadSettings({ env: {}, userFile: "/nonexistent/x.yaml" }).settings;
const once = <T = any>(e: EventEmitter, ev: string) => new Promise<T>((r) => e.once(ev, r));
const listen = (srv: Server) => new Promise<number>((r) => srv.listen(0, "127.0.0.1", () => r((srv.address() as any).port)));

test("registry and chain", () => {
  assert.deepEqual(Object.keys(STT_PROVIDERS).sort(), ["deepgram", "gladia", "script", "soniox"]);   // script = offline test double
  assert.equal(getSttProvider("deepgram").experimental, false); assert.equal(getSttProvider("soniox").experimental, true); assert.equal(getSttProvider("gladia").experimental, true);
  assert.throws(() => getSttProvider("whisper"), /Unknown STT provider/);
  const s2 = { ...S, stt: { ...S.stt, provider: "soniox" as const, fallback: ["deepgram" as const, "soniox" as const] } };
  assert.deepEqual(sttChain(s2), ["soniox", "deepgram"]);
  assert.ok(loadKeyterms(S).length > 0 && loadKeyterms({ ...S, stt: { ...S.stt, keyterms: { ...S.stt.keyterms, enabled: "off" } } }).length === 0);
});

test("soniox contract: auth header, config frame, binary audio, tokens -> interim/final/speech_final, empty-frame end", async () => {
  const seen: { auth?: string; config?: any; audio: number; end: boolean } = { audio: 0, end: false };
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");
  wss.on("connection", (ws: WS, req) => {
    seen.auth = req.headers.authorization;
    ws.on("message", (data, isBinary) => {
      if (!seen.config) { seen.config = JSON.parse(data.toString()); return; }
      if (isBinary) {
        if (!seen.audio++) {
          ws.send(JSON.stringify({ tokens: [{ text: "מה", is_final: false }], total_audio_proc_ms: 100 }));
          ws.send(JSON.stringify({ tokens: [{ text: "מה ", start_ms: 0, end_ms: 300, confidence: 0.9, is_final: true }, { text: "קורה", start_ms: 300, end_ms: 700, confidence: 0.8, is_final: true }, { text: "<end>", is_final: true }] }));
        }
      } else if (data.toString() === "") { seen.end = true; ws.send(JSON.stringify({ tokens: [], finished: true })); ws.close(1000); }
    });
  });
  const port = (wss.address() as any).port;
  const s = new SonioxStream({ apiKey: "KEY", channel: "them", language: "he", keyterms: ["DNS", "SSL"], endpointingMs: 350, baseUrl: `ws://127.0.0.1:${port}` });
  const results: SttResult[] = []; s.on("result", (r) => results.push(r));
  await s.open();
  assert.equal(s.send(Buffer.alloc(3200)), true);
  await new Promise((r) => setTimeout(r, 150));
  await s.close(); await new Promise((r) => setTimeout(r, 50));
  assert.equal(seen.auth, "Bearer KEY");
  assert.equal(seen.config.model, "stt-rt-v5"); assert.equal(seen.config.audio_format, "pcm_s16le"); assert.equal(seen.config.sample_rate, 16000); assert.equal(seen.config.num_channels, 1);
  assert.deepEqual(seen.config.language_hints, ["he"]); assert.deepEqual(seen.config.context.terms, ["DNS", "SSL"]); assert.equal(seen.config.enable_endpoint_detection, true);
  assert.equal(seen.config.max_endpoint_delay_ms, 500, "350 ms is clamped to the documented 500-3000 range");
  assert.equal(seen.config.api_key, undefined, "key goes in the header, not the deprecated api_key field");
  assert.equal(seen.end, true); assert.equal(s.audioSeconds, 0.1);
  const interim = results.find((r) => !r.isFinal), fin = results.find((r) => r.isFinal);
  assert.equal(interim?.text, "מה"); assert.equal(fin?.text, "מה קורה"); assert.equal(fin?.speechFinal, true);
  assert.equal(fin?.words.length, 2); assert.ok(Math.abs(fin!.confidence! - 0.85) < 1e-9); assert.ok(fin!.speechEndWall! <= fin!.arrivedAt);
  wss.close();
});

test("soniox: error frame is classified (402 -> quota, 401 -> auth, 503 -> overload)", async () => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" }); await once(wss, "listening");
  let code = 402;
  wss.on("connection", (ws) => ws.once("message", () => { ws.send(JSON.stringify({ tokens: [], error_code: code, error_type: "x", error_message: "no" })); ws.close(1008); }));
  const port = (wss.address() as any).port;
  for (const [c, kind] of [[402, "quota"], [401, "auth"], [503, "overload"]] as const) {
    code = c;
    const s = new SonioxStream({ apiKey: "k", channel: "me", baseUrl: `ws://127.0.0.1:${port}` });
    const err = once<ProviderError>(s, "error"); s.on("disconnected", () => {});
    await s.open();
    const e = await err; assert.equal(e.kind, kind); await s.close();
  }
  wss.close();
});

test("soniox: unexpected drop emits disconnected, reconnects, and re-anchors", async () => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" }); await once(wss, "listening");
  let conns = 0;
  wss.on("connection", (ws) => { conns++; ws.once("message", () => { if (conns === 1) setTimeout(() => ws.terminate(), 20); }); });
  const s = new SonioxStream({ apiKey: "k", channel: "them", baseUrl: `ws://127.0.0.1:${(wss.address() as any).port}` });
  const dis = once(s, "disconnected"), rec = once(s, "reconnected");
  await s.open(); await dis; await rec;
  assert.equal(conns, 2); assert.equal(s.isOpen, true); await s.close(); wss.close();
});

test("gladia contract: POST init with key and config, binary audio, transcript partial/final, stop_recording", async () => {
  const seen: { key?: string; body?: any; audio: number; stop: boolean } = { audio: 0, stop: false };
  const http = createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d));
    req.on("end", () => {
      seen.key = String(req.headers["x-gladia-key"]);
      if (req.url !== "/v2/live" || req.method !== "POST") { res.writeHead(404).end(); return; }
      seen.body = JSON.parse(b);
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ id: "abc", url: `ws://127.0.0.1:${(http.address() as any).port}/ws?token=t` }));
    });
  });
  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (ws) => ws.on("message", (data, isBinary) => {
    if (isBinary) {
      if (!seen.audio++) {
        ws.send(JSON.stringify({ type: "transcript", data: { id: "1", is_final: false, utterance: { text: "מה קו", start: 0, end: 0.4, language: "he" } } }));
        ws.send(JSON.stringify({ type: "transcript", data: { id: "1", is_final: true, utterance: { text: "מה קורה", start: 0, end: 0.8, language: "he", words: [{ word: "מה", start: 0, end: 0.3, confidence: 0.9 }, { word: "קורה", start: 0.3, end: 0.8, confidence: 0.7 }] } } }));
      }
    } else if (JSON.parse(data.toString()).type === "stop_recording") { seen.stop = true; ws.close(1000); }
  }));
  const port = await listen(http);
  const s = new GladiaStream({ apiKey: "GKEY", channel: "them", language: "he", keyterms: ["DNS"], endpointingMs: 350, baseUrl: `http://127.0.0.1:${port}` });
  const results: SttResult[] = []; s.on("result", (r) => results.push(r));
  await s.open(); s.send(Buffer.alloc(3200));
  await new Promise((r) => setTimeout(r, 150));
  await s.close(); await new Promise((r) => setTimeout(r, 50));
  assert.equal(seen.key, "GKEY");
  assert.equal(seen.body.encoding, "wav/pcm"); assert.equal(seen.body.sample_rate, 16000); assert.equal(seen.body.bit_depth, 16); assert.equal(seen.body.channels, 1);
  assert.deepEqual(seen.body.language_config, { languages: ["he"], code_switching: false }); assert.equal(seen.body.endpointing, 0.35);
  assert.equal(seen.body.messages_config.receive_partial_transcripts, true); assert.equal(seen.body.realtime_processing.custom_vocabulary, true);
  assert.equal(seen.stop, true);
  assert.equal(results[0].isFinal, false); assert.equal(results[0].text, "מה קו");
  const fin = results.find((r) => r.isFinal)!; assert.equal(fin.text, "מה קורה"); assert.equal(fin.speechFinal, true); assert.equal(fin.words.length, 2);
  wss.close(); http.close();
});

test("gladia: init HTTP errors become ProviderErrors (401 auth, 429 rate)", async () => {
  let status = 401;
  const http = createServer((_q, res) => { res.writeHead(status, { "retry-after": "2" }).end("{}"); });
  const port = await listen(http);
  for (const [st, kind] of [[401, "auth"], [429, "rate"], [422, "bad_request"]] as const) {
    status = st;
    const s = new GladiaStream({ apiKey: "k", channel: "them", baseUrl: `http://127.0.0.1:${port}` });
    await assert.rejects(s.open(), (e: any) => e instanceof ProviderError && e.kind === kind);
  }
  http.close();
});

// ---- channel fallback switching with fake providers ----
class FakeStream extends EventEmitter implements SttStreamLike {
  dropped = 0; sent = 0; opened = false; closed = false; isOpen = true;
  constructor(public name: string, private failOpen?: ProviderError) { super(); }
  async open() { if (this.failOpen) throw this.failOpen; this.opened = true; }
  send(b: Buffer) { this.sent += b.length; return true; }
  async close() { this.closed = true; }
  get audioSeconds() { return this.sent / 32000; }
}
const fake = (id: string, streams: FakeStream[], failOpen?: ProviderError): SttProvider => ({
  id: id as any, experimental: false, capabilities: { keyterms: true, diarize: false, interim: true, maxKeyterms: 100 },
  create: () => { const s = new FakeStream(id, failOpen); streams.push(s); return s; }, probe: async () => ({ ok: true }),
});
const mkChannel = (chain: SttProvider[], now = { t: 0 }) => new SttChannel({
  channel: "them", chain, keyOf: () => "k", base: {}, circuit: { failures: 3, windowMs: 10_000 }, now: () => now.t,
});

test("channel: non-retryable failure (auth/quota) switches to the fallback immediately, with a switched event", async () => {
  const a: FakeStream[] = [], b: FakeStream[] = [];
  const ch = mkChannel([fake("deepgram", a), fake("soniox", b)]);
  const sw = once<any>(ch, "switched"); await ch.open();
  ch.send(Buffer.alloc(3200)); assert.equal(a[0].sent, 3200);
  a[0].emit("error", new ProviderError("quota", "deepgram", "credit finished"));
  const ev = await sw; assert.deepEqual([ev.from, ev.to, ev.kind], ["deepgram", "soniox", "quota"]);
  assert.equal(ch.provider, "soniox"); ch.send(Buffer.alloc(6400)); assert.equal(b[0].sent, 6400); assert.equal(a[0].sent, 3200);
  assert.deepEqual(ch.audioSecondsByProvider(), { deepgram: 0.1, soniox: 0.2 });
  const r: SttResult = { channel: "them", text: "x", isFinal: true, speechFinal: true, words: [], arrivedAt: 1 };
  const got: SttResult[] = []; ch.on("result", (x) => got.push(x)); a[0].emit("result", r); b[0].emit("result", r);
  assert.equal(got.length, 1, "results from the abandoned provider are ignored");
  assert.equal(a[0].closed, true);
});

test("channel: a single retryable failure waits; repeated failures within the window switch", async () => {
  const a: FakeStream[] = [], b: FakeStream[] = []; const now = { t: 1000 };
  const ch = mkChannel([fake("deepgram", a), fake("soniox", b)], now); await ch.open();
  let switched = 0; ch.on("switched", () => switched++);
  const net = () => new ProviderError("network", "deepgram", "closed");
  a[0].emit("disconnected", { channel: "them", error: net() }); now.t += 1000; a[0].emit("disconnected", { channel: "them", error: net() });
  await new Promise((r) => setTimeout(r, 5)); assert.equal(switched, 0);
  a[0].emit("reconnected", {}); now.t += 1000;     // a reconnect resets the count
  a[0].emit("disconnected", { channel: "them", error: net() }); a[0].emit("disconnected", { channel: "them", error: net() });
  await new Promise((r) => setTimeout(r, 5)); assert.equal(switched, 0);
  a[0].emit("disconnected", { channel: "them", error: net() });
  await new Promise((r) => setTimeout(r, 5)); assert.equal(switched, 1); assert.equal(ch.provider, "soniox");
});

test("channel: failure at open moves to the fallback; a bad_request does not; no fallback = exhausted", async () => {
  const a: FakeStream[] = [], b: FakeStream[] = [];
  const ch = mkChannel([fake("deepgram", a, new ProviderError("auth", "deepgram", "401")), fake("soniox", b)]);
  const sw = once<any>(ch, "switched"); await ch.open(); const ev = await sw;
  assert.equal(ev.atOpen, true); assert.equal(ch.provider, "soniox"); assert.equal(b[0].opened, true);
  const ch2 = mkChannel([fake("deepgram", [], new ProviderError("bad_request", "deepgram", "400")), fake("soniox", [])]);
  await assert.rejects(ch2.open(), (e: any) => e.kind === "bad_request");
  const ch3 = mkChannel([fake("deepgram", [], new ProviderError("auth", "deepgram", "401"))]);
  await assert.rejects(ch3.open(), (e: any) => e.kind === "auth");
  const x: FakeStream[] = [], ch4 = mkChannel([fake("deepgram", x), fake("soniox", [], new ProviderError("auth", "soniox", "401"))]);
  await ch4.open(); const ex = once(ch4, "exhausted"); x[0].emit("error", new ProviderError("quota", "deepgram", "q")); await ex;
  assert.equal(ch4.provider, "deepgram", "stays on the primary when the fallback cannot open");
});
