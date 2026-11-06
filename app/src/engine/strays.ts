// Policy for stray errors (uncaught exceptions and unhandled rejections) during a call. Pure, so it can be tested without the engine.
// A live call is never ended for a handful of errors: the transcript and cards keep being recorded. Only a runaway loop ends it.

/** Errors are counted over this window. */
export const STRAY_WINDOW_MS = 60_000;
/** More than this many in the window raises the amber bar (the call goes on). */
export const STRAY_WARN_ABOVE = 3;
/** This many in the window means a loop is spinning: end the call so the saved files stay small and the machine stays usable. */
export const STRAY_RUNAWAY = 200;

export type StrayAction = "crash" | "log" | "warn";

/** Counts errors in a sliding window. */
export function strayCounter() {
  let times: number[] = [];
  return (now: number): number => {
    times = [...times.filter((t) => now - t < STRAY_WINDOW_MS), now];
    return times.length;
  };
}

/** What to do with the latest error. Before the call is live (or while stopping) an error ends it; in a live call it is logged,
 *  with "warn" on the first error past the threshold in a window, and a runaway count ends it. */
export function strayAction(count: number, live: boolean, stopping: boolean): StrayAction {
  if (!live || stopping || count >= STRAY_RUNAWAY) return "crash";
  return count === STRAY_WARN_ABOVE + 1 ? "warn" : "log";
}
