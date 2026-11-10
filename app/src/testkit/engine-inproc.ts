// Runs the real engine modules (engine/ingest.ts, question.ts, moments.ts ...) inside the test process, on the virtual clock and the policy fake model.
// The engine is a module singleton (one call per process), so a test file that uses this helper holds ONE engine; tests inside it call reset() between cases.
// Import this file first, call setupEngine() once, then feed lines. Nothing here touches the network, keys or audio.
import { createVClock, type VClock } from "./vclock.ts";
import { policyModel, type PolicyModel } from "./policy-model.ts";
import type { SttResult } from "../providers/stt/types.ts";

export type CardRow = Record<string, unknown> & { t: number; id: string; type: string };
export type Engine = Awaited<ReturnType<typeof setupEngine>>;

/** `sets` are `--set key=value` overrides for the engine settings (moments.engine=v2 is always on). */
export async function setupEngine(sets: Record<string, string | number | boolean> = {}) {
  const base: Record<string, string | number | boolean> = { "moments.engine": "v2", "reflex.stall": true, "llm.reflex.model": "scripted:policy", ...sets };
  process.argv.push("--profile", "e2e-policy", "--no-brief");
  for (const [k, v] of Object.entries(base)) process.argv.push("--set", `${k}=${v}`);
  const boot = await import("../engine/boot.ts");
  const ingest = await import("../engine/ingest.ts");
  const state = await import("../engine/state.ts");
  const moments = await import("../engine/moments.ts");
  const observer = await import("../engine/moments-observer.ts");
  const question = await import("../engine/question.ts");
  const sched = await import("../moments/scheduler.ts");
  const vc: VClock = createVClock({ start: 1_800_000_000_000 });
  vc.install();
  boot.restartCallClock(); // callStart was read from the real clock at import
  const pm: PolicyModel = policyModel({ strict: false, fallback: "SKIP" });
  boot.registry.resolve = (async () => pm.model) as never; // every ref resolves to the policy fake; the call's role travels in providerOptions.wingman.role
  // Objects built at import time hold the real clock (default argument `Date.now`). Give the breakers and the supervisor the virtual one.
  const { CircuitBreaker } = await import("../health.ts");
  for (const m of boot.REFLEX_MODELS)
    boot.breakers.set(
      m,
      new CircuitBreaker({ failures: boot.S.llm.circuit.failures, windowMs: 10_000, cooldownMs: boot.S.llm.circuit.cooldownMs }, () => Date.now()),
    );
  (boot.sup as unknown as { now: () => number }).now = () => Date.now();
  const rows: CardRow[] = [];
  boot.log.onCardRow = (row) => void rows.push({ ...(row as CardRow), t: Date.now() });
  state.st.call.consented = true;
  state.st.call.quiet = false;

  const e = {
    vc,
    pm,
    rows,
    boot,
    st: state.st,
    moments,
    /** The observer path (engine/moments-observer.ts): noteLine, topicChanged, ... */
    observer,
    question,
    /** A final line. `side` them = the other side. Returns the wall time it was fed at. */
    say(side: "me" | "them", text: string): number {
      const now = Date.now();
      ingest.onResult({ channel: side, text, isFinal: true, speechFinal: true, words: [], arrivedAt: now, speechEndWall: now } as SttResult);
      return now;
    },
    /** Cards on screen by id (updates merged, withdrawn removed), in order of first appearance. */
    screen(): CardRow[] {
      const by = new Map<string, CardRow>();
      for (const r of rows) {
        if (r.type !== "card" || r.health || r.hidden) continue;
        if (r.withdraw) by.delete(r.id);
        else by.set(r.id, { ...(by.get(r.id) ?? {}), ...r });
      }
      return [...by.values()];
    },
    /** First time (ms after `from`) a card that is still on screen at the end was emitted. */
    firstCardMs(from: number): number | undefined {
      const ids = new Set(e.screen().map((c) => c.id));
      const r = rows.find((x) => x.type === "card" && ids.has(x.id) && x.t >= from);
      return r ? r.t - from : undefined;
    },
    /** A fresh call state between tests: scheduler, memory, observer, turn counters. Moves the clock past the novelty and hero windows. */
    async reset(advanceMs = 200_000) {
      await vc.advance(advanceMs);
      rows.length = 0;
      pm.reset();
      pm.setUsage({ input: 3000, output: 60, cacheRead: 2500 });
      state.st.m.sched = sched.newSchedulerState();
      state.st.m.mem = (await import("../session/types.ts")).emptyMemory();
      state.st.m.promised.clear();
      state.st.m.lastPromiseAt = 0;
      state.st.m.paused = undefined;
      state.st.m.lastFailKind = undefined;
      state.st.q.bankShownAt.clear();
      state.st.q.reflexErrors = 0;
      state.st.voice.lastMeVoiced = 0;
      state.st.turn.current?.abort();
      for (const m of boot.REFLEX_MODELS)
        boot.breakers.set(
          m,
          new CircuitBreaker({ failures: boot.S.llm.circuit.failures, windowMs: 10_000, cooldownMs: boot.S.llm.circuit.cooldownMs }, () => Date.now()),
        );
      // The supervisor keeps its own memory of slow and failed calls (hysteresis). A new case starts from rung 0.
      Object.assign(boot.sup, { rung: 0, reasons: [], betterSince: null, tags: [], lags: [], troubleUntil: 0, llmHard: false, busy: 0 });
      boot.sup.set({ llmSlow: false, llmTrouble: false, llmDown: false, llmOnFallback: false, costCapped: false });
      boot.downUntil.clear();
      (boot.cost as unknown as { spend: unknown[] }).spend = []; // the rolling hourly spend
      boot.transcript.length = 0;
      moments._resetMoments();
      observer.resetObserver();
    },
    stop() {
      vc.uninstall();
    },
  };
  return e;
}
