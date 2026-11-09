// Every v2 token budget in one place. The legacy constants (12 lines, 80 lines, 6000 chars, 300, 40k chars ...) stay where they are.
// Token counts are estimates (no tokenizer, no dependency). The estimate leans high so a budget is never broken in reality.
import { charCounts, estimateFromCounts } from "./calibration.ts";

export type Role = "moment" | "observer" | "memory" | "compact" | "ask" | "digest" | "wrapup";
export const ROLES: readonly Role[] = ["moment", "observer", "memory", "compact", "ask", "digest", "wrapup"];

/** Estimated tokens of a text. By default ASCII about 3.5 characters per token and every other character (Hebrew, emoji ...) 0.6 token; the numbers come from
 *  context/calibration.ts (not fitted to real calls until scripts/calibrate-tokens.ts has run on real usage rows). */
export function estimateTokens(s: string): number {
  if (!s) return 0;
  return estimateFromCounts(charCounts(s));
}

/** Cuts a text so that estimateTokens(result) <= maxTokens. Cuts at a line or word end when it can. */
export function truncateToTokens(s: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (estimateTokens(s) <= maxTokens) return s;
  let lo = 0,
    hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (estimateTokens(s.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  let cut = s.slice(0, lo);
  const nl = cut.lastIndexOf("\n"),
    sp = cut.lastIndexOf(" ");
  const at = Math.max(nl, sp);
  if (at > lo * 0.7) cut = cut.slice(0, at);
  return cut.trimEnd();
}

export type RoleBudget = {
  /** hard cap of the whole input (all blocks) */
  total: number;
  /** block A (shared, same bytes for every role) */
  shared: number;
  memory: number;
  roleInstructions: number;
  rawTail: number;
  trigger: number;
  /** retrieved background chunks; 0 turns retrieval off for the role */
  retrieved: number;
};

export type Budgets = Record<Role, RoleBudget>;

/** Retrieval and chunking (shared by all roles). */
export const RETRIEVE = {
  chunkTokens: 500,
  topChunks: 3,
  maxTokens: 600,
  /** BM25 score a chunk needs before it is used at all (see retrieve.ts) */
  minScore: 3,
} as const;

/** Defaults. Settings (memory.budgetTokens, ctx.rawTailTokens) may override memory and rawTail per call. */
export const DEFAULT_BUDGETS: Budgets = {
  // direct question or implied moment: fast, small. Last lines only.
  moment: { total: 6500, shared: 3000, memory: 1800, roleInstructions: 1800, rawTail: 600, trigger: 200, retrieved: 600 },
  observer: { total: 6500, shared: 3000, memory: 1800, roleInstructions: 1800, rawTail: 800, trigger: 200, retrieved: 0 },
  // updater: the new lines since the last cursor
  memory: { total: 7000, shared: 3000, memory: 1800, roleInstructions: 900, rawTail: 1200, trigger: 100, retrieved: 0 },
  compact: { total: 8000, shared: 3000, memory: 1800, roleInstructions: 900, rawTail: 2400, trigger: 100, retrieved: 0 },
  ask: { total: 12000, shared: 3000, memory: 1800, roleInstructions: 900, rawTail: 4500, trigger: 400, retrieved: 600 },
  // digest: the pre-meeting text itself goes in `trigger`
  digest: { total: 16000, shared: 3000, memory: 0, roleInstructions: 900, rawTail: 0, trigger: 12000, retrieved: 0 },
  wrapup: { total: 14000, shared: 3000, memory: 1800, roleInstructions: 900, rawTail: 7000, trigger: 100, retrieved: 0 },
};

/** Never trim memory below this when it is trimmed because the whole input is too big. */
export const MEMORY_FLOOR_TOKENS = 300;

/** Budgets with the user's settings applied (memory.budgetTokens, ctx.rawTailTokens). Roles with a 0 stay 0. */
export function withSettings(opts: { memoryTokens?: number; rawTailTokens?: number }, base: Budgets = DEFAULT_BUDGETS): Budgets {
  const out = {} as Budgets;
  for (const r of ROLES) {
    const b = { ...base[r] };
    if (opts.memoryTokens !== undefined && b.memory > 0) b.memory = Math.max(0, Math.floor(opts.memoryTokens));
    if (opts.rawTailTokens !== undefined && b.rawTail > 0 && (r === "moment" || r === "observer" || r === "memory"))
      b.rawTail = Math.max(0, Math.floor(opts.rawTailTokens));
    out[r] = b;
  }
  return out;
}

// ---------------------------------------------------------------- drift between the estimate and the provider's count
/** The estimate is warned about when it is off by more than this share of the real count. */
export const DRIFT_WARN = 0.25;
/** (estimate - actual) / actual, in percent with one decimal, or undefined when a side is missing. Positive = the estimate is too high (safe), negative = too low (a budget could be broken). */
export function driftPct(estimate: number, actual: number): number | undefined {
  if (!(estimate > 0) || !(actual > 0)) return undefined;
  return Math.round(((estimate - actual) / actual) * 1000) / 10;
}
/** Keeps the drift per role. `note` says when to write a warning: the first time a role is off by more than DRIFT_WARN in this tracker (one line per role per call, not one per request); with a finite `everyMs` it may repeat after that long. */
export class DriftTracker {
  private last = new Map<string, number>();
  readonly samples = new Map<string, { n: number; sum: number; worst: number }>();
  note(role: string, estimate: number, actual: number, now: number, everyMs = Infinity): { pct?: number; warn: boolean } {
    const pct = driftPct(estimate, actual);
    if (pct === undefined) return { warn: false };
    const s = this.samples.get(role) ?? { n: 0, sum: 0, worst: 0 };
    s.n++;
    s.sum += pct;
    if (Math.abs(pct) > Math.abs(s.worst)) s.worst = pct;
    this.samples.set(role, s);
    const off = Math.abs(pct) > DRIFT_WARN * 100;
    const prev = this.last.get(role);
    if (!off || (prev !== undefined && now - prev < everyMs)) return { pct, warn: false };
    this.last.set(role, now);
    return { pct, warn: true };
  }
}
