"use strict";
// Pure helpers for Home, shared by the renderer (classic script) and the unit test (src/dashboard-home.test.ts).
// No DOM here: everything takes plain data (call state from the controller, settings rows from the catalog) and returns plain data.
(function (root) {
  const Ask = typeof module !== "undefined" && module.exports ? require("../shared/ask.js") : root.WingmanAsk;
  // Ask is the shared question-timer helper (shared/ask.js): require() under node, window.WingmanAsk in the page.
  /** The stop panel: what is happening now. `call.stopPhase` ("saving" -> "summary" -> "done") comes from run.ts through the controller; when it is empty, infer from the flags. */
  function stopSteps(call) {
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
      { key: "listening", label: "Stopped listening", state: "done" },
      { key: "saving", label: "Saving the call", state: save },
      { key: "summary", label: c.summarySkipped ? "Summary skipped" : "Writing the summary", state: sum },
    ];
  }

  /** "AI on · ..." line for the Start card, from the settings rows (catalog.describe: { key, value }). Nothing is guessed: missing rows are left out. */
  function aiMode(items) {
    const v = {};
    for (const i of items || []) if (i && typeof i.key === "string") v[i.key] = i.value;
    if (!("run.noAi" in v)) return null;
    if (v["run.noAi"] === false) return { on: false, text: "AI off in Settings · Prepared cards only, nothing goes to Anthropic" }; // run.noAi is shown inverted: false = "Use the AI at all" is off
    const me = { always: "answers your questions: always", hotkey: "answers your questions: hotkey only", off: "your own questions: only with the hotkey" }[
      v["assist.answerMe"]
    ];
    const them = v["reflex.allowAns"] === false ? "other side: Prepared cards only" : null;
    const parts = ["AI on", me, them, v["cards.quiet"] === true ? "starts in quiet mode" : null].filter(Boolean);
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
  function startPaths(list, now) {
    const ready = Plans.ready(list || [], now);
    const next = Plans.nextMeeting(ready, now);
    const rows = ready.map((m) => ({
      id: m.id,
      name: Plans.label(m),
      sub: m.title ? m.who || m.goal || "" : m.who ? m.goal || "" : "",
      time: m.at ? Plans.formatAt(m.at, now) : "",
      isNext: !!next && next.id === m.id,
      must: m.mustCount != null ? m.mustCount : (m.mustCover || []).length,
      files: m.files || 0,
      startLabel: "Start " + Plans.label(m).slice(0, 50),
    }));
    return { next: next ? rows.find((r) => r.id === next.id) : null, rows };
  }
  /** "Next: Dana at 14:30" */
  const nextText = (row) => `Next: ${row.name}${row.time ? " at " + row.time.replace(/^Today /, "") : ""}`;
  /** Practice uses the next prepared meeting (or the only one), as the app does; none = a plain practice. */
  const practiceTarget = (list, now) => Plans.practiceDefault(list || [], now);
  const practiceLabel = (m) => (m ? `Practice call · uses "${Plans.label(m).slice(0, 40)}"` : "Practice call (offline, free)");

  /** The combined Note / Ask input. */
  const COMPOSER = {
    note: { label: "Note for the AI", button: "Add note", placeholder: "A note for the AI, e.g. this is about the shop migration", sent: "Note added" },
    ask: {
      label: "Ask Wingman",
      button: "Ask",
      placeholder: "Ask Wingman, e.g. what is a CNAME record?",
      sent: "Question sent: the answer shows in the answer window",
    },
  };
  const composer = (mode) => COMPOSER[mode === "ask" ? "ask" : "note"];
  /** Status line while Ctrl+Opt+A (or the Listen button) is armed: the next thing said is a question. */
  const askStatus = (call, now) => {
    if (!call || !call.askArmed) return "";
    const left = Ask.askClock(call.askUntil, now == null ? Date.now() : now);
    return "Listening for your question. Say it now." + (left ? " " + left + " left" : "");
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
    practiceTarget,
    practiceLabel,
    COMPOSER,
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
