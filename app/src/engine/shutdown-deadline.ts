// One clock for the whole shutdown. The tray sends SIGINT at 12 s and SIGKILL at 20 s after Stop, so every limit below is counted from the START of
// shutdown, never from the moment an earlier step happened to finish.

/** Closing audio and sockets may take this long before the process exits at once (the mic must not stay open). */
export const HARD_EXIT_MS = 10_000;
/** The final frame look and the summary share this long. */
export const SUMMARY_BUDGET_MS = 12_000;
/** Exit no matter what, counted from the start of shutdown. Under the tray's SIGKILL at 20 s. */
export const LAST_RESORT_MS = 16_000;
/** The tray kills the engine's process group this long after Stop. */
export const TRAY_SIGKILL_MS = 20_000;

/** Delay for the last-resort exit timer when it is armed at `now` and shutdown started at `startedAt`. Never later than LAST_RESORT_MS after the start. */
export function lastResortDelayMs(startedAt: number, now: number): number {
  return Math.max(1000, startedAt + LAST_RESORT_MS - now);
}
