// Virtual clock for tests. A test advances time by hand; timers fire in order, and a 90 s meeting runs in a few ms of real time.
//   const vc = createVClock({ start: 1_700_000_000_000 });
//   vc.install();                 // Date.now, new Date(), performance.now, setTimeout, setInterval, setImmediate and their clear* now follow vc
//   await vc.advance(90_000);     // fires every timer due in the next 90 s, in order, letting promise chains run between timers
//   vc.uninstall();
// advance() is async because code waiting on a timer usually continues in a promise callback; between timers the clock lets those run.
// It does not fake I/O (files, sockets, child processes). Use it for in-process logic: stall timers, pacing, cadence, latency budgets.
import { setClockSource } from "../clock.ts";

type Timer = { id: number; at: number; every?: number; fn: () => void; seq: number };
export type VClock = ReturnType<typeof createVClock>;

const real = {
  Date: globalThis.Date,
  perfNow: performance.now.bind(performance),
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  setImmediate: globalThis.setImmediate,
  clearImmediate: globalThis.clearImmediate,
};

/** Lets pending promise callbacks run (a few turns of the microtask queue). */
const flush = async (turns = 12) => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
  await new Promise<void>((r) => real.setImmediate(r)); // and one real event-loop turn, for code that continues after a macrotask (streams, I/O callbacks)
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

export function createVClock(o: { start?: number } = {}) {
  const wall = o.start ?? 1_700_000_000_000;
  const mono0 = 1000; // performance.now starts at a non-zero value like a real process
  let elapsed = 0;
  let nextId = 1,
    seq = 0;
  const timers = new Map<number, Timer>();
  let installed = false;

  const handle = (id: number) => {
    // Node timers are objects with ref/unref; a number would break code that calls .unref().
    const h = { _vid: id, ref: () => h, unref: () => h, hasRef: () => true, refresh: () => h, [Symbol.toPrimitive]: () => id };
    return h;
  };
  const idOf = (h: unknown): number | undefined => (typeof h === "number" ? h : (h as { _vid?: number } | undefined)?._vid);

  function add(fn: () => void, ms: number, every?: number) {
    const id = nextId++;
    const d = Math.max(0, Number.isFinite(ms) ? ms : 0);
    timers.set(id, { id, at: elapsed + d, every: every === undefined ? undefined : Math.max(1, every), fn, seq: seq++ });
    return handle(id);
  }
  const clear = (h: unknown) => {
    const id = idOf(h);
    if (id !== undefined) timers.delete(id);
  };

  const api = {
    now: () => wall + elapsed,
    perf: () => mono0 + elapsed,
    /** ms advanced since creation */
    elapsed: () => elapsed,
    setTimeout: (fn: (...a: unknown[]) => void, ms = 0, ...args: unknown[]) => add(() => fn(...args), ms),
    clearTimeout: clear,
    setInterval: (fn: (...a: unknown[]) => void, ms = 0, ...args: unknown[]) => add(() => fn(...args), ms, ms),
    clearInterval: clear,
    setImmediate: (fn: (...a: unknown[]) => void, ...args: unknown[]) => add(() => fn(...args), 0),
    clearImmediate: clear,
    /** Number of timers waiting. */
    pending: () => timers.size,
    /** Time of the next timer from now, or undefined. */
    nextIn: () => {
      let min: number | undefined;
      for (const t of timers.values()) min = min === undefined ? t.at - elapsed : Math.min(min, t.at - elapsed);
      return min;
    },
    /** Moves time forward by `ms`, firing every timer that falls due, in time order (ties in creation order). A timer set by a timer is fired too if it falls inside the window. */
    async advance(ms: number) {
      const end = elapsed + Math.max(0, ms);
      await flush();
      for (let guard = 0; guard < 1_000_000; guard++) {
        let next: Timer | undefined;
        for (const t of timers.values()) if (t.at <= end && (!next || t.at < next.at || (t.at === next.at && t.seq < next.seq))) next = t;
        if (!next) break;
        elapsed = Math.max(elapsed, next.at);
        if (next.every !== undefined) {
          next.at = elapsed + next.every;
          next.seq = seq++;
        } else timers.delete(next.id);
        next.fn(); // like Node, an exception in a timer is uncaught and ends the test
        await flush();
      }
      elapsed = end;
      await flush();
    },
    /** Runs timers until none are left or `maxMs` of virtual time has passed (default 1 hour). Intervals never end, so they stop at maxMs. */
    async runAll(maxMs = 3_600_000) {
      const end = elapsed + maxMs;
      while (timers.size) {
        const n = api.nextIn()!;
        if (elapsed + n > end) break;
        await api.advance(n);
      }
    },
    /** Puts the virtual clock on the globals and on the clock.ts seam. */
    install() {
      if (installed) return api;
      installed = true;
      const RealDate = real.Date;
      class VDate extends RealDate {
        constructor(...a: unknown[]) {
          if (a.length === 0) super(api.now());
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- forwarding the Date constructor overloads
          else super(...(a as [any]));
        }
        static override now() {
          return api.now();
        }
      }
      // A Proxy so that Date() called without new still returns a string, as the real Date does (a class would throw).
      globalThis.Date = new Proxy(VDate, { apply: () => new VDate().toString() }) as unknown as DateConstructor;
      performance.now = api.perf;
      globalThis.setTimeout = api.setTimeout as unknown as typeof globalThis.setTimeout;
      globalThis.clearTimeout = api.clearTimeout as unknown as typeof globalThis.clearTimeout;
      globalThis.setInterval = api.setInterval as unknown as typeof globalThis.setInterval;
      globalThis.clearInterval = api.clearInterval as unknown as typeof globalThis.clearInterval;
      globalThis.setImmediate = api.setImmediate as unknown as typeof globalThis.setImmediate;
      globalThis.clearImmediate = api.clearImmediate as unknown as typeof globalThis.clearImmediate;
      setClockSource({ wall: api.now, mono: api.perf });
      return api;
    },
    uninstall() {
      if (!installed) return;
      installed = false;
      globalThis.Date = real.Date;
      performance.now = real.perfNow;
      globalThis.setTimeout = real.setTimeout;
      globalThis.clearTimeout = real.clearTimeout;
      globalThis.setInterval = real.setInterval;
      globalThis.clearInterval = real.clearInterval;
      globalThis.setImmediate = real.setImmediate;
      globalThis.clearImmediate = real.clearImmediate;
      setClockSource(undefined);
    },
  };
  return api;
}

/** Runs `fn` with a virtual clock installed, and always restores the real one. */
export async function withVClock<T>(fn: (vc: VClock) => Promise<T>, o: { start?: number } = {}): Promise<T> {
  const vc = createVClock(o);
  vc.install();
  try {
    return await fn(vc);
  } finally {
    vc.uninstall();
  }
}
/** The real, un-faked timers, for test code that must wait in real time while a virtual clock is installed. */
export const realTimers = { setTimeout: real.setTimeout, clearTimeout: real.clearTimeout, now: () => real.Date.now(), perfNow: real.perfNow };
