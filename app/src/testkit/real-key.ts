// The maintainer's real-transport recording (cassette:record, morning) passes the Anthropic key in the environment. src/engine/boot.ts removes
// every key variable from process.env when it is imported, so a worker must read the key BEFORE that import. This module does only that.
// Import it first in a worker, before test-setup.ts (which fills a placeholder) and before anything that can reach boot.ts.
const raw = process.env.ANTHROPIC_API_KEY;

/** The key as it was in the environment at start, or undefined when it was not set. A test placeholder is never a real key. */
export const REAL_ANTHROPIC_KEY: string | undefined = raw && raw !== "test-placeholder-key" ? raw : undefined;
