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
  const api = { stepsToFirstCard, MAX_FIRST_CARD_STEPS, REQUIRED, OPTIONAL, FIRST_CARD_PATH, plan, progressText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WingmanSetup = api;
})(typeof window !== "undefined" ? window : globalThis);
