// Wingman app: the menu bar (quick control) plus the Wingman window (home, calls, settings), one process, ONE call controller.
// The menu and the window both talk to tray/controller.cjs, which runs `src/call.ts` with WINGMAN_CONTROL=1 (stdin commands, @@wingman status lines).
// No network of its own; the only listener is the owner-only control socket for the CLI (tray/control-socket.cjs). Start: pnpm tray (menu bar only) or pnpm dashboard (menu bar + window).
// Snapshot mode (WINGMAN_DASHBOARD_SNAPSHOT): hidden window only, no Tray, no global shortcuts, no call is ever spawned.
const { app, Tray, Menu, BrowserWindow, Notification, nativeImage, ipcMain, dialog, shell, globalShortcut, screen, clipboard, nativeTheme } = require("electron");
app.setName("Wingman");   // menu bar app name, About box and notifications (the Dock name comes from .app/Wingman.app)
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const lib = require("./lib.cjs");
const { createController } = require("./controller.cjs");
const windowHost = require("../dashboard/window.cjs");
const { createControlServer } = require("./control-socket.cjs");

const ROOT = path.join(__dirname, "..");
const ICON = path.join(ROOT, "..", "brand", "png", "trayTemplate.png");
const LOGS = path.join(ROOT, "calls", "tray.log");
const BRIEF_FILE = path.join(process.env.WINGMAN_BRIEFS_DIR || path.join(ROOT, "data", "private", "briefs"), "latest.yaml");
const SNAPSHOT = !!process.env.WINGMAN_DASHBOARD_SNAPSHOT;
const WANT_WINDOW = SNAPSHOT || process.argv.includes("--open-window") || process.env.WINGMAN_OPEN_WINDOW === "1";

let tray, clock, promptWin, lastMenuKey = "", host, ctl, controlServer;

let gotLock = true;
if (!SNAPSHOT) {
  app.dock && app.dock.hide();                      // menu-bar first: in the Dock only while the window is open
  gotLock = app.requestSingleInstanceLock();        // a second launch hands over to the first one (second-instance below) and exits
  if (!gotLock) app.quit();
}

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
function onChange() { refresh(); host && host.push(); }

// Small input window for a quick note (global shortcut). It is the only extra window; it takes focus because Dan asked for it.
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
ipcMain.handle("prompt:submit", (e, kind, data) => {
  if (!promptWin || e.sender !== promptWin.webContents) throw new Error("denied");
  if (kind === "note" && data && typeof data.text === "string") ctl.note(data.text);
  promptWin && promptWin.close();
  return true;
});

// Global keys while a call runs (the answer window owns Ctrl+Opt+C/P/R/K/L). Ctrl+Opt+A = ask Wingman (the next sentence, within 10 s, is a question for it).
const KEYS = { consent: "Control+Alt+Return", note: "Control+Alt+N", ask: "Control+Alt+A" };
function registerKeys() {
  const bad = [];
  if (!globalShortcut.register(KEYS.consent, () => ctl.consent())) bad.push(KEYS.consent);
  if (!globalShortcut.register(KEYS.note, () => { if (ctl.isRunning() && state().phase !== "stopping") ask(); })) bad.push(KEYS.note);
  if (!globalShortcut.register(KEYS.ask, () => ctl.askWingman())) bad.push(KEYS.ask);
  if (bad.length) logLine(`could not register ${bad.join(", ")}`);
}

function refresh() {
  if (!tray) return;
  const s = state(), running = ctl.isRunning();
  const v = lib.view(s, Date.now());
  tray.setTitle(v.title, { fontType: "monospacedDigit" });
  tray.setToolTip(v.tooltip);
  const key = lib.menuKey(s, running) + v.statusLine.replace(/\d+:\d\d/, "");
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
    items.push({ label: "Start call", click: () => ctl.start({}) });
    items.push({ label: "Start call without AI (bank cards only)", click: () => ctl.start({ noAi: true }) });
    items.push({ label: s.briefReady ? "Plan a call: briefing ready \u2713 (edit\u2026)" : "Plan a call\u2026", click: () => openWindow({ view: "home", focus: "plan" }) });
    items.push({ type: "separator" });
    items.push({ label: "Try a practice call (offline, free)", click: () => ctl.practice() });
  } else {
    if (s.phase === "waiting") items.push({ label: "\u2705  Consent given: start listening", accelerator: KEYS.consent, registerAccelerator: false, click: () => ctl.consent() });
    if (s.proposed && !s.client) items.push({ label: `Confirm client: ${s.proposed}`, click: () => ctl.confirmClient() });
    items.push({ label: "Ask Wingman: my next sentence is for you", accelerator: KEYS.ask, registerAccelerator: false, enabled: s.phase === "live", click: () => ctl.askWingman() });
    items.push({ label: "Add a note for the AI\u2026", accelerator: KEYS.note, registerAccelerator: false, enabled: s.phase !== "stopping", click: () => ask() });
    items.push({ label: "Quiet mode (hide cards)", type: "checkbox", checked: !!s.quiet, enabled: s.phase === "live", click: (mi) => ctl.setQuiet(mi.checked) });
    items.push({ type: "separator" });
    items.push({ label: s.phase === "stopping" ? "Stopping\u2026" : "Stop call", enabled: s.phase !== "stopping", click: () => ctl.stop() });
    items.push({ label: "Stop and delete this call", enabled: s.phase !== "stopping", click: () => ctl.stopDelete() });
  }
  items.push({ type: "separator" });
  items.push({ label: s.doctorRunning ? "Checking\u2026" : "Check everything (doctor)", enabled: !s.doctorRunning && !running, click: () => { openWindow({ view: "home" }); ctl.runDoctor(); } });
  items.push({ label: "Show log", click: () => shell.openPath(LOGS) });
  items.push({ type: "separator" });
  items.push({ label: "Quit Wingman", click: () => { if (running) { ctl.stop(); setTimeout(() => app.quit(), 9000); } else app.quit(); } });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

app.on("second-instance", (_e, argv) => { host && host.open({ view: "home" }); });

app.whenReady().then(() => {
  if (!gotLock) return;
  if (!SNAPSHOT) fs.mkdirSync(path.join(ROOT, "calls"), { recursive: true });
  ctl = createController({
    // Snapshot mode can never start anything: the spawn function itself refuses.
    spawn: SNAPSHOT ? () => { throw new Error("snapshot mode never spawns a process"); } : spawn,
    root: ROOT, logPath: SNAPSHOT ? "" : LOGS, tmpDir: app.getPath("temp"), notify: (t, b) => notify(t, b, /summary ready/i.test(t) ? { view: "call", id: ctl.getState().callId, tab: "followup" } : undefined), onChange,
  });
  host = windowHost.create({ app, BrowserWindow, ipcMain, dialog, screen, clipboard, nativeTheme, shell, controller: ctl });
  ctl.boot(lib.briefReady(BRIEF_FILE));
  // Local control channel for the `wingman` CLI: owner-only Unix socket, fixed command list (tray/control-socket.cjs). Never in snapshot mode.
  if (!SNAPSHOT) {
    controlServer = createControlServer({ controller: ctl, lib, briefFile: BRIEF_FILE, log: logLine, info: () => ({ pid: process.pid, version: app.getVersion() }) });
    controlServer.start().catch((e) => logLine("control socket not started: " + e.message));
  }
  if (!SNAPSHOT) {
    const img = fs.existsSync(ICON) ? nativeImage.createFromPath(ICON) : nativeImage.createEmpty();
    img.setTemplateImage(true);
    tray = new Tray(img);
    if (img.isEmpty()) tray.setTitle("Wingman");
    refresh();
    registerKeys();
    clock = setInterval(() => { refresh(); const b = lib.briefReady(BRIEF_FILE); if (b !== state().briefReady && !ctl.isRunning()) ctl.boot(b); }, 1000);
  }
  if (WANT_WINDOW) host.open({ view: "home" });
});
app.on("window-all-closed", (e) => { if (SNAPSHOT) app.quit(); else e.preventDefault(); });   // closing a window must not quit the menu-bar app
app.on("will-quit", () => { globalShortcut.unregisterAll(); controlServer && controlServer.stop(); });
app.on("before-quit", () => { clearInterval(clock); ctl && ctl.shutdown(); });
process.on("uncaughtException", (e) => { logLine("ERR tray " + (e && e.stack || e)); });
