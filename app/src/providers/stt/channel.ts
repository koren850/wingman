// One STT channel ("me" or "them") over a provider chain. Switches to the next provider mid-call when
// a failure is non-retryable (auth, quota, spend cap) or repeats (circuit: N failures in windowMs).
// Also keeps a short audio ring while the socket is down and replays it after a reconnect. Created by src/run.ts.
import { EventEmitter } from "node:events";
import { classifySttError, ProviderError } from "../errors.ts";
import { STT_OPEN_TIMEOUT_MS, type Channel, SttOptions, SttProvider, SttResult, SttStreamLike } from "./types.ts";

/** Two failure events closer together than this are one socket failure. */
const SAME_FAILURE_MS = 250;

/** chain = providers in fallback order; circuit = switch after `failures` errors within `windowMs`. */
export type ChannelOpts = {
  channel: Channel;
  chain: SttProvider[]; // primary first
  keyOf: (providerId: string) => string | undefined;
  base: Omit<SttOptions, "apiKey" | "channel">;
  baseUrls?: Record<string, string>; // tests: point an adapter at a mock server
  circuit: { failures: number; windowMs: number };
  ringMs?: number; // audio kept while the socket is down, flushed on reopen (0/undefined = drop, old behaviour)
  openTimeoutMs?: number; // one open (or reopen) attempt gives up after this long (default 8 s)
  deadAfterMs?: number; // a socket that stays disconnected this long is treated as dead (default 45 s)
  /** After a switch to a fallback for a transient reason, try the primary again after this long (default 60 s, 0 = never). */
  failbackAfterMs?: number;
  now?: () => number;
};

/** Events: result · disconnected · reconnected · switched {from,to,kind,reason} · exhausted (ProviderError) · stt_error (ProviderError) · keyterms_off */
export class SttChannel extends EventEmitter {
  private idx = 0;
  private stream?: SttStreamLike;
  private failures: number[] = [];
  private switching = false;
  private closed = false;
  private lastFailure?: { stream: SttStreamLike | undefined; kind: string; at: number };
  private seconds: Record<string, number> = {};
  private droppedOld = 0;
  private ring: Buffer[] = []; // ring: most recent ringMs of audio while the socket is not open
  private ringBytes = 0;
  private ringDropped = 0; // chunks that fell off the ring (counted in `dropped`)
  private flushedBytes = 0; // total bytes ever replayed from the ring
  private flushEndSec = 0; // flushed audio occupies [0, flushEndSec] of the current connection's audio clock
  private deadTimer?: NodeJS.Timeout;
  private deadFor?: SttStreamLike; // the stream the dead timer is armed for
  private opening = false; // the first open() is running: failure events of its stream belong to open(), not to switchNext()
  private failbackTimer?: NodeJS.Timeout;
  constructor(private o: ChannelOpts) {
    super();
  }

  get provider() {
    return this.o.chain[this.idx].id;
  }
  get isOpen() {
    return !!this.stream?.isOpen;
  }
  get dropped() {
    return this.droppedOld + this.ringDropped + (this.stream?.dropped ?? 0);
  }
  /** ms of audio waiting in the ring right now (the socket is not open) */
  get ringedMs() {
    return this.ringBytes / 32;
  }
  /** chunks that fell off the ring because it was full (the oldest go first) */
  get ringDroppedChunks() {
    return this.ringDropped;
  }
  /** ms of audio replayed from the ring after a reconnect / provider switch */
  get flushedMs() {
    return this.flushedBytes / 32;
  }
  get audioSeconds() {
    return Object.values(this.audioSecondsByProvider()).reduce((a, b) => a + b, 0);
  }
  audioSecondsByProvider() {
    return { ...this.seconds, [this.provider]: (this.seconds[this.provider] ?? 0) + (this.stream?.audioSeconds ?? 0) };
  }
  private now() {
    return (this.o.now ?? Date.now)();
  }

  /** Open the first provider in the chain that works; a switchProvider failure moves on, others throw. */
  async open(): Promise<void> {
    this.opening = true;
    try {
      await this.openChain();
    } finally {
      this.opening = false;
    }
  }
  private async openChain(): Promise<void> {
    let last: ProviderError | undefined;
    for (; this.idx < this.o.chain.length; this.idx++) {
      try {
        await this.openCurrent(this.idx);
        return;
      } catch (e) {
        last = classifySttError(this.provider, e);
        this.emit("stt_error", last);
        if (!last.switchProvider) throw last;
        if (this.idx + 1 < this.o.chain.length)
          this.emit("switched", { from: this.provider, to: this.o.chain[this.idx + 1].id, kind: last.kind, reason: last.message, atOpen: true });
      }
    }
    this.idx = this.o.chain.length - 1;
    throw last!;
  }

  /** Open chain[idx]. `this.idx` (the provider the bookkeeping credits) moves to idx only once the new stream is current. */
  private async openCurrent(idx = this.idx) {
    const p = this.o.chain[idx],
      key = this.o.keyOf(p.id);
    if (!key) throw classifySttError(p.id, Object.assign(new Error("API key missing"), { statusCode: 401 }));
    if (this.closed) return;
    const s = p.create({ ...this.o.base, apiKey: key, channel: this.o.channel, baseUrl: this.o.baseUrls?.[p.id] ?? this.o.base.baseUrl });
    this.wire(s, p.id);
    const limit = this.o.openTimeoutMs ?? STT_OPEN_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        s.open(),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new ProviderError("timeout", p.id, `${p.id}: open timed out after ${Math.round(limit / 1000)} s`)), limit);
        }),
      ]);
    } catch (e) {
      void Promise.resolve(s.close()).catch(() => {}); // a failed open must not leave a half-open socket behind
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (this.closed) {
      // close() ran while this stream was opening: do not keep it.
      void Promise.resolve(s.close()).catch(() => {});
      return;
    }
    this.idx = idx;
    this.stream = s;
    this.flushRing(s);
  }

  /** Replay buffered audio, oldest first, right after a (re)open. Each connection re-anchors its audio clock at open,
   *  so flushed audio sits at [0, flushEndSec]; results ending inside it get no speechEndWall (sent in a burst, not real time). */
  private flushRing(s: SttStreamLike) {
    this.flushEndSec = 0;
    if (!this.ring.length) return;
    const chunks = this.ring;
    this.ring = [];
    this.ringBytes = 0;
    let sent = 0;
    for (let i = 0; i < chunks.length; i++) {
      if (s.send(chunks[i])) {
        sent += chunks[i].length;
        this.flushedBytes += chunks[i].length;
      } else {
        // socket went down again mid-flush: put the unsent rest back (oldest first), before anything buffered since
        const rest = chunks.slice(i);
        this.ring = [...rest, ...this.ring];
        this.ringBytes += rest.reduce((n, c) => n + c.length, 0);
        break;
      }
    }
    this.flushEndSec = sent / 32000;
  }

  private buffer(pcm: Buffer) {
    const cap = (this.o.ringMs ?? 0) * 32; // 16 kHz s16le mono = 32 bytes/ms
    this.ring.push(pcm);
    this.ringBytes += pcm.length;
    while (this.ring.length && this.ringBytes > cap) {
      this.ringBytes -= this.ring.shift()!.length;
      this.ringDropped++;
    }
  }

  private wire(s: SttStreamLike, providerId: string) {
    // Events from a stream that is no longer the current one (an old stream closing after a switch) are ignored, so a stale
    // disconnect cannot trigger a second failover.
    s.on("result", (r: SttResult) => {
      if (s !== this.stream && this.stream) return;
      // A result that ends inside flushed audio would get a lag inflated by the burst: drop its wall-clock anchor
      const end = r.words?.at(-1)?.end;
      if (this.flushEndSec > 0 && r.speechEndWall !== undefined && (end === undefined || end <= this.flushEndSec + 0.05))
        r = { ...r, speechEndWall: undefined };
      this.emit("result", r);
    });
    s.on("keyterms_off", (e) => this.emit("keyterms_off", e));
    s.on("reconnected", (d) => {
      if (s !== this.stream) return;
      this.clearDead();
      this.failures = [];
      this.flushRing(s);
      this.emit("reconnected", d);
    });
    s.on("disconnected", (d) => {
      if (s !== this.stream) return;
      this.emit("disconnected", d);
      const err = d.error ?? classifySttError(providerId, d);
      this.onFailure(err, s, "disconnected");
      this.armDeadTimer(s, err);
    });
    // `info.terminal`: the stream gave up reconnecting on its own, so nothing will heal it without us.
    s.on("error", (e, info?: { terminal?: boolean }) => {
      if (s !== this.stream && this.stream) return;
      const err = classifySttError(providerId, e);
      this.emit("stt_error", err);
      this.onFailure(err, s, "error", !!info?.terminal);
    });
  }

  /** A socket that never comes back (the adapter's own reconnect gave up silently) is treated as a terminal failure. */
  private clearDead() {
    clearTimeout(this.deadTimer);
    this.deadTimer = undefined;
    this.deadFor = undefined;
  }
  private armDeadTimer(s: SttStreamLike, err: ProviderError) {
    if (this.deadTimer && this.deadFor === s) return; // already counting for this stream: repeated disconnects must not restart it
    clearTimeout(this.deadTimer);
    this.deadFor = s;
    this.deadTimer = setTimeout(() => {
      this.deadTimer = undefined;
      this.deadFor = undefined;
      if (this.closed || s !== this.stream || s.isOpen) return;
      void this.switchNext(err);
    }, this.o.deadAfterMs ?? 45_000);
    this.deadTimer.unref?.();
  }

  /** Decide: wait for the SDK/adapter to reconnect, or switch provider now. */
  private onFailure(err: ProviderError, stream: SttStreamLike | undefined, kind: "error" | "disconnected", terminal = false) {
    if (this.opening) return; // open() sees the same failure as a rejection and moves on itself; two paths would open two fallback sockets
    const t = this.now();
    // One socket failure can surface twice: an "error" event, then the "disconnected" for the same close (or the other way round).
    // An event of the other kind from the same stream within SAME_FAILURE_MS is the same failure: count it once toward the circuit.
    const last = this.lastFailure;
    const sameFailure = !!last && last.stream === stream && last.kind !== kind && t - last.at < SAME_FAILURE_MS;
    this.lastFailure = { stream, kind, at: t };
    if (!sameFailure) this.failures = [...this.failures.filter((x) => t - x < this.o.circuit.windowMs), t];
    const nonRetryable = err.switchProvider && !err.retryable;
    // A terminal error is one the stream will not recover from: always move on (next provider, or "exhausted" and the retry loop).
    if (terminal) void this.switchNext(err);
    else if (nonRetryable || (err.switchProvider && this.failures.length >= this.o.circuit.failures)) void this.switchNext(err);
  }

  /** Move to the next provider in the chain. On success emits "switched"; if none opens, emits "exhausted" and keeps the old stream. Re-entrant calls are ignored. */
  async switchNext(err: ProviderError) {
    if (this.switching) return;
    this.switching = true;
    try {
      const old = this.stream,
        from = this.provider;
      for (let i = this.idx + 1; i < this.o.chain.length; i++) {
        try {
          this.stream = undefined;
          await this.openCurrent(i);
          if (this.closed) {
            // close() ran while the fallback was opening: do not leave that new socket (and the old one) running.
            void (this.stream as SttStreamLike | undefined)?.close().catch(() => {});
            void old?.close().catch(() => {});
            return;
          }
          this.seconds[from] = (this.seconds[from] ?? 0) + (old?.audioSeconds ?? 0);
          this.droppedOld += old?.dropped ?? 0;
          this.failures = [];
          this.emit("switched", { from, to: this.provider, kind: err.kind, reason: err.message });
          void old?.close().catch(() => {});
          if (!(err.switchProvider && !err.retryable)) this.armFailback(); // a refused key will not come back by itself
          return;
        } catch (e) {
          this.emit("stt_error", classifySttError(this.o.chain[i].id, e));
          this.stream = old;
        }
      }
      this.emit("exhausted", err);
    } finally {
      this.switching = false;
    }
  }

  /** On a fallback after a transient failure: look at the primary again after a stable period and go back to it when it opens. */
  private armFailback() {
    const ms = this.o.failbackAfterMs ?? 60_000;
    clearTimeout(this.failbackTimer);
    if (!ms || this.closed || this.idx === 0) return;
    this.failbackTimer = setTimeout(() => void this.tryFailback(), ms);
    this.failbackTimer.unref?.();
  }
  private async tryFailback() {
    if (this.closed || this.switching || this.idx === 0) return;
    this.switching = true;
    const old = this.stream,
      from = this.provider;
    try {
      // The old stream (and its provider index) stays current until the primary is open, so its audio seconds, errors and events are not disturbed.
      await this.openCurrent(0);
      if (this.closed) {
        void old?.close().catch(() => {});
        return;
      }
      if (this.stream === old) throw new Error("failback produced no new stream");
      this.seconds[from] = (this.seconds[from] ?? 0) + (old?.audioSeconds ?? 0);
      this.droppedOld += old?.dropped ?? 0;
      this.failures = [];
      this.clearDead();
      void old?.close().catch(() => {});
      this.emit("failback", { from, to: this.provider });
    } catch {
      this.switching = false;
      this.armFailback(); // still down: look again later
    } finally {
      this.switching = false;
    }
  }

  /** After "exhausted" with no fallback left: open a fresh socket on the CURRENT provider. Throws (classified) on failure. The old stream stays
   *  as this.stream until the new one is open, so a failing new socket cannot trigger another switch. */
  async reopen(): Promise<void> {
    const old = this.stream,
      prov = this.provider;
    await this.openCurrent().catch((e) => {
      throw classifySttError(prov, e);
    });
    if (this.closed) return; // close() ran while reopening: openCurrent already closed the new stream
    this.failures = [];
    if (old && old !== this.stream) {
      this.seconds[prov] = (this.seconds[prov] ?? 0) + old.audioSeconds;
      this.droppedOld += old.dropped;
      void old.close().catch(() => {});
    }
    this.emit("reconnected", { channel: this.o.channel, reopened: true });
  }

  /** Returns false when the chunk was not sent live (buffered in the ring or dropped). Never throws. */
  send(pcm: Buffer): boolean {
    // Ring whenever the channel is not open, also before the first open succeeds (a slow first connect must not lose the opening seconds).
    if ((this.o.ringMs ?? 0) > 0 && !this.closed && !this.stream?.isOpen) {
      this.buffer(pcm);
      return false;
    }
    if (!this.stream) {
      this.droppedOld++;
      return false;
    }
    if (this.ring.length) this.flushRing(this.stream); // reopened without a 'reconnected' event: keep order
    return this.stream.send(pcm);
  }
  async close() {
    this.closed = true;
    clearTimeout(this.failbackTimer);
    this.clearDead();
    await this.stream?.close();
  }
}
