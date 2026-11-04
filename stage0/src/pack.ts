// The "pack": the business content Wingman answers from (answer bank, house style, keyterms, topic words). It is NOT in the repo:
// look-up order per file is  1. $WINGMAN_PACK_DIR or ~/.config/wingman/pack/   2. the repo's data/example-pack/ (an invented example).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DATA } from "./env.ts";

export const EXAMPLE_PACK = join(DATA, "example-pack");
export const USER_PACK = join(homedir(), ".config", "wingman", "pack");
export const PACK_FILES = ["bank.yaml", "bank.en.yaml", "house-style.md", "keyterms.txt", "topics.txt"] as const;

/** Pack folders in look-up order. */
export const packDirs = (env: NodeJS.ProcessEnv = process.env): string[] => [env.WINGMAN_PACK_DIR || USER_PACK, EXAMPLE_PACK];
/** Path of a pack file: the first folder that has it. Undefined if none does. */
export function packPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return packDirs(env).map((d) => join(d, name)).find((f) => existsSync(f));
}
/** Text of a pack file, or "" when no folder has it. */
export function readPack(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const f = packPath(name, env);
  return f ? readFileSync(f, "utf8") : "";
}

export type Topics = { loose: RegExp | undefined; strict: RegExp | undefined };
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const compile = (terms: string[]): RegExp | undefined => {
  const parts = terms.map((t) => (t.startsWith("=") ? `\\b${escapeRe(t.slice(1).trim())}\\b` : escapeRe(t))).filter((p) => p !== "\\b\\b");
  return parts.length ? new RegExp(`(${parts.join("|")})`, "i") : undefined;
};
/**
 * topics.txt: the words that mean "this is about the user's own services". One word or phrase per line, `#` comments.
 * A line starting with `=` matches as a whole word only (`=dns`). Lines under `[strict]` are the unmistakable terms used on supplier / team calls;
 * the loose list is everything above `[strict]` plus the strict terms. No file = no topic words (nothing counts as the user's services).
 */
export function parseTopics(raw: string): Topics {
  const loose: string[] = [], strict: string[] = []; let into = loose;
  for (const line of raw.split("\n")) {
    const l = line.trim();
    if (!l || l.startsWith("#")) continue;
    if (/^\[strict\]$/i.test(l)) { into = strict; continue; }
    if (/^\[loose\]$/i.test(l)) { into = loose; continue; }
    into.push(l);
  }
  return { loose: compile([...loose, ...strict]), strict: compile(strict) };
}
let topicsCache: { key: string; t: Topics } | undefined;
export function loadTopics(env: NodeJS.ProcessEnv = process.env): Topics {
  const f = packPath("topics.txt", env) ?? "";
  const raw = f ? readFileSync(f, "utf8") : "";
  if (topicsCache?.key === f + raw) return topicsCache.t;
  const t = parseTopics(raw); topicsCache = { key: f + raw, t }; return t;
}
