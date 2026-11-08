// Prompt-cache layout of the v2 calls: which blocks carry a cache marker for which role, and the least prefix the provider will cache.
//
// Facts (Anthropic prompt caching docs, checked 2026-11-08):
//   - a prefix is cached only above a model minimum: 512 tokens for Haiku 5.5, Sonnet 5.5 and Opus 5.x, 1024 for Sonnet 5 / 4.x, 2048 for Opus 4.7,
//     4096 for Haiku 4.5 and Opus 4.5 / 4.6. A shorter prefix is processed without caching and without an error.
//   - a write costs 1.25x the input price (5 minutes) or 2x (1 hour); a read costs 0.1x (0.05x on Sonnet 5.5). At most 4 markers per request.
//   - a read needs a marker at the end of the prefix that was written; the system looks back up to 20 blocks.
// So a marker pays only when the block is read again before it expires, and a block that changes every few seconds is written again and again.
//
// Layout (see build.ts):
//   system[0]  A      shared rules, profile, brief   same bytes for every role and every call        marker 1 h (every role: a read needs the marker)
//   system[1]  rules  the role's fixed instructions  same bytes for every call of this role          marker 1 h for roles that run often
//   system[2]  B      the call memory                changes with every patch (20 s or more)         marker 5 min for roles that call twice between patches
//   system[3]  data   per-call facts of the role     changes with every call                         no marker
//   messages          the raw tail and the trigger   no marker (optional append-only chunks: see build.ts `tailChunk`)
import type { Role } from "./budget.ts";

export type CachePolicy = {
  /** marker on the role's fixed instructions */
  rules?: "1h" | "5m";
  /** marker on the memory block */
  memory?: "1h" | "5m";
  /** raw transcript lines per cached chunk of the tail (0 = the tail is not cached) */
  tailChunk: number;
};

/** Why each choice (calls per hour from the planned caps; the fixtures in src/e2e/v2-cost.test.ts measure it):
 *  moment, observer   often, several calls between two memory patches -> rules 1 h, memory 5 min.
 *  memory             every 20 s but its own patch changes the memory block before its next call -> rules 1 h, memory never cached (a write nobody reads).
 *  compact            every 6 min -> rules 1 h; the memory block is written once per call, so no marker.
 *  ask, digest, wrapup  on demand, a few per call -> only block A (it is read from the other roles' writes), no marker on rules or memory. */
export const CACHE_POLICY: Record<Role, CachePolicy> = {
  moment: { rules: "1h", memory: "5m", tailChunk: 0 },
  observer: { rules: "1h", memory: "5m", tailChunk: 0 },
  memory: { rules: "1h", tailChunk: 0 },
  compact: { rules: "1h", tailChunk: 0 },
  ask: { tailChunk: 0 },
  digest: { tailChunk: 0 },
  wrapup: { tailChunk: 0 },
};

/** The least number of prompt tokens the provider caches for this model. Infinity = the provider has no prompt cache. Unknown Anthropic models: 1024. */
export function cacheMinTokens(ref: string): number {
  const i = ref.indexOf(":");
  const provider = i > 0 ? ref.slice(0, i).toLowerCase() : "";
  const id = (i > 0 ? ref.slice(i + 1) : ref).toLowerCase();
  if (provider !== "anthropic") return Infinity;
  if (/haiku-4-5|opus-4-6|opus-4-5/.test(id)) return 4096;
  if (/opus-4-7|mythos-preview/.test(id)) return 2048;
  if (/haiku-5|sonnet-5-5|opus-5|fable|mythos-5/.test(id)) return 512;
  if (/sonnet-5|sonnet-4|opus-4/.test(id)) return 1024;
  return 1024;
}

/** Splits a role text into its fixed rules and the per-call data that follows (the facts block and the call frame). Without a marker the whole text is rules. */
const DATA_MARKERS = ["\n\n<call_facts>", "\n\nCall frame ("];
export function splitRoleText(text: string): { rules: string; data: string } {
  let at = -1;
  for (const m of DATA_MARKERS) {
    const k = text.indexOf(m);
    if (k >= 0 && (at < 0 || k < at)) at = k;
  }
  return at < 0 ? { rules: text, data: "" } : { rules: text.slice(0, at), data: text.slice(at).trimStart() };
}
