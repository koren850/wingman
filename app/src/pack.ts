// The "pack": the business content Wingman answers from (answer bank, house style, keyterms, topic words). It is NOT in the repo:
// look-up order per file is  1. $WINGMAN_PACK_DIR or ~/.config/wingman/pack/   2. the repo's data/example-pack/ (an invented example).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DATA } from "./env.ts";
import YAML from "yaml";
import { escapeRe } from "./text-util.ts";
import { KINDS } from "./session/types.ts";

export const EXAMPLE_PACK = join(DATA, "example-pack");
export const USER_PACK = join(homedir(), ".config", "wingman", "pack");
export const PACK_FILES = ["bank.yaml", "bank.en.yaml", "house-style.md", "keyterms.txt", "topics.txt"] as const;

/** Pack folders in look-up order. */
export const packDirs = (env: NodeJS.ProcessEnv = process.env): string[] => [env.WINGMAN_PACK_DIR || USER_PACK, EXAMPLE_PACK];
/** Path of a pack file: the first folder that has it. Undefined if none does. */
export function packPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return packDirs(env)
    .map((d) => join(d, name))
    .find((f) => existsSync(f));
}
/**
 * Files a user pack lacks while it does have its own bank.yaml: they are filled in from the example pack (invented content) per file.
 * The fallback stays, but doctor shows it so a half-copied pack does not silently mix example text into the user's answers.
 */
export function packMixedIn(env: NodeJS.ProcessEnv = process.env): string[] {
  const user = packDirs(env)[0];
  if (user === EXAMPLE_PACK || !existsSync(join(user, "bank.yaml"))) return [];
  return PACK_FILES.filter((f) => !existsSync(join(user, f)) && existsSync(join(EXAMPLE_PACK, f)));
}
/** Text of a pack file, or "" when no folder has it. */
export function readPack(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const f = packPath(name, env);
  return f ? readFileSync(f, "utf8") : "";
}

export type Topics = { loose: RegExp | undefined; strict: RegExp | undefined };
const compile = (terms: string[]): RegExp | undefined => {
  // "=term" is a whole-word match. \b is ASCII-only in JS (it never sees a Hebrew word edge), so the edges are Unicode letters/digits.
  const parts = terms
    .map((t) => (t.startsWith("=") ? t.slice(1).trim() && `(?<![\\p{L}\\p{N}_])${escapeRe(t.slice(1).trim())}(?![\\p{L}\\p{N}_])` : escapeRe(t)))
    .filter(Boolean);
  return parts.length ? new RegExp(`(${parts.join("|")})`, "iu") : undefined;
};
/**
 * topics.txt: the words that mean "this is about the user's own services". One word or phrase per line, `#` comments.
 * A line starting with `=` matches as a whole word only (`=dns`). Lines under `[strict]` are the unmistakable terms used on supplier / team calls;
 * the loose list is everything above `[strict]` plus the strict terms. No file = no topic words (nothing counts as the user's services).
 */
export function parseTopics(raw: string): Topics {
  const loose: string[] = [],
    strict: string[] = [];
  let into = loose;
  for (const line of raw.split("\n")) {
    const l = line.trim();
    if (!l || l.startsWith("#")) continue;
    if (/^\[strict\]$/i.test(l)) {
      into = strict;
      continue;
    }
    if (/^\[loose\]$/i.test(l)) {
      into = loose;
      continue;
    }
    into.push(l);
  }
  return { loose: compile([...loose, ...strict]), strict: compile(strict) };
}
let topicsCache: { key: string; t: Topics } | undefined;
export function loadTopics(env: NodeJS.ProcessEnv = process.env): Topics {
  const f = packPath("topics.txt", env) ?? "";
  const raw = f ? readFileSync(f, "utf8") : "";
  if (topicsCache?.key === f + raw) return topicsCache.t;
  const t = parseTopics(raw);
  topicsCache = { key: f + raw, t };
  return t;
}

// ---------- custom call modes (modes.yaml) ----------
/** A mode the user wrote in their pack (modes.yaml). It adds text to the moment prompt and can set two numbers. The text is the user's own, but still untrusted. */
export type CustomMode = { id: string; label: string; instructions: string; minValue?: number; maxPerMinute?: number };
export const MAX_CUSTOM_MODES = 6;
export const MAX_MODE_TEXT = 600;
/** Names a custom mode cannot take: the built-in kinds (the list is in session/types.ts) and the control word "auto". */
const builtinModeId = (id: string): boolean => (KINDS as readonly string[]).includes(id) || id === "auto";
/** Plain text for a prompt: control and direction characters out, angle brackets and ampersands escaped, capped (in characters, not bytes). */
const modeText = (x: unknown, max: number): string =>
  Array.from(
    (typeof x === "string" ? x : "")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/[ \t]+/g, " ")
      .trim(),
  )
    .slice(0, max)
    .join("");
/** Reads the text of modes.yaml (a list of { id, label, instructions, minValue?, maxPerMinute? }). A bad entry is skipped, never fatal: at most 6 modes. */
export function parseCustomModes(raw: string): CustomMode[] {
  let doc: unknown;
  try {
    doc = YAML.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(doc)
    ? doc
    : doc && typeof doc === "object" && Array.isArray((doc as { modes?: unknown }).modes)
      ? (doc as { modes: unknown[] }).modes
      : [];
  const out: CustomMode[] = [];
  for (const e of list) {
    if (out.length >= MAX_CUSTOM_MODES) break;
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim().toLowerCase() : "";
    if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(id) || builtinModeId(id) || out.some((m) => m.id === id)) continue;
    const instructions = modeText(o.instructions, MAX_MODE_TEXT);
    if (!instructions) continue;
    const m: CustomMode = { id, label: modeText(o.label, 40).replace(/\s+/g, " ") || id, instructions };
    if (Number.isInteger(o.minValue) && (o.minValue as number) >= 1 && (o.minValue as number) <= 3) m.minValue = o.minValue as number;
    if (Number.isInteger(o.maxPerMinute) && (o.maxPerMinute as number) >= 1 && (o.maxPerMinute as number) <= 6) m.maxPerMinute = o.maxPerMinute as number;
    out.push(m);
  }
  return out;
}
/** The custom modes of the user's pack (no example fallback: an example mode would show up for everyone). Missing or broken file = none. */
export function loadCustomModes(env: NodeJS.ProcessEnv = process.env): CustomMode[] {
  const f = join(packDirs(env)[0], "modes.yaml");
  try {
    return existsSync(f) ? parseCustomModes(readFileSync(f, "utf8")) : [];
  } catch {
    return [];
  }
}
