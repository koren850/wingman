"use strict";
// Pure helpers for Home, shared by the renderer (classic script) and the unit test (src/dashboard-home.test.ts).
// No DOM here: everything takes plain data (call state from the controller, settings rows from the catalog) and returns plain data.
(function (root) {
  // Texts come from the string catalogs through `t(key, vars)`. Without one (the unit test of the English window) the English catalog is used.
  const defaultT = (key, vars) =>
    typeof module !== "undefined" && module.exports ? require("./i18n.js").t("en", key, vars) : root.WingmanI18n.t("en", key, vars);
  const Ask = typeof module !== "undefined" && module.exports ? require("../shared/ask.js") : root.WingmanAsk;
  // Ask is the shared question-timer helper (shared/ask.js): require() under node, window.WingmanAsk in the page.
  /** The stop panel: what is happening now. `call.stopPhase` ("saving" -> "summary" -> "done") comes from run.ts through the controller; when it is empty, infer from the flags. */
  function stopSteps(call, t = defaultT) {
    const c = call || {},
      ph = c.stopPhase || "";
    let save, sum;
    if (ph === "saving") {
      save = "now";
      sum = "todo";
    } else if (ph === "summary") {
      save = "done";
      sum = "now";
    } else if (ph === "done") {
      save = "done";
      sum = "done";
    } else {
      save = c.endedCleanly ? "done" : "now";
      sum = c.summaryOk || c.endedCleanly ? "done" : "now";
    }
    if (c.summarySkipped) sum = "done";
    return [
      { key: "listening", label: t("stop.listening"), state: "done" },
      { key: "saving", label: t("stop.saving"), state: save },
      { key: "summary", label: c.summarySkipped ? t("stop.summarySkipped") : t("stop.summary"), state: sum },
    ];
  }

  /** "AI on · ..." line for the Start card, from the settings rows (catalog.describe: { key, value }). Nothing is guessed: missing rows are left out. */
  function aiMode(items, t = defaultT) {
    const v = {};
    for (const i of items || []) if (i && typeof i.key === "string") v[i.key] = i.value;
    if (!("run.noAi" in v)) return null;
    if (v["run.noAi"] === false) return { on: false, text: t("ai.off") }; // run.noAi is shown inverted: false = "Use the AI at all" is off
    const me = { always: t("ai.me.always"), hotkey: t("ai.me.hotkey"), off: t("ai.me.off") }[v["assist.answerMe"]];
    const them = v["reflex.allowAns"] === false ? t("ai.them.cardsOnly") : null;
    const parts = [t("ai.on"), me, them, v["cards.quiet"] === true ? t("ai.quiet") : null].filter(Boolean);
    return { on: true, text: parts.join(" · ") };
  }

  /** The last readiness result when it says NOT READY (BUSY and "not checked" never block). */
  const blockedBy = (d) => (d && !d.ok && d.verdict === "NOT READY" ? d : null);

  /** Prepared meetings (shared/plans.js): require() under node, window.WingmanPlans in the page. */
  const Plans = typeof module !== "undefined" && module.exports ? require("../shared/plans.js") : root.WingmanPlans;

  /**
   * What the Start card shows for the prepared meetings (list from the main process, already ready ones only, soonest first):
   * { next, rows } where next is the "Next: <who> at 14:30" meeting (timed, not long past) or null, and each row has the texts of one line.
   */
  function startPaths(list, now, t = defaultT, lang = "en") {
    const ready = Plans.ready(list || [], now);
    const next = Plans.nextMeeting(ready, now);
    const rows = ready.map((m) => ({
      id: m.id,
      name: Plans.label(m),
      sub: m.title ? m.who || m.goal || "" : m.who ? m.goal || "" : "",
      time: m.at ? formatWhen(m.at, now, t, lang) : "",
      timeShort: m.at
        ? formatWhen(m.at, now, t, lang) === t("when.today", { time: Plans.clock(m.at) })
          ? Plans.clock(m.at)
          : formatWhen(m.at, now, t, lang)
        : "",
      isNext: !!next && next.id === m.id,
      must: m.mustCount != null ? m.mustCount : (m.mustCover || []).length,
      files: m.files || 0,
      uses: m.uses || 0,
      pending: !!m.pending,
      startLabel: t("home.startNamed", { name: Plans.label(m).slice(0, 50) }),
    }));
    return { next: next ? rows.find((r) => r.id === next.id) : null, rows };
  }
  /** "Today 14:30", "Tomorrow 09:00", "Yesterday 16:00", else a short date and the time, in the window language. */
  function formatWhen(ms, now, t = defaultT, lang = "en") {
    if (!ms) return "";
    const d = new Date(ms),
      n = new Date(now);
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(d) - day(n)) / 86400000);
    const clock = Plans.clock(ms);
    if (diff === 0) return t("when.today", { time: clock });
    if (diff === 1) return t("when.tomorrow", { time: clock });
    if (diff === -1) return t("when.yesterday", { time: clock });
    let date;
    try {
      date = new Intl.DateTimeFormat(lang === "he" ? "he-IL" : "en-GB", { weekday: "short", day: "numeric", month: "short" }).format(d);
    } catch {
      date = Plans.formatAt(ms, now).replace(/ \d{2}:\d{2}$/, "");
    }
    return `${date} ${clock}`;
  }
  /** "Next: Dana at 14:30" */
  const nextText = (row, t = defaultT) =>
    row.time ? t("home.nextAt", { name: row.name, time: row.timeShort || row.time }) : t("home.next", { name: row.name });
  /** Practice uses the next prepared meeting (or the only one), as the app does; none = a plain practice. */
  const practiceTarget = (list, now) => Plans.practiceDefault(list || [], now);
  const practiceLabel = (m, t = defaultT) => (m ? t("home.practiceWith", { name: Plans.label(m).slice(0, 40) }) : t("home.practice"));

  /** The combined Note / Ask input: its label, button, placeholder and the line announced after sending. */
  const composer = (mode, t = defaultT) => {
    const k = mode === "ask" ? "ask" : "note";
    return { label: t(`compose.${k}.label`), button: t(`compose.${k}.button`), placeholder: t(`compose.${k}.placeholder`), sent: t(`compose.${k}.sent`) };
  };
  /** Status line while Ctrl+Opt+A (or the Listen button) is armed: the next thing said is a question. */
  const askStatus = (call, now, t = defaultT) => {
    if (!call || !call.askArmed) return "";
    const left = Ask.askClock(call.askUntil, now == null ? Date.now() : now);
    return t("ask.armed") + (left ? " " + t("ask.left", { time: left }) : "");
  };
  /** The "Skip summary" control shows while the summary is the step in progress (not before, not after, not twice). */
  const canSkipSummary = (call) => !!call && call.phase === "stopping" && call.stopPhase === "summary" && !call.summarySkipped && !call.summaryOk;

  /** Doctor lines are written for the command line. Say where things are now: keys in the Keychain (Settings, Keys), permissions for Wingman. */
  function niceFix(t) {
    return String(t || "")
      .replace(/add it to ~?\/?[\w./-]*keys\.env/gi, "add it in Settings, Keys")
      .replace(/~?\/?[\w./-]*keys\.env/gi, "Settings, Keys")
      .replace(/\b(your )?terminal( app)?\b/gi, "Wingman")
      .replace(/\bdoctor\b/gi, "readiness check");
  }
  const keyRelated = (x) => /api_key|\bkeys?\b|deepgram|anthropic/i.test(String(x && x.text) + " " + String((x && x.fix) || ""));

  /** Keep keyboard focus across a re-render: remember the focused element by id (or data-fk) and its caret, give it back to the new element. */
  function focusKey(el) {
    return el ? el.id || (el.getAttribute && el.getAttribute("data-fk")) || "" : "";
  }

  const api = {
    stopSteps,
    aiMode,
    blockedBy,
    startPaths,
    nextText,
    formatWhen,
    practiceTarget,
    practiceLabel,
    composer,
    askStatus,
    canSkipSummary,
    niceFix,
    keyRelated,
    focusKey,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WingmanHome = api;
})(typeof window !== "undefined" ? window : globalThis);
