// How the engine modules ask for a stop without importing shutdown.ts. shutdown.ts imports almost every engine module (it has to flush and close
// them all), so a module that imported it back would close an import cycle. They call `lifecycle.shutdown()` here instead; shutdown.ts fills the
// hooks in when it loads (run.ts imports it). Before that the hooks do nothing.

/** Audio source stoppers, run first in shutdown(). */
export const stops: (() => Promise<void>)[] = [];

export const lifecycle = {
  /** Stops the call: summary, files, exit. Set by shutdown.ts. */
  shutdown: (async () => {}) as () => Promise<void>,
  /** Skips the post-call summary for this stop. Set by shutdown.ts. */
  skipSummaryNow: (() => {}) as () => void,
};
