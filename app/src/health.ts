// Health supervisor and degrade ladder. Mostly pure logic: run.ts feeds signals (provider failures, lag, audio loss) and renders the result.
// Rungs: 0 full · 1 reduced AI · 2 provider switch · 3 bank-only · 4 transcript-only · 5 off.
// Rule: the applied rung changes only BETWEEN questions (except 5/off), and recovery needs a stable period.
// Rung 5 is only for a user stop or withdrawn consent (signal `fatal`); a dead STT channel is rung 4 (transcript-only), retried in the background.
import { EventEmitter } from "node:events";
import { ht, reasonText, type UiLang } from "./htext.ts";

/** Degrade level, 0 = everything works, 5 = Wingman stopped. Higher is worse. */
export type Rung = 0 | 1 | 2 | 3 | 4 | 5;

/** What run.ts currently knows to be wrong. Each flag is independent; decide() picks the worst rung. */
export type Signals = {
  noAi: boolean; // user chose bank-only (--no-ai)
  llmDown: boolean; // every configured LLM model is unusable (breakers open, auth/spend cap)
  llmOnFallback: boolean; // reflex runs on a fallback model
  llmTrouble: boolean; // recent 429/529/timeout
  llmSlow: boolean; // first-tag p50 above llm.reflex.slowMs
  costCapped: boolean; // budget.maxUsdPerCall reached
  sttOnFallback: boolean; // an STT channel runs on its fallback provider
  sttSlow: boolean; // final lag p50 above health.slowSttMs
  themDead: boolean; // no client audio: cannot detect questions
  themSttDown: boolean; // the client channel's transcription is unusable (key/credit refused, or down on every provider): transcript-only, retried slowly. NOT rung 5: the user's own channel still works
  bankFailed: boolean; // bank or detector unusable
  fatal: string | null; // consent withdrawn or a user stop (never an STT outage: that is themSttDown, rung 4)
};
export const NO_SIGNALS: Signals = {
  noAi: false,
  llmDown: false,
  llmOnFallback: false,
  llmTrouble: false,
  llmSlow: false,
  costCapped: false,
  sttOnFallback: false,
  sttSlow: false,
  themDead: false,
  themSttDown: false,
  bankFailed: false,
  fatal: null,
};

/** Which rung the signals ask for, and why (worst wins). */
export function decide(s: Signals): { rung: Rung; reasons: string[] } {
  if (s.fatal) return { rung: 5, reasons: [s.fatal] };
  const r4 = [s.themDead && "other side not heard", s.themSttDown && "other side's transcription is down", s.bankFailed && "bank or detector failed"].filter(
    Boolean,
  ) as string[];
  if (r4.length) return { rung: 4, reasons: r4 };
  const r3 = [s.noAi && "AI off (--no-ai)", s.llmDown && "no LLM provider usable", s.costCapped && "LLM budget cap reached"].filter(Boolean) as string[];
  if (r3.length) return { rung: 3, reasons: r3 };
  const r2 = [s.llmOnFallback && "reflex on fallback model", s.sttOnFallback && "STT on fallback provider"].filter(Boolean) as string[];
  if (r2.length) return { rung: 2, reasons: r2 };
  const r1 = [s.llmSlow && "AI slow", s.llmTrouble && "AI rate-limited/overloaded", s.sttSlow && "STT slow"].filter(Boolean) as string[];
  if (r1.length) return { rung: 1, reasons: r1 };
  return { rung: 0, reasons: [] };
}

/** What each rung allows the call loop to do. */
export function capabilities(r: Rung) {
  // ans: model answers continue while the AI is only slow (rung 1): a late answer is dropped by reflex.dropStaleMs, so a slow model costs cards, not all cards.
  // meAns: answers for the user's own questions (assist.*) do not depend on the other side being heard, so they survive the transcript-only rung (4).
  return { detect: r <= 3, bank: r <= 3, llm: r <= 2, ans: r <= 2, listening: r <= 4, meAns: r <= 4 };
}

/** User-facing bar text in the UI language (default Hebrew) and level. noAi alone is the user's own choice: info, not a warning. */
export function describeRung(
  r: Rung,
  reasons: string[],
  userChoiceOnly = false,
  lang: UiLang = "he",
): { level: "red" | "amber" | "info"; text: string } | null {
  const list = reasons.map((x) => reasonText(lang, x));
  const why = list.length ? ` (${list.join(", ")})` : "";
  switch (r) {
    case 0:
      return null;
    case 1:
      return { level: "amber", text: ht(lang, "rung.1", { why }) };
    case 2:
      return { level: "amber", text: ht(lang, "rung.2", { why }) };
    case 3:
      return userChoiceOnly ? { level: "info", text: ht(lang, "rung.3.user") } : { level: "red", text: ht(lang, "rung.3", { why }) };
    case 4:
      return { level: "red", text: ht(lang, "rung.4", { why }) };
    case 5:
      return { level: "red", text: ht(lang, "rung.5", { why }) };
  }
}

/**
 * Per-model circuit breaker (not a rung): stops calling a model that keeps failing, then lets one probe through.
 * closed -> (failures in window) -> open -> (cooldown) -> half-open probe -> (closeAfter successes) -> closed.
 */
export class CircuitBreaker {
  private fails: number[] = [];
  private okCount = 0;
  private openedAt = 0;
  private probeAt: number | undefined; // a half-open probe is in flight (one at a time)
  state: "closed" | "open" | "half-open" = "closed";
  constructor(
    private cfg: { failures: number; windowMs: number; cooldownMs: number; closeAfter?: number },
    private now: () => number = Date.now,
  ) {}
  /** Would a request go through right now? Read-only: status checks use this, so they never use up the half-open probe. */
  peek(): boolean {
    if (this.state === "open") return this.now() - this.openedAt >= this.cfg.cooldownMs;
    if (this.state === "half-open") return this.probeAt === undefined || this.now() - this.probeAt >= this.cfg.cooldownMs;
    return true;
  }
  /** May a request go through? Call only right before a real request: in half-open it reserves the one probe. */
  allow(): boolean {
    if (this.state === "open" && this.now() - this.openedAt >= this.cfg.cooldownMs) {
      this.state = "half-open";
      this.okCount = 0;
      this.probeAt = undefined;
    }
    if (this.state === "open") return false;
    if (this.state === "half-open") {
      // one probe at a time; a probe that never reports back is forgotten after a cooldown
      if (this.probeAt !== undefined && this.now() - this.probeAt < this.cfg.cooldownMs) return false;
      this.probeAt = this.now();
    }
    return true;
  }
  failure(forceOpen = false) {
    const t = this.now();
    this.probeAt = undefined;
    this.fails = [...this.fails.filter((x) => t - x < this.cfg.windowMs), t];
    if (forceOpen || this.state === "half-open" || this.fails.length >= this.cfg.failures) {
      this.state = "open";
      this.openedAt = t;
      this.okCount = 0;
    }
  }
  success() {
    this.probeAt = undefined;
    if (this.state === "half-open") {
      if (++this.okCount >= (this.cfg.closeAfter ?? 2)) {
        this.state = "closed";
        this.fails = [];
      }
    } else if (this.state === "closed") this.fails = [];
  }
}

/** Timing knobs. `troubleHoldMs`: how long one 429/overload keeps the AI-trouble flag. `fastRecoverMs`: shortened calm period after the other side is heard again. */
export type HealthConfig = {
  tickMs: number;
  recoverStableMs: number;
  slowMs: number;
  slowSttMs: number;
  minSamples: number;
  troubleHoldMs?: number;
  fastRecoverMs?: number;
  /** Shortened calm period after a transient AI outage (429 / overload / timeouts, no auth or spend-cap error). Default 15 s. */
  llmRecoverMs?: number;
};

/** The reasons a short AI outage shows (breaker open, then rate-limited). Only these may recover on the shorter `llmRecoverMs`. */
/** Latency samples kept for the "AI slow" verdict (median of the last N first-tag times). */
const TAG_WINDOW = 8;
const LLM_TRANSIENT_REASONS = new Set(["no LLM provider usable", "AI rate-limited/overloaded"]);

/**
 * Turns signals into one applied rung and emits "rung" events { from, to, reasons }. Why it is not instant:
 * - degrading waits until no question is in flight (beginQuestion/endQuestion), so a card is never changed mid-answer;
 *   only rung 5 (fatal) applies immediately.
 * - recovering needs `recoverStableMs` of continuous better signals, so a flapping provider does not make the UI flicker.
 */
export class HealthSupervisor extends EventEmitter {
  rung: Rung = 0;
  reasons: string[] = [];
  private sig: Signals = { ...NO_SIGNALS };
  private busy = 0;
  private betterSince: number | null = null;
  private tags: number[] = [];
  private lags: number[] = [];
  private troubleUntil = 0;
  private llmHard = false; // an auth / spend-cap / quota error is not cleared yet: no shortcut for recovery
  private fastRecover = false; // the other side was heard again: leave "other side not heard" after fastRecoverMs, not recoverStableMs
  private timer?: NodeJS.Timeout;
  constructor(
    private cfg: HealthConfig,
    private now: () => number = Date.now,
  ) {
    super();
  }

  start() {
    this.timer = setInterval(() => this.tick(), this.cfg.tickMs);
    this.timer.unref();
  }
  stop() {
    clearInterval(this.timer);
  }
  set(patch: Partial<Signals>) {
    if ((patch.themDead === false && this.sig.themDead) || (patch.themSttDown === false && this.sig.themSttDown)) this.fastRecover = true;
    Object.assign(this.sig, patch);
    if (patch.fatal || (this.fastRecover && (patch.themDead === false || patch.themSttDown === false))) this.tick();
  }
  beginQuestion() {
    this.busy++;
  }
  endQuestion() {
    this.busy = Math.max(0, this.busy - 1);
    if (!this.busy) this.tick();
  }
  get idle() {
    return this.busy === 0;
  }

  // Slow detection uses the median of the last 8 samples and needs minSamples: a majority of slow replies, not one or two, makes the AI "slow".
  recordTag(ms: number) {
    this.tags = [...this.tags.slice(-(TAG_WINDOW - 1)), ms];
    this.set({ llmSlow: this.p50(this.tags) > this.cfg.slowMs && this.tags.length >= this.cfg.minSamples });
  }
  recordSttLag(ms: number) {
    this.lags = [...this.lags.slice(-4), ms];
    this.set({ sttSlow: this.p50(this.lags) > this.cfg.slowSttMs && this.lags.length >= this.cfg.minSamples });
  }
  noteLlmTrouble() {
    this.troubleUntil = this.now() + (this.cfg.troubleHoldMs ?? 60_000);
    this.set({ llmTrouble: true });
  }
  /** A hard LLM error (key rejected, spend cap, quota): recovery keeps the full calm period until an answer works again. */
  noteLlmHard() {
    this.llmHard = true;
  }
  /** An answer worked: clears the hard-error mark. */
  noteLlmOk() {
    this.llmHard = false;
  }
  private p50(a: number[]) {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  }

  /** Evaluate. Degrading applies at the next idle moment; recovering also needs `recoverStableMs` of calm. */
  tick(): void {
    const t = this.now();
    if (this.sig.llmTrouble && t >= this.troubleUntil) this.sig.llmTrouble = false;
    const want = decide(this.sig);
    if (want.rung === 5 && this.rung !== 5) return this.apply(5, want.reasons);
    if (this.rung === 5) return;
    if (!this.idle) return;
    if (want.rung > this.rung) {
      this.betterSince = null;
      return this.apply(want.rung, want.reasons);
    }
    if (want.rung < this.rung) {
      this.betterSince ??= t;
      const need =
        this.fastRecover && this.reasons.length > 0 && this.reasons.every((r) => r === "other side not heard" || r === "other side's transcription is down")
          ? (this.cfg.fastRecoverMs ?? 2000)
          : !this.llmHard && this.reasons.length > 0 && this.reasons.every((r) => LLM_TRANSIENT_REASONS.has(r))
            ? Math.min(this.cfg.recoverStableMs, this.cfg.llmRecoverMs ?? 15_000)
            : this.cfg.recoverStableMs;
      if (t - this.betterSince >= need) {
        this.tags = [];
        this.lags = [];
        this.sig.llmSlow = false;
        this.sig.sttSlow = false;
        return this.apply(want.rung, want.reasons);
      }
      return;
    }
    this.betterSince = null;
    if (want.reasons.join() !== this.reasons.join()) {
      this.reasons = want.reasons;
      this.emit("rung", { from: this.rung, to: this.rung, reasons: want.reasons });
    }
  }

  private apply(to: Rung, reasons: string[]) {
    const from = this.rung;
    this.rung = to;
    this.reasons = reasons;
    this.betterSince = null;
    this.fastRecover = false;
    this.emit("rung", { from, to, reasons });
  }
  /** True when the only reason for bank-only is the user's own --no-ai. */
  get userChoiceOnly() {
    return this.rung === 3 && this.sig.noAi && !this.sig.llmDown && !this.sig.costCapped;
  }
  get caps() {
    return capabilities(this.rung);
  }
  get signals(): Readonly<Signals> {
    return this.sig;
  }
}

/** Wait before STT reopen attempt n (0 first): 1, 2, 4, 8, then every 10 s; once the failure is permanent (key/credit refused) every `slowMs` (30 s). */
export const sttRetryDelayMs = (n: number, permanent: boolean, slowMs = 30_000): number => (permanent ? slowMs : Math.min(10_000, 1000 * 2 ** n));
/** A refused key / exhausted credit / spend cap: retrying fast is pointless, but it is still retried slowly (the user may top up mid-call). "unknown" is treated as transient. */
export const isPermanentSttError = (e: { retryable?: boolean; kind?: string }): boolean => e.retryable === false && e.kind !== "unknown";
