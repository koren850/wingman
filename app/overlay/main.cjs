// Answer window (Electron main): tails calls/latest/{cards,transcript}.jsonl and call.json every 100 ms and forwards rows to index.html over IPC (see preload.cjs).
// Started by src/overlay.ts (from call.ts or `pnpm overlay`). No network, no listener; content is local text only.
// Opens on the second display only: on one screen it refuses, because the window would show in a screen share.
const { app, BrowserWindow, screen, globalShortcut, clipboard, ipcMain } = require("electron");
require("../shared/permissions.cjs").install(app); // no browser permission is ever granted to a window
const fs = require("node:fs");
const path = require("node:path");
const { callPhase, pushCapture, registerCaptureKeys, unregisterCaptureKeys, readShown, writeShown, makeBye } = require("./lib.cjs");
const { readNewRows, rowKey, Seen, StdinRows, Backlog, ReloadGate } = require("./resilient.cjs");
const { createMemoryFeed } = require("./memfeed.cjs");
const { applyAct } = require("./act.cjs");
const { createDisplayFollow, pickDisplay: pickSafeDisplay, registerHotkeys, hotkeyNote, hotkeyItems, DEFAULT_HOTKEYS } = require("./window.cjs");
const STR = require("./strings.js");

// A crash in this process must never raise Electron's error dialog (it could appear on a shared screen): log one line and carry on.
const logErr = (what, e) => {
  try {
    console.error(`(answer window: ${what}: ${String((e && e.message) || e).slice(0, 200)})`);
  } catch {
    /* stderr gone */
  }
};
process.on("uncaughtException", (e) => logErr("uncaught exception", e));
process.on("unhandledRejection", (e) => logErr("unhandled rejection", e));
// App icon from brand/ (rebuild with brand/build.sh). Missing file = Electron default icon.
const BRAND_ICON = path.join(__dirname, "..", "..", "brand", "png", "icon-512.png");

// WINGMAN_CALLS_DIR: point at a temp calls folder (snapshots/tests). WINGMAN_OVERLAY_SNAPSHOT=<png>: render hidden, save, quit.
const CALLS = require("../shared/paths.cjs").callsDir();
const STATE_DIR = path.dirname(CALLS); // the overlay's own state file (cards shown so far) sits beside calls/
const SNAP = process.env.WINGMAN_OVERLAY_SNAPSHOT;
let cardsShown = SNAP ? 0 : readShown(fs, path, STATE_DIR); // snapshots never read or write the real state
// Hidden snapshots: no Dock icon.
if (SNAP && process.platform === "darwin") {
  try {
    app.setActivationPolicy("accessory");
    app.dock && app.dock.hide();
  } catch {
    /* no dock */
  }
}
// Settings arrive as JSON from src/overlay.ts (call.ts / pnpm overlay). Defaults here equal config/defaults.yaml.
const CFG = Object.assign(
  {
    enabled: true,
    display: "secondary",
    allowPrimary: false,
    contentProtection: true,
    layout: "focus",
    fontPt: 30,
    language: "he",
    showLastLine: true,
    liveTextPt: 22,
    maxCards: 4,
    rewindSeconds: 30,
    theme: "dark", // dark | light | auto
    textSize: "m", // s | m | l
    hotkeys: {},
  },
  (() => {
    try {
      return JSON.parse(process.env.WINGMAN_OVERLAY || "{}");
    } catch {
      return {};
    }
  })(),
);
// Hotkeys: the settings may name only some; the rest keep these defaults. The last six reach the hero card from the keyboard (the window never takes focus, so Tab cannot).
CFG.hotkeys = { ...DEFAULT_HOTKEYS, ...(CFG.hotkeys && typeof CFG.hotkeys === "object" ? CFG.hotkeys : {}) };
const THEME = ["dark", "light", "auto"].includes(process.env.WINGMAN_OVERLAY_THEME || CFG.theme) ? process.env.WINGMAN_OVERLAY_THEME || CFG.theme : "dark";
const TEXT_SIZE = ["s", "m", "l"].includes(process.env.WINGMAN_OVERLAY_SIZE || CFG.textSize) ? process.env.WINGMAN_OVERLAY_SIZE || CFG.textSize : "m";
// UI language of the window: "he" (default, existing behaviour) or "en". src/overlay.ts resolves ui.language=auto before it spawns the window; WINGMAN_OVERLAY_LANG overrides it (snapshots).
const LANGUAGE = (process.env.WINGMAN_OVERLAY_LANG || CFG.language) === "en" ? "en" : "he";
// Layout: "focus" (default) or "full". WINGMAN_OVERLAY_LAYOUT overrides it (snapshots).
const LAYOUT = (process.env.WINGMAN_OVERLAY_LAYOUT || CFG.layout) === "full" ? "full" : "focus";
const tn = (key, vars) => STR.t(LANGUAGE, key, vars);
const DATA = require("../shared/paths.cjs").dataDir();
/** The note for the tray and the window: a taken hotkey, a lost display. kind "" clears it. The tray reads overlay-note.json in the data folder. */
function setNote(kind, text) {
  if (SNAP) return;
  const file = path.join(DATA, "overlay-note.json");
  try {
    if (!text) fs.rmSync(file, { force: true });
    else {
      fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify({ t: Date.now(), kind, text }) + "\n", { mode: 0o600 });
    }
  } catch (e) {
    logErr("note", e);
  }
  try {
    if (win && !win.isDestroyed()) win.webContents.send("note", { kind, text });
  } catch {
    /* page gone */
  }
}
const mem = createMemoryFeed({ send: (row) => win && !win.isDestroyed() && win.webContents.send("card", row) });
let currentDir = "",
  memAt = 0;
let keyNote = ""; // the note about hotkeys that did not register; shown again when the page reloads
let win,
  timer,
  lastCapture,
  endedSent = false,
  endedCheckAt = 0,
  phaseKey = "",
  hangTimer,
  reloadTimer,
  parentTimer,
  capList = [];
const captureKeys = []; // Ctrl+Opt+1..3 held while the window runs
// Orphan guard: when the engine (call.ts) that opened this window dies, even by SIGKILL, its stdin pipe closes and its pid disappears: quit.
if (process.env.WINGMAN_WATCH_PARENT === "1") {
  const parent = process.ppid,
    bye = makeBye({
      timers: () => [timer, hangTimer, reloadTimer, parentTimer],
      follow: () => follow,
      unregister: () => globalShortcut.unregisterAll(),
      exit: (c) => app.exit(c),
    });
  process.stdin.on("end", bye);
  process.stdin.on("close", bye);
  process.stdin.on("error", bye);
  // The same pipe also carries the engine's card rows (second path, for when cards.jsonl cannot be written): one JSON row per line.
  const pipeRows = new StdinRows();
  process.stdin.on("data", (b) => {
    try {
      for (const r of pipeRows.push(b)) onPipeRow(r);
    } catch (e) {
      logErr("pipe", e);
    }
  });
  process.stdin.resume();
  parentTimer = setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      bye();
    }
    if (process.ppid !== parent) bye();
  }, 2000);
  parentTimer.unref();
}
// Tailed files of calls/latest: cards.jsonl (cards + captures) and transcript.jsonl (for the rewind panel).
/** @type {Record<"cards" | "transcript" | "live", { file: string | undefined, offset: number }>} */
const tails = { cards: { file: undefined, offset: 0 }, transcript: { file: undefined, offset: 0 }, live: { file: undefined, offset: 0 } };

// With a single display the overlay would sit on the shared screen. Refuse unless overlay.allowPrimary (WINGMAN_ALLOW_PRIMARY=1).
// overlay/window.cjs decides (and follows the display when it is unplugged); this wrapper only prints the warnings.
let follow;
function pickDisplay() {
  const r = pickSafeDisplay(screen, CFG);
  if (r.warn === "primary")
    console.error("\n!!! overlay.allowPrimary: only one display, the answer window is on the PRIMARY screen. Do NOT share this screen. !!!\n");
  if (r.warn === "single")
    console.error(
      "\n!!! Only one display found: refusing to open the answer window (it would be visible when you share your screen).\n    Connect a second screen, or set overlay.allowPrimary: true (WINGMAN_ALLOW_PRIMARY=1) if you will not share any screen. !!!\n",
    );
  return r.display;
}

/** Builds the always-on-top, non-focusable (never steals focus from the call app) card window and registers the global hotkeys. Exits with code 3 if no safe display exists. */
function create() {
  // Snapshot mode needs no second screen: it never shows a window.
  let d;
  if (SNAP) d = screen.getPrimaryDisplay();
  else {
    d = pickDisplay();
    if (d) {
      // a second look at the choice by the display follower (it owns the display id from now on)
      follow = createDisplayFollow({
        screen,
        win: {
          isDestroyed: () => !win || win.isDestroyed(),
          hide: () => win.hide(),
          showInactive: () => win.showInactive(),
          setBounds: (b) => win.setBounds(b),
          getBounds: () => win.getBounds(),
          isVisible: () => win.isVisible(),
        },
        cfg: CFG,
        note: (kind) => (kind ? setNote("display", tn("note.displayGone")) : keyNote ? setNote("hotkey", keyNote) : setNote("", "")), // when the display is back, a hotkey note that still holds is shown again
        log: () => {},
      });
      follow.start();
    }
  }
  if (!d) {
    app.exit(3);
    return;
  }
  if (SNAP && app.dock) app.dock.hide();
  const w = SNAP ? 760 : Math.min(760, d.workArea.width);
  if (process.platform === "darwin" && app.dock && require("node:fs").existsSync(BRAND_ICON)) app.dock.setIcon(BRAND_ICON);
  win = new BrowserWindow({
    x: d.workArea.x + d.workArea.width - w - 20,
    y: d.workArea.y + 40,
    width: w,
    height: SNAP ? 900 : Math.min(240, d.workArea.height - 80), // the page reports its content height right after load (the "size" channel)
    show: false,
    paintWhenInitiallyHidden: true,
    alwaysOnTop: true,
    frame: false,
    transparent: false,
    backgroundColor: "#111418",
    focusable: false,
    skipTaskbar: true,
    icon: BRAND_ICON,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  if (!SNAP) {
    win.setAlwaysOnTop(true, "floating");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  // Content protection is ON but UNTESTED with Zoom; the second screen is the real protection.
  // overlay.contentProtection: false (WINGMAN_SHOW_IN_CAPTURE=1) turns it off for the Zoom share test.
  if (CFG.contentProtection) win.setContentProtection(true);
  win.loadFile(path.join(__dirname, "index.html"), { query: { lang: LANGUAGE, layout: LAYOUT, theme: THEME, size: TEXT_SIZE, ...(SNAP ? {} : { fit: "1" }) } }); // ?lang= and ?layout= let the page draw its first frame right (no inline script: CSP)
  // Poll only after the page has its listeners; a reload replays the call files from the start.
  win.webContents.on("did-finish-load", () => {
    win.webContents.send("config", {
      language: LANGUAGE,
      maxCards: CFG.maxCards,
      layout: LAYOUT,
      theme: THEME,
      textSize: TEXT_SIZE,
      fontPt: CFG.fontPt,
      showLastLine: CFG.showLastLine !== false,
      liveTextPt: CFG.liveTextPt,
      rewindSeconds: CFG.rewindSeconds,
      hotkeys: CFG.hotkeys,
      cardsShown,
      fit: !SNAP,
    });
    if (!SNAP && win && !win.isVisible() && !(follow && follow.hidden)) win.showInactive(); // shown once the page is ready, never focused
    tails.cards = { file: undefined, offset: 0 };
    tails.transcript = { file: undefined, offset: 0 };
    tails.live = { file: undefined, offset: 0 };
    capList = [];
    phaseKey = "";
    mem.reset();
    memAt = 0;
    pageReady = true;
    if (keyNote) win.webContents.send("note", { kind: "hotkey", text: keyNote });
    replayBacklog(); // rows that only came by the pipe come back after a reload
    clearInterval(timer);
    timer = setInterval(poll, 100);
  });
  // Crash and hang handling: the page is reloaded (it replays the call from the files and the pipe backlog); never an error dialog, never a closed window.
  const gate = new ReloadGate();
  const reloadSoon = (why) => {
    pageReady = false;
    clearInterval(timer);
    logErr("page " + why + "; reloading", "");
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      try {
        if (win && !win.isDestroyed()) win.webContents.reload();
      } catch (e) {
        logErr("reload", e);
      }
    }, gate.next());
  };
  win.webContents.on("render-process-gone", (_e, d) => {
    clearInterval(timer); // the page is dead: the 100 ms poll must not send to it until the reload has set it up again (did-finish-load restarts it)
    reloadSoon("process gone (" + (d && d.reason) + ")");
  });
  win.webContents.on("did-fail-load", (_e, code, desc, _url, isMain) => {
    if (isMain && code !== -3) reloadSoon("failed to load (" + desc + ")");
  });
  win.on("unresponsive", () => {
    logErr("page unresponsive", "");
    clearTimeout(hangTimer);
    hangTimer = setTimeout(() => {
      try {
        win.webContents.forcefullyCrashRenderer();
      } catch {
        reloadSoon("hung");
      }
    }, 8000); // still hung after 8 s: kill the page (render-process-gone reloads it)
  });
  win.on("responsive", () => clearTimeout(hangTimer));
  // focusable:false means Esc never reaches the window, so clear/pause are global shortcuts.
  if (SNAP) {
    snapshotMode();
    return;
  }
  // Every register() result is checked: a key another app already owns shows a note in the window and in the tray note file, never silence.
  const to = (ch, payload) => () => win && !win.isDestroyed() && win.webContents.send(ch, payload);
  const HK = CFG.hotkeys;
  const reg = registerHotkeys(
    globalShortcut,
    hotkeyItems(HK, {
      page: to,
      copyLast: () => {
        if (lastCapture) copyValue(lastCapture);
      },
    }),
  );
  if (reg.failed.length) {
    console.error("Could not register some global shortcuts: " + reg.failed.map((f) => `${f.accel} (${f.name}, ${f.why})`).join(", ") + ".");
    keyNote = hotkeyNote(reg.failed, tn);
    setNote("hotkey", keyNote);
  } else setNote("", "");
  if (follow) follow.attach();
  ipcMain.on("size", (_e, h) => {
    if (typeof h !== "number" || !Number.isFinite(h) || !follow) return;
    follow.fit(h);
    if (!follow.hidden && win && !win.isDestroyed() && !win.isVisible()) win.showInactive();
  });
  // Ctrl+Opt+1..3 copy chip N (newest first). Tray registers Return/N/A only, so no collision.
  captureKeys.push(...registerCaptureKeys(globalShortcut, () => capList, copyValue, Object.values(CFG.hotkeys)));
  // Click on a captured item copies it (the window never takes focus).
  ipcMain.on("copy", (_e, text) => {
    if (typeof text === "string" && text.length < 200) copyValue(text);
  });
  // The page counts new hero cards; the total lives in the state file so the key hints stay hidden after the first few cards of the app's life.
  ipcMain.on("shown", (_e, n) => {
    if (SNAP || !Number.isInteger(n) || n < 1 || n > 1000) return;
    cardsShown += n;
    writeShown(fs, path, STATE_DIR, cardsShown);
  });
  // Card controls from the page (rate, pin, dismiss, recap). Validated again; saved to the call folder; a failure is logged, never shown over the call.
  ipcMain.on("act", (_e, m) => {
    if (!currentDir) return;
    const r = applyAct(currentDir, m, Date.now());
    if (!r.ok) logErr("act", r.error);
  });
}

/** Puts text on the clipboard and tells the page so it can flash "copied". */
function copyValue(text) {
  clipboard.writeText(text);
  win && win.webContents.send("copied", text);
}

// Snapshot: replay the calls folder, optionally fire hotkey events (WINGMAN_OVERLAY_SNAPSHOT_KEYS="rewind,pause"), wait, save, quit.
function snapshotMode() {
  const keys = String(process.env.WINGMAN_OVERLAY_SNAPSHOT_KEYS || "")
    .split(",")
    .filter(Boolean);
  win.webContents.once("did-finish-load", () => {
    setTimeout(() => keys.forEach((k) => win.webContents.send(k)), 900);
    // key "late": a new answer arrives after the other keys (e.g. while the rewind sheet is open)
    if (keys.includes("late"))
      setTimeout(
        () =>
          win.webContents.send("card", {
            type: "card",
            id: "late-ai",
            turnId: "late",
            badge: "ai",
            question: "ומה לגבי המחיר?",
            say: "המחיר תלוי בהיקף, בערך 8,000 ₪ + מע״מ.",
            facts: [],
            at: Date.now(),
          }),
        1300,
      );
    setTimeout(async () => {
      fs.writeFileSync(String(SNAP), (await win.webContents.capturePage()).toPNG());
      app.quit();
    }, 2200);
  });
}

// Cards reach the page by two paths: cards.jsonl (tailed by poll) and the engine's pipe on stdin. `seen` makes each row show once.
const seen = new Seen(),
  backlog = new Backlog();
let pageReady = false;
function onPipeRow(c) {
  if (!c || typeof c !== "object") return;
  backlog.add(c);
  if (!seen.add(rowKey(c))) return; // the disk path already delivered it
  if (!pageReady) return; // the backlog above keeps it: replayBacklog() sends it when the page is ready (a second buffer here grew without end)
  try {
    handleCardRow(c);
  } catch (e) {
    logErr("card row", e);
  }
}
/** After the page was reset (new call, reload): rows that came by the pipe come back (they may not be on disk), then disk rows fill in. */
function replayBacklog() {
  seen.clear();
  for (const c of backlog.all()) {
    if (seen.add(rowKey(c))) {
      try {
        handleCardRow(c);
      } catch (e) {
        logErr("card row", e);
      }
    }
  }
}
/** Sends one cards.jsonl row to the page. */
function handleCardRow(c) {
  if (c.type === "capture") {
    lastCapture = c.value;
    capList = pushCapture(capList, c.value);
    win.webContents.send("capture", c);
  } else if (c.type === "ask") win.webContents.send("ask", { on: !!c.on, until: Number(c.until) || 0 });
  else if (c.type === "speaker") {
    if (Number.isInteger(c.spk)) win.webContents.send("speaker", { spk: c.spk, name: typeof c.name === "string" ? c.name.slice(0, 40) : "" });
  } else if (c.type === "flow")
    win.webContents.send("flow", {
      state: c.state === "internal" ? "internal" : "open",
      who: Array.isArray(c.who)
        ? c.who
            .filter((w) => typeof w === "string")
            .slice(0, 6)
            .map((w) => w.slice(0, 40))
        : [],
      topic: typeof c.topic === "string" ? c.topic.slice(0, 160) : "",
    });
  else if (c.type === "addressed")
    win.webContents.send("addressed", {
      who: typeof c.who === "string" ? c.who.slice(0, 40) : "",
      text: typeof c.text === "string" ? c.text.slice(0, 200) : "",
    });
  else if (c.type === "frame") {
    if (c.frame && typeof c.frame === "object") win.webContents.send("frame", c.frame);
  } else if (c.type === "memory") mem.fromRow(c);
  else if (c.type === "nudge") {
    // a live nudge (coach.nudges): numbers only, the window writes the words. An old row (a replay after a reload) is not shown.
    const kind = ["pace", "share", "interrupt"].includes(c.kind) ? c.kind : "";
    const fresh = !Number.isFinite(c.at) || Date.now() - c.at < 30000;
    if (kind && fresh)
      win.webContents.send("nudge", {
        kind,
        value: Math.max(0, Math.min(1000, Math.round(Number(c.value) || 0))),
        limit: Math.max(0, Math.min(1000, Math.round(Number(c.limit) || 0))),
      });
  } else if (c.type === "recap") {
    const p = mem.recap(c);
    if (p) win.webContents.send("recap", p);
  } else if (!c.hidden) {
    if (c.health) mem.health(c); // the AI paused / offline pill follows the engine's health bars
    win.webContents.send("card", c);
  }
}

/** One 100 ms tick: follows calls/latest (a new call dir resets the page), forwards new cards/captures/lines, and checks call.json at most once a second. */
function poll() {
  try {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) pollOnce();
  } catch (e) {
    logErr("poll", e);
  } // one bad tick must not stop the card feed
}
function pollOnce() {
  let dir;
  try {
    dir = fs.realpathSync(path.join(CALLS, "latest"));
  } catch {
    return;
  }
  const cardsFile = path.join(dir, "cards.jsonl");
  if (cardsFile !== tails.cards.file) {
    tails.cards = { file: cardsFile, offset: 0 };
    tails.transcript = { file: path.join(dir, "transcript.jsonl"), offset: 0 };
    tails.live = { file: path.join(dir, "live.jsonl"), offset: 0 };
    lastCapture = undefined;
    capList = [];
    phaseKey = "";
    endedSent = false;
    currentDir = dir;
    mem.reset();
    memAt = 0;
    win.webContents.send("reset");
    replayBacklog();
  }
  for (const c of readNewRows(tails.cards)) {
    if (seen.add(rowKey(c))) handleCardRow(c);
  }
  if (Date.now() - memAt > 1000) {
    memAt = Date.now();
    mem.fromDir(dir); // session.json: the call memory, once a second
  }
  const partials = readNewRows(tails.live);
  const p = partials[partials.length - 1]; // only the newest words matter
  if (p) win.webContents.send("partial", { t: p.t, ch: p.ch, text: p.text, spk: p.spk, name: p.name });
  for (const l of readNewRows(tails.transcript)) win.webContents.send("line", { t: l.t, ch: l.ch, text: l.text, spk: l.spk, name: l.name });
  // call.json: the real call phase (starting / waiting / live / ended). Sent when it changes; {phase:null} = no phase written, the page falls back to its timer.
  if (!endedSent && Date.now() - endedCheckAt > 1000) {
    endedCheckAt = Date.now();
    let raw = "";
    try {
      raw = fs.readFileSync(path.join(dir, "call.json"), "utf8");
    } catch {}
    const p = callPhase(raw);
    if (p) {
      const key = p.phase + ":" + p.liveAt;
      if (key !== phaseKey) {
        phaseKey = key;
        win.webContents.send("phase", p);
      }
      if (p.phase === "ended") {
        endedSent = true;
        capList = [];
        win.webContents.send("ended");
      }
    }
  }
}

app.whenReady().then(create);
app.on("window-all-closed", () => {
  clearInterval(timer);
  unregisterCaptureKeys(globalShortcut, captureKeys);
  globalShortcut.unregisterAll();
  app.quit();
});
app.on("will-quit", () => {
  unregisterCaptureKeys(globalShortcut, captureKeys);
  globalShortcut.unregisterAll();
});
