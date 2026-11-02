// Wingman menu-bar app: start/stop a call, consent, client, notes, quiet, briefing, dashboard, check.
// Runs `src/call.ts` (answer window + listening) with WINGMAN_CONTROL=1 and talks to it over stdin/stdout.
// No network of its own, no listener. Start: pnpm tray.
const { app, Tray, Menu, BrowserWindow, Notification, nativeImage, ipcMain, dialog, shell, globalShortcut } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const lib = require("./lib.cjs");

const ROOT = path.join(__dirname, "..");
const BIN = (n) => path.join(ROOT, "node_modules", ".bin", n);
const ICON = path.join(ROOT, "..", "brand", "png", "trayTemplate.png");
const LOGS = path.join(ROOT, "calls", "tray.log");

let tray, call, state = lib.initialState(), clock, promptWin, lastMenuKey = "";

app.dock && app.dock.hide();                      // menu-bar only, never in the Dock or the app switcher
if (!app.requestSingleInstanceLock()) app.quit();  // one menu-bar icon only

// Only status lines and errors are logged (never card text, client names or notes). Private file, fresh per call.
function logLine(s) { try { fs.appendFileSync(LOGS, `${new Date().toISOString()} ${s}\n`, { mode: 0o600 }); } catch { /* calls/ may not exist yet */ } }
function notify(title, body) { try { new Notification({ title, body, silent: true }).show(); } catch { /* notifications off */ } }

function startCall(extraArgs = [], extraEnv = {}) {
  if (call) return;
  state = lib.reduce(lib.initialState(), { ev: "starting", practice: !!extraEnv.WINGMAN_STT_SCRIPT });
  const env = { ...process.env, WINGMAN_CONTROL: "1", FORCE_COLOR: "0", ...extraEnv };
  try { fs.writeFileSync(LOGS, "", { mode: 0o600 }); fs.chmodSync(LOGS, 0o600); } catch { /* best effort */ }
  // detached: call.ts leads its own process group, so a stuck call can be force-killed with everything under it.
  call = spawn(BIN("tsx"), [path.join(ROOT, "src", "call.ts"), ...extraArgs], { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  call.on("error", (e) => { logLine("ERR spawn " + e.message); notify("Wingman could not start", e.message); call = undefined; state = lib.reduce(state, { ev: "exit", code: 1 }); refresh(); });
  call.stdin.on("error", () => { /* the call already ended */ });
  let buf = "";
  const onData = (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const msg = lib.parseStatus(line);
      if (!msg) continue;
      logLine(line.trim());
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
    if (code && code !== 0 && !state.endedCleanly && !state.offReason) notify("Wingman stopped", state.lastError ? state.lastError.slice(0, 120) : `exit code ${code}. Details: calls/tray.log`);
    refresh();
  });
  refresh();
}

// Practice call: a pretend client (data/demo/demo-call.json) plays into the real call loop with scripted AI.
// File mode: no mic, no system audio, no network, no cost. Lets Dan try the answer window and the keys.
function practiceCall() {
  const script = path.join(ROOT, "data", "demo", "demo-call.json");
  const gapMs = 4500;
  let lines = 16; try { lines = JSON.parse(fs.readFileSync(script, "utf8")).length; } catch { /* default */ }
  const wav = path.join(app.getPath("temp"), "wingman-practice.wav");
  lib.writeSilentWav(wav, Math.ceil((lines * gapMs) / 1000) + 12);
  startCall(["--profile", "demo", "--file", wav, "--no-brief"], { WINGMAN_STT_SCRIPT: script, WINGMAN_SCRIPT_GAP_MS: String(gapMs) });
  notify("Practice call", "A pretend client is talking. Watch the answer window on your second screen. Nothing is sent anywhere.");
}

function send(cmd) { try { if (call && call.stdin.writable) call.stdin.write(cmd + "\n"); } catch { /* ended */ } }
function killGroup(sig) { try { process.kill(-call.pid, sig); } catch { try { call.kill(sig); } catch { /* gone */ } } }
function stopCall(cmd = "stop") {
  if (!call) return;
  send(cmd); state = lib.reduce(state, { ev: "stopping" }); refresh();
  const c = call;
  setTimeout(() => { if (call === c) killGroup("SIGINT"); }, 12000);      // call.ts: graceful stop
  setTimeout(() => { if (call === c) killGroup("SIGKILL"); }, 20000);     // stuck: force everything off (mic included)
}

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

// Global keys while a call runs (the answer window owns Ctrl+Opt+C/P/R/K).
const KEYS = { consent: "Control+Alt+Return", note: "Control+Alt+N" };
function consent() { if (call && state.phase === "waiting") send("consent"); }
function registerKeys() {
  const bad = [];
  if (!globalShortcut.register(KEYS.consent, consent)) bad.push(KEYS.consent);
  if (!globalShortcut.register(KEYS.note, () => { if (call && state.phase !== "stopping") ask("note"); })) bad.push(KEYS.note);
  if (bad.length) logLine(`could not register ${bad.join(", ")}`);
}

function refresh() {
  if (!tray) return;
  const v = lib.view(state, Date.now());
  tray.setTitle(v.title, { fontType: "monospacedDigit" });
  tray.setToolTip(v.tooltip);
  const key = lib.menuKey(state, !!call) + v.statusLine.replace(/\d+:\d\d/, "");
  if (key === lastMenuKey) return;   // rebuilding an open menu every second would close it
  lastMenuKey = key;
  const items = [
    { label: v.statusLine, enabled: false },
    ...(v.healthLines.map((h) => ({ label: h, enabled: false }))),
    { type: "separator" },
  ];
  if (!call) {
    items.push({ label: "Start call", accelerator: "", click: () => startCall() });
    items.push({ label: "Start call without AI (bank cards only)", click: () => startCall(["--no-ai"]) });
    items.push({ label: state.briefReady ? "Briefing ready ✓ (edit…)" : "Prepare a briefing…", click: () => ask("brief") });
    items.push({ type: "separator" });
    items.push({ label: "Try a practice call (offline, free)", click: practiceCall });
  } else {
    if (state.phase === "waiting") items.push({ label: "✅  Consent given: start listening", accelerator: KEYS.consent, registerAccelerator: false, click: consent });
    if (state.proposed && !state.client) items.push({ label: `Confirm client: ${state.proposed}`, click: () => send("client") });
    items.push({ label: "Add a note for the AI…", accelerator: KEYS.note, registerAccelerator: false, enabled: state.phase !== "stopping", click: () => ask("note") });
    items.push({ label: "Quiet mode (hide cards)", type: "checkbox", checked: !!state.quiet, enabled: state.phase === "live", click: (mi) => send(`quiet ${mi.checked ? "on" : "off"}`) });
    items.push({ type: "separator" });
    items.push({ label: state.phase === "stopping" ? "Stopping…" : "Stop call", enabled: state.phase !== "stopping", click: () => stopCall() });
    items.push({ label: "Stop and delete this call", enabled: state.phase !== "stopping", click: () => stopCall("stop-delete") });
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
  registerKeys();
  clock = setInterval(refresh, 1000);
});
app.on("window-all-closed", (e) => e.preventDefault());   // closing the note window must not quit the menu-bar app
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("before-quit", () => { clearInterval(clock); if (call) { send("stop"); setTimeout(() => call && killGroup("SIGKILL"), 8000).unref(); } });
process.on("uncaughtException", (e) => { logLine("ERR tray " + (e && e.stack || e)); });
