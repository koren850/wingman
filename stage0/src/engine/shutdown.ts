// The one exit path: stop, post-call summary, deletion question, and the crash / stray-error handling that leads into it.
import { rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import bin from "../../shared/bin.cjs";
import { join } from "node:path";
import { childEnv, CALLS, ROOT } from "../env.ts";
import type { Channel } from "../providers/stt/types.ts";
import { sttChain } from "../providers/stt/index.ts";
import { describe, type ProviderError } from "../providers/errors.ts";
import { runSummary, formatShort, backgroundSummaryArgs } from "../summary.ts";
import { progress, missedMust } from "../frame.ts";
import { errBrief, status } from "./out.ts";
import { log, S, profile, noAi, discard, cost, tracker, frameOn, ECHO, brief, sup, notesAbort, contextNotes, speakers, transcript, registry } from "./boot.ts";
import { st, chans } from "./state.ts";
import { askKey } from "./control.ts";
import { frameRound } from "./coach.ts";
import { speedSummary } from "./cards.ts";
import { uncovered, liveNotes } from "./side.ts";
import { sttSeconds } from "./degrade.ts";
import { pending, meTimers } from "./ingest.ts";
import { meTimers2 } from "./me.ts";

/** Audio source stoppers, run first in shutdown(). */
export const stops: (() => Promise<void>)[] = [];

/** Skip the summary for this stop: aborts the model call if it is running, and shutdown() moves on. The call stays saved (write it later with `wingman calls summary <id> --generate`). */
let summarySkipped = false, summaryDone = false;
const summaryAbort = new AbortController();
let wakeSkip: () => void = () => {};
const summarySkipWait = new Promise<void>((res) => { wakeSkip = res; });
export function skipSummaryNow() {
  if (summarySkipped) return;
  summarySkipped = true; summaryAbort.abort(); wakeSkip();
  try { log.write("events", { type: "summary.skipped", reason: "user" }); } catch { /* best effort */ }
}
/** Post-call summary: one model call before the "delete this call?" question. Never blocks longer than summary.timeoutMs; errors are logged, not thrown. */
async function postCallSummary() {
  if (summarySkipped) { status("summary", { ok: false, skipped: true }); return; }
  try {
    log.write("events", { type: "context.snapshot", contextNotes, aiNotes: liveNotes });   // lets `pnpm summary <id>` rebuild the same input later
    const r = await runSummary({
      dir: log.dir, callId: log.id, S, registry, cost, noAi, signal: summaryAbort.signal, discard: discard || st.call.discardNow, crashed: st.call.crashed,
      data: { lines: transcript.map((l) => ({ ch: l.ch, text: l.text, ...(l.who ? { who: speakers.name(l.who.spk) ?? `Speaker ${l.who.spk}` } : {}) })), contextNotes, aiNotes: liveNotes, frame: tracker.current },
      write: (stream, row) => log.write(stream, row),
    });
    if (summarySkipped) { status("summary", { ok: false, skipped: true }); return; }
    summaryDone = true;
    if (r.skipped) return;
    if (r.ok) console.log(formatShort(r.summary!)); else console.log(`\nSummary failed: ${r.error}`);
    status("summary", { ok: r.ok, id: log.id });
  } catch (e) { try { log.write("events", { type: "summary.error", error: String((e as Error)?.message ?? e) }); } catch { /* best effort: the log itself may be what failed */ } }
}

/** The one exit path (stop command, Ctrl+C, SIGTERM/SIGHUP, idle stop, file end, crash, rung 5). Idempotent.
 *  Order: abort jobs and timers -> stop audio -> close STT -> write usage + endedAt (phase "ended") -> final frame look -> summary
 *  -> ask about deletion (terminal only) -> process.exit. call.json gets phase "ended" as soon as the call files are written (before the summary);
 *  the tray follows the {ev:"stopphase"} lines for progress. Watchdogs: 10 s force-exit if closing audio/sockets hangs (the mic must not stay open),
 *  16 s last-resort exit overall. The tray's own SIGINT (12 s) / SIGKILL (20 s) escalation comes after those. */
export async function shutdown() {
  if (st.call.shuttingDown) return;
  st.call.shuttingDown = true; st.turn.current?.abort(); notesAbort.abort();
  status("stopphase", { phase: "saving" });   // the app shows: saving, then summary, then done (tray/lib.cjs STOP_PHASES)
  const shutdownDeadline = Date.now() + 12_000;
  const hard = setTimeout(() => { console.error("shutdown stuck: forcing exit"); process.exit(1); }, 10_000);   // a hung audio/socket close must not keep the mic open
  for (const t of meTimers) clearTimeout(t); meTimers.clear();
  for (const t of meTimers2) clearTimeout(t); meTimers2.clear(); st.me.current?.abort(); clearTimeout(st.ask.timer);
  for (const ch of ["me", "them"] as Channel[]) { clearTimeout(pending[ch]?.timer); delete pending[ch]; }
  for (const s of stops) await s().catch(() => {});
  sup.stop();
  try { rmSync(join(log.dir, "live.jsonl"), { force: true }); } catch { /* best effort: interim words are never worth keeping, even if the rest of the shutdown hangs */ }
  await Promise.all([chans.me?.close(), chans.them?.close()].filter(Boolean)).catch(() => {});
  clearTimeout(hard);
  setTimeout(() => process.exit(st.call.crashed ? 1 : 0), 16_000).unref();   // last resort, before the tray's SIGKILL at 20 s (files are already written)
  // Budget: the tray sends SIGINT at 12 s and SIGKILL at 20 s after Stop, so the final frame + summary share ~12 s from the start of shutdown.
  // The call files (usage, endedAt) are written FIRST; the frame look and the summary are best effort on top of that.
  const left = () => shutdownDeadline - Date.now();
  try {
    cost.setSttSeconds(sttSeconds());
    log.write("usage", { role: "stt", vendor: chans.them?.provider, seconds: { me: chans.me?.audioSeconds, them: chans.them?.audioSeconds }, bySeconds: sttSeconds(), usd: cost.sttUsd, dropped: { me: chans.me?.dropped, them: chans.them?.dropped } });
    if (brief?.mustCover?.length) { const left = uncovered(); log.write("events", { type: "mustcover.summary", left }); if (left.length) console.log(`\nNot covered in this call: ${left.join(", ")}`); }
    log.write("events", { type: "echo.summary", mode: st.echo.mode, setting: ECHO.mode, gatedSeconds: Math.round(st.echo.gatedMs / 1000), echoDropped: st.echo.dropped });
    log.write("events", { type: "foreign.summary", dropped: st.stt.foreignDropped });
    log.write("events", { type: "me.summary", mode: S.assist.answerMe, answers: st.me.shown, questions: st.me.seq });
    if (st.stt.foreignDropped) console.log(`\nDropped ${st.stt.foreignDropped} speech-to-text lines in a foreign script (not Hebrew/English).`);
    log.write("usage", { role: "summary", llmUsd: cost.llmUsd, sttUsd: cost.sttUsd, totalUsd: cost.totalUsd, roles: cost.roles, unpriced: [...cost.unpriced] });
    const summary = speedSummary();
    log.write("events", { type: "speed.summary", summary });
    log.update({ endedAt: new Date().toISOString(), crashed: st.call.crashed, phase: "ended" });
    console.log(`\nSpeakers mode (${st.echo.mode}): mic muted ${Math.round(st.echo.gatedMs / 1000)} s while the client talked · ${st.echo.dropped} echo lines dropped`);
    console.log(`\n${summary}\nCost: ${cost.line()} (estimate from settings budget.prices)\nSTT chunks dropped (socket not open): me ${chans.me?.dropped ?? 0}, them ${chans.them?.dropped ?? 0}`);
  } catch (e) { console.error("call summary failed:", errBrief(e)); try { log.write("events", { type: "shutdown.error", error: String((e as Error)?.stack ?? e) }); } catch { /* best effort: the log itself may be what failed */ } }
  // (usage was logged twice on purpose: once above so the numbers exist even if the summary hangs, again below with the summary's own cost.)
  // One last frame look so the checklist result in the review is current (a few seconds at most, never when the call is discarded or crashed).
  if (frameOn && left() > 6000 && !st.call.crashed && !discard && !st.call.discardNow && cost.llmState() !== "capped") {
    await Promise.race([frameRound(true), new Promise((res) => setTimeout(res, Math.min(S.frame.timeoutMs + 500, left() - 5000)))]).catch(() => {});
    const f = tracker.current;
    if (f) log.write("events", { type: "frame.summary", kind: f.kind, done: progress(f).done, total: progress(f).total, missed: missedMust(f).map((m) => m.item) });
  }
  status("stopphase", { phase: "summary" });
  await Promise.race([postCallSummary(), summarySkipWait, new Promise((res) => setTimeout(res, Math.max(1500, left())))]);
  if (summarySkipped) status("summary", { ok: false, skipped: true });
  try { log.write("usage", { role: "summary", llmUsd: cost.llmUsd, sttUsd: cost.sttUsd, totalUsd: cost.totalUsd, roles: cost.roles, unpriced: [...cost.unpriced] }); } catch { /* best effort: the call files were already written above */ }
  try { log.update({ endedAt: new Date().toISOString(), crashed: st.call.crashed, phase: "ended" }); } catch { /* best effort: the call files were already written above */ }
  let del = discard || st.call.discardNow;
  if (!del && !st.call.crashed && process.stdin.isTTY) {
    process.stdout.write("\nDelete this call's saved text now? y = delete, any other key (or 10 s) = keep: ");
    del = (await askKey(10_000)).toLowerCase() === "y";
  }
  if (del) {
    try { rmSync(log.dir, { recursive: true, force: true }); if (!existsSync(join(CALLS, "latest"))) rmSync(join(CALLS, "latest"), { force: true }); } catch { /* best effort: a folder that cannot be deleted is left for `pnpm purge` */ }
    console.log(`\nDeleted ${log.dir}`);
  } else {
    console.log(`\nSaved ${log.dir}\nRate the cards: pnpm tag · delete later: pnpm purge ${log.id}`);
    // A long call's summary does not fit the ~12 s stop budget (a 70-minute call ended with no summary). It is finished by a separate
    // background process that outlives this one (same code as `wingman calls summary <id> --generate`).
    if (!summaryDone && !summarySkipped && !st.call.crashed && !noAi && S.summary.enabled) {
      summaryAbort.abort();
      try {
        const t = bin.binCommand("tsx", backgroundSummaryArgs(ROOT, log.id, profile), ROOT);
        spawn(t.cmd, t.args, { cwd: ROOT, detached: true, stdio: "ignore", env: childEnv() }).on("error", () => {}).unref();
        log.write("events", { type: "summary.background" });
        status("summary", { ok: false, background: true, id: log.id });
      } catch { /* the user can still run: wingman calls summary <id> --generate */ }
    }
  }
  if (!del) try { rmSync(join(log.dir, "live.jsonl"), { force: true }); } catch { /* best effort */ }
  status("stopphase", { phase: "done" });
  status("ended", { id: log.id, deleted: del, crashed: st.call.crashed });
  try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { /* best effort: stdin may not be a terminal any more */ }
  process.exit(st.call.crashed ? 1 : 0);
}
/** Fatal error path: print, log, then shut down in order to save what we have (crashed=true lands in call.json). A second crash during shutdown exits at once. */
export function crash(kind: string, e: unknown) {
  if (kind === "main" && (e as ProviderError)?.kind) console.error(`\n🔴 ${describe(e as ProviderError)} – ${(e as Error).message}\n   (providers: stt ${sttChain(S).join(" -> ")}; fix the key/credit or set stt.fallback; pnpm run doctor checks all of them)`);
  else console.error(`\n🔴 ${kind}: ${errBrief(e)}`);
  try { log.write("events", { type: "crash", kind, error: String((e as Error)?.stack ?? e) }); } catch { /* best effort: the log may be unwritable; the crash is printed above */ }
  if (st.call.shuttingDown) process.exit(1);
  st.call.crashed = true;
  setTimeout(() => process.exit(1), 5000).unref(); // never hang on a broken shutdown
  void shutdown();
}
// During a live call one stray error must not end the call: log it and keep listening. Only repeated errors (more than 3 in a
// minute) or an error before the call is live end it.
let strayErrors: number[] = [];
function stray(kind: string, e: unknown) {
  const now = Date.now();
  strayErrors = [...strayErrors.filter((t) => now - t < 60_000), now];
  if (!st.call.consented || st.call.shuttingDown || strayErrors.length > 3) { crash(kind, e); return; }
  try { log.write("events", { type: "error.survived", kind, error: String((e as Error)?.stack ?? e).slice(0, 2000) }); } catch { /* best effort: the log may be unwritable; the error is printed below */ }
  console.error(`\n⚠️ ${kind} (call continues): ${errBrief(e)}`);
}
/** Registers the crash and signal handlers (once, at startup). */
export function installProcessHandlers() {
  process.on("uncaughtException", (e) => stray("uncaughtException", e));
  process.on("unhandledRejection", (e) => stray("unhandledRejection", e));
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGHUP", () => void shutdown());
}
