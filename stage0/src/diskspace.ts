// Free-space check for the calls folder. A call that cannot write loses its transcript and summary, so the engine warns early:
// amber under 500 MB, red under 100 MB (run.ts shows a health bar; the tray turns a red bar into a macOS notification).
import { statfsSync } from "node:fs";

export const DISK_AMBER_BYTES = 500 * 1024 * 1024;
export const DISK_RED_BYTES = 100 * 1024 * 1024;

/** Free bytes for unprivileged users on the volume holding `dir`, or null when it cannot be read (never throws). */
export function freeBytes(dir: string): number | null {
  if (process.env.WINGMAN_FREE_BYTES) return Number(process.env.WINGMAN_FREE_BYTES);   // tests: pretend the disk is nearly full
  try { const s = statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}
/** "ok" | "amber" | "red" for a free-space figure. Unknown (null) is "ok": no false alarm when statfs is unavailable. */
export function diskLevel(bytes: number | null, amber = DISK_AMBER_BYTES, red = DISK_RED_BYTES): "ok" | "amber" | "red" {
  if (bytes === null) return "ok";
  return bytes < red ? "red" : bytes < amber ? "amber" : "ok";
}
/** Hebrew bar text for the health bar. */
export function diskText(level: "amber" | "red", bytes: number): string {
  const mb = Math.max(0, Math.round(bytes / 1024 / 1024));
  return level === "red"
    ? `כמעט אין מקום בדיסק (${mb} MB פנויים). השיחה עלולה לא להישמר. פנה מקום בדיסק עכשיו`
    : `מעט מקום בדיסק (${mb} MB פנויים). פנה מקום כדי שהשיחה והסיכום יישמרו`;
}
