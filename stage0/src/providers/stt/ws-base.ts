// Shared plumbing for WebSocket STT adapters (Soniox, Gladia): open with timeout, send guard, keep-alive,
// backoff reconnect, normalized events. Deepgram uses its SDK's own socket instead.
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { classifySttError, ProviderError } from "../errors.ts";
import type { SttOptions, SttStreamLike } from "./types.ts";

/** Base for WebSocket adapters. Subclasses supply the URL, the config frame and the message parser. */
export abstract class WsStream extends EventEmitter implements SttStreamLike {
  protected ws?: WebSocket;
  protected connBytes = 0;      // bytes sent on the current socket (re-anchored per (re)open)
  protected totalBytes = 0;
  protected closing = false;
  private opens = 0;
  private keepAliveTimer?: NodeJS.Timeout;
  dropped = 0;
  constructor(protected provider: string, protected opts: SttOptions, protected reconnectMax = 3, protected backoffMs = [1000, 2000, 4000]) { super(); }

  /** URL to connect to (Gladia needs a POST first). */
  protected abstract connectUrl(): Promise<string>;
  protected connectHeaders(): Record<string, string> { return {}; }
  protected abstract onOpen(ws: WebSocket): void;               // send the config frame
  protected abstract onMessage(msg: any): void;
  protected keepAliveFrame(): string | undefined { return undefined; }
  protected endFrame(): string | Buffer | undefined { return undefined; }

  get isOpen() { return this.ws?.readyState === WebSocket.OPEN; }
  get audioSeconds() { return this.totalBytes / 32000; }

  async open() { await this.connect(); }

  private async connect() {
    const url = await this.connectUrl();
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: this.connectHeaders() });
      this.ws = ws;
      const timer = setTimeout(() => { reject(new ProviderError("timeout", this.provider, `${this.provider}: open timed out`)); try { ws.terminate(); } catch {} }, 10_000);
      ws.once("open", () => {
        clearTimeout(timer); this.connBytes = 0; this.opens++;
        try { this.onOpen(ws); } catch (e) { reject(classifySttError(this.provider, e)); return; }
        const ka = this.keepAliveFrame();
        clearInterval(this.keepAliveTimer);
        if (ka) this.keepAliveTimer = setInterval(() => { try { if (this.isOpen) ws.send(ka); } catch {} }, this.opts.keepAliveMs ?? 5000);
        if (this.opens > 1) this.emit("reconnected", { channel: this.opts.channel, opens: this.opens });
        resolve();
      });
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        let msg: any; try { msg = JSON.parse(data.toString()); } catch { return; }
        try { this.onMessage(msg); } catch (e) { this.emit("error", classifySttError(this.provider, e)); }
      });
      ws.on("unexpected-response", (_req, res) => { clearTimeout(timer); reject(classifySttError(this.provider, Object.assign(new Error(`Unexpected server response: ${res.statusCode}`), { statusCode: res.statusCode }))); });
      ws.on("error", (e) => { clearTimeout(timer); if (this.opens === 0) reject(classifySttError(this.provider, e)); else this.emit("error", classifySttError(this.provider, e)); });
      ws.on("close", (code, reason) => {
        clearTimeout(timer); clearInterval(this.keepAliveTimer);
        if (this.closing || ws !== this.ws) { this.emit("close"); return; }
        const err = classifySttError(this.provider, Object.assign(new Error(reason.toString()), { code }));
        this.emit("disconnected", { channel: this.opts.channel, code, reason: reason.toString(), error: err });
        void this.reconnect(err);
      });
    });
  }

  // Retries only network-like failures with backoff (default 1 s, 2 s, 4 s). Auth/quota errors are emitted at once so SttChannel can switch provider.
  private async reconnect(cause: ProviderError) {
    if (!cause.retryable && cause.kind !== "network") { this.emit("error", cause); return; }   // auth/quota: the manager switches provider
    for (let i = 0; i < this.reconnectMax && !this.closing; i++) {
      await new Promise((r) => setTimeout(r, this.backoffMs[Math.min(i, this.backoffMs.length - 1)]));
      if (this.closing) return;
      try { await this.connect(); return; } catch (e) { cause = classifySttError(this.provider, e); if (!cause.retryable && cause.kind !== "network") break; }
    }
    if (!this.closing) this.emit("error", cause);
  }

  send(pcm: Buffer): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { this.dropped++; return false; }
    try { this.ws.send(pcm); } catch { this.dropped++; return false; }
    this.connBytes += pcm.length; this.totalBytes += pcm.length;
    return true;
  }

  async close() {
    this.closing = true; clearInterval(this.keepAliveTimer);
    const end = this.endFrame();
    try { if (end !== undefined && this.isOpen) this.ws!.send(end); } catch {}
    // (a custom baseUrl means a test server: no need to wait)
    await new Promise((r) => setTimeout(r, this.opts.baseUrl ? 100 : 1500));   // let the final results arrive
    try { this.ws?.close(); } catch {}
  }
}
