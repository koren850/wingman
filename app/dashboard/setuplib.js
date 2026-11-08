"use strict";
// Pure helpers for the guided setup, shared by the renderer (classic script) and the unit test (src/setup-flow.test.ts).
// The required path is three steps. Everything else is optional ("Make it yours").
(function (root) {
  const REQUIRED = ["try", "connect", "allow"];
  const OPTIONAL = ["about", "privacy", "mic", "pack", "check"];
  /**
   * What the setup card shows. in: { done: {id: bool}, skipped: {id: bool}, force, closed }.
   * Returns { total, count (required steps done), ready (all required done), settled (each required step done or skipped), visible, next (first required step still open, or "") }.
   */
  function plan(o) {
    const done = (o && o.done) || {},
      skipped = (o && o.skipped) || {};
    const count = REQUIRED.filter((id) => done[id]).length;
    const ready = count === REQUIRED.length;
    const settled = REQUIRED.every((id) => done[id] || skipped[id]);
    const next = REQUIRED.find((id) => !done[id] && !skipped[id]) || "";
    const visible = !!(o && o.force) || !settled || (ready && !(o && o.closed));
    return { total: REQUIRED.length, count, ready, settled, visible, next };
  }
  /** "2 of 3" for the progress chip (the page passes its own words: "{n} of {total}"). */
  const progressText = (count, total, fmt) => (fmt ? fmt.replace("{n}", count).replace("{total}", total) : `${count} of ${total}`);
  /** The first real card needs at most this many steps on screen: keys, permissions (with the restart hint inside), the practice call. */
  const FIRST_CARD_PATH = ["connect", "allow", "try"];
  /**
   * What is still to do before the first real card, in order, for the flags { done: {id: bool} }. The practice call (try) is the last step and needs no keys.
   * The window language picker sits on the same card but is never a step: Wingman starts in the system language.
   */
  function stepsToFirstCard(o) {
    const done = (o && o.done) || {};
    return FIRST_CARD_PATH.filter((id) => !done[id]);
  }
  /** The most steps a new user may need before the first card. A test holds the path to this. */
  const MAX_FIRST_CARD_STEPS = 5;

  /* ---------- The first-run window: paste two keys, allow the sound, go ---------- */
  const WIZ_STEPS = ["keys", "allow", "ready"];
  const PROVIDERS = ["deepgram", "anthropic"];
  /** What goes wrong with a pasted key, in plain words: the text key and the one fix button. Result words come from src/keycheck.cjs and keys:connect. */
  const KEY_PROBLEMS = {
    invalid: { text: "wiz.err.invalid", fix: "get" }, // the service refused the key
    nocredit: { text: "wiz.err.nocredit", fix: "billing" }, // right key, no money on the account
    network: { text: "wiz.err.network", fix: "retry" },
    unavailable: { text: "wiz.err.unavailable", fix: "retry" },
    format: { text: "wiz.err.format", fix: "get" },
    limit: { text: "wiz.err.limit", fix: "retry" },
    store: { text: "wiz.err.store", fix: "retry" },
    app: { text: "wiz.err.app", fix: "" },
  };
  /** The message key and the fix for a result word. An unknown word still gets a plain message and a retry. */
  const keyProblem = (result) => KEY_PROBLEMS[result] || { text: "wiz.err.other", fix: "retry" };
  /** The keys step is done when both keys are saved: the service accepted them, or accepted them but the account has no credit yet (the practice call still works).
   * `st` is { deepgram: "ok" | "nocredit" | "missing" | a problem word, anthropic: ... }. */
  const keysDone = (st) => PROVIDERS.every((p) => st && (st[p] === "ok" || st[p] === "nocredit"));
  /**
   * What the sound step needs on this system. in: { platform, mic ("granted" | "not-determined" | "denied" | "restricted" | "unknown"), audioAck }.
   * Returns { mic: "ok" | "ask" | "blocked", system: "ok" | "todo" | "none", done }.
   * macOS: the microphone is read from the system; System Audio Recording cannot be read, so the person says it is on (the check at the end tests it for real).
   * Windows: only the microphone switch exists; the sound of the call needs no permission. Other systems: nothing to allow.
   */
  function allowState(o) {
    const platform = (o && o.platform) || "darwin",
      mic = (o && o.mic) || "unknown";
    const m =
      mic === "granted" ? "ok" : mic === "denied" || mic === "restricted" ? "blocked" : platform === "darwin" || mic === "not-determined" ? "ask" : "ok"; // unknown on Windows or Linux: do not block
    const system = platform === "darwin" ? (o && o.audioAck ? "ok" : "todo") : "none";
    return { mic: m, system, done: m === "ok" && system !== "todo" };
  }
  /** Which wizard step is open, from what is done. Returns { step, keys, allow }. `force` keeps the person on a step they chose. */
  function wizardPlan(o) {
    const keys = keysDone(o && o.keys),
      allow = !!(o && o.allow && o.allow.done);
    const step = keys ? (allow ? "ready" : "allow") : "keys";
    return { step: o && WIZ_STEPS.includes(o.pick) && (o.pick === "keys" || keys) ? o.pick : step, keys, allow };
  }
  /** Show the first-run window? Only until the person finishes or skips it, and only when keys are missing or they are in the middle of it. */
  const wizardVisible = (o) => !(o && (o.done || o.skipped || o.running)) && !!(o && (o.keysMissing || o.started));
  /** Short mask for a saved key: "...ab12". */
  const mask = (last4) => (last4 ? "\u2026" + last4 : "");
  const api = {
    WIZ_STEPS,
    KEY_PROBLEMS,
    keyProblem,
    keysDone,
    allowState,
    wizardPlan,
    wizardVisible,
    mask,
    stepsToFirstCard,
    MAX_FIRST_CARD_STEPS,
    REQUIRED,
    OPTIONAL,
    FIRST_CARD_PATH,
    plan,
    progressText,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WingmanSetup = api;
})(typeof window !== "undefined" ? window : globalThis);
