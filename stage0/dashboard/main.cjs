// Stage 0 dashboard: review calls, rate cards (usefulness gate). Plain HTML + vanilla JS, file://, no network, no port.
const { app, BrowserWindow, ipcMain, dialog, screen, clipboard, nativeTheme } = require("electron");
const { execFile } = require("node:child_process");
const path = require("node:path");
// App icon from brand/ (rebuild with brand/build.sh). Missing file = Electron default icon.
const BRAND_ICON = path.join(__dirname, "..", "..", "brand", "png", "icon-512.png");
const lib = require("./lib.cjs");

const ROOT = path.join(__dirname, "..");
// WINGMAN_CALLS_DIR: point the dashboard at another calls folder (fixtures for screenshots/tests).
const CALLS = process.env.WINGMAN_CALLS_DIR || path.join(ROOT, "calls");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
let win;

// WINGMAN_DASHBOARD_SIZE="900x640" (snapshot aid).
const SIZE = /^(\d{3,4})x(\d{3,4})$/.test(process.env.WINGMAN_DASHBOARD_SIZE || "") ? process.env.WINGMAN_DASHBOARD_SIZE.split("x").map(Number) : null;
// Window background must equal --bg of the page so there is no flash on open.
const BG = { dark: "#120E0B", light: "#FEF7EC" };
const bgNow = () => (nativeTheme.shouldUseDarkColors ? BG.dark : BG.light);
function create() {
  if (/^(light|dark)$/.test(process.env.WINGMAN_DASHBOARD_THEME || "")) nativeTheme.themeSource = process.env.WINGMAN_DASHBOARD_THEME;
  const d = screen.getPrimaryDisplay();
  if (process.platform === "darwin" && app.dock && require("node:fs").existsSync(BRAND_ICON)) app.dock.setIcon(BRAND_ICON);
  win = new BrowserWindow({
    x: d.workArea.x + Math.max(0, Math.round((d.workArea.width - 1200) / 2)), y: d.workArea.y + 30,
    width: SIZE ? SIZE[0] : Math.min(1200, d.workArea.width), height: SIZE ? SIZE[1] : Math.min(800, d.workArea.height - 40),
    backgroundColor: bgNow(), title: "Wingman dashboard",
    // Snapshot mode (tests/docs): render hidden, save a PNG, quit. Never steals focus from the user's screen.
    show: !process.env.WINGMAN_DASHBOARD_SNAPSHOT, paintWhenInitiallyHidden: true,
    icon: BRAND_ICON,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Calls hold client conversations: hide from screen share unless explicitly disabled (for screenshots).
  if (process.env.WINGMAN_DASHBOARD_SHOW_IN_CAPTURE !== "1") win.setContentProtection(true);
  nativeTheme.on("updated", () => { if (win && !win.isDestroyed()) win.setBackgroundColor(bgNow()); });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  // Dev aid for screenshots: WINGMAN_DASHBOARD_OPEN="<callId>:<tab>" opens that call directly.
  // Optional 3rd part: rate filter (unrated|side) or transcript line number. Tabs: followup | rate | transcript | missed | details (old names summary/cards/side/speed/cost/events are mapped by the page).
  const [call, tab, extra] = String(process.env.WINGMAN_DASHBOARD_OPEN || "").split(":");
  // Snapshot aids: WINGMAN_DASHBOARD_THEME=light|dark, WINGMAN_DASHBOARD_VIEW=settings.
  const query = {};
  if (call) { query.call = call; query.tab = tab || ""; if (extra) query.x = extra; }
  if (/^(light|dark)$/.test(process.env.WINGMAN_DASHBOARD_THEME || "")) query.theme = process.env.WINGMAN_DASHBOARD_THEME;
  if (/^(settings|system|inbox)$/.test(process.env.WINGMAN_DASHBOARD_VIEW || "")) query.view = process.env.WINGMAN_DASHBOARD_VIEW;
  win.loadFile(path.join(__dirname, "index.html"), Object.keys(query).length ? { query } : undefined);
  const snap = process.env.WINGMAN_DASHBOARD_SNAPSHOT;
  // The page sets body[data-ready=1] once its first view is drawn; wait for that (max 12 s) instead of a fixed delay.
  if (snap) win.webContents.once("did-finish-load", async () => {
    for (let i = 0; i < 80; i++) {
      const ready = await win.webContents.executeJavaScript("document.body.dataset.ready === '1'").catch(() => false);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    await new Promise((r) => setTimeout(r, 500));
    require("node:fs").writeFileSync(snap, (await win.webContents.capturePage()).toPNG());
    app.quit();
  });
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

// Copy button of the summary tab (text only, bounded).
ipcMain.handle("clipboard:write", guard((text) => {
  if (typeof text !== "string" || !text || text.length > 20000) throw new Error("bad text");
  clipboard.writeText(text);
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
