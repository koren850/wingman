"use strict";
// Answer window, main process side: where the window may be, how tall it is, and what happens when a monitor goes or comes.
// Pure logic with injected `screen`, `win` and `globalShortcut` objects, so tests run it without Electron. main.cjs wires the real ones.
//
// Rules (the answer window can be on a shared screen, so they are strict):
//   * The window only ever sits inside the work area of the chosen display. Every move goes through place(), which takes the display from pick().
//   * With one display it refuses (unless allowPrimary), as before.
//   * When the chosen display goes away the window is hidden, not moved to the primary screen. When a fitting display is back it returns there.
//   * The page reports its content height; the window follows it, inside the work area, and never takes focus.
const MIN_H = 56; // a bar of pills
const MARGIN = 20;
const TOP = 40;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const num = (x, d) => (Number.isFinite(Number(x)) ? Number(x) : d);

/**
 * Bounds for a window of `content` px of page height inside `work` ({x,y,width,height}).
 * `current` keeps where the user dragged it (clamped inside). Without it the window sits at the top right corner.
 */
function fitBounds({ content, width = 760, work, current, minH = MIN_H }) {
  const w = Math.max(200, Math.min(width, work.width));
  const maxH = Math.max(minH, work.height - 16);
  const h = Math.round(clamp(num(content, minH), minH, maxH));
  const hasCur = current && Number.isFinite(current.x) && Number.isFinite(current.y);
  const x0 = hasCur ? current.x : work.x + work.width - w - MARGIN;
  const y0 = hasCur ? current.y : work.y + TOP;
  return {
    x: Math.round(clamp(x0, work.x, work.x + work.width - w)),
    y: Math.round(clamp(y0, work.y, work.y + work.height - h)),
    width: w,
    height: h,
  };
}

/** True when `b` lies fully inside `work`. */
const inside = (b, work) => b.x >= work.x && b.y >= work.y && b.x + b.width <= work.x + work.width && b.y + b.height <= work.y + work.height;

/**
 * Which display the window may use: the second display, or the primary only when `cfg.allowPrimary`.
 * Returns { display, warn } where display is null when no display is safe.
 */
function pickDisplay(screen, cfg) {
  const all = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const second = all.find((d) => d.id !== primary.id);
  if (cfg.display === "primary" && cfg.allowPrimary) return { display: primary, warn: "primary" };
  if (second) return { display: second, warn: "" };
  if (cfg.allowPrimary) return { display: primary, warn: "primary" };
  return { display: null, warn: "single" };
}

/**
 * Follows the chosen display. `win` needs isDestroyed, hide, showInactive, setBounds, getBounds, isVisible.
 * `note(kind, vars)` tells the user (window banner and tray note file); kind "" clears the note.
 */
function createDisplayFollow({
  screen,
  win,
  cfg,
  note = /** @type {(kind: string) => void} */ (() => {}),
  width = 760,
  log = /** @type {(what: string) => void} */ (() => {}),
}) {
  let chosen = null; // id of the display the window belongs to
  let hidden = false;
  let content = MIN_H;
  const alive = () => win && !win.isDestroyed();

  /** The one place that moves the window. `display` must come from pick(). */
  function place(display, keepPos) {
    if (!alive() || !display || display.id !== chosen) return null;
    const current = keepPos && win.isVisible() ? win.getBounds() : undefined;
    const b = fitBounds({ content, width, work: display.workArea, current });
    win.setBounds(b);
    return b;
  }
  function pick() {
    const r = pickDisplay(screen, cfg);
    if (r.warn === "primary") log("primary");
    return r.display;
  }
  const show = () => {
    if (alive() && !win.isVisible()) win.showInactive(); // never focus
  };

  const api = {
    get chosen() {
      return chosen;
    },
    get hidden() {
      return hidden;
    },
    /** First choice. Returns the display, or null when none is safe (the caller exits). */
    start() {
      const d = pick();
      if (!d) return null;
      chosen = d.id;
      hidden = false;
      return d;
    },
    /** The page reported its content height (px). Returns the bounds set, or null. */
    fit(h) {
      content = Math.round(clamp(num(h, content), MIN_H, 20000));
      if (hidden || chosen == null) return null;
      const d = screen.getAllDisplays().find((x) => x.id === chosen);
      if (!d || !alive()) return null;
      const cur = win.getBounds();
      const want = fitBounds({ content, width, work: d.workArea, current: cur });
      if (Math.abs(want.height - cur.height) < 2 && want.x === cur.x && want.y === cur.y && want.width === cur.width) return null;
      win.setBounds(want);
      return want;
    },
    /** screen "display-removed". */
    removed(display) {
      if (!display || display.id !== chosen || hidden) return;
      hidden = true;
      if (alive()) win.hide();
      note("removed");
      // another fitting display may still exist (three screens): go there, never to the primary screen
      const d = pick();
      if (d && d.id !== display.id) api.added();
    },
    /** screen "display-added" (and a retry after a removal). */
    added() {
      if (!hidden) return;
      const d = pick();
      if (!d) return;
      chosen = d.id;
      hidden = false;
      place(d, false);
      show();
      note("");
    },
    /** screen "display-metrics-changed": resolution or arrangement changed; keep the window inside its work area. */
    metrics(display) {
      if (hidden || !display || display.id !== chosen || !alive()) return;
      place(display, true);
    },
    /** Connects the three events of an Electron `screen`. */
    attach() {
      screen.on("display-removed", (_e, d) => api.removed(d));
      screen.on("display-added", () => api.added());
      screen.on("display-metrics-changed", (_e, d) => api.metrics(d));
    },
  };
  return api;
}

/**
 * Registers global hotkeys and reports the ones that did not work.
 * items: [{ name, accel, run }]. Returns { ok: [name], failed: [{ name, accel, why }] }.
 * A false result from register (key taken by another app) and a throw (bad accelerator) both count as failed.
 */
function registerHotkeys(globalShortcut, items) {
  const ok = [];
  const failed = [];
  const used = new Map();
  for (const it of items) {
    if (!it || !it.accel) continue;
    if (used.has(it.accel)) {
      failed.push({ name: it.name, accel: it.accel, why: "duplicate" });
      continue;
    }
    used.set(it.accel, it.name);
    try {
      if (globalShortcut.register(it.accel, it.run)) ok.push(it.name);
      else failed.push({ name: it.name, accel: it.accel, why: "taken" });
    } catch {
      failed.push({ name: it.name, accel: it.accel, why: "invalid" });
    }
  }
  return { ok, failed };
}

/** The key names for a note, as the user knows them (Control = Ctrl, Alt = Opt). */
const fmtKey = (a) =>
  String(a || "")
    .split("+")
    .map((p) => ({ Control: "Ctrl", Alt: "Opt", Option: "Opt", Command: "Cmd" })[p] || p)
    .join("+");

/** One note line for the keys that failed, or "" when none. `t(key, vars)` is the string table of the UI language. */
function hotkeyNote(failed, t) {
  if (!failed.length) return "";
  return failed
    .slice(0, 3)
    .map((f) => t(f.why === "taken" ? "note.keyTaken" : "note.keyBad", { key: fmtKey(f.accel), name: t("hk." + f.name) }))
    .join(" · ");
}

module.exports = { MIN_H, fitBounds, inside, pickDisplay, createDisplayFollow, registerHotkeys, hotkeyNote, fmtKey };
