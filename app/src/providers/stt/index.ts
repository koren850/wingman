// STT registry: provider id -> adapter. Add a provider by writing an adapter and listing it here.
// Callers: src/run.ts (builds an SttChannel per channel from sttChain) and src/doctor.ts.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Settings } from "../../settings.ts";
import { APP_DIR, expandHome } from "../../settings.ts";
import { packPath } from "../../pack.ts";
import { deepgram } from "./deepgram.ts";
import { soniox } from "./soniox.ts";
import { gladia } from "./gladia.ts";
import { script } from "../scripted.ts";
import type { SttProvider } from "./types.ts";

/** All adapters, including the offline "script" double. */
export const STT_PROVIDERS: Record<string, SttProvider> = { deepgram, soniox, gladia, script };
/** Adapter by id. Throws with the list of valid ids. */
export function getSttProvider(id: string): SttProvider {
  const p = STT_PROVIDERS[id];
  if (!p) throw new Error(`Unknown STT provider "${id}". Available: ${Object.keys(STT_PROVIDERS).join(", ")}`);
  return p;
}
/** Primary then fallbacks, without duplicates. */
export function sttChain(s: Settings): string[] {
  return [...new Set([s.stt.provider, ...s.stt.fallback])];
}

/** Keyterms per settings (stt.keyterms.enabled / file / max). One term per line; missing file = none. */
export function loadKeyterms(s: Settings): string[] {
  if (s.stt.keyterms.enabled === "off") return [];
  const f = s.stt.keyterms.file ? resolve(APP_DIR, expandHome(s.stt.keyterms.file)) : packPath("keyterms.txt"); // empty setting = the pack's list; relative = from the app folder, absolute and ~/ as written
  if (!f || !existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, s.stt.keyterms.max);
}
export type { SttProvider, SttStreamLike, SttResult, SttOptions, Word, Channel } from "./types.ts";
