// The Wingman window (home, calls, settings). Hosted by the menu-bar process (tray/main.cjs) so the menu and the
// window drive ONE call controller. Every IPC handler checks the sender and validates its arguments; the window can
// only ask the controller for the fixed commands, it never writes arbitrary text to a call's stdin.
const path = require("node:path");
const fs = require("node:fs");
const { execFile } = require("node:child_process");
const lib = require("../tray/lib.cjs");
const catalog = require("../tray/settings-catalog.cjs");
const data = require("./lib.cjs");
const { createLiveTail } = require("./livetail.cjs");
const liveFixture = require("./livefixture.cjs");
const attachments = require("../tray/attachments.cjs");

const ROOT = path.join(__dirname, "..");
const BRAND_ICON = path.join(ROOT, "..", "brand", "png", "icon-512.png");
const CALLS = process.env.WINGMAN_CALLS_DIR || path.join(ROOT, "calls");
const BRIEFS = process.env.WINGMAN_BRIEFS_DIR || path.join(ROOT, "data", "private", "briefs");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const BG = { dark: "#120E0B", light: "#FEF7EC" };
const SNAP = process.env.WINGMAN_DASHBOARD_SNAPSHOT || "";
const SIZE = /^(\d{3,4})x(\d{3,4})$/.test(process.env.WINGMAN_DASHBOARD_SIZE || "") ? process.env.WINGMAN_DASHBOARD_SIZE.split("x").map(Number) : null;

/** Snapshot-only fake call states (WINGMAN_DASHBOARD_FAKE_CALL=waiting|live|live-warn|stopping|ended). Nothing is spawned. */
function fakeCall(kind, now = Date.now()) {
  if (!kind) return null;
  const ev = (s, e) => lib.reduce(s, e);
  let s = ev(lib.initialState(), { ev: "boot", briefReady: true });
  s = ev(s, { ev: "starting" }); s = ev(s, { ev: "waiting", id: "01JTESTDEMOSUMMARYCALL0001" });
  if (kind === "waiting") return { ...s, running: true, startedAt: now - 18000 };
  if (kind === "ended") { s = ev(s, { ev: "consented" }); s = ev(s, { ev: "summary", ok: true }); s = ev(s, { ev: "ended", id: "01JTESTDEMOSUMMARYCALL0001" }); s = ev(s, { ev: "exit", code: 0 }); return { ...s, running: false }; }
  s = ev(s, { ev: "consented" }); s = ev(s, { ev: "propose", title: "Dana Levi · Levi Studio" }); s = ev(s, { ev: "note", count: 2 });
  if (kind === "live-warn") { s = ev(s, { ev: "health", id: "stt", level: "red", text: "Speech service is not answering" }); s = ev(s, { ev: "health", id: "bt", level: "amber", text: "AirPods are the microphone: transcript quality drops" }); s = ev(s, { ev: "overlay", ok: false, reason: "one-screen" }); }
  if (kind === "stopping") s = ev(s, { ev: "stopping" });
  return { ...s, running: true, startedAt: now - 9 * 60000, liveAt: now - (8 * 60000 + 14000) };
}
const FAKE_DOCTOR = {
  ready: { ran: true, ok: true, verdict: "READY", failing: [], warnings: [{ text: "only one screen: the answer window will NOT open", fix: "connect the second screen before the call" }], at: 0 },
  notready: { ran: true, ok: false, verdict: "NOT READY", failing: [{ text: "DEEPGRAM_API_KEY missing (speech to text)", fix: "add it to ~/.config/wingman/keys.env" }, { text: "mic silent (peak 0.000)", fix: "grant Microphone to your terminal app, restart it" }], warnings: [], at: 0 },
};

/** The sender must be the dashboard window's MAIN frame, still showing our own local page (not a sub-frame, not another window). */
function isDashboardSender(e, win) {
  if (!win || win.isDestroyed() || !e || e.sender !== win.webContents) return false;
  const f = e.senderFrame;
  if (!f || f !== win.webContents.mainFrame) return false;
  return typeof f.url === "string" && f.url.startsWith("file://") && /\/dashboard\/index\.html(\?|#|$)/.test(f.url);
}

function create(ctx) {
  const { app, BrowserWindow, ipcMain, dialog, screen, clipboard, nativeTheme, shell, controller } = ctx;
  let win, fake = fakeCall(process.env.WINGMAN_DASHBOARD_FAKE_CALL), fakeDoc = FAKE_DOCTOR[process.env.WINGMAN_DASHBOARD_FAKE_DOCTOR] || null;
  if (fakeDoc) fakeDoc = { ...fakeDoc, at: Date.now() - 4 * 60000 };
  const bgNow = () => (nativeTheme.shouldUseDarkColors ? BG.dark : BG.light);
  const mine = (e) => isDashboardSender(e, win);
  const handle = (name, fn) => ipcMain.handle(name, (e, ...a) => { if (!mine(e)) throw new Error("denied"); return fn(...a); });
  const view = () => { const s = fake || controller.getState(); return { ...s, doctor: fakeDoc || s.doctor, now: Date.now(), fake: !!fake }; };
  const briefInfo = () => { const b = lib.readBrief(path.join(BRIEFS, "latest.yaml")); return b ? { ...b, notes: b.notes.join("\n"), mustCover: b.mustCover.join("\n") } : null; };

  // Live conversation: tails the running call's transcript.jsonl / cards.jsonl (never the @@wingman status lines). Not used for fake/snapshot states.
  const live = createLiveTail({ callsDir: CALLS, send: (p) => { if (win && !win.isDestroyed()) win.webContents.send("live:update", p); } });

  // Hidden from screenshots and screen share only while a call runs (live conversation on screen). Between calls the
  // window captures normally, so a screenshot of it is not a black box.
  let protectedNow;
  function protect() {
    if (!win || win.isDestroyed()) return;
    const s = fake || controller.getState();
    const on = process.env.WINGMAN_DASHBOARD_SHOW_IN_CAPTURE !== "1" && !!s && s.phase && s.phase !== "idle";
    if (on !== protectedNow) { protectedNow = on; win.setContentProtection(on); }
  }

  /** Push the controller state to the window. Never shows or focuses the window. */
  function push() {
    if (!fake && !SNAP) { try { live.sync(controller.getState()); } catch { /* the feed must never break the state push */ } }
    protect();
    if (win && !win.isDestroyed()) win.webContents.send("call:state", view());
  }

  /** Open (or focus) the window. Only called from a user action: a menu click, a second launch, or `pnpm dashboard`. */
  function open(o = {}) {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show(); win.focus();
      win.webContents.send("nav", { view: o.view || "home", id: o.id, tab: o.tab, focus: o.focus });
      return win;
    }
    if (/^(light|dark)$/.test(process.env.WINGMAN_DASHBOARD_THEME || "")) nativeTheme.themeSource = process.env.WINGMAN_DASHBOARD_THEME;
    const d = screen.getPrimaryDisplay();
    if (!SNAP && process.platform === "darwin" && app.dock) { try { app.dock.show(); if (fs.existsSync(BRAND_ICON)) app.dock.setIcon(BRAND_ICON); } catch { /* no dock */ } }
    win = new BrowserWindow({
      x: d.workArea.x + Math.max(0, Math.round((d.workArea.width - 1200) / 2)), y: d.workArea.y + 30,
      width: SIZE ? SIZE[0] : Math.min(1200, d.workArea.width), height: SIZE ? SIZE[1] : Math.min(820, d.workArea.height - 40), minWidth: 560, minHeight: 480,
      backgroundColor: bgNow(), title: "Wingman",
      // Snapshot mode (tests/docs): render hidden, save a PNG, quit. Never steals focus from the user's screen.
      show: !SNAP, paintWhenInitiallyHidden: true, icon: BRAND_ICON,
      webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    protectedNow = undefined; protect();   // hidden from capture only during a call (see protect())
    nativeTheme.on("updated", () => { if (win && !win.isDestroyed()) win.setBackgroundColor(bgNow()); });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.on("closed", () => { win = undefined; if (!SNAP && app.dock) { try { app.dock.hide(); } catch { /* no dock */ } } });
    // Snapshot aids: WINGMAN_DASHBOARD_OPEN="<callId>:<tab>[:extra]", _THEME, _VIEW=home|inbox|settings|system, _FOCUS=plan.
    const [call, tab, extra] = String(process.env.WINGMAN_DASHBOARD_OPEN || "").split(":");
    const query = {};
    if (call) { query.call = call; query.tab = tab || ""; if (extra) query.x = extra; }
    if (/^(light|dark)$/.test(process.env.WINGMAN_DASHBOARD_THEME || "")) query.theme = process.env.WINGMAN_DASHBOARD_THEME;
    if (/^[abc]$/.test(process.env.WINGMAN_DASHBOARD_SKIN || "")) query.skin = process.env.WINGMAN_DASHBOARD_SKIN;
    const v = SNAP ? process.env.WINGMAN_DASHBOARD_VIEW : o.view;
    if (/^(home|calls|inbox|settings|system)$/.test(v || "")) query.view = v;
    if (/^(plan|advanced)$/.test((SNAP ? process.env.WINGMAN_DASHBOARD_FOCUS : o.focus) || "")) query.focus = SNAP ? process.env.WINGMAN_DASHBOARD_FOCUS : o.focus;
    if (!SNAP && o.id) { query.call = o.id; query.tab = o.tab || ""; }
    win.loadFile(path.join(__dirname, "index.html"), Object.keys(query).length ? { query } : undefined);
    if (SNAP) win.webContents.once("did-finish-load", async () => {
      // The page sets body[data-ready=1] once its first view is drawn; wait for that (max 15 s) instead of a fixed delay.
      for (let i = 0; i < 100; i++) {
        const ready = await win.webContents.executeJavaScript("document.body.dataset.ready === '1'").catch(() => false);
        if (ready) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      await new Promise((r) => setTimeout(r, 600));
      // Snapshot aid: WINGMAN_DASHBOARD_SCROLL=<pixels>|bottom scrolls the page before the picture.
      const sc = process.env.WINGMAN_DASHBOARD_SCROLL;
      if (/^(\d{1,5}|bottom)$/.test(sc || "")) { await win.webContents.executeJavaScript(sc === "bottom" ? "window.scrollTo(0, document.body.scrollHeight)" : `window.scrollTo(0, ${sc})`).catch(() => {}); await new Promise((r) => setTimeout(r, 300)); }
      // Snapshot aid: WINGMAN_DASHBOARD_EVAL=<file.js> runs a script in the page and writes its JSON result to <snapshot>.json (used by the clickable audit).
      if (process.env.WINGMAN_DASHBOARD_EVAL) { try { const r = await win.webContents.executeJavaScript(fs.readFileSync(process.env.WINGMAN_DASHBOARD_EVAL, "utf8")); fs.writeFileSync(SNAP + ".json", JSON.stringify(r, null, 1)); } catch (e) { fs.writeFileSync(SNAP + ".json", JSON.stringify({ error: String(e) })); } }
      fs.writeFileSync(SNAP, (await win.webContents.capturePage()).toPNG());
      app.quit();
    });
    return win;
  }

  // ---- calls (review) ----
  handle("calls:list", () => data.listCalls(CALLS));
  handle("calls:get", (id) => data.getCall(CALLS, id));
  handle("calls:search", (q) => data.searchCalls(CALLS, q));
  handle("calls:setTag", (id, cardId, useful) => data.setTag(CALLS, id, cardId, useful));
  handle("calls:delete", (id) => {
    data.callDir(CALLS, id); // validates before the dialog
    const r = dialog.showMessageBoxSync(win, { type: "warning", buttons: ["Cancel", "Delete"], defaultId: 0, cancelId: 0, title: "Delete call", message: `Delete call ${id}?`, detail: "The transcript, cards and ratings of this call are removed permanently." });
    if (r !== 1) return false;
    data.deleteCall(CALLS, id);
    return true;
  });
  handle("clipboard:write", (text) => {
    if (typeof text !== "string" || !text || text.length > 20000) throw new Error("bad text");
    clipboard.writeText(text);
    return true;
  });

  // ---- the live call: fixed commands only ----
  handle("call:state", () => view());
  handle("live:get", (id) => {
    if (typeof id !== "string" || id.length > 60) throw new Error("bad id");
    if (fake) { const f = fake.running && fake.callId === id ? liveFixture.build(fake.liveAt || fake.startedAt, id) : null; return f || { callId: "", reset: true, lines: [], cards: [] }; }
    return live.snapshot(id);
  });
  handle("call:cmd", (name, arg) => {
    if (typeof name !== "string") throw new Error("bad command");
    if (fake || SNAP) return { ok: false, error: "preview" };       // snapshot/preview states never touch a call
    switch (name) {
      case "start": return { ok: controller.start({ noAi: false }) };
      case "startNoAi": return { ok: controller.start({ noAi: true }) };
      case "practice": return { ok: controller.practice() };
      case "consent": return { ok: controller.consent() };
      case "quiet": if (typeof arg !== "boolean") throw new Error("bad argument"); return { ok: controller.setQuiet(arg) };
      case "client": return { ok: controller.confirmClient() };
      case "note": if (typeof arg !== "string" || arg.length > 2000) throw new Error("bad argument"); return { ok: controller.note(arg) };
      case "stop": return { ok: controller.stop() };
      case "stopDelete": {
        const r = dialog.showMessageBoxSync(win, { type: "warning", buttons: ["Keep the call", "Stop and delete"], defaultId: 0, cancelId: 0, title: "Stop and delete", message: "Stop this call and delete everything from it?", detail: "The transcript, cards and notes are removed permanently. No summary is written." });
        return { ok: r === 1 ? controller.stopDelete() : false, cancelled: r !== 1 };
      }
      default: throw new Error("unknown command");
    }
  });

  // ---- briefing ("Plan a call") ----
  handle("brief:get", () => briefInfo());
  handle("brief:save", (d) => {
    if (!d || typeof d !== "object") throw new Error("bad briefing");
    for (const k of ["who", "goal", "notes", "mustCover"]) if (typeof d[k] !== "string" || d[k].length > 1500) throw new Error("bad briefing field " + k);
    const b = lib.briefFrom(d);
    if (!b) return { ok: false, error: "Fill in at least one field." };
    lib.writeBrief(BRIEFS, b);
    controller.briefSaved();
    return { ok: true, brief: briefInfo() };
  });
  handle("brief:clear", () => { lib.clearBrief(BRIEFS); if (!SNAP) store.clear(); controller.briefCleared(); return { ok: true }; });

  // ---- background files for the plan (.txt .md, .pdf when pdftotext exists, pasted text): validated in tray/attachments.cjs ----
  // Content is never logged or sent back to the page: the list only has names and sizes.
  const store = attachments.createStore({ dir: path.join(BRIEFS, "attachments") });
  const FAKE_ATT = process.env.WINGMAN_DASHBOARD_FAKE_ATTACH ? { files: [{ id: "afake0001", name: "hosting-offer.txt", chars: 6200, expiresInMs: 5.5 * 3600e3 }, { id: "afake0002", name: "pasted text", chars: 1450, expiresInMs: 5.9 * 3600e3 }], maxChars: attachments.MAX_CHARS, pdf: false } : null;
  const attState = () => FAKE_ATT || store.list();
  handle("attach:list", () => attState());
  handle("attach:add", async (name, bytes) => {
    if (typeof name !== "string" || name.length > 300) throw new Error("bad file name");
    if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) throw new Error("bad file");
    if (fake || SNAP) return { ok: false, error: "preview", state: attState() };
    const r = await store.addFile(name, bytes);
    return { ok: !!r.ok, error: r.error, truncated: !!r.truncated, state: attState() };
  });
  handle("attach:paste", (text) => {
    if (typeof text !== "string" || text.length > 200000) throw new Error("bad text");
    if (fake || SNAP) return { ok: false, error: "preview", state: attState() };
    const r = store.addPaste(text);
    return { ok: !!r.ok, error: r.error, truncated: !!r.truncated, state: attState() };
  });
  handle("attach:remove", (id) => { if (typeof id !== "string" || id.length > 30) throw new Error("bad id"); if (!fake && !SNAP) store.remove(id); return attState(); });

  // ---- readiness (doctor) ----
  handle("doctor:run", async () => {
    if (fakeDoc) return { ...fakeDoc, at: Date.now() };
    if (SNAP) return null;
    return controller.runDoctor();
  });

  // ---- settings ----
  const settingsEnv = () => ({ ...require("../src/keychain.cjs").childEnv(process.env), NO_COLOR: "1", FORCE_COLOR: "0" });   // the settings tools never need API keys
  const child = (args, input) => new Promise((resolve) => {
    const p = execFile(TSX, args, { cwd: ROOT, timeout: 30_000, maxBuffer: 2_000_000, env: settingsEnv() }, (err, stdout) => {
      const line = String(stdout || "").trim().split("\n").filter(Boolean).pop() || "";
      try { resolve(JSON.parse(line)); } catch { resolve({ ok: false, message: err ? String(err.message).slice(0, 300) : "no answer from the settings tool" }); }
    });
    if (input != null) { p.stdin.on("error", () => {}); p.stdin.end(input); }
  });
  const readSettings = async () => {
    const r = await child(["src/settings-edit-cli.ts", "read"]);
    if (!r.ok) return { ok: false, message: String(r.message || "unknown error").slice(0, 600) };
    return { ok: true, items: catalog.describe(r), groups: catalog.GROUPS, userFile: String(r.userFile), keysFile: String(r.keysFile), keys: r.keys, keyVars: r.keyVars, changed: r.changed.length };
  };
  handle("settings:get", readSettings);
  handle("settings:set", async (key, value) => {
    const item = typeof key === "string" && catalog.BY_KEY.get(key);
    if (!item) throw new Error("unknown setting");
    let stored; try { stored = value === null ? null : catalog.toStored(item, value); } catch (e) { return { ok: false, message: `${item.label}: ${e.message}` }; }
    const r = await child(["src/settings-edit-cli.ts", "write"], JSON.stringify({ [key]: stored }));
    if (!r.ok) return { ok: false, message: String(r.message || "not saved").slice(0, 400) };
    return { ok: true, state: await readSettings() };
  });
  handle("settings:reveal", (what) => {
    if (what !== "keys" && what !== "settings") throw new Error("bad target");
    return readSettings().then((s) => {
      const f = what === "keys" ? s.keysFile : s.userFile;
      if (!f) return false;
      const p = f.startsWith("~/") ? path.join(require("node:os").homedir(), f.slice(2)) : f;
      shell.showItemInFolder(p); return true;
    });
  });
  // Advanced (read-only) list for debugging.
  handle("tools:settings", () => new Promise((resolve) => execFile(TSX, ["src/settings-cli.ts"], { cwd: ROOT, timeout: 60_000, maxBuffer: 2_000_000, env: settingsEnv() }, (err, stdout, stderr) => resolve({ ok: !err, text: String(stdout || "") + (stderr ? "\n" + String(stderr) : "") || (err ? String(err.message) : "") }))));

  // ---- keys: Keychain storage, write-only input. All logic in keys-ipc.cjs (main process only). ----
  require("./keys-ipc.cjs").register({
    handle, getWin: () => win, dialog,
    fake: process.env.WINGMAN_DASHBOARD_FAKE_KEYS || (SNAP ? "missing" : ""),   // snapshots never touch the real Keychain
    keysFile: async () => {
      if (process.env.WINGMAN_KEYS_FILE) return process.env.WINGMAN_KEYS_FILE;
      const s = await readSettings(); const f = s.ok && s.keysFile;
      return f ? (f.startsWith("~/") ? path.join(require("node:os").homedir(), f.slice(2)) : f) : path.join(require("node:os").homedir(), ".config", "wingman", "keys.env");
    },
  });

  return { open, push, live, get win() { return win; }, isOpen: () => !!win && !win.isDestroyed() };
}

module.exports = { create, fakeCall, isDashboardSender };
