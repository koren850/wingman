// Stage 0 dashboard: review calls, rate cards (usefulness gate). Plain HTML + vanilla JS, file://, no network, no port.
const { app, BrowserWindow, ipcMain, dialog, screen } = require("electron");
const { execFile } = require("node:child_process");
const path = require("node:path");
// App icon from brand/ (rebuild with brand/build.sh). Missing file = Electron default icon.
const BRAND_ICON = path.join(__dirname, "..", "..", "brand", "png", "icon-512.png");
const lib = require("./lib.cjs");

const ROOT = path.join(__dirname, "..");
const CALLS = path.join(ROOT, "calls");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
let win;

function create() {
  const d = screen.getPrimaryDisplay();
  if (process.platform === "darwin" && app.dock && require("node:fs").existsSync(BRAND_ICON)) app.dock.setIcon(BRAND_ICON);
  win = new BrowserWindow({
    x: d.workArea.x + Math.max(0, Math.round((d.workArea.width - 1200) / 2)), y: d.workArea.y + 30,
    width: Math.min(1200, d.workArea.width), height: Math.min(800, d.workArea.height - 40),
    backgroundColor: "#111418", title: "Wingman dashboard",
    // Snapshot mode (tests/docs): render hidden, save a PNG, quit. Never steals focus from the user's screen.
    show: !process.env.WINGMAN_DASHBOARD_SNAPSHOT, paintWhenInitiallyHidden: true,
    icon: BRAND_ICON,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Calls hold client conversations: hide from screen share unless explicitly disabled (for screenshots).
  if (process.env.WINGMAN_DASHBOARD_SHOW_IN_CAPTURE !== "1") win.setContentProtection(true);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  // Dev aid for screenshots: WINGMAN_DASHBOARD_OPEN="<callId>:<tab>" opens that call directly.
  const [call, tab] = String(process.env.WINGMAN_DASHBOARD_OPEN || "").split(":");
  win.loadFile(path.join(__dirname, "index.html"), call ? { query: { call, tab: tab || "" } } : undefined);
  const snap = process.env.WINGMAN_DASHBOARD_SNAPSHOT;
  if (snap) win.webContents.once("did-finish-load", () => setTimeout(async () => {
    require("node:fs").writeFileSync(snap, (await win.webContents.capturePage()).toPNG());
    app.quit();
  }, 1500));
}

const mine = (e) => win && e.sender === win.webContents;
const guard = (fn) => (e, ...a) => { if (!mine(e)) throw new Error("denied"); return fn(...a); };

ipcMain.handle("calls:list", guard(() => lib.listCalls(CALLS)));
ipcMain.handle("calls:get", guard((id) => lib.getCall(CALLS, id)));
ipcMain.handle("calls:search", guard((q) => lib.searchCalls(CALLS, q)));
ipcMain.handle("calls:setTag", guard((id, cardId, useful) => lib.setTag(CALLS, id, cardId, useful)));
ipcMain.handle("calls:delete", guard((id) => {
  lib.callDir(CALLS, id); // validates before the dialog
  const r = dialog.showMessageBoxSync(win, { type: "warning", buttons: ["Cancel", "Delete"], defaultId: 0, cancelId: 0, title: "Delete call", message: `Delete call ${id}?`, detail: "The transcript, cards and ratings of this call are removed permanently." });
  if (r !== 1) return false;
  lib.deleteCall(CALLS, id);
  return true;
}));

// Read-only CLI output (the tools already redact keys).
function run(args) {
  return new Promise((resolve) => {
    execFile(TSX, args, { cwd: ROOT, timeout: 60_000, maxBuffer: 2_000_000, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } }, (err, stdout, stderr) => {
      const text = String(stdout || "") + (stderr ? "\n" + String(stderr) : "");
      resolve({ ok: !err, text: text || (err ? String(err.message) : "") });
    });
  });
}
ipcMain.handle("tools:settings", guard(() => run(["src/settings-cli.ts"])));
ipcMain.handle("tools:doctor", guard(() => run(["src/doctor.ts", "--offline"])));

app.whenReady().then(create);
app.on("window-all-closed", () => app.quit());
