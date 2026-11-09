// How the engine modules ask for a stop without importing shutdown.ts. shutdown.ts imports almost every engine module (it has to flush and close
// them all), so a module that imported it back would close an import cycle. They call `lifecycle.shutdown()` here instead; shutdown.ts fills the
// hooks in when it loads (run.ts imports it). Before that the hooks do nothing.

/** Audio source stoppers, run first in shutdown(). */
export const stops: (() => Promise<void>)[] = [];

const stopHooks: (() => void)[] = [];
/** Registers a function that stops a module's own timers and watchers. shutdown() runs them all as soon as Stop begins, so nothing restarts afterwards. */
export function onStop(fn: () => void) {
  stopHooks.push(fn);
}
/** Runs the hooks (once each, a throwing one does not stop the others). Called by shutdown(). */
export function runStopHooks() {
  for (const fn of stopHooks.splice(0)) {
    try {
      fn();
    } catch {
      /* a timer that cannot be cleared must not block the stop */
    }
  }
}

export const lifecycle = {
  /** Stops the call: summary, files, exit. Set by shutdown.ts. */
  shutdown: (async () => {}) as () => Promise<void>,
  /** Skips the post-call summary for this stop. Set by shutdown.ts. */
  skipSummaryNow: (() => {}) as () => void,
};
