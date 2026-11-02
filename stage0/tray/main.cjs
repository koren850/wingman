// Wingman menu-bar app: start/stop a call, consent, client, notes, quiet, briefing, dashboard, check.
// Runs `src/call.ts` (answer window + listening) with WINGMAN_CONTROL=1 and talks to it over stdin/stdout.
// No network of its own, no listener. Start: pnpm tray.
const { app, Tray, Menu, BrowserWindow, Notification, nativeImage, ipcMain, dialog, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const lib = require("./lib.cjs");

const ROOT = path.join(__dirname, "..");
const BIN = (n) => path.join(ROOT, "node_modules", ".bin", n);
const ICON = path.join(ROOT, "..", "brand", "png", "trayTemplate.png");
const LOGS = path.join(ROOT, "calls", "tray.log");

let tray, call, state = lib.initialState(), clock, promptWin;

app.dock && app.dock.hide();                      // menu-bar only, never in the Dock or the app switcher
if (!app.requestSingleInstanceLock()) app.quit();  // one menu-bar icon only

function logLine(s) { try { fs.appendFileSync(LOGS, `${new Date().toISOString()} ${s}\n`); } catch { /* calls/ may not exist yet */ } }
function notify(title, body) { try { new Notification({ title, body, silent: true }).show(); } catch { /* notifications off */ } }

function startCall(extraArgs = []) {
  if (call) return;
  state = lib.reduce(lib.initialState(), { ev: "starting" });
  const env = { ...process.env, WINGMAN_CONTROL: "1", FORCE_COLOR: "0" };
  call = spawn(BIN("tsx"), [path.join(ROOT, "src", "call.ts"), ...extraArgs], { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const onData = (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      logLine(line);
      const msg = lib.parseStatus(line);
      if (!msg) continue;
      const before = state;
      state = lib.reduce(state, msg);
      for (const n of lib.notifications(before, state, msg)) notify(n.title, n.body);
    }
  };
  call.stdout.on("data", onData);
  call.stderr.on("data", (d) => { logLine("ERR " + d.toString().trimEnd()); state = lib.reduce(state, { ev: "stderr", text: d.toString() }); });
  call.on("exit", (code) => {
    call = undefined;
    state = lib.reduce(state, { ev: "exit", code });
    if (code && code !== 0 && !state.endedCleanly) notify("Wingman stopped", state.lastError ? state.lastError.slice(0, 120) : `exit code ${code}. Details: calls/tray.log`);
    refresh();
  });
  refresh();
}

function send(cmd) { if (call && call.stdin.writable) call.stdin.write(cmd + "\n"); }
function stopCall() { if (!call) return; send("stop"); state = lib.reduce(state, { ev: "stopping" }); refresh(); setTimeout(() => { if (call) call.kill("SIGINT"); }, 8000); }

// Small input window for a note or a briefing (the only windows that take focus, because Dan opened them).
function ask(kind) {
  if (promptWin) { promptWin.focus(); return; }
  promptWin = new BrowserWindow({
    width: 460, height: kind === "brief" ? 470 : 230, resizable: false, minimizable: false, maximizable: false, alwaysOnTop: true,
    title: kind === "brief" ? "Wingman · briefing" : "Wingman · note for the AI", backgroundColor: "#FEF7EC",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  promptWin.setContentProtection(true);
  promptWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  promptWin.webContents.on("will-navigate", (e) => e.preventDefault());
  promptWin.loadFile(path.join(__dirname, "prompt.html"), { query: { kind } });
  promptWin.on("closed", () => { promptWin = undefined; });
}
ipcMain.handle("prompt:submit", (e, kind, data) => {
  if (!promptWin || e.sender !== promptWin.webContents) throw new Error("denied");
  if (kind === "note") { const t = lib.cleanText(data && data.text, 300); if (t) send("note " + t); }
  if (kind === "brief") {
    const b = lib.briefFrom(data);
    if (b) { lib.writeBrief(path.join(ROOT, "data", "private", "briefs"), b); notify("Briefing saved", "The next call in the next 6 hours uses it."); state = lib.reduce(state, { ev: "brief" }); }
  }
  promptWin && promptWin.close();
  refresh();
  return true;
});

function runDoctor() {
  const p = spawn(BIN("tsx"), [path.join(ROOT, "src", "doctor.ts")], { cwd: ROOT, env: { ...process.env, FORCE_COLOR: "0" } });
  let out = "";
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
  state = lib.reduce(state, { ev: "doctor.start" }); refresh();
  p.on("exit", () => {
    state = lib.reduce(state, { ev: "doctor.end" });
    const verdict = lib.doctorVerdict(out);
    dialog.showMessageBox({ type: verdict.ok ? "info" : "warning", title: "Wingman check", message: verdict.ok ? "READY for a call" : "NOT READY", detail: lib.tail(out, 1800), buttons: ["OK"] });
    refresh();
  });
}

function openDashboard() {
  spawn(BIN("electron"), [path.join(ROOT, "dashboard", "main.cjs")], { cwd: ROOT, stdio: "ignore", detached: true }).unref();
}

function refresh() {
  if (!tray) return;
  const v = lib.view(state, Date.now());
  tray.setTitle(v.title, { fontType: "monospacedDigit" });
  tray.setToolTip(v.tooltip);
  const items = [
    { label: v.statusLine, enabled: false },
    ...(v.healthLines.map((h) => ({ label: h, enabled: false }))),
    { type: "separator" },
  ];
  if (!call) {
    items.push({ label: "Start call", accelerator: "", click: () => startCall() });
    items.push({ label: "Start call without AI (bank cards only)", click: () => startCall(["--no-ai"]) });
    items.push({ label: state.briefReady ? "Briefing ready ✓ (edit…)" : "Prepare a briefing…", click: () => ask("brief") });
  } else {
    if (state.phase === "waiting") items.push({ label: "✅  Consent given: start listening", click: () => send("consent") });
    if (state.proposed && !state.client) items.push({ label: `Confirm client: ${state.proposed}`, click: () => send("client") });
    items.push({ label: "Add a note for the AI…", enabled: state.phase !== "stopping", click: () => ask("note") });
    items.push({ label: "Quiet mode (hide cards)", type: "checkbox", checked: !!state.quiet, enabled: state.phase === "live", click: (mi) => send(`quiet ${mi.checked ? "on" : "off"}`) });
    items.push({ type: "separator" });
    items.push({ label: state.phase === "stopping" ? "Stopping…" : "Stop call", enabled: state.phase !== "stopping", click: stopCall });
  }
  items.push({ type: "separator" });
  items.push({ label: "Open dashboard", click: openDashboard });
  items.push({ label: state.doctorRunning ? "Checking…" : "Check everything (doctor)", enabled: !state.doctorRunning && !call, click: runDoctor });
  items.push({ label: "Show log", click: () => shell.openPath(LOGS) });
  items.push({ type: "separator" });
  items.push({ label: "Quit Wingman", click: () => { if (call) { stopCall(); setTimeout(() => app.quit(), 9000); } else app.quit(); } });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

app.whenReady().then(() => {
  fs.mkdirSync(path.join(ROOT, "calls"), { recursive: true });
  const img = fs.existsSync(ICON) ? nativeImage.createFromPath(ICON) : nativeImage.createEmpty();
  img.setTemplateImage(true);
  tray = new Tray(img);
  if (img.isEmpty()) tray.setTitle("Wingman");
  state = lib.reduce(state, { ev: "boot", briefReady: lib.briefReady(path.join(ROOT, "data", "private", "briefs", "latest.yaml")) });
  refresh();
  clock = setInterval(refresh, 1000);
});
app.on("window-all-closed", (e) => e.preventDefault());   // closing the note window must not quit the menu-bar app
app.on("before-quit", () => { clearInterval(clock); if (call) call.kill("SIGINT"); });
