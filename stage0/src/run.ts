// Wingman Stage 0: live (system audio + mic) or --file <stereo.wav> (L = me, R = them).
//   pnpm start                 live call (listening starts at once; with "Ask me before listening starts" on, press Enter first and nothing is sent before that)
//   pnpm start --file x.wav    replay a recording in real time
//   pnpm start --no-ai         Prepared cards only (no AI)
//   pnpm start --discard       delete the call folder when the call ends
//   Keys while running: Enter = start listening (only when it is waiting) · q = Quiet mode on/off (cards saved, not shown)
//                       n = type a context note for the AI ("this is about the shop migration"), Enter to add · Ctrl+C = stop
//   WINGMAN_CONTROL=1         remote control for the menu-bar app: line commands on stdin (consent = Start listening, quiet, client, ask, note <text>, stop)
//                             and "@@wingman {json}" status lines on stdout (starting/waiting/consented, ask, mode, stopphase, ended...).
//                             call.json in the call folder also gets phase ("starting"|"waiting"|"live"|"ended") and liveAt for the answer window.
//
// Main flow (one process = one call; the code lives in src/engine/, see the map below):
//   audio (audio.ts: mic -> "me", system tap -> "them") -> SttChannel per side (providers/stt) -> onResult/acceptResult
//   -> per-channel buffer, joined on speech_final or a fallback timer (flush) -> "them": question detector (detector.ts),
//   split/merge fixes, then onQuestion: prepared bank card at once, stall line after reflex.stallAfterMs, Claude reflex
//   answer streamed in behind it (reflex.ts) -> emitCard -> cards.jsonl (the answer window tails it).
//   "me" finals go to handleMe: only the user's own questions to Wingman (ask key, or a detected question) get a "me" card.
// Side jobs on timers: notes (notesRound), call frame + tips (frameRound/tipsTick), must-cover reminders, health tick.
// State is module-level on purpose: one call per process. Everything async checks `shuttingDown` before it writes.
//
// Safety and cost:
//   - Nothing is sent for transcription until `consented` (immediately, or after "Start listening" when privacy.requireConsentAck is on).
//   - AI text passes guards.ts (no prices, dates, promises); a hit becomes a stall line.
//   - budget.maxUsdPerCall: at "capped" (cost.llmState) every model job (reflex, notes, frame, tips, me) stops; prepared cards still work.
//   - budget.idleStopMin: a call with no speech stops itself. STT minutes only warn.
//
// IPC contract with the tray app (WINGMAN_CONTROL=1):
//   stdin  lines: consent | quiet [on|off] | client | ask [text] | note <text> | stop | stop-no-summary | skip-summary | stop-delete
//   stdout "@@wingman {json}" lines. Stop sequence: {ev:"stopphase",phase:"saving"} -> "summary" -> "done", then {ev:"ended"}.
//   The tray escalates a stop with SIGINT at 12 s and SIGKILL at 20 s, so shutdown() finishes inside that.
//
// Engine map (src/engine/):
//   boot.ts      settings, keys, brief, prepared bank, call log: everything read once at start
//   state.ts     the mutable state several modules share (st), and the two STT channels (chans)
//   out.ts       "@@wingman" status lines, health bars, error helpers (errBrief, safe, survived)
//   cards.ts     the single exit for cards (cap, quiet mode, dedupe) and the latency rows
//   ingest.ts    STT results -> echo drop, transcript, per-channel buffer, flush into questions
//   question.ts  a question from the other side: prepared bank, stall line, Claude reflex, guards
//   me.ts        answers for the user's own questions (ask key, typed ask)
//   side.ts, coach.ts, flowmode.ts, selfcheck.ts   fact cards, notes, reminders; call frame and tips; several voices; self-check cards
//   stt.ts, audio-sources.ts, watchdogs.ts          STT channels and retry loops; mic and system audio; silence watchdogs
//   degrade.ts   reflex model health, the degrade ladder, the health tick
//   consent.ts, control.ts, shutdown.ts             start listening; keys and tray commands; stop, summary, crash handling
import { fileArg, noAi, log, sup, brief, spotter, snapshot, bank, discard, S, ECHO } from "./engine/boot.ts";
import { setPhase, status, health, safe } from "./engine/out.ts";
import { crash, installProcessHandlers } from "./engine/shutdown.ts";
import { createChannels, openBothChannels, wireChannels } from "./engine/stt.ts";
import { resolveReflexModels, startHealthTick, checkDisk } from "./engine/degrade.ts";
import { notesRound, reminderTick } from "./engine/side.ts";
import { frameRound, tipsTick } from "./engine/coach.ts";
import { flowTick } from "./engine/flowmode.ts";
import { startConsent } from "./engine/consent.ts";
import { startFileSource, startLiveSources } from "./engine/audio-sources.ts";

// A card row that cannot be saved (disk full) still raises the health bar; the call goes on.
log.onWriteFail = (e) => { try { health("disk", "amber", "לא ניתן לשמור את השיחה בדיסק (אין מקום?). השיחה ממשיכה, אבל ההקלטה והסיכום עלולים להיות חלקיים. פנה מקום בדיסק", String(e?.message ?? e)); } catch { /* best effort: the bar itself needs the log */ } };
setPhase("starting");
status("mode", { noAi });   // effective AI mode for the app (the setting or --no-ai)
installProcessHandlers();

/** Timer jobs (all unref'd: they never keep the process alive on their own). */
function startTimers() {
  startHealthTick();
  setInterval(safe("notes", notesRound), S.notes.everyMs).unref();
  setInterval(safe("frame", () => frameRound()), 5000).unref();
  setInterval(safe("tips", tipsTick), 5000).unref();
  setInterval(safe("reminders", reminderTick), 30_000).unref();
  setInterval(safe("flow", flowTick), 5000).unref();
}

/** What the terminal shows once the call is set up. */
function printStartup() {
  if (brief?.planId) log.write("events", { type: "plan.used", planId: brief.planId, title: brief.title ?? "" });   // which prepared meeting this call used (ids and names only)
  if (brief) console.log(`Brief loaded: ${[brief.who, brief.goal].filter(Boolean).join(" · ") || "(notes only)"}${brief.mustCover?.length ? ` · must cover: ${brief.mustCover.join(", ")}` : ""}`);
  console.log(spotter ? `Fact cards: ${spotter.size.clients} clients, ${spotter.size.domains} domains (snapshot ${snapshot?.generatedAt?.slice(0, 10) ?? "?"})` : "Fact cards: off (no snapshot at facts.file)");
}
function printBanner() {
  console.log(`Wingman Stage 0 · call ${log.id} · ${fileArg ? "file " + fileArg : "live"} · ${bank.length} prepared cards${noAi ? " · prepared only" : ""}${discard ? " · --discard" : ""}`);
  console.log(`Cards also go to ${log.dir}/cards.jsonl (run "pnpm overlay" for the second-screen window). Keys: Enter = start listening (when waiting) · q = Quiet mode · a = ask Wingman · n = add a note for the AI · y = confirm the proposed client · Ctrl+C = stop.`);
  console.log(`Speakers mode: ${ECHO.mode} (audio.echo.mode; "filter" is best with headphones) · capture box ${S.capture.enabled ? "on" : "off"}`);
}

/** Startup: open both STT channels, start timers, wire STT events to health bars, handle consent, then start the audio sources (or the replay file). */
async function main() {
  createChannels();
  await resolveReflexModels();
  await openBothChannels();
  startTimers();
  printStartup();
  checkDisk(true);
  sup.tick();
  wireChannels();
  printBanner();
  startConsent();
  if (fileArg) await startFileSource(fileArg); else await startLiveSources();
}

main().catch((e) => crash("main", e));
