// Loads API keys from ~/.config/wingman/keys.env (never from the repo). Process env wins over the file.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const KEYS_FILE = join(homedir(), ".config", "wingman", "keys.env");
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DATA = join(ROOT, "data");
export const CALLS = join(ROOT, "calls");

/** provider id -> env var holding its key. */
export const KEY_VARS = {
  anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", google: "GOOGLE_GENERATIVE_AI_API_KEY",
  mistral: "MISTRAL_API_KEY", groq: "GROQ_API_KEY",
  deepgram: "DEEPGRAM_API_KEY", soniox: "SONIOX_API_KEY", gladia: "GLADIA_API_KEY",
} as const;
export type KeyName = keyof typeof KEY_VARS;
export type Keys = Partial<Record<KeyName, string>>;

export function parseKeysFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2]) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

export function loadKeys(file = KEYS_FILE, env: NodeJS.ProcessEnv = process.env): Keys {
  const fromFile = existsSync(file) ? parseKeysFile(readFileSync(file, "utf8")) : {};
  const keys: Keys = {};
  for (const [name, v] of Object.entries(KEY_VARS)) { const val = env[v]?.trim() || fromFile[v]; if (val) keys[name as KeyName] = val; }
  return keys;
}

export function requireKeys<K extends KeyName>(which: K[], file = KEYS_FILE) {
  const k = loadKeys(file);
  const missing = which.filter((w) => !k[w]);
  if (missing.length) {
    console.error(`Missing key(s): ${missing.map((m) => KEY_VARS[m]).join(", ")}. Add them to ${file}`);
    process.exit(2);
  }
  return k as Record<K, string> & Keys;
}

/** Template comment for a new keys.env (values are never printed by Wingman). */
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
