// CostMeter: money spent this call, from the settings price table (budget.prices) and the ACTUAL usage the providers report.
// LLM spend is capped (budget.maxUsdPerCall: at the cap run.ts stops model calls, so only prepared cards answer);
// STT spend (base price + the add-ons that are on: speaker labels, keyterms) is tracked and shown, never capped. STT minutes only raise a warning (budget.maxMinutesPerCall),
// and so does the total of the call (budget.warnUsdPerCall).
// run.ts feeds it after every model call and reads llmState()/minutesState() in its guards and its 1 s health tick.
import type { Settings } from "./settings.ts";

export type LlmUsage = {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number; noCacheTokens?: number };
};
export type RoleTotals = { calls: number; usd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
export type CostState = "ok" | "warn" | "capped";

/** Usage roles (usage.jsonl). `reflex`, `notes`, `assist`... are the older jobs; the last seven are the moment engine's (PLAN 3.5). */
export const MOMENT_ROLES = ["moment", "observer", "memory", "compact", "ask", "digest", "wrapup"] as const;
export type MomentRole = (typeof MOMENT_ROLES)[number];
/** Soft hourly cap: when the last 60 minutes of AI spend reach this share of budget.maxLlmUsdPerHour, that job stops. Cheapest to lose first; a direct question stops last.
 *  Jobs the user asks for by hand (ask, digest, wrapup) and the older jobs are never stopped by it, but their spend counts. */
export const SHED_AT: Partial<Record<string, number>> = { compact: 0.6, observer: 0.8, memory: 0.9, moment: 1 };
/** The same order as a list, first to stop first. */
export const SHED_ORDER = Object.entries(SHED_AT)
  .sort((a, b) => a[1]! - b[1]!)
  .map(([role]) => role);
const HOUR_MS = 3_600_000;

/** Per-call spend tracker. One instance per call (run.ts). */
export class CostMeter {
  readonly roles: Record<string, RoleTotals> = {};
  readonly unpriced = new Set<string>();
  private sttSeconds: Record<string, number> = {};
  constructor(
    private prices: Settings["budget"]["prices"],
    private budget: Pick<Settings["budget"], "maxUsdPerCall" | "warnAt" | "maxMinutesPerCall"> & { warnUsdPerCall?: number; maxLlmUsdPerHour?: number },
  ) {}
  /** Spend rows of the last hours, for the rolling hourly cap: [wall ms, usd]. Older than one hour are dropped when read. */
  private spend: [number, number][] = [];

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
    if (usd > 0) this.spend.push([Date.now(), usd]);
    if (this.spend.length > 20000) this.spend.splice(0, this.spend.length - 20000);
    return { usd, tokens };
  }

  /** AI spend in the last 60 minutes (USD). */
  hourUsd(now = Date.now()): number {
    const from = now - HOUR_MS;
    while (this.spend.length && this.spend[0][0] <= from) this.spend.shift();
    return this.spend.reduce((a, [, u]) => a + u, 0);
  }
  /** Share of budget.maxLlmUsdPerHour used in the last hour (0 when there is no hourly cap). */
  hourRatio(now = Date.now()): number {
    const cap = this.budget.maxLlmUsdPerHour ?? 0;
    return cap > 0 ? this.hourUsd(now) / cap : 0;
  }
  /** True when the soft hourly cap says this job should not run now (see SHED_AT). */
  shed(role: string, now = Date.now()): boolean {
    const at = SHED_AT[role];
    return at !== undefined && this.hourRatio(now) >= at;
  }
  /** The per-call cap or the soft hourly cap stops direct questions. The reason is a short token for the bar and the log. */
  paused(now = Date.now()): "call-cap" | "hour-cap" | undefined {
    if (this.llmState() === "capped") return "call-cap";
    return this.shed("moment", now) ? "hour-cap" : undefined;
  }

  /** Audio seconds sent so far per STT provider, summed over both channels (set, not added). */
  setSttSeconds(bySeconds: Record<string, number>, channels = 1) {
    this.sttSeconds = bySeconds;
    this.sttChannels = Math.max(1, channels);
  }
  private sttChannels = 1;
  private addonSeconds: Record<string, { diarize: number; keyterms: number }> = {};
  /** Audio seconds per provider that ran with speaker labels (diarize) and with keyterms, summed over channels. Priced by budget.prices.sttAddons. */
  setSttAddonSeconds(by: Record<string, { diarize: number; keyterms: number }>) {
    this.addonSeconds = by;
  }
  get llmUsd() {
    return Object.values(this.roles).reduce((a, r) => a + r.usd, 0);
  }
  /** Speech-to-text base price only (audio hours x budget.prices.stt). */
  get sttBaseUsd() {
    return Object.entries(this.sttSeconds).reduce((a, [prov, s]) => a + (s / 3600) * (this.prices.stt[prov] ?? 0), 0);
  }
  /** Speaker-label and keyterm add-ons that were on. */
  get sttAddonUsd() {
    const p = this.prices.sttAddons ?? {};
    return Object.entries(this.addonSeconds).reduce(
      (a, [prov, s]) => a + (s.diarize / 3600) * (p[prov]?.diarizeUsdPerHour ?? 0) + (s.keyterms / 3600) * (p[prov]?.keytermsUsdPerHour ?? 0),
      0,
    );
  }
  get sttUsd() {
    return this.sttBaseUsd + this.sttAddonUsd;
  }
  /** Share of input tokens served from the prompt cache, 0-100, for one role or all roles. undefined when there were no input tokens. */
  cacheHitPct(role?: string): number | undefined {
    const rs = role ? [this.roles[role]].filter(Boolean) : Object.values(this.roles);
    const input = rs.reduce((a, r) => a + r.inputTokens, 0);
    return input > 0 ? Math.round((rs.reduce((a, r) => a + r.cacheReadTokens, 0) / input) * 1000) / 10 : undefined;
  }
  /** Cache hit % per role, for the usage summary row. */
  get cacheHitByRole(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const k of Object.keys(this.roles)) {
      const p = this.cacheHitPct(k);
      if (p !== undefined) out[k] = p;
    }
    return out;
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
  /** ok / warn once the whole call (AI + speech to text) passed budget.warnUsdPerCall. A warning only: speech to text is never stopped. 0 or unset = no warning. */
  totalState(): "ok" | "warn" {
    const w = this.budget.warnUsdPerCall ?? 0;
    return w > 0 && this.totalUsd >= w ? "warn" : "ok";
  }
  /** One-line cost text for the terminal, the cost warning and the usage log: AI and STT side by side, then the total. */
  line() {
    return `AI $${this.llmUsd.toFixed(3)} of $${this.budget.maxUsdPerCall} · STT $${this.sttUsd.toFixed(2)} · total $${this.totalUsd.toFixed(2)}`;
  }
}
