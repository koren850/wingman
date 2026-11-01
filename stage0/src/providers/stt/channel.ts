// One STT channel ("me" or "them") over a provider chain. Switches to the next provider mid-call when
// a failure is non-retryable (auth, quota, spend cap) or repeats (circuit: N failures in windowMs).
import { EventEmitter } from "node:events";
import { classifySttError, type ProviderError } from "../errors.ts";
import type { Channel, SttOptions, SttProvider, SttStreamLike } from "./types.ts";

export type ChannelOpts = {
  channel: Channel;
  chain: SttProvider[];                                   // primary first
  keyOf: (providerId: string) => string | undefined;
  base: Omit<SttOptions, "apiKey" | "channel">;
  baseUrls?: Record<string, string>;                      // tests: point an adapter at a mock server
  circuit: { failures: number; windowMs: number };
  now?: () => number;
};

/** Events: result · disconnected · reconnected · switched {from,to,kind,reason} · exhausted (ProviderError) · stt_error (ProviderError) · keyterms_off */
export class SttChannel extends EventEmitter {
  private idx = 0;
  private stream?: SttStreamLike;
  private failures: number[] = [];
  private switching = false;
  private seconds: Record<string, number> = {};
  private droppedOld = 0;
  constructor(private o: ChannelOpts) { super(); }

  get provider() { return this.o.chain[this.idx].id; }
  get isOpen() { return !!this.stream?.isOpen; }
  get dropped() { return this.droppedOld + (this.stream?.dropped ?? 0); }
  get audioSeconds() { return Object.values(this.audioSecondsByProvider()).reduce((a, b) => a + b, 0); }
  audioSecondsByProvider() { return { ...this.seconds, [this.provider]: (this.seconds[this.provider] ?? 0) + (this.stream?.audioSeconds ?? 0) }; }
  private now() { return (this.o.now ?? Date.now)(); }

  /** Open the first provider in the chain that works; a switchProvider failure moves on, others throw. */
  async open(): Promise<void> {
    let last: ProviderError | undefined;
    for (; this.idx < this.o.chain.length; this.idx++) {
      try { await this.openCurrent(); return; }
      catch (e) {
        last = classifySttError(this.provider, e);
        this.emit("stt_error", last);
        if (!last.switchProvider) throw last;
        if (this.idx + 1 < this.o.chain.length) this.emit("switched", { from: this.provider, to: this.o.chain[this.idx + 1].id, kind: last.kind, reason: last.message, atOpen: true });
      }
    }
    this.idx = this.o.chain.length - 1;
    throw last!;
  }

  private async openCurrent() {
    const p = this.o.chain[this.idx], key = this.o.keyOf(p.id);
    if (!key) throw classifySttError(p.id, Object.assign(new Error("API key missing"), { statusCode: 401 }));
    const s = p.create({ ...this.o.base, apiKey: key, channel: this.o.channel, baseUrl: this.o.baseUrls?.[p.id] ?? this.o.base.baseUrl });
    this.wire(s);
    await s.open();
    this.stream = s;
  }

  private wire(s: SttStreamLike) {
    s.on("result", (r) => { if (s === this.stream || !this.stream) this.emit("result", r); });
    s.on("keyterms_off", (e) => this.emit("keyterms_off", e));
    s.on("reconnected", (d) => { if (s !== this.stream) return; this.failures = []; this.emit("reconnected", d); });
    s.on("disconnected", (d) => { if (s !== this.stream) return; this.emit("disconnected", d); this.onFailure(d.error ?? classifySttError(this.provider, d)); });
    s.on("error", (e) => { if (s !== this.stream && this.stream) return; const err = classifySttError(this.provider, e); this.emit("stt_error", err); this.onFailure(err); });
  }

  /** Decide: wait for the SDK/adapter to reconnect, or switch provider now. */
  private onFailure(err: ProviderError) {
    const t = this.now();
    this.failures = [...this.failures.filter((x) => t - x < this.o.circuit.windowMs), t];
    const nonRetryable = err.switchProvider && !err.retryable;
    if (nonRetryable || (err.switchProvider && this.failures.length >= this.o.circuit.failures)) void this.switchNext(err);
  }

  async switchNext(err: ProviderError) {
    if (this.switching) return;
    this.switching = true;
    try {
      const old = this.stream, from = this.provider;
      for (let i = this.idx + 1; i < this.o.chain.length; i++) {
        const prevIdx = this.idx; this.idx = i;
        try {
          this.stream = undefined; await this.openCurrent();
          this.seconds[from] = (this.seconds[from] ?? 0) + (old?.audioSeconds ?? 0); this.droppedOld += old?.dropped ?? 0;
          this.failures = [];
          this.emit("switched", { from, to: this.provider, kind: err.kind, reason: err.message });
          void old?.close().catch(() => {});
          return;
        } catch (e) { this.emit("stt_error", classifySttError(this.o.chain[i].id, e)); this.idx = prevIdx; this.stream = old; }
      }
      this.emit("exhausted", err);
    } finally { this.switching = false; }
  }

  send(pcm: Buffer): boolean { return this.stream ? this.stream.send(pcm) : (this.droppedOld++, false); }
  async close() { await this.stream?.close(); }
}
