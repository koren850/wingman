// Wingman engine entry point: one process = one call (live audio, or --file <stereo.wav> with L = me, R = them).
//   pnpm start                 live call      pnpm start --file x.wav   replay a recording in real time
//   pnpm start --no-ai         prepared cards only      pnpm start --discard   delete the call folder when it ends
// The tray app drives this process with WINGMAN_CONTROL=1 (line commands on stdin, "@@wingman {json}" lines on stdout).
// This file only wires the modules in src/engine/ together; the engine map and data flow are in docs/ARCHITECTURE.md,
// the tray IPC contract is at the top of engine/control.ts. State is module-level on purpose (one call per process); everything async checks `shuttingDown`.
// Safety and cost: audio is sent for transcription only once listening has started (`consented`): at call start by default, or after "Start listening" when privacy.requireConsentAck is on (ADR 29); AI text passes guards.ts; budget.maxUsdPerCall caps model jobs.
import { st } from "./engine/state.ts";
import { fileArg, noAi, CONTROL, log, sup, brief, spotter, snapshot, bank, discard, S, ECHO, UI_LANG, interview } from "./engine/boot.ts";
import { ht } from "./htext.ts";
import { setPhase, status, health, safe } from "./engine/out.ts";
import { crash, installProcessHandlers } from "./engine/shutdown.ts";
import { createChannels, openBothChannels, wireChannels } from "./engine/stt.ts";
import { resolveReflexModels, startHealthTick, checkDisk, v2Active } from "./engine/degrade.ts";
import { notesRound, reminderTick } from "./engine/side.ts";
import { tipsTick } from "./engine/coach.ts";
import { flowTick } from "./engine/flowmode.ts";
import { startConsent } from "./engine/consent.ts";
import { startControlReader } from "./engine/control.ts";
import { startFileSource, startLiveSources } from "./engine/audio-sources.ts";

// A card row that cannot be saved (disk full) still raises the health bar; the call goes on.
log.onWriteFail = (e) => {
  try {
    health("disk", "amber", ht(UI_LANG, "disk.write"), String(e?.message ?? e));
  } catch {
    /* best effort: the bar itself needs the log */
  }
};
setPhase("starting");
status("mode", { noAi }); // effective AI mode for the app (the setting or --no-ai)
installProcessHandlers();
if (CONTROL) startControlReader(); // Stop must work while the STT sockets are still opening (that can take 30 s)

/** Timer jobs (all unref'd: they never keep the process alive on their own). */
function startTimers() {
  startHealthTick();
  setInterval(safe("notes", notesRound), S.notes.everyMs).unref();
  setInterval(safe("tips", tipsTick), 5000).unref();
  setInterval(safe("reminders", reminderTick), 30_000).unref();
  setInterval(safe("flow", flowTick), 5000).unref();
}

/** What the terminal shows once the call is set up. */
function printStartup() {
  if (brief?.planId) log.write("events", { type: "plan.used", planId: brief.planId, title: brief.title ?? "" }); // which prepared meeting this call used (ids and names only)
  if (brief)
    console.log(
      `Brief loaded: ${[brief.who, brief.goal].filter(Boolean).join(" · ") || "(notes only)"}${brief.mustCover?.length ? ` · must cover: ${brief.mustCover.join(", ")}` : ""}`,
    );
  console.log(
    spotter
      ? `Fact cards: ${spotter.size.clients} clients, ${spotter.size.domains} domains (snapshot ${snapshot?.generatedAt?.slice(0, 10) ?? "?"})`
      : "Fact cards: off (no snapshot at facts.file)",
  );
}
function printBanner() {
  console.log(
    `Wingman · call ${log.id} · ${fileArg ? "file " + fileArg : "live"} · ${bank.length} prepared cards${noAi ? " · prepared only" : ""}${discard ? " · --discard" : ""}`,
  );
  if (S.moments.engine === "v2")
    console.log(
      v2Active()
        ? "Help engine: New (the AI reads the call and decides when a card helps; observer up to " + S.moments.observerPerMinute + " calls a minute)."
        : `Help engine: Classic (the New engine is off ${interview ? "in a practice interview" : "with --no-ai"}).`,
    );
  console.log(
    `Cards also go to ${log.dir}/cards.jsonl (run "pnpm overlay" for the second-screen window). Keys: Enter = start listening (when waiting) · q = Quiet mode · a = ask Wingman · n = add a note for the AI · y = confirm the proposed client · Ctrl+C = stop.`,
  );
  console.log(`Speakers mode: ${ECHO.mode} (audio.echo.mode; "filter" is best with headphones) · capture box ${S.capture.enabled ? "on" : "off"}`);
}

/** Startup: open both STT channels, start timers, wire STT events to health bars, handle consent, then start the audio sources (or the replay file). */
async function main() {
  createChannels();
  wireChannels(); // before opening: a terminal failure of the first channel while the second is still opening must reach the retry loop
  await resolveReflexModels();
  await openBothChannels();
  startTimers();
  printStartup();
  checkDisk(true);
  sup.tick();
  printBanner();
  if (st.call.shuttingDown) return; // Stop came during startup: shutdown() is already closing the call, so start nothing new
  startConsent();
  if (fileArg) await startFileSource(fileArg);
  else await startLiveSources();
}

main().catch((e) => crash("main", e));
