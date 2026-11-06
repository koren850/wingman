// Silence watchdogs: the mic (never heard / long silence) and the system-audio tap (dead tap, or only the user talking).
import { callAppRunning } from "../callapp.ts";
import { SupervisedSource, peakOf } from "../audio.ts";
import { health, healthClear, safe } from "./out.ts";
import { log, sup, S, fileArg } from "./boot.ts";
import { st, mono } from "./state.ts";

const ONLY_YOU_TEXT = "אני שומע רק אותך. כדי לקבל תשובות גם לצד השני, הצטרף לשיחה או הפעל את השמע שלה. אפשר לשאול אותי כל דבר: Ctrl+Opt+A";
const MIC_LONG_SILENT_MS = 5 * 60_000;
let micPeakAfterStart = 0,
  micPeakWin = 0,
  micSilentShown = false,
  micWatch: NodeJS.Timeout | undefined;

/** One mic frame: tracks the peak levels the mic watchdog reads, and clears the bar when the mic is heard again. */
export function noteMicFrame(pk: number) {
  micPeakAfterStart = Math.max(micPeakAfterStart, pk);
  micPeakWin = Math.max(micPeakWin, pk);
  if (micSilentShown && pk >= S.audio.watchdog.micPeak) {
    micSilentShown = false;
    healthClear("mic");
  }
}
/** The mic source came back: the next silence may raise its bar again. */
export function micBack() {
  micSilentShown = false;
}
export function stopMicWatch() {
  clearInterval(micWatch);
}

// Mic watchdog. Silence is normal while the user listens (a quiet Bluetooth mic raised "mic not picking up" about 20 times).
// Red only when the mic was NEVER heard since listening started (permission, wrong device). Once it was heard, only a long silence
// (micLongSilentMs) gives one calm amber line, cleared as soon as the mic is heard again.
export function startMicWatch() {
  if (!fileArg) {
    micPeakWin = 0;
    let silentSince = Date.now();
    micWatch = setInterval(() => {
      if (st.call.shuttingDown) return;
      const now = Date.now();
      if (micPeakWin >= S.audio.watchdog.micPeak) silentSince = now;
      if (micPeakAfterStart < S.audio.watchdog.micPeak) {
        if (!micSilentShown) {
          micSilentShown = true;
          health("mic", "red", "המיקרופון לא קולט. בדוק הרשאת מיקרופון ב-Settings ובחירת מיקרופון, ואז הרץ בדיקת מוכנות");
        }
      } else if (now - silentSince >= MIC_LONG_SILENT_MS && !micSilentShown) {
        micSilentShown = true;
        health("mic", "amber", "לא שמעתי אותך כמה דקות. אם דיברת, בדוק את המיקרופון");
      }
      micPeakWin = 0;
    }, S.audio.watchdog.micSilentMs);
    micWatch.unref();
  }
}

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
    if (shownKind === "red") sup.set({ themDead: false });
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
  setInterval(
    safe("sys watchdog tick", () => {
      if (!sys || !st.call.consented || st.call.shuttingDown) return;
      if (mono() - st.voice.lastSysFrame > deadFrameMs) {
        if (shownKind !== "red") {
          if (shownKind === "calm") {
            healthClear("only-you");
            shownKind = undefined;
          }
          shownKind = "red";
          sup.set({ themDead: true });
          log.write("events", { type: "watchdog.tap-dead" });
          health(
            "them-silent",
            "red",
            "אין שמע מהצד השני (ערוץ השמע של המערכת לא שולח כלום). התשובות אליך עדיין פועלות. בדוק שהשמע של השיחה מופעל ושהווליום למעלה",
          );
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
        health("only-you", "info", ONLY_YOU_TEXT);
      });
    }),
    2000,
  ).unref();
}
