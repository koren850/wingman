// Health supervisor and degrade ladder (FAILURES.md section 2). Pure logic: run.ts feeds signals and renders the result.
// Rungs: 0 full · 1 reduced AI · 2 provider switch · 3 bank-only · 4 transcript-only · 5 off.
// Rule: the applied rung changes only BETWEEN questions (except 5/off), and recovery needs a stable period.
import { EventEmitter } from "node:events";

export type Rung = 0 | 1 | 2 | 3 | 4 | 5;
export const RUNG_NAMES = ["full", "reduced-ai", "provider-switch", "bank-only", "transcript-only", "off"] as const;

export type Signals = {
  noAi: boolean;            // user chose bank-only (--no-ai)
  llmDown: boolean;         // every configured LLM model is unusable (breakers open, auth/spend cap)
  llmOnFallback: boolean;   // reflex runs on a fallback model
  llmTrouble: boolean;      // recent 429/529/timeout
  llmSlow: boolean;         // first-tag p50 above llm.reflex.slowMs
  costCapped: boolean;      // budget.maxUsdPerCall reached
  sttOnFallback: boolean;   // an STT channel runs on its fallback provider
  sttSlow: boolean;         // final lag p50 above health.slowSttMs
  themDead: boolean;        // no client audio / client STT down: cannot detect questions
  bankFailed: boolean;      // bank or detector unusable
  fatal: string | null;     // STT down on every provider, consent withdrawn, crash...
};
export const NO_SIGNALS: Signals = { noAi: false, llmDown: false, llmOnFallback: false, llmTrouble: false, llmSlow: false, costCapped: false, sttOnFallback: false, sttSlow: false, themDead: false, bankFailed: false, fatal: null };

/** Which rung the signals ask for, and why (worst wins). */
export function decide(s: Signals): { rung: Rung; reasons: string[] } {
  if (s.fatal) return { rung: 5, reasons: [s.fatal] };
  const r4 = [s.themDead && "other side not heard", s.bankFailed && "bank or detector failed"].filter(Boolean) as string[];
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
  // meAns: answers for Dan's own questions (assist.*) do not depend on the other side being heard, so they survive the transcript-only rung (4).
  return { detect: r <= 3, bank: r <= 3, llm: r <= 2, ans: r === 0 || r === 2, listening: r <= 4, meAns: r <= 4 };
}

/** Dan-facing bar text (Hebrew) and level. noAi alone is the user's own choice: info, not a warning. */
export function describeRung(r: Rung, reasons: string[], userChoiceOnly = false): { level: "red" | "amber" | "info"; text: string } | null {
  const why = reasons.length ? ` (${reasons.join(", ")})` : "";
  switch (r) {
    case 0: return null;
    case 1: return { level: "amber", text: `AI מופחת: בנק ותשובת עצירה בלבד${why}` };
    case 2: return { level: "amber", text: `עברנו לספק גיבוי${why}` };
    case 3: return userChoiceOnly ? { level: "info", text: "מצב בנק בלבד (בלי AI)" } : { level: "red", text: `בנק בלבד: ה-AI לא זמין${why}` };
    case 4: return { level: "red", text: `אין כרטיסים לצד השני${why}. תשובות אליך (Ctrl+Opt+A) עדיין פועלות` };
    case 5: return { level: "red", text: `Wingman כבוי${why}` };
  }
}

/** closed -> (failures in window) -> open -> (cooldown) -> half-open probe -> (closeAfter successes) -> closed. */
export class CircuitBreaker {
  private fails: number[] = [];
  private okCount = 0;
  private openedAt = 0;
  state: "closed" | "open" | "half-open" = "closed";
  constructor(private cfg: { failures: number; windowMs: number; cooldownMs: number; closeAfter?: number }, private now: () => number = Date.now) {}
  /** May a request go through? (open breakers let one probe through after the cooldown). */
  allow(): boolean {
    if (this.state === "open" && this.now() - this.openedAt >= this.cfg.cooldownMs) { this.state = "half-open"; this.okCount = 0; }
    return this.state !== "open";
  }
  failure(forceOpen = false) {
    const t = this.now();
    this.fails = [...this.fails.filter((x) => t - x < this.cfg.windowMs), t];
    if (forceOpen || this.state === "half-open" || this.fails.length >= this.cfg.failures) { this.state = "open"; this.openedAt = t; this.okCount = 0; }
  }
  success() {
    if (this.state === "half-open") { if (++this.okCount >= (this.cfg.closeAfter ?? 2)) { this.state = "closed"; this.fails = []; } }
    else if (this.state === "closed") this.fails = [];
  }
}

export type HealthConfig = { tickMs: number; recoverStableMs: number; slowMs: number; slowSttMs: number; minSamples: number; troubleHoldMs?: number; fastRecoverMs?: number };

export class HealthSupervisor extends EventEmitter {
  rung: Rung = 0;
  reasons: string[] = [];
  private sig: Signals = { ...NO_SIGNALS };
  private busy = 0;
  private betterSince: number | null = null;
  private tags: number[] = [];
  private lags: number[] = [];
  private troubleUntil = 0;
  private fastRecover = false;   // the other side was heard again: leave "other side not heard" after fastRecoverMs, not recoverStableMs
  private timer?: NodeJS.Timeout;
  constructor(private cfg: HealthConfig, private now: () => number = Date.now) { super(); }

  start() { this.timer = setInterval(() => this.tick(), this.cfg.tickMs); this.timer.unref(); }
  stop() { clearInterval(this.timer); }
  set(patch: Partial<Signals>) {
    if (patch.themDead === false && this.sig.themDead) this.fastRecover = true;
    Object.assign(this.sig, patch);
    if (patch.fatal || (this.fastRecover && patch.themDead === false)) this.tick();
  }
  beginQuestion() { this.busy++; }
  endQuestion() { this.busy = Math.max(0, this.busy - 1); if (!this.busy) this.tick(); }
  get idle() { return this.busy === 0; }

  recordTag(ms: number) { this.tags = [...this.tags.slice(-4), ms]; this.set({ llmSlow: this.p50(this.tags) > this.cfg.slowMs && this.tags.length >= this.cfg.minSamples }); }
  recordSttLag(ms: number) { this.lags = [...this.lags.slice(-4), ms]; this.set({ sttSlow: this.p50(this.lags) > this.cfg.slowSttMs && this.lags.length >= this.cfg.minSamples }); }
  noteLlmTrouble() { this.troubleUntil = this.now() + (this.cfg.troubleHoldMs ?? 60_000); this.set({ llmTrouble: true }); }
  private p50(a: number[]) { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; }

  /** Evaluate. Degrading applies at the next idle moment; recovering also needs `recoverStableMs` of calm. */
  tick(): void {
    const t = this.now();
    if (this.sig.llmTrouble && t >= this.troubleUntil) this.sig.llmTrouble = false;
    const want = decide(this.sig);
    if (want.rung === 5 && this.rung !== 5) return this.apply(5, want.reasons);
    if (this.rung === 5) return;
    if (!this.idle) return;
    if (want.rung > this.rung) { this.betterSince = null; return this.apply(want.rung, want.reasons); }
    if (want.rung < this.rung) {
      this.betterSince ??= t;
      const need = this.fastRecover && this.reasons.length > 0 && this.reasons.every((r) => r === "other side not heard") ? (this.cfg.fastRecoverMs ?? 2000) : this.cfg.recoverStableMs;
      if (t - this.betterSince >= need) { this.tags = []; this.lags = []; this.sig.llmSlow = false; this.sig.sttSlow = false; return this.apply(want.rung, want.reasons); }
      return;
    }
    this.betterSince = null;
    if (want.reasons.join() !== this.reasons.join()) { this.reasons = want.reasons; this.emit("rung", { from: this.rung, to: this.rung, reasons: want.reasons }); }
  }

  private apply(to: Rung, reasons: string[]) {
    const from = this.rung; this.rung = to; this.reasons = reasons; this.betterSince = null; this.fastRecover = false;
    this.emit("rung", { from, to, reasons });
  }
  /** True when the only reason for bank-only is the user's own --no-ai. */
  get userChoiceOnly() { return this.rung === 3 && this.sig.noAi && !this.sig.llmDown && !this.sig.costCapped; }
  get caps() { return capabilities(this.rung); }
  get signals(): Readonly<Signals> { return this.sig; }
}
