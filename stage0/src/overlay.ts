// Starts the Electron answer window with the overlay settings (pnpm overlay, and used by call.ts).
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { ROOT, childEnv } from "./env.ts";
import { loadSettingsOrExit, type Settings } from "./settings.ts";
import { fileURLToPath } from "node:url";

export function overlayEnv(s: Settings): NodeJS.ProcessEnv {
  const o = s.overlay;
  return { ...childEnv(process.env), WINGMAN_OVERLAY: JSON.stringify({ enabled: o.enabled, display: o.display, allowPrimary: o.allowPrimary, contentProtection: o.contentProtection, fontPt: o.fontPt, showLastLine: o.showLastLine, rewindSeconds: o.rewindSeconds, maxCards: s.cards.maxOnScreen, hotkeys: o.hotkeys }) };
}
export function spawnOverlay(s: Settings, detached = false): ChildProcess | undefined {
  if (!s.overlay.enabled) { console.log("(overlay.enabled is false: cards go to the terminal and cards.jsonl only)"); return undefined; }
  // stdin is a pipe only so the window can see its parent die (pipe closes even on SIGKILL) and exit instead of being orphaned: overlay/main.cjs, WINGMAN_WATCH_PARENT.
  const p = spawn(join(ROOT, "node_modules", ".bin", "electron"), [join(ROOT, "overlay", "main.cjs")], { cwd: ROOT, stdio: ["pipe", "inherit", "inherit"], env: { ...overlayEnv(s), WINGMAN_WATCH_PARENT: "1" }, detached });
  p.stdin?.on("error", () => {});
  return p;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { settings } = loadSettingsOrExit();
  const p = spawnOverlay(settings);
  p?.on("exit", (c) => process.exit(c ?? 0));
}
