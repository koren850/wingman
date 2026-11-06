// CostMeter: money spent this call, from the settings price table (budget.prices) and the ACTUAL usage the providers report.
// LLM spend is capped (budget.maxUsdPerCall: at the cap run.ts stops model calls, so only prepared cards answer);
// STT spend is tracked and shown, not capped. STT minutes only raise a warning (budget.maxMinutesPerCall).
// run.ts feeds it after every model call and reads llmState()/minutesState() in its guards and its 1 s health tick.
import type { Settings } from "./settings.ts";

export type LlmUsage = {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number; noCacheTokens?: number };
};
export type RoleTotals = { calls: number; usd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
export type CostState = "ok" | "warn" | "capped";

/** Per-call spend tracker. One instance per call (run.ts). */
export class CostMeter {
  readonly roles: Record<string, RoleTotals> = {};
  readonly unpriced = new Set<string>();
  private sttSeconds: Record<string, number> = {};
  constructor(
    private prices: Settings["budget"]["prices"],
    private budget: Pick<Settings["budget"], "maxUsdPerCall" | "warnAt" | "maxMinutesPerCall">,
  ) {}

  /** Cost of one LLM call in USD (also added to the role total). Unknown models cost 0 and are listed in `unpriced`. */
  addLlm(role: string, modelRef: string, usage: unknown, providerMetadata?: unknown): { usd: number; tokens: Omit<RoleTotals, "calls" | "usd"> } {
    const u = (usage ?? {}) as LlmUsage,
      d = u.inputTokenDetails ?? {};
    const pm = ((providerMetadata as { anthropic?: object } | undefined)?.anthropic ?? {}) as { cacheCreationInputTokens?: number };
    // A NaN/negative count from a provider must not poison the running total (NaN >= cap is false: the budget cap would never trip).
    const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0);
    const input = n(u.inputTokens),
      output = n(u.outputTokens);
    const read = n(d.cacheReadTokens),
      write = d.cacheWriteTokens !== undefined ? n(d.cacheWriteTokens) : n(pm.cacheCreationInputTokens);
    const plain = d.noCacheTokens !== undefined ? n(d.noCacheTokens) : Math.max(0, input - read - write);
    const p = this.prices.llm[modelRef];
    if (!p) this.unpriced.add(modelRef);
    const usd = p
      ? (plain * p.inUsdPerM + read * (p.cacheReadUsdPerM ?? p.inUsdPerM) + write * (p.cacheWriteUsdPerM ?? p.inUsdPerM) + output * p.outUsdPerM) / 1e6
      : 0;
    const tokens = { inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write };
    const r = (this.roles[role] ??= { calls: 0, usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    r.calls++;
    r.usd += usd;
    for (const k of Object.keys(tokens) as (keyof typeof tokens)[]) r[k] += tokens[k];
    return { usd, tokens };
  }

  /** Audio seconds sent so far per STT provider, summed over both channels (set, not added). */
  setSttSeconds(bySeconds: Record<string, number>, channels = 1) {
    this.sttSeconds = bySeconds;
    this.sttChannels = Math.max(1, channels);
  }
  private sttChannels = 1;
  get llmUsd() {
    return Object.values(this.roles).reduce((a, r) => a + r.usd, 0);
  }
  get sttUsd() {
    return Object.entries(this.sttSeconds).reduce((a, [prov, s]) => a + (s / 3600) * (this.prices.stt[prov] ?? 0), 0);
  }
  get totalUsd() {
    return this.llmUsd + this.sttUsd;
  }
  get sttMinutes() {
    return Math.max(0, ...Object.values(this.sttSeconds)) / this.sttChannels / 60;
  } // the seconds sum both channels: divide by the channel count to get the call length

  /** ok / warn (>= warnAt of the cap) / capped (>= cap). A cap of 0 means "no LLM spend allowed" (capped once anything was spent; a priced-zero call stays ok). */
  llmState(): CostState {
    const cap = this.budget.maxUsdPerCall;
    if (this.llmUsd >= cap && (cap > 0 || this.llmUsd > 0)) return "capped";
    if (cap > 0 && this.llmUsd >= cap * this.budget.warnAt) return "warn";
    return "ok";
  }
  /** Same scale for call length (STT minutes). Only a warning in run.ts; it never stops the call. */
  minutesState(): CostState {
    const cap = this.budget.maxMinutesPerCall;
    return this.sttMinutes >= cap ? "capped" : this.sttMinutes >= cap * this.budget.warnAt ? "warn" : "ok";
  }
  /** One-line cost text for the terminal and the cost warning card. */
  line() {
    return `AI $${this.llmUsd.toFixed(3)} of $${this.budget.maxUsdPerCall} · STT $${this.sttUsd.toFixed(2)}`;
  }
}
