// The one exit path: stop, post-call summary, deletion question, and the crash / stray-error handling that leads into it.
import { rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { errStack, eventError } from "../errtext.ts";
import bin from "../../shared/bin.cjs";
import { join } from "node:path";
import { childEnv, CALLS, ROOT } from "../env.ts";
import type { Channel } from "../providers/stt/types.ts";
import { sttChain } from "../providers/stt/index.ts";
import { describe, type ProviderError } from "../providers/errors.ts";
import { runSummary, runWrapup, formatShort, backgroundSummaryArgs } from "../summary.ts";
import { errBrief, status, health, healthClear } from "./out.ts";
import { ht } from "../htext.ts";
import { strayCounter, strayAction, STRAY_WINDOW_MS, STRAY_WARN_ABOVE } from "./strays.ts";
import {
  log,
  S,
  profile,
  noAi,
  discard,
  UI_LANG,
  cost,
  tracker,
  ECHO,
  brief,
  sup,
  notesAbort,
  contextNotes,
  speakers,
  transcript,
  registry,
  PROMPT_V,
} from "./boot.ts";
import { st, chans } from "./state.ts";
import { askKey } from "./control.ts";
import { flushMemory, memoryLoop } from "./coach.ts";
import { endCallLearning } from "./moments.ts";
import { engineV2 } from "./memory.ts";
import { speedSummary } from "./cards.ts";
import { uncovered, liveNotes } from "./side.ts";
import { sttSeconds } from "./degrade.ts";
import { pending, meTimers, acceptLate } from "./ingest.ts";
import { meTimers2 } from "./me.ts";
import { killAudioChildren } from "../audio.ts";
import { HARD_EXIT_MS, SUMMARY_BUDGET_MS, lastResortDelayMs } from "./shutdown-deadline.ts";

/** The per-call usage summary row: money, tokens, cache hit %, and the model and prompt ids behind it. */
const summaryRow = () => ({
  role: "summary",
  llmUsd: cost.llmUsd,
  sttUsd: cost.sttUsd,
  totalUsd: cost.totalUsd,
  roles: cost.roles,
  unpriced: [...cost.unpriced],
  cacheHitPct: cost.cacheHitPct(),
  cacheHitPctByRole: cost.cacheHitByRole,
  models: { reflex: S.llm.reflex.model, fallbacks: S.llm.reflex.fallbacks, assist: S.assist.model, notes: S.notes.model, summary: S.summary.model },
  prompt: PROMPT_V,
});

const cacheLine = () => {
  const p = cost.cacheHitPct();
  return p === undefined ? "" : `\nPrompt cache: ${p}% of AI input tokens were cache hits`;
};

/** Audio source stoppers, run first in shutdown(). */
export const stops: (() => Promise<void>)[] = [];

/** Skip the summary for this stop: aborts the model call if it is running, and shutdown() moves on. The call stays saved (write it later with `wingman calls summary <id> --generate`). */
let summarySkipped = false,
  summaryDone = false;
const summaryAbort = new AbortController();
let wakeSkip: () => void = () => {};
const summarySkipWait = new Promise<void>((res) => {
  wakeSkip = res;
});
export function skipSummaryNow() {
  if (summarySkipped) return;
  summarySkipped = true;
  summaryAbort.abort();
  wakeSkip();
  try {
    log.write("events", { type: "summary.skipped", reason: "user" });
  } catch {
    /* best effort */
  }
}
/** Post-call summary: one model call before the "delete this call?" question. Never blocks longer than summary.timeoutMs; errors are logged, not thrown. */
async function postCallSummary() {
  if (summarySkipped) {
    status("summary", { ok: false, skipped: true });
    return;
  }
  try {
    log.write("events", { type: "context.snapshot", contextNotes, aiNotes: liveNotes }); // lets `pnpm summary <id>` rebuild the same input later
    const data = {
      lines: transcript.map((l) => ({ ch: l.ch, text: l.text, ...(l.who ? { who: speakers.name(l.who.spk) ?? `Speaker ${l.who.spk}` } : {}) })),
      contextNotes,
      aiNotes: liveNotes,
      frame: tracker.current,
    };
    // v2: the wrap-up reads the call memory (open loops, follow-up) and the last lines, with no second full pass over the transcript. If it cannot run
    // (no memory, discard, crash, AI off) or cannot save, today's transcript summary below takes over.
    const mem = engineV2(S) ? memoryLoop()?.memory : undefined;
    let r: Awaited<ReturnType<typeof runSummary>> | undefined;
    if (mem) {
      r = await runWrapup({
        dir: log.dir,
        callId: log.id,
        S,
        registry,
        cost,
        noAi,
        signal: summaryAbort.signal,
        discard: discard || st.call.discardNow,
        crashed: st.call.crashed,
        mem,
        lines: data.lines,
        contextNotes,
        write: (stream, row) => log.write(stream, row),
      });
      if (!r.ok && r.skipped !== "user") r = undefined; // no memory, or it could not be saved: today's path (it logs its own skip reason)
    }
    r ??= await runSummary({
      dir: log.dir,
      callId: log.id,
      S,
      registry,
      cost,
      noAi,
      signal: summaryAbort.signal,
      discard: discard || st.call.discardNow,
      crashed: st.call.crashed,
      data,
      write: (stream, row) => log.write(stream, row),
    });
    if (summarySkipped) {
      status("summary", { ok: false, skipped: true });
      return;
    }
    summaryDone = true;
    if (r.skipped) return;
    if (r.ok) console.log(formatShort(r.summary!, UI_LANG));
    else console.log(`\nSummary failed: ${r.error}`);
    status("summary", { ok: r.ok, id: log.id });
  } catch (e) {
    try {
      log.write("events", { type: "summary.error", error: eventError(e) });
    } catch {
      /* best effort: the log itself may be what failed */
    }
  }
}

/** Writes endedAt and phase "ended" to call.json. Safe to call more than once (the last call wins), never throws. */
function markEnded() {
  try {
    log.update({ endedAt: new Date().toISOString(), crashed: st.call.crashed, phase: "ended" });
  } catch {
    /* best effort: the log itself may be what failed */
  }
}
/** The speech-to-text usage row. Written once in the normal path, and by the hard-exit timer when closing hung. */
function writeSttUsage() {
  try {
    cost.setSttSeconds(sttSeconds());
    log.write("usage", {
      role: "stt",
      vendor: chans.them?.provider,
      seconds: { me: chans.me?.audioSeconds, them: chans.them?.audioSeconds },
      bySeconds: sttSeconds(),
      usd: cost.sttUsd,
      dropped: { me: chans.me?.dropped, them: chans.them?.dropped },
      ring: {
        me: { flushedMs: chans.me?.flushedMs, droppedChunks: chans.me?.ringDroppedChunks },
        them: { flushedMs: chans.them?.flushedMs, droppedChunks: chans.them?.ringDroppedChunks },
      },
    });
  } catch {
    /* best effort */
  }
}

/** The one exit path (stop command, Ctrl+C, SIGTERM/SIGHUP, idle stop, file end, crash, rung 5). Idempotent.
 *  Order: abort jobs and timers -> stop audio -> close STT -> write usage + endedAt (phase "ended") -> final frame look -> summary
 *  -> ask about deletion (terminal only) -> process.exit. call.json gets phase "ended" as soon as the call files are written (before the summary);
 *  the tray follows the {ev:"stopphase"} lines for progress. Watchdogs: 10 s force-exit if closing audio/sockets hangs (the mic must not stay open),
 *  16 s last-resort exit overall, counted from the start of shutdown (shutdown-deadline.ts). The tray's own SIGINT (12 s) / SIGKILL (20 s) escalation comes after those. */
export async function shutdown() {
  if (st.call.shuttingDown) return;
  // shuttingDown stops everything that would start something new (cards, questions, notes). `closing` lets the STT finals that are still on their
  // way (the sockets get ~1.5 s to flush) into the transcript and the summary; it ends when the channels are closed.
  st.call.shuttingDown = true;
  st.call.closing = true;
  st.turn.current?.abort();
  notesAbort.abort();
  void flushMemory(); // session.json is on disk before anything slow starts (also on the crash path: crash() calls shutdown())
  endCallLearning(); // the ratings of this call go to learn.json (counts only)
  status("stopphase", { phase: "saving" }); // the app shows: saving, then summary, then done (tray/lib.cjs STOP_PHASES)
  const startedAt = Date.now();
  const shutdownDeadline = startedAt + SUMMARY_BUDGET_MS;
  // The call record first: endedAt and phase "ended" need no audio state, so the hard exit below can never leave call.json at phase "live".
  markEnded();
  const hard = setTimeout(() => {
    console.error("shutdown stuck: forcing exit");
    writeSttUsage(); // the numbers exist even when closing the audio or sockets hung
    markEnded();
    killAudioChildren(); // an ffmpeg that ignores SIGINT must not keep the mic open after we are gone
    process.exit(1);
  }, HARD_EXIT_MS); // a hung audio/socket close must not keep the mic open
  // Last resort, armed now and counted from the start of shutdown (not from when the channels happened to close), so it always lands before the tray's SIGKILL.
  const lastResort = setTimeout(() => process.exit(st.call.crashed ? 1 : 0), lastResortDelayMs(startedAt, Date.now()));
  lastResort.unref();
  for (const [t, r] of [...meTimers]) {
    clearTimeout(t);
    acceptLate(r, true);
  }
  meTimers.clear(); // echo-delayed "me" finals: booked now, not lost
  for (const t of meTimers2) clearTimeout(t);
  meTimers2.clear();
  st.me.current?.abort();
  clearTimeout(st.ask.timer);
  for (const ch of ["me", "them"] as Channel[]) {
    clearTimeout(pending[ch]?.timer);
    delete pending[ch];
  }
  await Promise.all(stops.map((s) => s().catch(() => {}))); // in parallel: two slow sources must not add up (each can take 3 s to drop)
  sup.stop();
  try {
    rmSync(join(log.dir, "live.jsonl"), { force: true });
  } catch {
    /* best effort: interim words are never worth keeping, even if the rest of the shutdown hangs */
  }
  await Promise.all([chans.me?.close(), chans.them?.close()].filter(Boolean)).catch(() => {});
  st.call.closing = false;
  clearTimeout(hard);
  // Budget: the tray sends SIGINT at 12 s and SIGKILL at 20 s after Stop, so the final frame + summary share ~12 s from the start of shutdown.
  // The call files (usage, endedAt) are written FIRST; the frame look and the summary are best effort on top of that.
  const left = () => shutdownDeadline - Date.now();
  try {
    writeSttUsage();
    if (brief?.mustCover?.length) {
      const left = uncovered();
      log.write("events", { type: "mustcover.summary", left });
      if (left.length) console.log(`\nNot covered in this call: ${left.join(", ")}`);
    }
    log.write("events", {
      type: "echo.summary",
      mode: st.echo.mode,
      setting: ECHO.mode,
      gatedSeconds: Math.round(st.echo.gatedMs / 1000),
      echoDropped: st.echo.dropped,
    });
    log.write("events", { type: "foreign.summary", dropped: st.stt.foreignDropped });
    log.write("events", { type: "me.summary", mode: S.assist.answerMe, answers: st.me.shown, questions: st.me.seq });
    if (st.stt.foreignDropped) console.log(`\nDropped ${st.stt.foreignDropped} speech-to-text lines in a foreign script (not Hebrew/English).`);
    log.write("usage", summaryRow());
    const summary = speedSummary();
    log.write("events", { type: "speed.summary", summary });
    log.update({ endedAt: new Date().toISOString(), crashed: st.call.crashed, phase: "ended" });
    console.log(
      `\nSpeakers mode (${st.echo.mode}): mic muted ${Math.round(st.echo.gatedMs / 1000)} s while the client talked · ${st.echo.dropped} echo lines dropped`,
    );
    console.log(
      `\n${summary}\nCost: ${cost.line()} (estimate from settings budget.prices)${cacheLine()}\nSTT chunks dropped (socket not open): me ${chans.me?.dropped ?? 0}, them ${chans.them?.dropped ?? 0}`,
    );
  } catch (e) {
    console.error("call summary failed:", errBrief(e));
    try {
      log.write("events", { type: "shutdown.error", error: errStack(e) });
    } catch {
      /* best effort: the log itself may be what failed */
    }
  }
  // v2: learn the last lines (a few seconds at most) and write session.json for good. The wrap-up below reads it.
  if (!discard && !st.call.discardNow) {
    let memTimer: NodeJS.Timeout | undefined;
    await Promise.race([flushMemory(Math.max(0, Math.min(3000, left() - 8000))), new Promise((res) => (memTimer = setTimeout(res, 3500)))]).catch(() => {});
    clearTimeout(memTimer);
  } else await flushMemory(0).catch(() => {});
  // (usage was logged twice on purpose: once above so the numbers exist even if the summary hangs, again below with the summary's own cost.)
  status("stopphase", { phase: "summary" });
  await Promise.race([postCallSummary(), summarySkipWait, new Promise((res) => setTimeout(res, Math.max(1500, left())))]);
  if (summarySkipped) status("summary", { ok: false, skipped: true });
  try {
    log.write("usage", summaryRow());
  } catch {
    /* best effort: the call files were already written above */
  }
  try {
    log.update({ endedAt: new Date().toISOString(), crashed: st.call.crashed, phase: "ended" });
  } catch {
    /* best effort: the call files were already written above */
  }
  let del = discard || st.call.discardNow;
  if (!del && !st.call.crashed && process.stdin.isTTY) {
    process.stdout.write("\nDelete this call's saved text now? y = delete, any other key (or 10 s) = keep: ");
    del = (await askKey(10_000)).toLowerCase() === "y";
  }
  // The call folder lost rows (vanished, disk full): keep the whole transcript from memory in a rescue folder and say so.
  let rescued: string | undefined;
  if (!del && log.degraded) {
    const text =
      transcript.map((l) => `${l.who ? (speakers.name(l.who.spk) ?? `Speaker ${l.who.spk}`) : l.ch === "me" ? "me" : "them"}: ${l.text}`).join("\n") + "\n";
    rescued = log.rescue(text);
    log.update({ writeFailures: log.writeFailures, ...(rescued ? { rescueDir: rescued } : {}) });
    console.log(
      rescued
        ? `\n⚠️ Some of this call could not be saved in its folder. A copy of the transcript is in ${rescued}`
        : "\n⚠️ Some of this call could not be saved, and no rescue copy could be written either.",
    );
  }
  if (del) {
    try {
      rmSync(log.dir, { recursive: true, force: true });
      if (!existsSync(join(CALLS, "latest"))) rmSync(join(CALLS, "latest"), { force: true });
    } catch {
      /* best effort: a folder that cannot be deleted is left for `pnpm purge` */
    }
    console.log(`\nDeleted ${log.dir}`);
  } else {
    // `pnpm demo` runs in a temporary folder that it deletes, so the hint would point nowhere.
    if (process.env.WINGMAN_DEMO !== "1") console.log(`\nSaved ${log.dir}\nRate the cards: pnpm tag · delete later: pnpm purge ${log.id}`);
    // A long call's summary does not fit the ~12 s stop budget (a 70-minute call ended with no summary). It is finished by a separate
    // background process that outlives this one (same code as `wingman calls summary <id> --generate`).
    if (!summaryDone && !summarySkipped && !st.call.crashed && !noAi && S.summary.enabled) {
      summaryAbort.abort();
      try {
        const t = bin.binCommand("tsx", backgroundSummaryArgs(ROOT, log.id, profile), ROOT);
        spawn(t.cmd, t.args, { cwd: ROOT, detached: true, stdio: "ignore", env: childEnv() })
          .on("error", () => {})
          .unref();
        log.write("events", { type: "summary.background" });
        status("summary", { ok: false, background: true, id: log.id });
      } catch {
        /* the user can still run: wingman calls summary <id> --generate */
      }
    }
  }
  if (!del)
    try {
      rmSync(join(log.dir, "live.jsonl"), { force: true });
    } catch {
      /* best effort */
    }
  status("stopphase", { phase: "done" });
  status("ended", {
    id: log.id,
    deleted: del,
    crashed: st.call.crashed,
    ...(log.degraded ? { writeFailures: log.writeFailures, saveFailed: true, rescued: rescued ?? null } : {}),
  });
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  } catch {
    /* best effort: stdin may not be a terminal any more */
  }
  process.exit(st.call.crashed ? 1 : 0);
}
/** Last-resort exit after a crash: just after shutdown()'s own 16 s limit. */
export const CRASH_EXIT_MS = 17_000;
/** Fatal error path: print, log, then shut down in order to save what we have (crashed=true lands in call.json). A second crash during shutdown is noted and never exits here: the 10 s and 16 s guards of shutdown() do that. */
export function crash(kind: string, e: unknown) {
  if (kind === "main" && (e as ProviderError)?.kind)
    console.error(
      `\n🔴 ${describe(e as ProviderError)} – ${(e as Error).message}\n   (providers: stt ${sttChain(S).join(" -> ")}; fix the key/credit or set stt.fallback; pnpm run doctor checks all of them)`,
    );
  else console.error(`\n🔴 ${kind}: ${errBrief(e)}`);
  try {
    log.write("events", { type: "crash", kind, error: errStack(e) });
  } catch {
    /* best effort: the log may be unwritable; the crash is printed above */
  }
  if (st.call.shuttingDown) {
    // A second failure while stopping: note it, never exit here. shutdown() has its own 10 s and 16 s guards and has already written the call record.
    st.call.crashed = true;
    return;
  }
  st.call.crashed = true;
  // Same budget as a normal stop (shutdown() has its own 10 s and 16 s exits): a 5 s limit here cut the save when two sources were slow to stop.
  setTimeout(() => process.exit(1), CRASH_EXIT_MS).unref(); // never hang on a broken shutdown
  void shutdown();
}
// During a live call stray errors must not end the call: log them and keep listening and recording. Repeated errors (more than 3 in a minute)
// raise an amber bar; only a runaway loop (strays.ts) or an error before the call is live ends it, through crash(), which saves everything first.
const countStray = strayCounter();
let strayBarTimer: NodeJS.Timeout | undefined;
function stray(kind: string, e: unknown) {
  const count = countStray(Date.now());
  const action = strayAction(count, st.call.consented, st.call.shuttingDown);
  if (action === "crash") {
    crash(kind, e);
    return;
  }
  try {
    log.write("events", { type: "error.survived", kind, count, error: errStack(e) });
  } catch {
    /* best effort: the log may be unwritable; the error is printed below */
  }
  console.error(`\n⚠️ ${kind} (call continues): ${errBrief(e)}`);
  if (count > STRAY_WARN_ABOVE) {
    try {
      if (action === "warn") health("stray-errors", "amber", ht(UI_LANG, "strays"));
      clearTimeout(strayBarTimer);
      strayBarTimer = setTimeout(() => healthClear("stray-errors"), STRAY_WINDOW_MS);
      strayBarTimer.unref();
    } catch {
      /* best effort: the bar is only a hint */
    }
  }
}
/** Registers the crash and signal handlers (once, at startup). */
export function installProcessHandlers() {
  // Test hooks (e2e only): WINGMAN_TEST_CRASH_MS=<ms> crashes the call that long after start; WINGMAN_TEST_SLOW_STOPS=<n>x<ms> adds n sources that take <ms> to stop; WINGMAN_TEST_STRAY_AT_STOP=1 raises a stray rejection at stop.
  const slow = /^(\d+)x(\d+)$/.exec(process.env.WINGMAN_TEST_SLOW_STOPS ?? "");
  if (slow) for (let i = 0; i < Number(slow[1]); i++) stops.push(() => new Promise<void>((r) => setTimeout(r, Number(slow[2]))));
  // WINGMAN_TEST_STRAY_AT_STOP=1 raises an unhandled rejection while the sources are being stopped (a late socket error or aborted model call).
  if (process.env.WINGMAN_TEST_STRAY_AT_STOP === "1")
    stops.push(async () => {
      setTimeout(() => void Promise.reject(new Error("injected stray at stop")), 20);
    });
  const crashMs = Number(process.env.WINGMAN_TEST_CRASH_MS);
  if (crashMs > 0) setTimeout(() => crash("test", new Error("injected crash")), crashMs).unref();
  process.on("uncaughtException", (e) => stray("uncaughtException", e));
  process.on("unhandledRejection", (e) => stray("unhandledRejection", e));
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGHUP", () => void shutdown());
}
