// Answer window (Electron main): tails calls/latest/{cards,transcript}.jsonl and call.json every 100 ms and forwards rows to index.html over IPC (see preload.cjs).
// Started by src/overlay.ts (from call.ts or `pnpm overlay`). No network, no listener; content is local text only.
// Opens on the second display only: on one screen it refuses, because the window would show in a screen share.
const { app, BrowserWindow, screen, globalShortcut, clipboard, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { callPhase, pushCapture, registerCaptureKeys, unregisterCaptureKeys } = require("./lib.cjs");
// App icon from brand/ (rebuild with brand/build.sh). Missing file = Electron default icon.
const BRAND_ICON = path.join(__dirname, "..", "..", "brand", "png", "icon-512.png");

// WINGMAN_CALLS_DIR: point at a temp calls folder (snapshots/tests). WINGMAN_OVERLAY_SNAPSHOT=<png>: render hidden, save, quit.
const CALLS = process.env.WINGMAN_CALLS_DIR || path.join(__dirname, "..", "calls");
const SNAP = process.env.WINGMAN_OVERLAY_SNAPSHOT;
// Hidden snapshots: no Dock icon.
if (SNAP && process.platform === "darwin") { try { app.setActivationPolicy("accessory"); app.dock && app.dock.hide(); } catch { /* no dock */ } }
// Settings arrive as JSON from src/overlay.ts (call.ts / pnpm overlay). Defaults here equal config/defaults.yaml.
const CFG = Object.assign({ enabled: true, display: "secondary", allowPrimary: false, contentProtection: true, fontPt: 30, showLastLine: true, maxCards: 4, rewindSeconds: 30, hotkeys: { clear: "Control+Alt+C", pause: "Control+Alt+P", rewind: "Control+Alt+R", copy: "Control+Alt+K", checklist: "Control+Alt+L" } },
  (() => { try { return JSON.parse(process.env.WINGMAN_OVERLAY || "{}"); } catch { return {}; } })());
let win, timer, lastCapture, endedSent = false, endedCheckAt = 0, phaseKey = "", capList = [];
const captureKeys = [];   // Ctrl+Opt+1..3 held while the window runs
// Orphan guard: when the engine (call.ts) that opened this window dies, even by SIGKILL, its stdin pipe closes and its pid disappears: quit.
if (process.env.WINGMAN_WATCH_PARENT === "1") {
  const parent = process.ppid, bye = () => { try { globalShortcut.unregisterAll(); } catch {} app.exit(0); };
  process.stdin.on("end", bye); process.stdin.on("close", bye); process.stdin.on("error", bye); process.stdin.resume();
  setInterval(() => { try { process.kill(parent, 0); } catch { bye(); } if (process.ppid !== parent) bye(); }, 2000).unref();
}
// Tailed files of calls/latest: cards.jsonl (cards + captures) and transcript.jsonl (for the rewind panel).
const tails = { cards: { file: undefined, offset: 0 }, transcript: { file: undefined, offset: 0 } };

// With a single display the overlay would sit on the shared screen. Refuse unless overlay.allowPrimary (WINGMAN_ALLOW_PRIMARY=1).
function pickDisplay() {
  const all = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const second = all.find((d) => d.id !== primary.id);
  if (CFG.display === "primary" && CFG.allowPrimary) return primary;
  if (second) return second;
  if (CFG.allowPrimary) {
    console.error("\n!!! overlay.allowPrimary: only one display, the answer window is on the PRIMARY screen. Do NOT share this screen. !!!\n");
    return primary;
  }
  console.error("\n!!! Only one display found: refusing to open the answer window (it would be visible when you share your screen).\n    Connect a second screen, or set overlay.allowPrimary: true (WINGMAN_ALLOW_PRIMARY=1) if you will not share any screen. !!!\n");
  return null;
}

/** Builds the always-on-top, non-focusable (never steals focus from the call app) card window and registers the global hotkeys. Exits with code 3 if no safe display exists. */
function create() {
  // Snapshot mode needs no second screen: it never shows a window.
  const d = SNAP ? screen.getPrimaryDisplay() : pickDisplay();
  if (!d) { app.exit(3); return; }
  if (SNAP && app.dock) app.dock.hide();
  const w = SNAP ? 760 : Math.min(760, d.workArea.width);
  if (process.platform === "darwin" && app.dock && require("node:fs").existsSync(BRAND_ICON)) app.dock.setIcon(BRAND_ICON);
  win = new BrowserWindow({
    x: d.workArea.x + d.workArea.width - w - 20, y: d.workArea.y + 40, width: w, height: SNAP ? 900 : Math.min(900, d.workArea.height - 80),
    show: !SNAP, paintWhenInitiallyHidden: true,
    alwaysOnTop: true, frame: false, transparent: false, backgroundColor: "#111418", focusable: false, skipTaskbar: true,
    icon: BRAND_ICON,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  if (!SNAP) { win.setAlwaysOnTop(true, "floating"); win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); }
  // Content protection is ON but UNTESTED with Zoom; the second screen is the real protection.
  // overlay.contentProtection: false (WINGMAN_SHOW_IN_CAPTURE=1) turns it off for the Zoom share test.
  if (CFG.contentProtection) win.setContentProtection(true);
  win.loadFile(path.join(__dirname, "index.html"));
  // Poll only after the page has its listeners; a reload replays the call files from the start.
  win.webContents.on("did-finish-load", () => {
    win.webContents.send("config", { maxCards: CFG.maxCards, fontPt: CFG.fontPt, showLastLine: CFG.showLastLine !== false, rewindSeconds: CFG.rewindSeconds, hotkeys: CFG.hotkeys });
    tails.cards = { file: undefined, offset: 0 }; tails.transcript = { file: undefined, offset: 0 }; capList = []; phaseKey = "";
    clearInterval(timer); timer = setInterval(poll, 100);
  });
  // focusable:false means Esc never reaches the window, so clear/pause are global shortcuts.
  if (SNAP) { snapshotMode(); return; }
  const ok1 = globalShortcut.register(CFG.hotkeys.clear, () => win && win.webContents.send("clear"));
  const ok2 = globalShortcut.register(CFG.hotkeys.pause, () => win && win.webContents.send("pause"));
  const ok3 = globalShortcut.register(CFG.hotkeys.rewind, () => win && win.webContents.send("rewind"));
  const ok4 = globalShortcut.register(CFG.hotkeys.copy, () => { if (lastCapture) copyValue(lastCapture); });
  const ok5 = !CFG.hotkeys.checklist || globalShortcut.register(CFG.hotkeys.checklist, () => win && win.webContents.send("checklist"));
  if (!ok1 || !ok2 || !ok3 || !ok4 || !ok5) console.error("Could not register some global shortcuts (" + Object.entries(CFG.hotkeys).map(([k, v]) => v + " = " + k).join(", ") + ").");
  // Ctrl+Opt+1..3 copy chip N (newest first). Tray registers Return/N/A only, so no collision.
  captureKeys.push(...registerCaptureKeys(globalShortcut, () => capList, copyValue, Object.values(CFG.hotkeys)));
  // Click on a captured item copies it (the window never takes focus).
  ipcMain.on("copy", (_e, text) => { if (typeof text === "string" && text.length < 200) copyValue(text); });
}

/** Puts text on the clipboard and tells the page so it can flash "copied". */
function copyValue(text) { clipboard.writeText(text); win && win.webContents.send("copied", text); }

// Snapshot: replay the calls folder, optionally fire hotkey events (WINGMAN_OVERLAY_SNAPSHOT_KEYS="rewind,pause"), wait, save, quit.
function snapshotMode() {
  const keys = String(process.env.WINGMAN_OVERLAY_SNAPSHOT_KEYS || "").split(",").filter(Boolean);
  win.webContents.once("did-finish-load", () => {
    setTimeout(() => keys.forEach((k) => win.webContents.send(k)), 900);
    // key "late": a new answer arrives after the other keys (e.g. while the rewind sheet is open)
    if (keys.includes("late")) setTimeout(() => win.webContents.send("card", { type: "card", id: "late-ai", turnId: "late", badge: "ai", question: "ומה לגבי המחיר?", say: "המחיר תלוי בהיקף, בערך 8,000 ₪ + מע״מ.", facts: [], at: Date.now() }), 1300);
    setTimeout(async () => { fs.writeFileSync(SNAP, (await win.webContents.capturePage()).toPNG()); app.quit(); }, 2200);
  });
}

/** One 100 ms tick: follows calls/latest (a new call dir resets the page), forwards new cards/captures/lines, and checks call.json at most once a second. */
function poll() {
  let dir;
  try { dir = fs.realpathSync(path.join(CALLS, "latest")); } catch { return; }
  const cardsFile = path.join(dir, "cards.jsonl");
  if (cardsFile !== tails.cards.file) { tails.cards = { file: cardsFile, offset: 0 }; tails.transcript = { file: path.join(dir, "transcript.jsonl"), offset: 0 }; lastCapture = undefined; capList = []; phaseKey = ""; endedSent = false; win.webContents.send("reset"); }
  for (const c of readNew(tails.cards)) {
    if (c.type === "capture") { lastCapture = c.value; capList = pushCapture(capList, c.value); win.webContents.send("capture", c); }
    else if (c.type === "ask") win.webContents.send("ask", { on: !!c.on, until: Number(c.until) || 0 });
    else if (c.type === "frame") { if (c.frame && typeof c.frame === "object") win.webContents.send("frame", c.frame); }
    else if (!c.hidden) win.webContents.send("card", c);
  }
  for (const l of readNew(tails.transcript)) win.webContents.send("line", { t: l.t, ch: l.ch, text: l.text });
  // call.json: the real call phase (starting / waiting / live / ended). Sent when it changes; {phase:null} = no phase written, the page falls back to its timer.
  if (!endedSent && Date.now() - endedCheckAt > 1000) {
    endedCheckAt = Date.now();
    let raw = "";
    try { raw = fs.readFileSync(path.join(dir, "call.json"), "utf8"); } catch {}
    const p = callPhase(raw);
    if (p) {
      const key = p.phase + ":" + p.liveAt;
      if (key !== phaseKey) { phaseKey = key; win.webContents.send("phase", p); }
      if (p.phase === "ended") { endedSent = true; capList = []; win.webContents.send("ended"); }
    }
  }
}

/** New complete JSONL rows since the last read. A half-written last line is left for the next tick (offset only advances past the last newline). */
function readNew(tail) {
  let size;
  try { size = fs.statSync(tail.file).size; } catch { return []; }
  if (size <= tail.offset) return [];
  const fd = fs.openSync(tail.file, "r");
  const buf = Buffer.alloc(size - tail.offset);
  fs.readSync(fd, buf, 0, buf.length, tail.offset);
  fs.closeSync(fd);
  const text = buf.toString("utf8");
  const lastNl = text.lastIndexOf("\n");
  if (lastNl < 0) return [];
  tail.offset += Buffer.byteLength(text.slice(0, lastNl + 1));
  const rows = [];
  for (const line of text.slice(0, lastNl).split("\n")) { try { rows.push(JSON.parse(line)); } catch {} }
  return rows;
}

app.whenReady().then(create);
app.on("window-all-closed", () => { clearInterval(timer); unregisterCaptureKeys(globalShortcut, captureKeys); globalShortcut.unregisterAll(); app.quit(); });
app.on("will-quit", () => { unregisterCaptureKeys(globalShortcut, captureKeys); globalShortcut.unregisterAll(); });
