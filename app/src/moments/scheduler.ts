// Scheduler: what to do with a moment the model returned. Pure: decide() reads a state object and returns a decision; recordShown() and
// recordFeedback() return the next state. No clock of its own (the state carries `now`), no globals. The model says what helps; this file
// says whether it is shown (a full card), kept as a small chip, or dropped, so a busy call never turns into a wall of cards.
import type { Moment, MomentMeta, MomentTag } from "./types.ts";
import { modeProfile } from "./modes.ts";
import type { MemoryKind } from "../session/types.ts";

export type ScheduledMoment = Moment & MomentMeta;
export type Action = "show" | "chip" | "drop";
export type Decision = {
  action: Action;
  /** Short machine reason, logged with every SKIP/drop so misses are measurable. */
  reason: string;
  rank: number;
  /** When a shown card takes over from the hero. */
  replaces?: string;
  /** The value needed for this tag right now (after feedback). */
  threshold: number;
};

export type SchedulerConfig = {
  /** Minimum VALUE to show a card, per tag; `default` for the rest (moments.minValue). */
  minValue: { default: number } & Partial<Record<MomentTag, number>>;
  maxPerMinute: number;
  noveltyMs: number;
  /** How long a shown card stays the hero (nothing of lower or equal rank replaces it). */
  topicLifetimeMs: number;
  /** An observer moment older than this (since its line) is dropped. */
  lateObserverMs: number;
  /** Not-useful ratings in a row for one kind that raise its threshold by one. */
  feedbackStreak: number;
};

export const DEFAULT_SCHEDULER: SchedulerConfig = {
  // A stall (price, date, promise) and a check protect the user from a wrong commitment, so one step lower than the rest.
  minValue: { default: 2, STALL: 1, CHECK: 1 },
  maxPerMinute: 3,
  noveltyMs: 120_000,
  topicLifetimeMs: 60_000,
  lateObserverMs: 6_000,
  feedbackStreak: 3,
};

/** Accepts the settings value (a number or a per-tag map) and gives a config value. */
export function minValueFrom(setting: unknown, base = DEFAULT_SCHEDULER.minValue): SchedulerConfig["minValue"] {
  if (typeof setting === "number" && Number.isFinite(setting)) return { default: clampValue(setting) };
  if (setting && typeof setting === "object") {
    const out = { ...base } as SchedulerConfig["minValue"];
    for (const [k, v] of Object.entries(setting as Record<string, unknown>))
      if (typeof v === "number" && Number.isFinite(v)) (out as Record<string, number>)[k] = clampValue(v);
    return out;
  }
  return { ...base };
}
const clampValue = (n: number) => Math.min(3, Math.max(0, Math.round(n)));

export type ShownRecord = {
  id: string;
  at: number;
  tag: MomentTag;
  bankId?: string;
  ref?: string;
  topic?: string;
  /** Memory version when it was shown (novelty compares with the current one). */
  memVer: number;
  rank: number;
  exempt: boolean;
};
export type SchedulerState = {
  now: number;
  /** The id of the turn (model call) whose output is current. A moment from another turn is stale. */
  currentTurnId?: number;
  memVer: number;
  /** Model down or slow: only a strong hint may show a bank or stall card. */
  offline?: boolean;
  /** The kind of call; modeProfile(kind) can lower or raise the minimum VALUE and the per-minute cap for it. */
  kind?: MemoryKind;
  shown: readonly ShownRecord[];
  hero?: { id: string; rank: number; at: number };
  /** Raised minimum VALUE per tag, from feedback. */
  boost: Readonly<Partial<Record<MomentTag, number>>>;
  /** Not-useful ratings in a row per tag. */
  streak: Readonly<Partial<Record<MomentTag, number>>>;
};

export const newSchedulerState = (now = 0): SchedulerState => ({ now, memVer: 0, shown: [], boost: {}, streak: {} });

const URGENCY: Record<MomentTag, number> = { SKIP: 0, STALL: 1.3, REPLY: 1.2, ANS: 1.1, BANK: 1.1, CHECK: 1.0, PROMPT: 0.9, TERM: 0.8, NOTE: 0.6 };
const AIM_FACTOR = { me: 1, all: 1, unclear: 0.7, other: 0 } as const;

/** Price and guarantee stalls and every check are not held back by the per-minute cap. */
export function isExempt(m: Moment): boolean {
  if (m.tag === "CHECK") return true;
  if (m.tag === "STALL") return m.stall === "price" || m.stall === "guarantee";
  return m.tag === "BANK" && (m.bankId === "stall-price" || m.bankId === "stall-guarantee");
}

/** 1 for a fresh line, falling to 0.2 at 10 s. */
export function freshness(ageMs: number): number {
  if (ageMs <= 3000) return 1;
  if (ageMs >= 10_000) return 0.2;
  return 1 - ((ageMs - 3000) / 7000) * 0.8;
}

export function rankOf(m: ScheduledMoment, now: number): number {
  const age = m.lineAt === undefined ? 0 : Math.max(0, now - m.lineAt);
  return round(m.value * URGENCY[m.tag] * freshness(age) * AIM_FACTOR[m.aim]);
}
const round = (n: number) => Math.round(n * 1000) / 1000;

export function thresholdFor(tag: MomentTag, state: SchedulerState, cfg: SchedulerConfig = DEFAULT_SCHEDULER): number {
  const prof = modeProfile(state.kind).minValue;
  const base = prof ? (prof[tag] ?? prof.default ?? cfg.minValue[tag] ?? cfg.minValue.default) : (cfg.minValue[tag] ?? cfg.minValue.default);
  return Math.min(3, Math.max(base, state.boost[tag] ?? 0));
}

export function decide(m: ScheduledMoment, state: SchedulerState, cfg: SchedulerConfig = DEFAULT_SCHEDULER): Decision {
  const rank = rankOf(m, state.now);
  const threshold = thresholdFor(m.tag, state, cfg);
  const d = (action: Action, reason: string, extra: Partial<Decision> = {}): Decision => ({ action, reason, rank, threshold, ...extra });
  if (m.turnId !== undefined && state.currentTurnId !== undefined && m.turnId !== state.currentTurnId) return d("drop", "stale-turn");
  if (m.tag === "SKIP") return d("drop", "skip");
  if (state.offline && !(m.hint === "strong" && (m.tag === "BANK" || m.tag === "STALL"))) return d("drop", "offline");
  if (m.aim === "other") return d("drop", "aim-other");
  if (m.source === "observer" && m.lineAt !== undefined && state.now - m.lineAt > cfg.lateObserverMs) return d("drop", "late");

  const topic = m.topic?.toLowerCase();
  const prior = state.shown.find(
    (r) =>
      state.now - r.at < cfg.noveltyMs &&
      ((m.ref && r.ref === m.ref) || (m.tag === "BANK" && r.tag === "BANK" && r.bankId === m.bankId) || (topic && r.topic === topic && r.tag === m.tag)),
  );
  if (prior && state.memVer <= prior.memVer) return d("drop", "not-novel");

  if (m.value < threshold) return d(m.value >= 1 && m.value === threshold - 1 ? "chip" : "drop", "below-min-value");

  const exempt = isExempt(m);
  const recent = state.shown.filter((r) => state.now - r.at < 60_000 && !r.exempt).length;
  const cap = cfg.maxPerMinute >= 99 ? cfg.maxPerMinute : (modeProfile(state.kind).maxPerMinute ?? cfg.maxPerMinute); // 99 = the direct path, never capped
  if (!exempt && recent >= cap) return d("chip", "per-minute-cap");

  const hero = state.hero;
  if (hero && state.now - hero.at < cfg.topicLifetimeMs) {
    if (rank <= hero.rank) return d("chip", "hero-holds");
    return d("show", "outranks-hero", { replaces: hero.id });
  }
  return d("show", "ok");
}

/** The state after a card was shown (not after a chip). `id` is the card id the engine gave it. */
export function recordShown(state: SchedulerState, m: ScheduledMoment, id: string, decision: Decision): SchedulerState {
  const rec: ShownRecord = {
    id,
    at: state.now,
    tag: m.tag,
    ...(m.bankId ? { bankId: m.bankId } : {}),
    ...(m.ref ? { ref: m.ref } : {}),
    ...(m.topic ? { topic: m.topic.toLowerCase() } : {}),
    memVer: state.memVer,
    rank: decision.rank,
    exempt: isExempt(m),
  };
  const keep = state.shown.filter((r) => state.now - r.at < 300_000).slice(-49);
  return { ...state, shown: [...keep, rec], hero: { id, rank: decision.rank, at: state.now } };
}

/** The hero is gone (dismissed, answered, closed): the next card is not held back by it. */
export function clearHero(state: SchedulerState, id?: string): SchedulerState {
  if (!state.hero || (id && state.hero.id !== id)) return state;
  const { hero: _hero, ...rest } = state;
  return rest;
}

/** Feedback on a card of this tag. Three "not useful" in a row raise that tag's minimum VALUE by one for the rest of the call; "useful" resets the streak. */
export function recordFeedback(
  state: SchedulerState,
  tag: MomentTag,
  rating: "useful" | "not-useful",
  cfg: SchedulerConfig = DEFAULT_SCHEDULER,
): SchedulerState {
  if (rating === "useful") return { ...state, streak: { ...state.streak, [tag]: 0 } };
  const n = (state.streak[tag] ?? 0) + 1;
  if (n < cfg.feedbackStreak) return { ...state, streak: { ...state.streak, [tag]: n } };
  const next = Math.min(3, thresholdFor(tag, state, cfg) + 1);
  return { ...state, streak: { ...state.streak, [tag]: 0 }, boost: { ...state.boost, [tag]: next } };
}
