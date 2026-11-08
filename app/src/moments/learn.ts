// Per-user learning across calls. The ratings of one call tune the scheduler for that call (scheduler.ts). This file remembers, between calls, which kinds of card
// this user keeps rating down, and raises the minimum VALUE of that kind by one at the start of the next calls.
// Rule (PLAN-r3 3.2): a tag's offset becomes +1 only after at least 3 negative ratings (not useful, or "fewer like this") over at least 2 different calls. It decays
// after 5 calls without a negative rating. The offset is 0 or 1: it never lowers a threshold and never raises it by more than one step.
// The file holds counts only: no card text, no transcript, no names. learn.json in the user data folder, mode 600, written atomically.
// A missing, unreadable or corrupt file is the same as an empty one. Nothing here throws.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { USER_DATA } from "../env.ts";
import { MOMENT_TAGS, type MomentTag } from "./types.ts";

export const LEARN_FILE = join(USER_DATA, "learn.json");
/** Negative ratings (over at least MIN_CALLS calls) that raise a tag's minimum VALUE. */
export const MIN_NEGATIVES = 3;
export const MIN_CALLS = 2;
/** Calls without a negative rating after which a raised tag goes back one step. */
export const DECAY_CALLS = 5;

export type TagLearn = {
  /** Negative ratings counted while the tag is being watched. */
  neg: number;
  /** Calls that had at least one negative rating for this tag. */
  negCalls: number;
  /** Calls since the last negative rating. */
  idle: number;
  /** 0 or 1. */
  offset: 0 | 1;
};
export type LearnState = { v: 1; calls: number; tags: Partial<Record<MomentTag, TagLearn>> };

const empty = (): LearnState => ({ v: 1, calls: 0, tags: {} });
const isTag = (t: string): t is MomentTag => (MOMENT_TAGS as readonly string[]).includes(t) && t !== "SKIP";
const count = (n: unknown, max = 100_000): number | undefined => (typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= max ? n : undefined);

/** Checks the shape. Anything else (wrong type, extra keys, negative or fractional numbers) makes the whole file count as empty. */
export function checkLearn(raw: unknown): LearnState | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const calls = count(r.calls);
  if (r.v !== 1 || calls === undefined || !r.tags || typeof r.tags !== "object" || Array.isArray(r.tags)) return undefined;
  const tags: LearnState["tags"] = {};
  for (const [k, v] of Object.entries(r.tags as Record<string, unknown>)) {
    if (!isTag(k) || !v || typeof v !== "object") return undefined;
    const t = v as Record<string, unknown>;
    const neg = count(t.neg),
      negCalls = count(t.negCalls),
      idle = count(t.idle);
    if (neg === undefined || negCalls === undefined || idle === undefined || (t.offset !== 0 && t.offset !== 1)) return undefined;
    tags[k] = { neg, negCalls, idle, offset: t.offset };
  }
  return { v: 1, calls, tags };
}

let cache: { file: string; state: LearnState } | undefined;

/** Reads learn.json. A missing or corrupt file gives an empty state (and is not rewritten until the next call ends). */
export function loadLearning(file: string = LEARN_FILE): LearnState {
  if (cache?.file === file) return cache.state;
  let state = empty();
  try {
    if (existsSync(file)) state = checkLearn(JSON.parse(readFileSync(file, "utf8"))) ?? empty();
  } catch {
    state = empty();
  }
  cache = { file, state };
  return state;
}

/** The raised tags as a scheduler map ({ CHECK: 1 }). Only tags at +1 are listed. */
export function learnedOffsets(file: string = LEARN_FILE): Partial<Record<MomentTag, number>> {
  const out: Partial<Record<MomentTag, number>> = {};
  for (const [k, v] of Object.entries(loadLearning(file).tags)) if (v?.offset === 1 && isTag(k)) out[k] = 1;
  return out;
}
/** The offset (0 or 1) for one tag. */
export const offsetFor = (tag: MomentTag, file: string = LEARN_FILE): 0 | 1 => loadLearning(file).tags[tag]?.offset ?? 0;

/** A call ended. `counts` = negative ratings per tag in that call (not useful or fewer). Every call counts for the decay, with or without ratings. Returns the new state. */
export function noteCallEnd(counts: Partial<Record<MomentTag, number>>, file: string = LEARN_FILE): LearnState {
  const prev = loadLearning(file);
  const tags: LearnState["tags"] = {};
  for (const [k, v] of Object.entries(prev.tags)) if (v) tags[k as MomentTag] = { ...v };
  for (const tag of MOMENT_TAGS) {
    if (tag === "SKIP") continue;
    const n = Math.max(0, Math.min(1000, Math.floor(Number(counts[tag] ?? 0)) || 0));
    const t = tags[tag] ?? { neg: 0, negCalls: 0, idle: 0, offset: 0 as const };
    if (n > 0) {
      t.neg += n;
      t.negCalls += 1;
      t.idle = 0;
      if (t.neg >= MIN_NEGATIVES && t.negCalls >= MIN_CALLS) t.offset = 1;
    } else {
      t.idle += 1;
      if (t.offset === 1 && t.idle >= DECAY_CALLS) {
        // one step back: the tag is no longer raised, and its record starts again
        t.offset = 0;
        t.neg = 0;
        t.negCalls = 0;
        t.idle = 0;
      } else if (t.offset === 0 && t.idle >= DECAY_CALLS) {
        // old, unconfirmed negatives fade as well
        t.neg = 0;
        t.negCalls = 0;
      }
    }
    if (t.neg || t.negCalls || t.offset)
      tags[tag] = t; // a tag with no history is not stored
    else delete tags[tag];
  }
  const state: LearnState = { v: 1, calls: Math.min(100_000, prev.calls + 1), tags };
  cache = { file, state };
  save(file, state);
  return state;
}

/**
 * After the call, in the call review: the user rated a held-back moment of this kind "I wanted this". That is evidence against the raised step: it takes one negative
 * rating away (never below 0), and when fewer than MIN_NEGATIVES are left the tag is not raised any more. It never counts as a call (decay is untouched). Returns the new state.
 */
export function noteWanted(tag: MomentTag, file: string = LEARN_FILE): LearnState {
  const prev = loadLearning(file);
  if (!isTag(tag)) return prev;
  const tags: LearnState["tags"] = {};
  for (const [k, v] of Object.entries(prev.tags)) if (v) tags[k as MomentTag] = { ...v };
  const t = tags[tag];
  if (t) {
    t.neg = Math.max(0, t.neg - 1);
    if (t.neg < MIN_NEGATIVES) t.offset = 0;
    if (!t.neg && !t.negCalls && !t.offset) delete tags[tag];
  }
  const state: LearnState = { v: 1, calls: prev.calls, tags };
  cache = { file, state };
  save(file, state);
  return state;
}

/** Counts only, for the dashboard or a log row. */
export function learnSummary(file: string = LEARN_FILE): {
  calls: number;
  raised: MomentTag[];
  watching: Partial<Record<MomentTag, { neg: number; calls: number }>>;
} {
  const s = loadLearning(file);
  const watching: Partial<Record<MomentTag, { neg: number; calls: number }>> = {};
  for (const [k, v] of Object.entries(s.tags)) if (v && v.neg > 0) watching[k as MomentTag] = { neg: v.neg, calls: v.negCalls };
  return { calls: s.calls, raised: Object.keys(learnedOffsets(file)) as MomentTag[], watching };
}

/** Forget everything (the user asked, or a test). */
export function resetLearning(file: string = LEARN_FILE): void {
  cache = { file, state: empty() };
  try {
    rmSync(file, { force: true });
  } catch {
    /* nothing to remove */
  }
}

/** For tests: drop the in-memory copy so the next load reads the file again. */
export function _dropLearnCache(): void {
  cache = undefined;
}

function save(file: string, state: LearnState): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      /* not supported on every platform */
    }
    renameSync(tmp, file);
  } catch {
    /* a read-only folder: the learning of this run stays in memory */
  }
}
