// Reflex model health (circuit breakers), the degrade ladder wiring, and the health tick: sleep detection, idle auto-stop, disk space, cost and call-length warnings.
import { ConfigError } from "../providers/llm.ts";
import { CALLS } from "../env.ts";
import { describe, type ProviderError } from "../providers/errors.ts";
import { detectGap } from "../clock.ts";
import { freeBytes, diskLevel, diskText } from "../diskspace.ts";
import { describeRung, type Rung } from "../health.ts";
import { ht } from "../htext.ts";
import { shutdown } from "./shutdown.ts";
import { health, healthClear, status, safe } from "./out.ts";
import {
  sup,
  log,
  cost,
  fileArg,
  S,
  ORPHAN_IDLE_MIN,
  REFLEX_MODELS,
  noAi,
  downUntil,
  breakers,
  registry,
  UI_LANG,
  PHONE,
  keyterms,
  momentsV2,
} from "./boot.ts";
import { sttSwitchedCh, sttRetryLoop } from "./stt.ts";
import { st, mono, chans } from "./state.ts";
import { liveSources } from "./audio-sources.ts";
import { llmFailurePolicy, pausedReason } from "./rules.ts";
import { aiPaused } from "./strings.ts";

/** Models whose breaker lets a request through, in configured order. `reserve` (only right before a real request) takes the
 *  half-open probe slot; status checks leave it free, or the health tick would use it up and the model could never recover. */
export function usableModels(reserve = false): string[] {
  const now = Date.now();
  return REFLEX_MODELS.filter((m) => (downUntil.get(m) ?? 0) <= now && (reserve ? breakers.get(m)!.allow() : breakers.get(m)!.peek()));
}
/** Reflex failure hook: opens the model's circuit breaker (hard = auth/quota/spend cap/unsupported opens it for longer), parks a spend-capped model for 6 h, tells the supervisor, shows a bar for hard errors. */
export function llmFailed(model: string, err: ProviderError) {
  st.m.lastFailKind = err.kind;
  const { hard, parkMs, noteTrouble } = llmFailurePolicy(err.kind);
  breakers.get(model)?.failure(hard);
  if (parkMs) downUntil.set(model, Date.now() + parkMs);
  if (hard) sup.noteLlmHard();
  if (noteTrouble) sup.noteLlmTrouble();
  log.write("events", { type: "llm.error", model, kind: err.kind, retryable: err.retryable, switchProvider: err.switchProvider, status: err.status });
  if (hard) {
    aiBars.add(model);
    health(`ai-${model}`, "red", ht(UI_LANG, "ai.hard", { err: describe(err), bankOnly: REFLEX_MODELS.length > 1 ? "" : "1" }));
  }
  refreshSignals();
}
/** Models whose hard-error bar ("AI authentication failed") is on screen. */
const aiBars = new Set<string>();
/** An answer from `model` worked again (a top-up, a new key, a half-open breaker that closed): its red bar goes. */
export function clearAiBar(model: string) {
  if (aiBars.delete(model)) healthClear(`ai-${model}`);
}

/** The v2 moment engine (live reading) drives this call: the setting is v2 and there is an AI. A practice interview is included: it has its own coaching mode (moments/modes.ts). */
export const v2Active = () => momentsV2;
/** Why the AI is paused right now, or undefined: the spend cap (per call or per hour), no usable model, or no network (the last failures were network errors). */
export function currentPause() {
  return pausedReason({ noAi, usable: usableModels().length, llmAllowed: sup.caps.llm, costPaused: cost.paused(), lastFailKind: st.m.lastFailKind });
}
/** Shows or clears the calm "AI paused" bar when the reason changes. Part of every refresh of the health signals. */
export function syncPaused(): void {
  if (!v2Active() || st.call.shuttingDown) return;
  const why = currentPause();
  if (why === st.m.paused) return;
  st.m.paused = why;
  log.write("events", { type: why ? "ai.paused" : "ai.resumed", why });
  if (why) health("ai-paused", "info", aiPaused(why));
  else healthClear("ai-paused");
}

/** Push the current facts to the supervisor (called every tick and after events). */
export function refreshSignals() {
  const usable = usableModels();
  sup.set({
    llmDown: !noAi && usable.length === 0,
    llmOnFallback: usable.length > 0 && usable[0] !== REFLEX_MODELS[0],
    costCapped: cost.llmState() === "capped",
  });
  syncPaused();
}
/** Audio seconds sent per STT provider, both channels summed. Cost input. */
export const sttSeconds = () => {
  const out: Record<string, number> = {};
  for (const c of [chans.me, chans.them]) for (const [k, v] of Object.entries(c?.audioSecondsByProvider() ?? {})) out[k] = (out[k] ?? 0) + v;
  return out;
};
/** Audio seconds that ran with add-ons, per provider: speaker labels on the channels that ask for them, keyterms on both channels when terms are sent. Cost input. */
export const sttAddonSeconds = () => {
  const out: Record<string, { diarize: number; keyterms: number }> = {};
  for (const [name, c] of [
    ["me", chans.me],
    ["them", chans.them],
  ] as const)
    for (const [k, v] of Object.entries(c?.audioSecondsByProvider() ?? {})) {
      const o = (out[k] ??= { diarize: 0, keyterms: 0 });
      if ((name === "them" && S.stt.speakers) || (PHONE && name === "me")) o.diarize += v;
      if (S.stt.keyterms.enabled !== "off" && keyterms.length > 0) o.keyterms += v;
    }
  return out;
};
let costWarned = false,
  totalWarned = false,
  minutesWarned = false;
/** Free-space check of the calls folder (at start and every 15 s): amber < 500 MB, red < 100 MB. The red bar also becomes a macOS notification (tray). */
let diskShown: "ok" | "amber" | "red" = "ok",
  diskAt = -Infinity;
export function checkDisk(force = false) {
  const m = mono();
  if (!force && m - diskAt < 15_000) return;
  diskAt = m;
  const b = freeBytes(CALLS),
    lvl = diskLevel(b);
  if (lvl === diskShown) return;
  diskShown = lvl;
  log.write("events", { type: "disk.free", level: lvl, mb: b === null ? null : Math.round(b / 1024 / 1024) });
  if (lvl === "ok") healthClear("disk-space");
  else health("disk-space", lvl, diskText(lvl, b ?? 0, UI_LANG));
}

/** After a sleep gap: timers that count silence start again, both audio sources are rebuilt (they may be dead after wake) and both STT sockets reopened. */
function onWake(gapMs: number) {
  log.write("events", { type: "sleep.gap", ms: gapMs });
  health("sleep", "amber", ht(UI_LANG, "sleep", { sec: Math.round(gapMs / 1000) }));
  sleepClearAt = Date.now() + 20_000;
  const m = mono();
  st.voice.lastSpeechMono = m;
  st.call.consentedMono = m;
  st.voice.lastSysFrame = m;
  st.voice.lastThemSound = Date.now();
  st.voice.lastThemText = Date.now();
  if (idleWarned) {
    idleWarned = false;
    healthClear("idle");
  }
  if (fileArg || st.call.shuttingDown) return;
  for (const src of liveSources) src.restart("wake");
  for (const [s, ch] of [
    [chans.me, "me"],
    [chans.them, "them"],
  ] as const)
    if (s) void sttRetryLoop(s, ch, false, 0, true); // a healthy socket is left alone
  log.write("events", { type: "wake.recover" });
}
/** Every health.tickMs: sleep detection, idle auto-stop, ladder signals, cost and call-length warnings, then the supervisor tick. */
let lastTick = Date.now(),
  lastTickMono = mono(),
  sleepClearAt = 0,
  idleWarned = false;
export function tickHealth() {
  if (st.call.shuttingDown) return; // during the summary no health card (cost, disk, idle) may land after phase "ended"
  // Y2: a long gap between ticks means the Mac slept (lid closed) mid-call. Wall time and monotonic time are compared, so a clock that is set
  // backwards is not mistaken for anything, and a sleep never counts as "nobody spoke" (idle time is monotonic).
  const now = Date.now(),
    m = mono();
  const g = detectGap({ wall: lastTick, mono: lastTickMono }, { wall: now, mono: m }, S.system.sleepGapMs ?? 0, S.health.tickMs);
  lastTick = now;
  lastTickMono = m;
  if (g.kind === "sleep") onWake(g.ms);
  else if (g.kind === "clock-back") log.write("events", { type: "clock.jump", backMs: g.ms });
  else if (sleepClearAt && now > sleepClearAt) {
    sleepClearAt = 0;
    healthClear("sleep");
  }
  checkDisk();
  // A call left running with nobody talking stops itself (a long real meeting is never cut while people speak).
  const idleMin = st.call.orphaned ? ORPHAN_IDLE_MIN : S.budget.idleStopMin;
  if (idleMin > 0 && st.call.consented && !fileArg && !st.call.shuttingDown) {
    if (!st.call.consentedMono) st.call.consentedMono = m;
    const idle = m - Math.max(st.voice.lastSpeechMono, st.call.consentedMono);
    if (idle >= idleMin * 60_000) {
      log.write("events", { type: "idle.stop", minutes: idleMin, orphaned: st.call.orphaned });
      console.log(`\nNobody spoke for ${idleMin} minutes: stopping the call.`);
      void shutdown();
    } else if (idle >= Math.max(1, idleMin - 2) * 60_000 && !idleWarned) {
      idleWarned = true;
      health("idle", "amber", ht(UI_LANG, "idle", { min: Math.round(idle / 60_000) }));
    } else if (idleWarned && idle < 60_000) {
      idleWarned = false;
      healthClear("idle");
    }
  }
  refreshSignals();
  cost.setSttSeconds(sttSeconds(), [chans.me, chans.them].filter(Boolean).length);
  cost.setSttAddonSeconds(sttAddonSeconds());
  sup.set({ sttOnFallback: sttSwitchedCh.size > 0 });
  const costState = cost.llmState();
  if (costState === "warn" && !costWarned) {
    costWarned = true;
    health("cost", "amber", ht(UI_LANG, "cost.ai", { line: cost.line() }));
    log.write("events", { type: "cost.warn", line: cost.line() });
  }
  if (cost.totalState() === "warn" && !totalWarned) {
    totalWarned = true;
    health("spend", "amber", ht(UI_LANG, "cost.total", { limit: S.budget.warnUsdPerCall, line: cost.line() }));
    log.write("events", { type: "cost.total-warn", line: cost.line(), limit: S.budget.warnUsdPerCall });
  }
  if (cost.minutesState() !== "ok" && !minutesWarned) {
    minutesWarned = true;
    health("minutes", "amber", ht(UI_LANG, "minutes", { min: cost.sttMinutes.toFixed(0) }));
  }
  sup.tick();
}
/** Ladder change handler: log it, show/clear the "ladder" bar, and at rung 5 (everything down) stop the call. */
export function renderRung({ from, to, reasons }: { from: Rung; to: Rung; reasons: string[] }) {
  log.write("events", { type: "ladder", from, to, reasons, idle: sup.idle });
  const d = describeRung(to, reasons, sup.userChoiceOnly, UI_LANG);
  if (from !== to) console.log(`\n⇅ ladder: rung ${from} -> ${to} (${reasons.join(", ") || "recovered"})`);
  if (!d) healthClear("ladder");
  else health("ladder", d.level, d.text);
  if (to === 5) {
    console.log("Wingman is OFF: " + reasons.join(", "));
    status("off", { reasons });
    void shutdown();
  }
}

/** Startup check: every reflex model must load. A broken first model is fatal unless fallbacks exist; a broken fallback is parked for the whole call. */
export async function resolveReflexModels() {
  for (const m of REFLEX_MODELS)
    if (!noAi) {
      try {
        await registry.resolve(m);
      } catch (e) {
        if (m === REFLEX_MODELS[0] && !(e instanceof ConfigError && REFLEX_MODELS.length > 1)) throw e;
        console.log(`⚠ AI model ${m}: ${(e as Error).message}`);
        downUntil.set(m, Infinity);
      }
    }
}

/** Starts the ladder supervisor and the health tick (every health.tickMs). The timer is unref'd: it never keeps the process alive on its own. */
export function startHealthTick() {
  sup.on("rung", renderRung);
  sup.start();
  lastTick = Date.now();
  lastTickMono = mono();
  setInterval(safe("health tick", tickHealth), S.health.tickMs).unref();
}
