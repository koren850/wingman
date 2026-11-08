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

/** What to do with the latest error. Always: log it and count it, "warn" on the first error past the threshold in a window.
 *  Only a runaway count ends the call, and never while it is stopping: Stop aborts model calls and closes sockets, which is exactly when a late
 *  rejection or socket error shows up, and the stop sequence has its own 10 s and 16 s guards. Before the call is live (waiting for consent) an
 *  error is survived the same way: both sockets are open and idle then, and one network hiccup must not end the waiting session.
 *  (`live` is kept in the signature for callers and tests; it no longer changes the answer.) */
export function strayAction(count: number, _live: boolean, stopping: boolean): StrayAction {
  if (!stopping && count >= STRAY_RUNAWAY) return "crash";
  return count === STRAY_WARN_ABOVE + 1 ? "warn" : "log";
}
