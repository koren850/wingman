// Input from the user: terminal keys (Enter, q, a, n, y, Ctrl+C) and the menu-bar app's line commands on stdin (WINGMAN_CONTROL=1).
//
// IPC contract with the tray app (WINGMAN_CONTROL=1):
//   stdin  lines: consent | quiet [on|off] | client | ask [text] | recap | note <text> | stop | stop-no-summary | skip-summary | stop-delete
//   stdout "@@wingman {json}" lines (see out.ts). Stop sequence: {ev:"stopphase",phase:"saving"} -> "summary" -> "done", then {ev:"ended"}.
//   call.json in the call folder also carries phase ("starting"|"waiting"|"live"|"ended") and liveAt for the answer window.
//   The reader starts with the process (run.ts); stop commands run at once, others wait until the consent step.
//   The tray escalates a stop with SIGINT at 12 s and SIGKILL at 20 s, so shutdown() must finish inside that.
import { createInterface } from "node:readline";
import { safe, health, healthClear, status } from "./out.ts";
import { shutdown, skipSummaryNow } from "./shutdown.ts";
import { st } from "./state.ts";
import { nameSpeaker, confirmClient, clientProposed } from "./side.ts";
import { armAsk, askTyped } from "./me.ts";
import { catchMeUp } from "./askcall.ts";
import { ORPHAN_IDLE_MIN, log, contextNotes, UI_LANG } from "./boot.ts";
import { ht } from "../htext.ts";
import { eventError } from "../errtext.ts";

// Single-key input (terminal mode only; with WINGMAN_CONTROL the tray uses stdin lines instead): Enter = consent, q = quiet, a = ask, n = note, y = confirm client, Ctrl+C = stop.
let keyWaiter: ((k: string) => void) | undefined;
export function setupKeys(onEnter: () => void) {
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (b: Buffer) => {
    for (const ch of b.toString()) {
      if (keyWaiter) {
        const w = keyWaiter;
        keyWaiter = undefined;
        w(ch);
        continue;
      }
      if (ch === "\u0003") {
        void shutdown();
        return;
      }
      if (noteBuf !== undefined) {
        noteKey(ch);
        continue;
      }
      if ((ch === "y" || ch === "Y") && clientProposed()) {
        confirmClient();
        continue;
      }
      if (ch === "a" || ch === "A") {
        armAsk();
        continue;
      }
      if (ch === "n" || ch === "N") {
        noteBuf = "";
        process.stdout.write("\nNote for the AI (Enter = add, Esc = cancel): ");
        continue;
      }
      if (ch === "\r" || ch === "\n") onEnter();
      if (ch === "q" || ch === "Q") toggleQuiet();
    }
  });
}
/** Quiet mode: cards are still saved to cards.jsonl but flagged hidden, so the answer window shows nothing. Reversible mid-call. */
function toggleQuiet(on = !st.call.quiet) {
  if (on === st.call.quiet) return;
  st.call.quiet = on;
  log.write("events", { type: "quiet", on: st.call.quiet });
  st.call.quiet ? health("quiet", "info", ht(UI_LANG, "quiet")) : healthClear("quiet");
  console.log(`\nquiet ${st.call.quiet ? "ON: cards are logged, not shown" : "OFF"}`);
  status("quiet", { on: st.call.quiet });
}
const typedNotes: string[] = [],
  MAX_TYPED_NOTES = 20,
  MAX_TYPED_NOTE_CHARS = 4096;
/** A typed context note for the AI (instant-start mode). Added to every prompt via contextNotes; capped so a long call cannot grow the prompt without bound. */
function addNote(text: string) {
  const note = text.trim();
  if (!note) return;
  const kept = note.slice(0, 300);
  contextNotes.push(kept);
  typedNotes.push(kept);
  log.write("events", { type: "context.note", note });
  // Typed notes are capped (last 20 notes / 4 KB) so a long call cannot grow every prompt without bound; brief notes are never dropped.
  while (typedNotes.length > 1 && (typedNotes.length > MAX_TYPED_NOTES || typedNotes.reduce((n, x) => n + x.length, 0) > MAX_TYPED_NOTE_CHARS)) {
    const old = typedNotes.shift()!,
      i = contextNotes.lastIndexOf(old);
    if (i >= 0) contextNotes.splice(i, 1);
  }
  console.log(`\n✓ note added (${contextNotes.length})`);
  status("note", { count: contextNotes.length });
}
/** The menu-bar app's pipe closed without a "stop" (its normal quit sends "stop" first, so this is a crash or kill). Nothing can reconnect to a running
 *  call (the app starts a new one), so the choice is between ending a live call that may be in a meeting, or letting it run unattended.
 *  While waiting for "Start listening" nothing is running: stop cleanly. While live: keep listening and keep showing cards (the answer window is
 *  a separate process), say so on the screen, and stop by itself after ORPHAN_IDLE_MIN minutes of silence (or on SIGTERM/SIGINT). */
function onControlClosed() {
  if (st.call.shuttingDown || st.call.orphaned) return;
  if (!st.call.consented) {
    log.write("events", { type: "control.closed", live: false });
    void shutdown();
    return;
  }
  st.call.orphaned = true;
  log.write("events", { type: "control.closed", live: true, idleStopMin: ORPHAN_IDLE_MIN });
  console.log(`\nThe menu-bar app closed: the call continues and stops by itself after ${ORPHAN_IDLE_MIN} minutes of silence.`);
  health("control", "amber", ht(UI_LANG, "orphan", { min: ORPHAN_IDLE_MIN }));
}
/** Commands that must act at once, also during startup (before the consent card exists). Everything else waits in a queue until setupControl(). */
const IMMEDIATE = new Set(["stop", "stop-no-summary", "skip-summary", "stop-delete"]);
let controlReader: ReturnType<typeof createInterface> | undefined;
let controlHandler: ((line: string) => void) | undefined;
const controlQueue: string[] = [];

/** Reads the tray's stdin commands from the very start of the process. "stop" and its variants are handled at once, so Stop during the
 *  (possibly 30 s) STT startup works without waiting for the SIGINT escalation; other commands are queued and run when setupControl() is called. */
export function startControlReader() {
  if (controlReader) return;
  controlReader = createInterface({ input: process.stdin });
  controlReader.on(
    "line",
    safe("control command", (line: string) => {
      const cmd = line.trim().split(" ")[0];
      if (IMMEDIATE.has(cmd) || controlHandler) (controlHandler ?? runControlCommand)(line);
      else controlQueue.push(line);
    }),
  );
  controlReader.on("close", safe("control closed", onControlClosed));
}
/** Menu-bar app commands (WINGMAN_CONTROL=1): one per line on stdin. A closed stdin (see onControlClosed) means the app crashed. */
export function setupControl(onConsent: () => void) {
  startControlReader();
  const handler = (line: string) => runControlCommand(line, onConsent);
  controlHandler = handler;
  for (const line of controlQueue.splice(0)) safe("control command", handler)(line);
}
function runControlCommand(line: string, onConsent?: () => void) {
  const [cmd, ...rest] = line.trim().split(" ");
  if (cmd === "consent") onConsent?.();
  else if (cmd === "quiet") toggleQuiet(rest[0] === "on" ? true : rest[0] === "off" ? false : undefined);
  else if (cmd === "client") confirmClient();
  else if (cmd === "ask") {
    const q = rest.join(" ").trim();
    if (q) askTyped(q);
    else armAsk();
  } // "ask" = the hotkey; "ask <text>" = a typed question (wingman CLI)
  else if (cmd === "recap") {
    // "Catch me up" (Ctrl+Opt+U, `wingman recap`): the five-line sheet from the call memory
    void catchMeUp().catch((e) => log.write("events", { type: "recap.error", error: eventError(e).slice(0, 200) }));
  } else if (cmd === "note") addNote(rest.join(" "));
  else if (cmd === "speaker") {
    const n = Number(rest[0]);
    if (Number.isInteger(n)) nameSpeaker(n, rest.slice(1).join(" "), "user");
  } // "speaker 2 Dana": the user renamed a voice
  else if (cmd === "stop") void shutdown();
  else if (cmd === "stop-no-summary") {
    skipSummaryNow();
    void shutdown();
  } // `wingman stop --no-summary`: keep the call, skip the summary
  else if (cmd === "skip-summary") {
    if (st.call.shuttingDown) skipSummaryNow();
  } // the "Skip summary" button while the summary is being written
  else if (cmd === "stop-delete") {
    st.call.discardNow = true;
    void shutdown();
  }
}
// Typed context note state (terminal key `n`): undefined = not typing.
let noteBuf: string | undefined;
function noteKey(ch: string) {
  if (ch === "\u001b") {
    noteBuf = undefined;
    process.stdout.write(" (cancelled)\n");
    return;
  }
  if (ch === "\r" || ch === "\n") {
    const note = (noteBuf ?? "").trim();
    noteBuf = undefined;
    if (note) addNote(note);
    else process.stdout.write("\n");
    return;
  }
  if (ch === "\u007f" || ch === "\b") {
    if (noteBuf) {
      noteBuf = [...noteBuf].slice(0, -1).join("");
      process.stdout.write("\b \b");
    }
    return;
  }
  if (ch >= " ") {
    noteBuf += ch;
    process.stdout.write(ch);
  }
}
/** Waits up to `ms` for one key press (the delete-this-call question). Resolves "" on timeout. */
export const askKey = (ms: number) =>
  new Promise<string>((res) => {
    const t = setTimeout(() => {
      keyWaiter = undefined;
      res("");
    }, ms);
    keyWaiter = (k) => {
      clearTimeout(t);
      res(k);
    };
  });
