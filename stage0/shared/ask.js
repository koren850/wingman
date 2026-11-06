"use strict";
// Ask countdown (Ctrl+Opt+A): seconds left in the real armed window. `until` comes from run.ts (askUntil = armed time + assist.askWindowMs).
// Classic script in the main window and the answer window, require() in the tray and in tests.
(function (root) {
  /** Whole seconds left until `until` (rounded up), or null when it is not armed, already past, or not a time. */
  function askSecondsLeft(until, now) {
    const u = Number(until),
      n = Number(now);
    if (!(u > 0) || !Number.isFinite(n)) return null;
    const s = Math.ceil((u - n) / 1000);
    return s > 0 ? s : null;
  }
  /** "42 s" under a minute, "1:05" above; null when there is nothing to show. */
  function askClock(until, now) {
    const s = askSecondsLeft(until, now);
    if (s === null) return null;
    return s < 60 ? s + " s" : Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }
  const api = { askSecondsLeft, askClock };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WingmanAsk = api;
})(typeof window !== "undefined" ? window : globalThis);
