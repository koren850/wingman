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
  /** "2 of 3" for the progress chip. */
  const progressText = (count, total) => `${count} of ${total}`;
  const api = { REQUIRED, OPTIONAL, plan, progressText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WingmanSetup = api;
})(typeof window !== "undefined" ? window : globalThis);
