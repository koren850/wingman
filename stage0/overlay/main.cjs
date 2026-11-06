// Answer window (Electron main): tails calls/latest/{cards,transcript}.jsonl and call.json every 100 ms and forwards rows to index.html over IPC (see preload.cjs).
// Started by src/overlay.ts (from call.ts or `pnpm overlay`). No network, no listener; content is local text only.
// Opens on the second display only: on one screen it refuses, because the window would show in a screen share.
const { app, BrowserWindow, screen, globalShortcut, clipboard, ipcMain } = require("electron");
require("../shared/permissions.cjs").install(app);   // no browser permission is ever granted to a window
const fs = require("node:fs");
const path = require("node:path");
const { callPhase, pushCapture, registerCaptureKeys, unregisterCaptureKeys } = require("./lib.cjs");
const { readNewRows, rowKey, Seen, StdinRows, Backlog, ReloadGate } = require("./resilient.cjs");

// A crash in this process must never raise Electron's error dialog (it could appear on a shared screen): log one line and carry on.
const logErr = (what, e) => { try { console.error(`(answer window: ${what}: ${String((e && e.message) || e).slice(0, 200)})`); } catch { /* stderr gone */ } };
process.on("uncaughtException", (e) => logErr("uncaught exception", e));
process.on("unhandledRejection", (e) => logErr("unhandled rejection", e));
// App icon from brand/ (rebuild with brand/build.sh). Missing file = Electron default icon.
const BRAND_ICON = path.join(__dirname, "..", "..", "brand", "png", "icon-512.png");

// WINGMAN_CALLS_DIR: point at a temp calls folder (snapshots/tests). WINGMAN_OVERLAY_SNAPSHOT=<png>: render hidden, save, quit.
const CALLS = require("../shared/paths.cjs").callsDir();
const SNAP = process.env.WINGMAN_OVERLAY_SNAPSHOT;
// Hidden snapshots: no Dock icon.
if (SNAP && process.platform === "darwin") { try { app.setActivationPolicy("accessory"); app.dock && app.dock.hide(); } catch { /* no dock */ } }
// Settings arrive as JSON from src/overlay.ts (call.ts / pnpm overlay). Defaults here equal config/defaults.yaml.
const CFG = Object.assign({ enabled: true, display: "secondary", allowPrimary: false, contentProtection: true, fontPt: 30, showLastLine: true, liveTextPt: 22, maxCards: 4, rewindSeconds: 30, hotkeys: { clear: "Control+Alt+C", pause: "Control+Alt+P", rewind: "Control+Alt+R", copy: "Control+Alt+K", checklist: "Control+Alt+L" } },
  (() => { try { return JSON.parse(process.env.WINGMAN_OVERLAY || "{}"); } catch { return {}; } })());
let win, timer, lastCapture, endedSent = false, endedCheckAt = 0, phaseKey = "", capList = [];
const captureKeys = [];   // Ctrl+Opt+1..3 held while the window runs
// Orphan guard: when the engine (call.ts) that opened this window dies, even by SIGKILL, its stdin pipe closes and its pid disappears: quit.
if (process.env.WINGMAN_WATCH_PARENT === "1") {
  const parent = process.ppid, bye = () => { try { globalShortcut.unregisterAll(); } catch {} app.exit(0); };
  process.stdin.on("end", bye); process.stdin.on("close", bye); process.stdin.on("error", bye);
  // The same pipe also carries the engine's card rows (second path, for when cards.jsonl cannot be written): one JSON row per line.
  const pipeRows = new StdinRows();
  process.stdin.on("data", (b) => { try { for (const r of pipeRows.push(b)) onPipeRow(r); } catch (e) { logErr("pipe", e); } });
  process.stdin.resume();
  setInterval(() => { try { process.kill(parent, 0); } catch { bye(); } if (process.ppid !== parent) bye(); }, 2000).unref();
}
// Tailed files of calls/latest: cards.jsonl (cards + captures) and transcript.jsonl (for the rewind panel).
const tails = { cards: { file: undefined, offset: 0 }, transcript: { file: undefined, offset: 0 }, live: { file: undefined, offset: 0 } };

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
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  if (!SNAP) { win.setAlwaysOnTop(true, "floating"); win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); }
  // Content protection is ON but UNTESTED with Zoom; the second screen is the real protection.
  // overlay.contentProtection: false (WINGMAN_SHOW_IN_CAPTURE=1) turns it off for the Zoom share test.
  if (CFG.contentProtection) win.setContentProtection(true);
  win.loadFile(path.join(__dirname, "index.html"));
  // Poll only after the page has its listeners; a reload replays the call files from the start.
  win.webContents.on("did-finish-load", () => {
    win.webContents.send("config", { maxCards: CFG.maxCards, fontPt: CFG.fontPt, showLastLine: CFG.showLastLine !== false, liveTextPt: CFG.liveTextPt, rewindSeconds: CFG.rewindSeconds, hotkeys: CFG.hotkeys });
    tails.cards = { file: undefined, offset: 0 }; tails.transcript = { file: undefined, offset: 0 }; tails.live = { file: undefined, offset: 0 }; capList = []; phaseKey = "";
    pageReady = true; replayBacklog();   // rows that only came by the pipe come back after a reload
    clearInterval(timer); timer = setInterval(poll, 100);
  });
  // Crash and hang handling: the page is reloaded (it replays the call from the files and the pipe backlog); never an error dialog, never a closed window.
  const gate = new ReloadGate();
  let hangTimer;
  const reloadSoon = (why) => { pageReady = false; logErr("page " + why + "; reloading", ""); setTimeout(() => { try { if (win && !win.isDestroyed()) win.webContents.reload(); } catch (e) { logErr("reload", e); } }, gate.next()); };
  win.webContents.on("render-process-gone", (_e, d) => reloadSoon("process gone (" + (d && d.reason) + ")"));
  win.webContents.on("did-fail-load", (_e, code, desc, _url, isMain) => { if (isMain && code !== -3) reloadSoon("failed to load (" + desc + ")"); });
  win.on("unresponsive", () => {
    logErr("page unresponsive", "");
    clearTimeout(hangTimer);
    hangTimer = setTimeout(() => { try { win.webContents.forcefullyCrashRenderer(); } catch { reloadSoon("hung"); } }, 8000);   // still hung after 8 s: kill the page (render-process-gone reloads it)
  });
  win.on("responsive", () => clearTimeout(hangTimer));
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

// Cards reach the page by two paths: cards.jsonl (tailed by poll) and the engine's pipe on stdin. `seen` makes each row show once.
const seen = new Seen(), backlog = new Backlog();
let pageReady = false; const waiting = [];
function onPipeRow(c) {
  if (!c || typeof c !== "object") return;
  backlog.add(c);
  if (!seen.add(rowKey(c))) return;   // the disk path already delivered it
  if (!pageReady) { waiting.push(c); return; }
  try { handleCardRow(c); } catch (e) { logErr("card row", e); }
}
/** After the page was reset (new call, reload): rows that came by the pipe come back (they may not be on disk), then disk rows fill in. */
function replayBacklog() {
  seen.clear(); waiting.length = 0;
  for (const c of backlog.all()) { if (seen.add(rowKey(c))) { try { handleCardRow(c); } catch (e) { logErr("card row", e); } } }
}
/** Sends one cards.jsonl row to the page. */
function handleCardRow(c) {
  if (c.type === "capture") { lastCapture = c.value; capList = pushCapture(capList, c.value); win.webContents.send("capture", c); }
  else if (c.type === "ask") win.webContents.send("ask", { on: !!c.on, until: Number(c.until) || 0 });
  else if (c.type === "speaker") { if (Number.isInteger(c.spk)) win.webContents.send("speaker", { spk: c.spk, name: typeof c.name === "string" ? c.name.slice(0, 40) : "" }); }
  else if (c.type === "flow") win.webContents.send("flow", { state: c.state === "internal" ? "internal" : "open", who: Array.isArray(c.who) ? c.who.filter((w) => typeof w === "string").slice(0, 6).map((w) => w.slice(0, 40)) : [], topic: typeof c.topic === "string" ? c.topic.slice(0, 160) : "" });
  else if (c.type === "addressed") win.webContents.send("addressed", { who: typeof c.who === "string" ? c.who.slice(0, 40) : "", text: typeof c.text === "string" ? c.text.slice(0, 200) : "" });
  else if (c.type === "frame") { if (c.frame && typeof c.frame === "object") win.webContents.send("frame", c.frame); }
  else if (!c.hidden) win.webContents.send("card", c);
}

/** One 100 ms tick: follows calls/latest (a new call dir resets the page), forwards new cards/captures/lines, and checks call.json at most once a second. */
function poll() {
  try { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) pollOnce(); } catch (e) { logErr("poll", e); }   // one bad tick must not stop the card feed
}
function pollOnce() {
  let dir;
  try { dir = fs.realpathSync(path.join(CALLS, "latest")); } catch { return; }
  const cardsFile = path.join(dir, "cards.jsonl");
  if (cardsFile !== tails.cards.file) { tails.cards = { file: cardsFile, offset: 0 }; tails.transcript = { file: path.join(dir, "transcript.jsonl"), offset: 0 }; tails.live = { file: path.join(dir, "live.jsonl"), offset: 0 }; lastCapture = undefined; capList = []; phaseKey = ""; endedSent = false; win.webContents.send("reset"); replayBacklog(); }
  for (const c of readNewRows(tails.cards)) { if (seen.add(rowKey(c))) handleCardRow(c); }
  const partials = readNewRows(tails.live); const p = partials[partials.length - 1];   // only the newest words matter
  if (p) win.webContents.send("partial", { t: p.t, ch: p.ch, text: p.text, spk: p.spk, name: p.name });
  for (const l of readNewRows(tails.transcript)) win.webContents.send("line", { t: l.t, ch: l.ch, text: l.text, spk: l.spk, name: l.name });
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

app.whenReady().then(create);
app.on("window-all-closed", () => { clearInterval(timer); unregisterCaptureKeys(globalShortcut, captureKeys); globalShortcut.unregisterAll(); app.quit(); });
app.on("will-quit", () => { unregisterCaptureKeys(globalShortcut, captureKeys); globalShortcut.unregisterAll(); });
