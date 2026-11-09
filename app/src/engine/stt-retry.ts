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

/** wake = skip when the channel is fine (a check after sleep); transient = a failure that can pass; permanent = refused key / no credit (slow schedule, red bar). */
type Mode = "wake" | "transient" | "permanent";
const STRENGTH: Record<Mode, number> = { wake: 0, transient: 1, permanent: 2 };
type Running = { mode: Mode; hooks: RetryHooks };

export class SttRetryRegistry {
  private running = new Map<string, Running>();

  /** Is a loop running for this channel? */
  has(ch: string) {
    return this.running.has(ch);
  }

  /** Runs the loop until the channel reopens or the call stops. A second call for a running channel does not start a second loop. When it is
   *  stronger (wake < transient < permanent) it takes the loop over: its hooks replace the old ones, so a wake-up loop that was only waiting for
   *  `healthy` keeps trying when a real failure arrives, and its `onRecovered` clears what the new request set. A weaker request is ignored. */
  async run(ch: string, h: RetryHooks, permanent = false, firstDelayMs?: number) {
    const mode: Mode = permanent ? "permanent" : h.healthy ? "wake" : "transient";
    const now = this.running.get(ch);
    if (now) {
      if (STRENGTH[mode] > STRENGTH[now.mode]) {
        now.mode = mode;
        now.hooks = { ...now.hooks, ...h, healthy: h.healthy }; // what the new request does not say stays; `healthy` is only for a wake-up loop, so it goes
      }
      return;
    }
    const me: Running = { mode, hooks: h };
    this.running.set(ch, me);
    const sleep = h.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    try {
      for (let n = 0; !me.hooks.stopped(); n++) {
        await sleep(n === 0 && firstDelayMs !== undefined ? firstDelayMs : sttRetryDelayMs(n, me.mode === "permanent", me.hooks.slowMs));
        const cur = me.hooks; // read again: the loop may have been taken over while it slept
        if (cur.stopped()) return;
        if (cur.healthy?.()) return;
        try {
          await cur.reopen();
          me.hooks.onRecovered(n + 1);
          return;
        } catch (e) {
          me.hooks.onFail(n + 1, e as Error);
          if (me.mode !== "permanent" && isPermanentSttError(e as { retryable?: boolean; kind?: string })) {
            me.mode = "permanent";
            me.hooks.onPermanent(e as Error);
          }
        }
      }
    } finally {
      if (this.running.get(ch) === me) this.running.delete(ch);
    }
  }
}
