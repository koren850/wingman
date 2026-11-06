// Paths (ROOT, DATA, CALLS) and API-key loading. Order: process env, then macOS Keychain, then the legacy
// ~/.config/wingman/keys.env (never from the repo). Keys are held in memory only; run.ts also deletes them from process.env
// so child processes (ffmpeg, audiotee) cannot inherit them.
import { readFileSync, existsSync, statSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import paths from "../shared/paths.cjs";
import migrate from "../shared/migrate.cjs";
import { realKeychain, ACCOUNTS, type Keychain } from "./keychain.ts";
export { childEnv } from "./keychain.ts";

export const KEYS_FILE = join(homedir(), ".config", "wingman", "keys.env");
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Shipped data only (example-pack, demo, test, gold, synthetic). The user's own data is in USER_DATA. */
export const DATA = join(ROOT, "data");
/** The user's data folder (shared/paths.cjs): ~/Library/Application Support/Wingman, or WINGMAN_DATA_DIR. */
export const USER_DATA: string = paths.dataDir();
/** WINGMAN_CALLS_DIR redirects only the call folder (the synthetic QA harness writes to qa/calls/, never into the user's real calls). */
export const CALLS: string = paths.callsDir();
/** Prepared meetings (plans) and their background files; WINGMAN_BRIEFS_DIR redirects it. */
export const BRIEFS: string = paths.briefsDir();
export const ENTITIES_FILE: string = paths.entitiesFile();
/** A path from settings: "data/private/x" means USER_DATA/x, "~/" the home folder, other relative paths are relative to stage0. */
export const resolveUserPath = (p: string): string => paths.resolveUserPath(p);
// One-time copy of data from the old in-repo folders (stage0/calls, stage0/data/private) to USER_DATA. Skipped when tests/QA redirect the data.
const migration = migrate.ensureUserData({});
export { migration };

/** provider id -> env var holding its key. */
export const KEY_VARS = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
  deepgram: "DEEPGRAM_API_KEY",
  soniox: "SONIOX_API_KEY",
  gladia: "GLADIA_API_KEY",
} as const;
export type KeyName = keyof typeof KEY_VARS;
export type Keys = Partial<Record<KeyName, string>>;

/** Parses KEY=value lines of keys.env (optional quotes). Empty values and other lines are ignored. */
export function parseKeysFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2])
      out[m[1]] = m[2]
        .trim()
        .replace(/^["']|["']$/g, "")
        .trim();
  }
  return out;
}

/** The keys file must be readable by its owner only. Too-open permissions are fixed (chmod 600) and reported once per process. */
let permsChecked = false;
export function securePerms(file: string, platform: string = process.platform): "ok" | "fixed" | "missing" {
  if (!existsSync(file)) return "missing";
  if (platform === "win32") return "ok"; // no POSIX mode bits on Windows: the file is protected by the user profile's access list
  const mode = statSync(file).mode & 0o777;
  if ((mode & 0o077) === 0) return "ok";
  chmodSync(file, 0o600);
  if (!permsChecked) console.error(`⚠ ${file} was readable by other users (mode ${mode.toString(8)}): fixed to 600.`);
  permsChecked = true;
  return "fixed";
}

/** Where each loaded key came from (never the value). */
export type KeySources = Partial<Record<KeyName, "env" | "keychain" | "file">>;

/** Order: process env, then the macOS Keychain (Deepgram + Anthropic only), then keys.env (legacy fallback). Keys live in memory only.
 *  `keychain` is opt-in: null (default) means no Keychain lookup, so tests and tools that pass a file never reach the real one. */
export function loadKeysWithSources(
  file = KEYS_FILE,
  env: NodeJS.ProcessEnv = process.env,
  keychain: Keychain | null = null,
): { keys: Keys; sources: KeySources } {
  try {
    securePerms(file);
  } catch {
    /* read-only file system: loading still works */
  }
  const fromFile = existsSync(file) ? parseKeysFile(readFileSync(file, "utf8")) : {};
  const keys: Keys = {},
    sources: KeySources = {};
  for (const [name, v] of Object.entries(KEY_VARS)) {
    const n = name as KeyName;
    let val = env[v]?.trim(),
      src: "env" | "keychain" | "file" = "env";
    if (!val && keychain && n in ACCOUNTS) {
      try {
        val = keychain.get(n as "deepgram" | "anthropic") || undefined;
      } catch {
        val = undefined;
      }
      src = "keychain";
    }
    if (!val && fromFile[v]) {
      val = fromFile[v];
      src = "file";
    }
    if (val) {
      keys[n] = val;
      sources[n] = src;
    }
  }
  return { keys, sources };
}
/** Same as loadKeysWithSources, keys only. */
export function loadKeys(file = KEYS_FILE, env: NodeJS.ProcessEnv = process.env, keychain: Keychain | null = null): Keys {
  return loadKeysWithSources(file, env, keychain).keys;
}

/** Loads keys and exits the process with code 2 and a clear message when any of `which` is missing. Uses the real Keychain by default. */
export function requireKeys<K extends KeyName>(which: K[], file = KEYS_FILE, keychain: Keychain | null = realKeychain()) {
  const k = loadKeys(file, process.env, keychain);
  const missing = which.filter((w) => !k[w]);
  if (missing.length) {
    console.error(
      `Missing key(s): ${missing.map((m) => KEY_VARS[m]).join(", ")}. Save them in Wingman: Settings → Keys (or pnpm keys set <provider>). Legacy fallback: ${file}`,
    );
    process.exit(2);
  }
  return k as Record<K, string> & Keys;
}

/** Template text for a new keys.env (values are never printed by Wingman). Not referenced anywhere in the repo at the moment. */
export const KEYS_TEMPLATE = `# Wingman keys. Paste each key after the =  (file mode must be 600)
DEEPGRAM_API_KEY=
ANTHROPIC_API_KEY=
# Optional providers (only the ones named in settings stt.provider / stt.fallback / llm.reflex.*):
# SONIOX_API_KEY=            (stt.provider: soniox, experimental)
# GLADIA_API_KEY=            (stt.provider: gladia, experimental)
# OPENAI_API_KEY=            (llm model "openai:...", needs: pnpm add @ai-sdk/openai)
# GOOGLE_GENERATIVE_AI_API_KEY=   (llm model "google:...", needs: pnpm add @ai-sdk/google)
# MISTRAL_API_KEY=  GROQ_API_KEY=
`;
