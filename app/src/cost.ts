// CostMeter: money spent this call, from the settings price table (budget.prices) and the ACTUAL usage the providers report.
// LLM spend is capped (budget.maxUsdPerCall: at the cap run.ts stops model calls, so only prepared cards answer);
// STT spend (base price + the add-ons that are on: speaker labels, keyterms) is tracked and shown, never capped. STT minutes only raise a warning (budget.maxMinutesPerCall),
// and so does the total of the call (budget.warnUsdPerCall).
// run.ts feeds it after every model call and reads llmState()/minutesState() in its guards and its 1 s health tick.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Settings } from "./settings.ts";
import { DRIFT_WARN } from "./context/budget.ts";

export type LlmUsage = {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number; noCacheTokens?: number };
};
export type RoleTotals = { calls: number; usd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
export type CostState = "ok" | "warn" | "capped";

/** Token counts of one call as the provider reported them. A NaN or negative count is read as 0. `inputTokens` is the total, cache reads and writes included. */
export type UsageTokens = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; noCacheTokens: number };
export function usageTokens(usage: unknown, providerMetadata?: unknown): UsageTokens {
  const u = (usage ?? {}) as LlmUsage,
    d = u.inputTokenDetails ?? {};
  const pm = ((providerMetadata as { anthropic?: object } | undefined)?.anthropic ?? {}) as { cacheCreationInputTokens?: number };
  // A NaN/negative count from a provider must not poison the running total (NaN >= cap is false: the budget cap would never trip).
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0);
  const inputTokens = n(u.inputTokens),
    outputTokens = n(u.outputTokens);
  const cacheReadTokens = n(d.cacheReadTokens),
    cacheWriteTokens = d.cacheWriteTokens !== undefined ? n(d.cacheWriteTokens) : n(pm.cacheCreationInputTokens);
  const noCacheTokens = d.noCacheTokens !== undefined ? n(d.noCacheTokens) : Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, noCacheTokens };
}
/** The fields every usage row carries next to the raw `usage`: input, output, cache_read and cache_write tokens of the call. */
export function usageFields(
  usage: unknown,
  providerMetadata?: unknown,
): { input_tokens: number; output_tokens: number; cache_read: number; cache_write: number } {
  const t = usageTokens(usage, providerMetadata);
  return { input_tokens: t.inputTokens, output_tokens: t.outputTokens, cache_read: t.cacheReadTokens, cache_write: t.cacheWriteTokens };
}

/** One line of the cache report: a role over some calls. `hitPct` is the share of input tokens read from the cache; `writePct` the share written. */
export type CacheReportRow = {
  role: string;
  calls: number;
  input: number;
  read: number;
  write: number;
  hitPct: number;
  writePct: number;
  usd: number;
  /** USD per hour of call time (the time between the first and the last usage row of each call). Undefined when the rows cover less than a minute. */
  usdPerHour?: number;
  drift?: number;
};
/** Cache report from usage rows (usage.jsonl rows of one or more calls). Rows without token fields are read from `usage` the same way addLlm does.
 *  Roles are listed by input tokens, biggest first. `drift` is the mean of (estimate - actual) / actual over the rows that carry `est_tokens`. */
export function cacheReport(rows: readonly Record<string, unknown>[]): CacheReportRow[] {
  const by = new Map<string, CacheReportRow & { dsum: number; dn: number }>();
  // Call time: per call (rows carry `_call` when they come from recentUsageRows, else all rows are one call), the span between the first and last row.
  const span = new Map<string, [number, number]>();
  for (const r of rows) {
    const t = Number(r.t);
    if (!Number.isFinite(t) || t <= 0) continue;
    const k = typeof r._call === "string" ? r._call : "";
    const w = span.get(k);
    span.set(k, w ? [Math.min(w[0], t), Math.max(w[1], t)] : [t, t]);
  }
  const hours = [...span.values()].reduce((a, [lo, hi]) => a + (hi - lo), 0) / HOUR_MS;
  for (const r of rows) {
    const role = typeof r.role === "string" ? r.role : "";
    if (!role || role === "stt" || role === "summary" || (r.usage === undefined && r.input_tokens === undefined)) continue;
    const f = typeof r.input_tokens === "number" ? { input: r.input_tokens, read: Number(r.cache_read) || 0, write: Number(r.cache_write) || 0 } : null;
    const t =
      f ?? (({ inputTokens: input, cacheReadTokens: read, cacheWriteTokens: write }) => ({ input, read, write }))(usageTokens(r.usage, r.providerMetadata));
    const o = by.get(role) ?? { role, calls: 0, input: 0, read: 0, write: 0, hitPct: 0, writePct: 0, usd: 0, dsum: 0, dn: 0 };
    o.calls++;
    o.input += t.input;
    o.read += t.read;
    o.write += t.write;
    o.usd += Number(r.usd) || 0;
    if (typeof r.drift_pct === "number" && Number.isFinite(r.drift_pct)) {
      o.dsum += r.drift_pct;
      o.dn++;
    }
    by.set(role, o);
  }
  return [...by.values()]
    .map(({ dsum, dn, ...o }) => ({
      ...o,
      ...(hours >= 1 / 60 ? { usdPerHour: Math.round((o.usd / hours) * 1e6) / 1e6 } : {}),
      hitPct: o.input ? Math.round((o.read / o.input) * 1000) / 10 : 0,
      writePct: o.input ? Math.round((o.write / o.input) * 1000) / 10 : 0,
      ...(dn ? { drift: Math.round((dsum / dn) * 10) / 10 } : {}),
    }))
    .sort((a, b) => b.input - a.input);
}
/** The report as text lines for the terminal and `wingman doctor`. `simulated`: the numbers come from a fixture with a simulated provider cache, not from real calls. */
export function formatCacheReport(rep: readonly CacheReportRow[], o: { simulated?: boolean } = {}): string[] {
  const n = (x: number) => x.toLocaleString("en-US");
  const lines = rep.map(
    (r) =>
      `${r.role.padEnd(9)} ${String(r.calls).padStart(5)} calls  input ${n(r.input).padStart(9)}  cache read ${n(r.read).padStart(9)}  cache write ${n(r.write).padStart(8)}  hit share ${String(r.hitPct).padStart(5)}%  $${r.usd.toFixed(4)}${r.usdPerHour !== undefined ? `  $${r.usdPerHour.toFixed(4)}/hour` : ""}${r.drift !== undefined ? `  estimate off by ${r.drift > 0 ? "+" : ""}${r.drift}%` : ""}`,
  );
  return o.simulated ? ["(simulated: fixture calls with a simulated provider cache, not real usage)", ...lines] : lines;
}

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
    const t = usageTokens(usage, providerMetadata);
    const input = t.inputTokens,
      output = t.outputTokens,
      read = t.cacheReadTokens,
      write = t.cacheWriteTokens,
      plain = t.noCacheTokens;
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
  /** The cache report of this call from the running totals, one row per role. */
  cacheReport(): CacheReportRow[] {
    return Object.entries(this.roles)
      .filter(([, r]) => r.inputTokens > 0)
      .map(([role, r]) => ({
        role,
        calls: r.calls,
        input: r.inputTokens,
        read: r.cacheReadTokens,
        write: r.cacheWriteTokens,
        hitPct: Math.round((r.cacheReadTokens / r.inputTokens) * 1000) / 10,
        writePct: Math.round((r.cacheWriteTokens / r.inputTokens) * 1000) / 10,
        usd: r.usd,
      }))
      .sort((a, b) => b.input - a.input);
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

/** What the cache report says is wrong, in plain words (empty = nothing to say). `minTokens(role)`: the model's cache minimum for that role. Roles with fewer than 8 calls are not judged. */
export function cacheAdvice(rep: readonly CacheReportRow[], minTokens: (role: string) => number): string[] {
  const out: string[] = [];
  for (const r of rep) {
    if (r.calls < 8) continue;
    const avg = r.input / r.calls;
    if (r.hitPct < 10 && r.writePct < 10 && avg < minTokens(r.role))
      out.push(`${r.role}: ${Math.round(avg)} input tokens a call is under the model's cache minimum (${minTokens(r.role)}): nothing is cached`);
    else if (r.writePct >= 30 && r.hitPct < 10)
      out.push(`${r.role}: ${r.writePct}% of the input is written to the cache and only ${r.hitPct}% is read: the cached part changes too often`);
    if (r.drift !== undefined && Math.abs(r.drift) > DRIFT_WARN * 100)
      out.push(
        `${r.role}: the token estimate is off by ${r.drift > 0 ? "+" : ""}${r.drift}% (limit ${DRIFT_WARN * 100}%): budgets for this role are ${r.drift > 0 ? "tighter" : "looser"} than they look`,
      );
  }
  return out;
}

/**
 * Block A (the shared start of every prompt) against the model's cache minimum, from the context records in usage rows. One line per role that has records.
 * "cached on its own": A reaches the minimum, so every role reads it. "with the role rules": only A plus the role's fixed rules reaches it (a marker on the
 * rules block caches both). "not cached": even together they are under the minimum.
 */
export function blockAReport(
  rows: readonly Record<string, unknown>[],
  minTokens: (role: string) => number,
): { role: string; a: number; rules: number; min: number; state: "alone" | "with-rules" | "none" }[] {
  const by = new Map<string, { n: number; a: number; rules: number }>();
  for (const r of rows) {
    const ctx = r.ctx as { parts?: Record<string, number> } | undefined;
    const role = typeof r.role === "string" ? r.role : "";
    if (!ctx?.parts || !role) continue;
    // Block A is every part of the record that is not one of the role's own parts (rules, profile, house style, bank index, brief).
    const own = (k: string) => Number(ctx.parts![k]) || 0;
    const a =
      Object.values(ctx.parts).reduce((n, v) => n + (Number(v) || 0), 0) -
      own("memory") -
      own("roleInstructions") -
      own("retrieved") -
      own("rawTail") -
      own("trigger");
    const o = by.get(role) ?? { n: 0, a: 0, rules: 0 };
    o.n++;
    o.a += a;
    o.rules += own("roleInstructions");
    by.set(role, o);
  }
  return [...by.entries()].map(([role, o]) => {
    const a = Math.round(o.a / o.n),
      rules = Math.round(o.rules / o.n),
      min = minTokens(role);
    return { role, a, rules, min, state: a >= min ? ("alone" as const) : a + rules >= min ? ("with-rules" as const) : ("none" as const) };
  });
}
export function formatBlockA(rep: ReturnType<typeof blockAReport>): string[] {
  return rep.map(
    (r) =>
      `${r.role.padEnd(9)} block A ${String(r.a).padStart(5)} tokens, role rules ${String(r.rules).padStart(5)}, model minimum ${r.min === Infinity ? "none" : r.min}: ${
        r.state === "alone"
          ? "block A is cached on its own"
          : r.state === "with-rules"
            ? "cached only together with the role rules"
            : "under the minimum, not cached"
      }`,
  );
}

/** The usage rows of the newest `n` call folders under `callsDir`, oldest first. Unreadable folders and rows are skipped. */
export function recentUsageRows(callsDir: string, n = 5): Record<string, unknown>[] {
  if (!existsSync(callsDir)) return [];
  const dirs = readdirSync(callsDir)
    .map((d) => join(callsDir, d))
    .filter((d) => {
      try {
        return statSync(d).isDirectory() && !statSync(d).isSymbolicLink() && existsSync(join(d, "usage.jsonl"));
      } catch {
        return false;
      }
    })
    .sort()
    .slice(-n);
  const rows: Record<string, unknown>[] = [];
  for (const d of dirs)
    for (const line of readFileSync(join(d, "usage.jsonl"), "utf8").split("\n")) {
      if (!line) continue;
      try {
        rows.push({ ...(JSON.parse(line) as Record<string, unknown>), _call: d });
      } catch {
        /* a row that is not valid JSON is skipped */
      }
    }
  return rows;
}
