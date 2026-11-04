// Wingman app: the menu bar (quick control) plus the Wingman window (home, calls, settings), one process, ONE call controller.
// The menu and the window both talk to tray/controller.cjs, which runs `src/call.ts` with WINGMAN_CONTROL=1 (stdin commands, @@wingman status lines).
// No network of its own; the only listener is the owner-only control socket for the CLI (tray/control-socket.cjs). Start: pnpm tray (menu bar only) or pnpm dashboard (menu bar + window).
// Snapshot mode (WINGMAN_DASHBOARD_SNAPSHOT): hidden window only, no Tray, no global shortcuts, no call is ever spawned.
const { app, Tray, Menu, BrowserWindow, Notification, nativeImage, ipcMain, dialog, shell, globalShortcut, screen, clipboard, nativeTheme, systemPreferences } = require("electron");
app.setName("Wingman");   // menu bar app name, About box and notifications (the Dock name comes from .app/Wingman.app)
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const lib = require("./lib.cjs");
const { askClock } = require("../shared/ask.js");
const { createController } = require("./controller.cjs");
const windowHost = require("../dashboard/window.cjs");
const { createControlServer } = require("./control-socket.cjs");
const { createPlanStore } = require("./plans.cjs");

const ROOT = path.join(__dirname, "..");
const userPaths = require("../shared/paths.cjs");
const { ensureUserData } = require("../shared/migrate.cjs");
const ICON = path.join(ROOT, "..", "brand", "png", "trayTemplate.png");
const CALLS_DIR = userPaths.callsDir();
const LOGS = path.join(CALLS_DIR, "tray.log");
const BRIEFS_DIR = userPaths.briefsDir();
const SNAPSHOT = !!process.env.WINGMAN_DASHBOARD_SNAPSHOT;
const WANT_WINDOW = SNAPSHOT || process.argv.includes("--open-window") || process.env.WINGMAN_OPEN_WINDOW === "1";

let plans, tray, clock, promptWin, lastMenuKey = "", host, ctl, controlServer;

// Single-instance guard (not in snapshot mode, so snapshots can run beside a real app).
let gotLock = true;
// Hidden snapshots: no Dock icon at all (one is shown per Electron process otherwise).
if (SNAPSHOT && process.platform === "darwin") { try { app.setActivationPolicy("accessory"); app.dock && app.dock.hide(); } catch { /* no dock */ } }
if (!SNAPSHOT) {
  app.dock && app.dock.hide();                      // menu-bar first: in the Dock only while the window is open
  gotLock = app.requestSingleInstanceLock();        // a second launch hands over to the first one (second-instance below) and exits
  if (!gotLock) app.quit();
}

/** Silent macOS notification. `go` (openWindow arg) makes a click open the Wingman window there. Never throws. */
function notify(title, body, go) {
  try {
    if (SNAPSHOT) return;
    const n = new Notification({ title, body, silent: true });
    if (go) n.on("click", () => openWindow(go));
    n.show();
  } catch { /* notifications off */ }
}
const logLine = (s) => ctl && ctl.logLine(s);
const state = () => ctl.getState();

function openWindow(o) { return host && host.open(o); }
/** Controller state changed: redraw the menu bar and push the new state to the window. */
function onChange() { refresh(); host && host.push(); }

// Small input window for a quick note (global shortcut or menu). It is the only extra window; it takes focus because the user asked for it.
// Always on top and content-protected, so it stays visible over the call app but never shows in a screen share.
function ask() {
  if (promptWin) { promptWin.focus(); return; }
  promptWin = new BrowserWindow({
    width: 460, height: 230, resizable: false, minimizable: false, maximizable: false, alwaysOnTop: true,
    title: "Wingman · note for the AI", backgroundColor: "#FEF7EC",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  promptWin.setContentProtection(true);
  promptWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  promptWin.webContents.on("will-navigate", (e) => e.preventDefault());
  promptWin.loadFile(path.join(__dirname, "prompt.html"), { query: { kind: "note" } });
  promptWin.on("closed", () => { promptWin = undefined; });
}
// IPC from prompt.js. Only the prompt window may call it. Only kind "note" is acted on (the "brief" form in prompt.html is not used by this file).
ipcMain.handle("prompt:submit", (e, kind, data) => {
  if (!promptWin || e.sender !== promptWin.webContents) throw new Error("denied");
  if (kind === "note" && data && typeof data.text === "string") ctl.note(data.text);
  promptWin && promptWin.close();
  return true;
});

// Global keys while a call runs. The answer window owns Ctrl+Opt+C/P/R/K/L and Ctrl+Opt+1-3 (lib.OVERLAY_KEYS); the menu-bar app never takes those.
// Ctrl+Opt+A = ask Wingman (the next sentence, within the answer window time, is a question for it).
const KEYS = lib.KEYS;
/** Registers the note and ask global keys. A key another app already owns just gets logged, not fatal. */
function registerKeys() {
  const bad = [];
  if (!globalShortcut.register(KEYS.note, () => { if (ctl.isRunning() && state().phase !== "stopping") ask(); })) bad.push(KEYS.note);
  if (!globalShortcut.register(KEYS.ask, () => ctl.askWingman())) bad.push(KEYS.ask);
  if (bad.length) logLine(`could not register ${bad.join(", ")}`);
}

// The Start listening key exists only while a call is really waiting (the optional "Ask me before listening starts" setting is on).
const startKey = lib.createStartKey({ globalShortcut, key: KEYS.consent, onPress: () => { if (state().phase === "waiting") ctl.consent(); }, log: logLine });
const confirmDelete = () => lib.confirmStopDelete({ dialog, stopDelete: () => ctl.stopDelete() });
let quitting = false;
/** Quit with a confirmation when a call runs. `quitting` stops a second quit click while the first is still stopping the call. */
function quitApp() {
  if (quitting) return;
  quitting = true;
  lib.requestQuit({
    isRunning: () => ctl.isRunning(), dialog, stop: () => ctl.stop(), quit: () => app.quit(),
    whenStopped: () => lib.waitUntil(() => !ctl.isRunning(), 25_000),
  }).then((r) => { if (r === "kept") quitting = false; }).catch(() => { quitting = false; });
}

/** Redraws the tray title every tick, but rebuilds the menu only when what it shows changed. */
function refresh() {
  if (!tray) return;
  const s = state(), running = ctl.isRunning();
  startKey.sync(running && s.phase === "waiting");
  const v = lib.view(s, Date.now());
  tray.setTitle(v.title, { fontType: "monospacedDigit" });
  tray.setToolTip(v.tooltip);
  // The status line holds a ticking m:ss timer; strip it so the key changes only on real changes.
  const key = lib.menuKey(s, running, Date.now()) + v.statusLine.replace(/\d+:\d\d/, "");
  if (key === lastMenuKey) return;   // rebuilding an open menu every second would close it
  lastMenuKey = key;
  const items = [
    { label: "Open Wingman", click: () => openWindow({ view: "home" }) },
    { type: "separator" },
    { label: v.statusLine, enabled: false },
    ...(v.healthLines.map((h) => ({ label: h, enabled: false }))),
    { type: "separator" },
  ];
  if (!running) {
    // Two clear paths: a quick call (no Plan) or a chosen prepared meeting. Starting never picks a Plan by itself.
    let meetings = []; try { meetings = lib.planMenu(plans.list(), Date.now()); } catch { /* the menu still works without the list */ }
    items.push({ label: "Start quick call", click: () => ctl.start({}) });
    items.push({ label: "Start prepared meeting", enabled: meetings.length > 0, submenu: meetings.length ? meetings.map((m) => ({ label: m.label, click: () => ctl.start({ planId: m.planId }) })) : [{ label: "No prepared meetings", enabled: false }] });
    items.push({ label: "Start quick call without AI (Prepared cards only)", click: () => ctl.start({ noAi: true }) });
    items.push({ label: "Prepare a meeting\u2026", click: () => openWindow({ view: "home", focus: "plan" }) });
    items.push({ type: "separator" });
    items.push({ label: "Try a practice call (offline, free)", click: () => ctl.practice() });
  } else {
    if (s.phase === "waiting") items.push({ label: "Start listening", accelerator: KEYS.consent, registerAccelerator: false, click: () => ctl.consent() });
    if (s.proposed && !s.client) items.push({ label: `Confirm client: ${s.proposed}`, click: () => ctl.confirmClient() });
    const askLeft = s.askArmed ? askClock(s.askUntil, Date.now()) : null;
    items.push({ label: s.askArmed ? "Listening for your question" + (askLeft ? ` \u00b7 ${askLeft} left` : "\u2026") : "Ask Wingman: my next sentence is for you", accelerator: KEYS.ask, registerAccelerator: false, enabled: s.phase === "live", click: () => ctl.askWingman() });
    items.push({ label: "Add a note for the AI\u2026", accelerator: KEYS.note, registerAccelerator: false, enabled: s.phase !== "stopping", click: () => ask() });
    items.push({ label: "Quiet mode (hide cards in the answer window)", type: "checkbox", checked: !!s.quiet, enabled: s.phase === "live", click: (mi) => ctl.setQuiet(mi.checked) });
    items.push({ type: "separator" });
    items.push({ label: s.phase === "stopping" ? "Stopping\u2026" : "Stop call", enabled: s.phase !== "stopping", click: () => ctl.stop() });
    items.push({ type: "separator" });
    items.push({ label: "Stop and delete this call\u2026", enabled: s.phase !== "stopping", click: () => confirmDelete() });
  }
  items.push({ type: "separator" });
  items.push({ label: s.doctorRunning ? "Checking\u2026" : "Run readiness check", enabled: !s.doctorRunning && !running, click: () => { openWindow({ view: "home" }); ctl.runDoctor(); } });
  items.push({ label: "Show log", click: () => shell.openPath(LOGS) });
  items.push({ type: "separator" });
  items.push({ label: running ? "Quit Wingman\u2026" : "Quit Wingman", click: () => quitApp() });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// A second launch (e.g. the .app clicked again) just brings up the window.
app.on("second-instance", (_e, argv) => { host && host.open({ view: "home" }); });

app.whenReady().then(() => {
  if (!gotLock) return;
  if (!SNAPSHOT) {
    // One-time copy of data from the old in-repo folders; the old folders stay (the owner deletes them). Never in snapshot mode.
    const mig = ensureUserData({ log: (m) => { try { fs.mkdirSync(CALLS_DIR, { recursive: true, mode: 0o700 }); fs.appendFileSync(LOGS, m + "\n", { mode: 0o600 }); } catch { /* log only */ } } });
    if (mig.status === "migrated" || mig.status === "failed") setTimeout(() => notify("Wingman", mig.status === "migrated" ? `Your calls and meetings now live in ${userPaths.dataDir()}. The old copy in the Wingman folder was left in place.` : "Could not copy your old data to the new folder. See Show log."), 1500);
    fs.mkdirSync(CALLS_DIR, { recursive: true, mode: 0o700 });
  }
  plans = createPlanStore({ dir: BRIEFS_DIR, readOnly: SNAPSHOT });   // snapshot mode never converts, sweeps or writes
  ctl = createController({
    // Snapshot mode can never start anything: the spawn function itself refuses.
    spawn: SNAPSHOT ? () => { throw new Error("snapshot mode never spawns a process"); } : spawn,
    root: ROOT, plans, logPath: SNAPSHOT ? "" : LOGS, tmpDir: app.getPath("temp"), notify: (t, b) => notify(t, b, /summary ready/i.test(t) ? { view: "call", id: ctl.getState().callId, tab: "followup" } : undefined), onChange,
  });
  host = windowHost.create({ app, BrowserWindow, ipcMain, dialog, screen, clipboard, nativeTheme, shell, systemPreferences, controller: ctl, plans });
  ctl.refreshPlans();
  // Local control channel for the `wingman` CLI: owner-only Unix socket, fixed command list (tray/control-socket.cjs). Never in snapshot mode.
  if (!SNAPSHOT) {
    controlServer = createControlServer({ controller: ctl, lib, plans, log: logLine, info: () => ({ pid: process.pid, version: app.getVersion() }) });
    controlServer.start().catch((e) => logLine("control socket not started: " + e.message));
  }
  if (!SNAPSHOT) {
    const img = fs.existsSync(ICON) ? nativeImage.createFromPath(ICON) : nativeImage.createEmpty();
    img.setTemplateImage(true);
    tray = new Tray(img);
    if (img.isEmpty()) tray.setTitle("Wingman");
    refresh();
    registerKeys();
    // 1 s tick: updates the live timer, and picks up prepared meetings written, used or expired outside the app (e.g. by the CLI).
    clock = setInterval(() => { ctl.refreshPlans(); refresh(); }, 1000);
  }
  if (WANT_WINDOW) host.open({ view: "home" });
});
app.on("window-all-closed", (e) => { if (SNAPSHOT) app.quit(); else e.preventDefault(); });   // closing a window must not quit the menu-bar app
app.on("will-quit", () => { globalShortcut.unregisterAll(); controlServer && controlServer.stop(); });
app.on("before-quit", () => { clearInterval(clock); ctl && ctl.shutdown(); });
process.on("uncaughtException", (e) => { logLine("ERR tray " + (e && e.stack || e)); });
