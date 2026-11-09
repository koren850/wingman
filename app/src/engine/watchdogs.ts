// Silence watchdogs: the mic (never heard / long silence) and the system-audio tap (dead tap, or only the user talking).
import { callAppRunning } from "../callapp.ts";
import { SupervisedSource, peakOf } from "../audio.ts";
import { health, healthClear, safe } from "./out.ts";
import { log, sup, S, fileArg, UI_LANG } from "./boot.ts";
import { ht } from "../htext.ts";
import { st, mono } from "./state.ts";
import { MicWatch } from "./mic-watch.ts";
import { MicBar } from "./mic-bar.ts";
import { themDeadFlag } from "./them-dead.ts";

/** The "other side not heard" flag for the supervisor, from three owners (see them-dead.ts). */
export const setThemDead = themDeadFlag((dead) => sup.set({ themDead: dead }));

/** The one "mic" bar: the watchdog above and the source supervisor (audio-sources.ts) both feed it, and it shows the worst of them. */
export const micBar = new MicBar({
  show: (level, text, note) => health("mic", level, text, note),
  clear: () => healthClear("mic"),
  texts: { never: () => ht(UI_LANG, "mic.never"), long: () => ht(UI_LANG, "mic.long") },
});
const MIC_LONG_SILENT_MS = 5 * 60_000;
const micWatch = new MicWatch({
  intervalMs: S.audio.watchdog.micSilentMs,
  micPeak: S.audio.watchdog.micPeak,
  longSilentMs: MIC_LONG_SILENT_MS,
  shuttingDown: () => st.call.shuttingDown,
  onNever: () => micBar.setWatch("never"),
  onLong: () => micBar.setWatch("long"),
  onHeard: () => micBar.setWatch(undefined),
});

/** One mic frame: tracks the peak levels the mic watchdog reads, and clears the bar when the mic is heard again. */
export function noteMicFrame(pk: number) {
  micWatch.frame(pk);
}
/** The mic source came back: the next silence may raise its bar again. */
export function micBack() {
  micWatch.back();
}
export function stopMicWatch() {
  micWatch.stop();
}

// Mic watchdog (see mic-watch.ts). It runs once the user is listening AND the mic source has started: `startMicWatch` is the first half (consent),
// `micStarted` the second (after mic.start()).
export function startMicWatch() {
  if (!fileArg) micWatch.consent();
}
export function micStarted() {
  if (!fileArg) micWatch.micStarted();
}

let tapTimer: NodeJS.Timeout | undefined;
/** Watches the system-audio tap (see the comment inside for the two cases it tells apart). */
export function startTapWatchdog(sys: SupervisedSource | undefined, deadFrameMs: number) {
  const W = S.audio.watchdog;
  // Silent-tap watchdog. Two different situations:
  //  1. Frames keep arriving but are silent while the user talks (a monologue, a test, thinking aloud): ONE calm info line. This NEVER sets
  //     themDead (that would drop the ladder to transcript-only for a minute). Sound or client text clears it at once.
  //  2. No frames at all from the tap for deadFrameMs: the tap is really dead -> red, themDead (recovers within seconds once frames return).
  // Answers for the user keep working in both cases.
  let shownKind: "red" | "calm" | undefined,
    checking = false;
  const clearThemBanner = () => {
    if (!shownKind) return;
    healthClear(shownKind === "red" ? "them-silent" : "only-you");
    if (shownKind === "red") setThemDead("tap", false);
    shownKind = undefined;
  };
  st.voice.themHeard = clearThemBanner;
  sys?.on(
    "pcm",
    safe("sys watchdog", (b: Buffer) => {
      st.voice.lastSysFrame = mono();
      if (peakOf(b) <= W.silentPeak) {
        if (shownKind === "red") {
          clearThemBanner();
        }
        return;
      } // frames are back (even quiet ones): the tap is alive
      st.voice.lastThemSound = Date.now();
      st.voice.themSoundSeen = true;
      clearThemBanner();
    }),
  );
  const ONLY_YOU_MS = Math.max(W.silentThemMs, 45_000);
  let lastOnlyYouAt = 0;
  tapTimer = setInterval(
    safe("sys watchdog tick", () => {
      if (!sys || !st.call.consented || st.call.shuttingDown) return;
      if (mono() - st.voice.lastSysFrame > deadFrameMs) {
        if (shownKind !== "red") {
          if (shownKind === "calm") {
            healthClear("only-you");
            shownKind = undefined;
          }
          shownKind = "red";
          setThemDead("tap", true);
          log.write("events", { type: "watchdog.tap-dead" });
          health("them-silent", "red", ht(UI_LANG, "tap.dead"));
        }
        return;
      }
      if (shownKind || checking) return;
      // "I only hear you" only after a long one-sided stretch: the other side is silent while the user talks for a while in any call
      // (it was shown 8 times while Zoom audio worked). At most once every 10 minutes.
      if (!(Date.now() - st.voice.lastThemSound > ONLY_YOU_MS && Date.now() - st.voice.lastMeVoiced < 3000 && Date.now() - lastOnlyYouAt > 10 * 60_000)) return;
      checking = true;
      void callAppRunning().then((app) => {
        checking = false;
        if (st.call.shuttingDown || shownKind || Date.now() - st.voice.lastThemSound <= ONLY_YOU_MS) return;
        lastOnlyYouAt = Date.now();
        log.write("events", { type: "watchdog.silent-them", callApp: app ?? null });
        shownKind = "calm";
        health("only-you", "info", ht(UI_LANG, "only.you"));
      });
    }),
    2000,
  );
  tapTimer.unref();
}
/** Stops the tap watchdog (shutdown, tests). */
export function stopTapWatchdog() {
  clearInterval(tapTimer);
  tapTimer = undefined;
}
