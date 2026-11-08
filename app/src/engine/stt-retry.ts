// The reopen loop of a speech-to-text channel that has no fallback left (used by engine/stt.ts). Free of engine state so a test can drive it.
// One loop per channel. A permanent error (refused key, no credit) that arrives while a transient loop is already running upgrades that loop
// to the slow schedule and the permanent bar; it does not start a second loop.
import { sttRetryDelayMs, isPermanentSttError } from "../health.ts";

export type RetryHooks = {
  reopen: () => Promise<void>;
  stopped: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** True when the channel is open and fine: a wake-up reopen is then skipped, so finals still in flight on the old socket are not dropped. */
  healthy?: () => boolean;
  slowMs: number;
  onPermanent: (e: Error) => void;
  onFail: (n: number, e: Error) => void;
  onRecovered: (attempts: number) => void;
};

export class SttRetryRegistry {
  private running = new Set<string>();
  private upgraded = new Set<string>();

  /** Is a loop running for this channel? */
  has(ch: string) {
    return this.running.has(ch);
  }

  /** Runs the loop until the channel reopens or the call stops. A second call for a running channel only upgrades it (when `permanent`). */
  async run(ch: string, h: RetryHooks, permanent = false, firstDelayMs?: number) {
    if (this.running.has(ch)) {
      if (permanent) this.upgraded.add(ch);
      return;
    }
    this.running.add(ch);
    const sleep = h.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    try {
      for (let n = 0; !h.stopped(); n++) {
        if (!permanent && this.upgraded.has(ch)) permanent = true;
        await sleep(n === 0 && firstDelayMs !== undefined ? firstDelayMs : sttRetryDelayMs(n, permanent, h.slowMs));
        if (h.stopped()) return;
        if (h.healthy?.()) return;
        try {
          await h.reopen();
          h.onRecovered(n + 1);
          return;
        } catch (e) {
          h.onFail(n + 1, e as Error);
          if (!permanent && isPermanentSttError(e as { retryable?: boolean; kind?: string })) {
            permanent = true;
            h.onPermanent(e as Error);
          }
        }
      }
    } finally {
      this.running.delete(ch);
      this.upgraded.delete(ch);
    }
  }
}
