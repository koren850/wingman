// Stage 0 answer window: watches calls/latest/cards.jsonl and shows the newest cards.
// No network, no listener; content is local text only. Opens on the second display if one exists.
const { app, BrowserWindow, screen, globalShortcut, clipboard, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
// App icon from brand/ (rebuild with brand/build.sh). Missing file = Electron default icon.
const BRAND_ICON = path.join(__dirname, "..", "..", "brand", "png", "icon-512.png");

// WINGMAN_CALLS_DIR: point at a temp calls folder (snapshots/tests). WINGMAN_OVERLAY_SNAPSHOT=<png>: render hidden, save, quit.
const CALLS = process.env.WINGMAN_CALLS_DIR || path.join(__dirname, "..", "calls");
const SNAP = process.env.WINGMAN_OVERLAY_SNAPSHOT;
// Settings arrive as JSON from src/overlay.ts (call.ts / pnpm overlay). Defaults here equal config/defaults.yaml.
const CFG = Object.assign({ enabled: true, display: "secondary", allowPrimary: false, contentProtection: true, fontPt: 30, maxCards: 4, rewindSeconds: 30, hotkeys: { clear: "Control+Alt+C", pause: "Control+Alt+P", rewind: "Control+Alt+R", copy: "Control+Alt+K" } },
  (() => { try { return JSON.parse(process.env.WINGMAN_OVERLAY || "{}"); } catch { return {}; } })());
let win, timer, lastCapture;
// Tailed files of calls/latest: cards.jsonl (cards + captures) and transcript.jsonl (for the rewind panel).
const tails = { cards: { file: undefined, offset: 0 }, transcript: { file: undefined, offset: 0 } };

// S3: with a single display the overlay would sit on the shared screen. Refuse unless overlay.allowPrimary (WINGMAN_ALLOW_PRIMARY=1).
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
    win.webContents.send("config", { maxCards: CFG.maxCards, fontPt: CFG.fontPt, rewindSeconds: CFG.rewindSeconds, hotkeys: CFG.hotkeys });
    tails.cards = { file: undefined, offset: 0 }; tails.transcript = { file: undefined, offset: 0 };
    clearInterval(timer); timer = setInterval(poll, 100);
  });
  // S4: focusable:false means Esc never reaches the window, so clear/pause are global shortcuts.
  if (SNAP) { snapshotMode(); return; }
  const ok1 = globalShortcut.register(CFG.hotkeys.clear, () => win && win.webContents.send("clear"));
  const ok2 = globalShortcut.register(CFG.hotkeys.pause, () => win && win.webContents.send("pause"));
  const ok3 = globalShortcut.register(CFG.hotkeys.rewind, () => win && win.webContents.send("rewind"));
  const ok4 = globalShortcut.register(CFG.hotkeys.copy, () => { if (lastCapture) { clipboard.writeText(lastCapture); win && win.webContents.send("copied", lastCapture); } });
  if (!ok1 || !ok2 || !ok3 || !ok4) console.error("Could not register some global shortcuts (" + Object.entries(CFG.hotkeys).map(([k, v]) => v + " = " + k).join(", ") + ").");
  // Click on a captured item copies it (the window never takes focus).
  ipcMain.on("copy", (_e, text) => { if (typeof text === "string" && text.length < 200) { clipboard.writeText(text); win && win.webContents.send("copied", text); } });
}

// Snapshot: replay the calls folder, optionally fire hotkey events (WINGMAN_OVERLAY_SNAPSHOT_KEYS="rewind,pause"), wait, save, quit.
function snapshotMode() {
  const keys = String(process.env.WINGMAN_OVERLAY_SNAPSHOT_KEYS || "").split(",").filter(Boolean);
  win.webContents.once("did-finish-load", () => {
    setTimeout(() => keys.forEach((k) => win.webContents.send(k)), 900);
    setTimeout(async () => { fs.writeFileSync(SNAP, (await win.webContents.capturePage()).toPNG()); app.quit(); }, 2200);
  });
}

function poll() {
  let dir;
  try { dir = fs.realpathSync(path.join(CALLS, "latest")); } catch { return; }
  const cardsFile = path.join(dir, "cards.jsonl");
  if (cardsFile !== tails.cards.file) { tails.cards = { file: cardsFile, offset: 0 }; tails.transcript = { file: path.join(dir, "transcript.jsonl"), offset: 0 }; lastCapture = undefined; win.webContents.send("reset"); }
  for (const c of readNew(tails.cards)) {
    if (c.type === "capture") { lastCapture = c.value; win.webContents.send("capture", c); }
    else if (!c.hidden) win.webContents.send("card", c);
  }
  for (const l of readNew(tails.transcript)) win.webContents.send("line", { t: l.t, ch: l.ch, text: l.text });
}

/** New complete JSONL rows since the last read. */
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
app.on("window-all-closed", () => { clearInterval(timer); globalShortcut.unregisterAll(); app.quit(); });
app.on("will-quit", () => globalShortcut.unregisterAll());
