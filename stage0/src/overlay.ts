// Starts the Electron answer window with the overlay settings (pnpm overlay, and used by call.ts).
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "./env.ts";
import { loadSettingsOrExit, type Settings } from "./settings.ts";
import { fileURLToPath } from "node:url";

export function overlayEnv(s: Settings): NodeJS.ProcessEnv {
  const o = s.overlay;
  return { ...process.env, WINGMAN_OVERLAY: JSON.stringify({ enabled: o.enabled, display: o.display, allowPrimary: o.allowPrimary, contentProtection: o.contentProtection, fontPt: o.fontPt, rewindSeconds: o.rewindSeconds, maxCards: s.cards.maxOnScreen, hotkeys: o.hotkeys }) };
}
export function spawnOverlay(s: Settings, detached = false): ChildProcess | undefined {
  if (!s.overlay.enabled) { console.log("(overlay.enabled is false: cards go to the terminal and cards.jsonl only)"); return undefined; }
  return spawn(join(ROOT, "node_modules", ".bin", "electron"), [join(ROOT, "overlay", "main.cjs")], { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"], env: overlayEnv(s), detached });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { settings } = loadSettingsOrExit();
  const p = spawnOverlay(settings);
  p?.on("exit", (c) => process.exit(c ?? 0));
}
