// Starts the Electron answer window (overlay/main.cjs) with the overlay settings (pnpm overlay, and used by call.ts).
// Settings travel to the window as one JSON env var, WINGMAN_OVERLAY. The window finds the call through calls/latest.
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { ROOT, childEnv } from "./env.ts";
import { loadSettingsOrExit, resolveUiLanguage, type Settings } from "./settings.ts";
import { fileURLToPath } from "node:url";
import bin from "../shared/bin.cjs";

/** Child environment for the window: childEnv() (no API keys) plus WINGMAN_OVERLAY with the overlay settings as JSON. */
export function overlayEnv(s: Settings): NodeJS.ProcessEnv {
  const o = s.overlay;
  return {
    ...childEnv(process.env),
    WINGMAN_OVERLAY: JSON.stringify({
      enabled: o.enabled,
      display: o.display,
      allowPrimary: o.allowPrimary,
      contentProtection: o.contentProtection,
      layout: o.layout,
      fontPt: o.fontPt,
      language: resolveUiLanguage(s),
      showLastLine: o.showLastLine,
      liveTextPt: o.liveTextPt,
      rewindSeconds: o.rewindSeconds,
      maxCards: s.cards.maxOnScreen,
      hotkeys: o.hotkeys,
    }),
  };
}
/** Spawns the window. Returns undefined when overlay.enabled is false. `detached` lets it outlive Ctrl+C for a short grace period (call.ts). */
export function spawnOverlay(s: Settings, detached = false): ChildProcess | undefined {
  if (!s.overlay.enabled) {
    console.log("(overlay.enabled is false: cards go to the terminal and cards.jsonl only)");
    return undefined;
  }
  // stdin is a pipe only so the window can see its parent die (pipe closes even on SIGKILL) and exit instead of being orphaned: overlay/main.cjs, WINGMAN_WATCH_PARENT.
  const t = bin.binCommand("electron", [join(ROOT, "overlay", "main.cjs")], ROOT);
  const p = spawn(t.cmd, t.args, { cwd: ROOT, stdio: ["pipe", "inherit", "inherit"], env: { ...overlayEnv(s), WINGMAN_WATCH_PARENT: "1" }, detached });
  p.stdin?.on("error", () => {});
  return p;
}
// Run directly (pnpm overlay): start the window alone and exit when it exits.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { settings } = loadSettingsOrExit();
  const p = spawnOverlay(settings);
  p?.on("exit", (c) => process.exit(c ?? 0));
}
