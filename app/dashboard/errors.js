"use strict";
// The one table of errors for the main window. Every entry says what happened, what to do next, and has one button.
// Texts live in the string catalogs (strings.en.js / strings.he.js) under err.<code>.what / .next / .btn, so both languages are checked by the parity test.
// classify(rawText) finds the entry for a message that came from the engine, the readiness check or a file import (first match wins; "generic" last).
// The button's action is performed by performErrorAction() in app.js. Classic script in the page (window.WingmanErrors), require() in tests.
(function (root) {
  /** Actions a button can do. "retry" needs a handler from the place that showed the error; the others work anywhere. */
  const ACTIONS = ["keys", "allow", "check", "retry", "settings", "home", "paste", "files", "calls", "dismiss"];
  // code, a pattern for the raw message, and the action of the button.
  const TABLE = [
    { code: "key-deepgram", match: /deepgram.*(key|missing|unauthori[sz]ed|401|403|invalid)|speech.*key.*(missing|invalid)/i, action: "keys" },
    { code: "key-anthropic", match: /anthropic.*(key|missing|unauthori[sz]ed|401|403|invalid)|api key.*(missing|invalid)/i, action: "keys" },
    { code: "mic-denied", match: /microphone.*(denied|permission|not allowed|blocked)|mic.*permission/i, action: "allow" },
    { code: "audio-denied", match: /system audio|screen recording|audio capture.*(denied|permission)/i, action: "allow" },
    { code: "mic-silent", match: /no microphone|mic(rophone)? .*(dead|silent|not hearing|no sound)|hearing only you|bluetooth|airpods/i, action: "settings" },
    { code: "stt-down", match: /speech (service|recognition|to text).*(not answering|down|failed|error|closed)|\bstt\b/i, action: "check" },
    { code: "llm-down", match: /\bAI\b.*(not answering|unavailable|overloaded|paused)|anthropic|overloaded|529|rate limit|\b429\b/i, action: "check" },
    { code: "offline", match: /offline|no network|internet|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i, action: "retry" },
    { code: "one-screen", match: /only one screen|one-screen|no answer window/i, action: "allow" },
    { code: "overlay-closed", match: /answer window closed|overlay.*closed/i, action: "dismiss" },
    { code: "off-itself", match: /turned itself off|stopped listening/i, action: "check" },
    { code: "pdf-missing", match: /pdftotext/i, action: "paste" },
    { code: "file-type", match: /cannot be read here|only \.txt|not a (text|calendar|pdf) file|no meeting found/i, action: "paste" },
    { code: "file-big", match: /2 MB|too much text|too large/i, action: "paste" },
    { code: "file-empty", match: /no readable text|file is empty|bad file|could not read that pdf/i, action: "paste" },
    { code: "file-limit", match: /background limit|at most \d+ background|remove a file/i, action: "files" },
    { code: "plan-empty", match: /fill in at least one|cannot be empty|add some text/i, action: "paste" },
    { code: "plan-limit", match: /at most \d+ (plans|prepared meetings)|delete one/i, action: "home" },
    { code: "digest-failed", match: /digest|prepare.*(failed|timed out)|could not read your text/i, action: "retry" },
    { code: "memory-edit", match: /memory edit|too many memory edits|notes (could not|not) (be )?saved/i, action: "retry" },
    { code: "plan-save", match: /could not save|not saved|did not start/i, action: "retry" },
    { code: "call-start", match: /did not work right now|could not start|could not be started/i, action: "check" },
    { code: "call-problem", match: /ended with a problem|crash/i, action: "calls" },
    { code: "preview", match: /\bpreview\b/i, action: "dismiss" },
    { code: "generic", match: null, action: "check" },
  ];
  const BY_CODE = new Map(TABLE.map((e) => [e.code, e]));
  const keysOf = (code) => ({ what: `err.${code}.what`, next: `err.${code}.next`, btn: `err.${code}.btn` });

  /** The table entry for a raw message (or for a code). Never null: "generic" is the last resort. */
  function classify(textOrCode) {
    const s = String(textOrCode == null ? "" : textOrCode);
    if (BY_CODE.has(s)) return BY_CODE.get(s);
    for (const e of TABLE) if (e.match && e.match.test(s)) return e;
    return BY_CODE.get("generic");
  }
  /** What the page shows: { code, what, next, btn, action } in a language. `t` is (key, vars) => text. */
  function describe(t, textOrCode, vars) {
    const e = classify(textOrCode);
    const k = keysOf(e.code);
    return { code: e.code, what: t(k.what, vars), next: t(k.next, vars), btn: t(k.btn, vars), action: e.action };
  }
  // "Fix it": what the button of a health message does. Each of these codes has an action, or a plain reason why it has none.
  const FIX = {
    "key-deepgram": "keys",
    "key-anthropic": "keys",
    "mic-denied": "pane-mic", // opens System Settings at Privacy, Microphone
    "audio-denied": "pane-audio", // opens System Settings at Privacy, System Audio Recording
    "mic-silent": "switch-mic", // Settings, microphone choice
    "stt-down": "retry-check",
    "llm-down": "retry-check",
    offline: "retry-check",
    "one-screen": "allow",
    "off-itself": "retry-check",
    "call-start": "retry-check",
    generic: "retry-check",
  };
  const NOFIX = { "overlay-closed": "err.overlay-closed.nofix", preview: "err.preview.nofix" };
  /** Every code that can come from the readiness check or the engine health line. A test checks that each has an action or a reason. */
  const HEALTH = [...Object.keys(FIX), ...Object.keys(NOFIX)];
  /** { code, action, label, reason } for a code or a raw message. label and reason are catalog keys; exactly one of action and reason is set for a health code. */
  function fixOf(textOrCode) {
    const code = classify(textOrCode).code;
    const action = FIX[code] || null;
    return { code, action, label: action ? "fix." + action : null, reason: action ? null : NOFIX[code] || null };
  }
  const FIX_ACTIONS = [...new Set(Object.values(FIX))];
  const api = { ACTIONS, TABLE, classify, describe, keysOf, FIX, NOFIX, HEALTH, FIX_ACTIONS, fixOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WingmanErrors = api;
})(typeof window !== "undefined" ? window : globalThis);
