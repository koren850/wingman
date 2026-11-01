// Stage 0 answer window: watches calls/latest/cards.jsonl and shows the newest cards.
// No network, no listener; content is local text only. Opens on the second display if one exists.
const { app, BrowserWindow, screen, globalShortcut } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const CALLS = path.join(__dirname, "..", "calls");
// Settings arrive as JSON from src/overlay.ts (call.ts / pnpm overlay). Defaults here equal config/defaults.yaml.
const CFG = Object.assign({ enabled: true, display: "secondary", allowPrimary: false, contentProtection: true, fontPt: 30, maxCards: 4, hotkeys: { clear: "Control+Alt+C", pause: "Control+Alt+P" } },
  (() => { try { return JSON.parse(process.env.WINGMAN_OVERLAY || "{}"); } catch { return {}; } })());
let win, watchedFile, offset = 0, timer;

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
  const d = pickDisplay();
  if (!d) { app.exit(3); return; }
  const w = Math.min(760, d.workArea.width);
  win = new BrowserWindow({
    x: d.workArea.x + d.workArea.width - w - 20, y: d.workArea.y + 40, width: w, height: Math.min(900, d.workArea.height - 80),
    alwaysOnTop: true, frame: false, transparent: false, backgroundColor: "#111418", focusable: false, skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Content protection is ON but UNTESTED with Zoom; the second screen is the real protection.
  // overlay.contentProtection: false (WINGMAN_SHOW_IN_CAPTURE=1) turns it off for the Zoom share test.
  if (CFG.contentProtection) win.setContentProtection(true);
  win.loadFile(path.join(__dirname, "index.html"));
  win.webContents.on("did-finish-load", () => win.webContents.send("config", { maxCards: CFG.maxCards, fontPt: CFG.fontPt }));
  timer = setInterval(poll, 100);
  // S4: focusable:false means Esc never reaches the window, so clear/pause are global shortcuts.
  const ok1 = globalShortcut.register(CFG.hotkeys.clear, () => win && win.webContents.send("clear"));
  const ok2 = globalShortcut.register(CFG.hotkeys.pause, () => win && win.webContents.send("pause"));
  if (!ok1 || !ok2) console.error("Could not register global shortcuts (" + CFG.hotkeys.clear + " = clear, " + CFG.hotkeys.pause + " = pause).");
}

function poll() {
  let target;
  try { target = path.join(fs.realpathSync(path.join(CALLS, "latest")), "cards.jsonl"); } catch { return; }
  if (target !== watchedFile) { watchedFile = target; offset = 0; win.webContents.send("reset"); }
  let size;
  try { size = fs.statSync(target).size; } catch { return; }
  if (size <= offset) return;
  const fd = fs.openSync(target, "r");
  const buf = Buffer.alloc(size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  const text = buf.toString("utf8");
  const lastNl = text.lastIndexOf("\n");
  if (lastNl < 0) return;
  offset += Buffer.byteLength(text.slice(0, lastNl + 1));
  for (const line of text.slice(0, lastNl).split("\n")) {
    try { const c = JSON.parse(line); if (!c.hidden) win.webContents.send("card", c); } catch {}
  }
}

app.whenReady().then(create);
app.on("window-all-closed", () => { clearInterval(timer); globalShortcut.unregisterAll(); app.quit(); });
app.on("will-quit", () => globalShortcut.unregisterAll());
