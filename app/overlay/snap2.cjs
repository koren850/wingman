// Hidden snapshots of the answer window v2 (never shows a window): electron snap2.cjs <outDir> [--check] <spec>...
// spec = <scenario>[:key,key] with keys light | dark | s | m | l (look). Scenarios: fixtures-v2.cjs. Language: WINGMAN_OVERLAY_LANG=en|he.
// It loads index.html in a hidden window with the real preload and sends the scenario rows on the same channels main.cjs uses.
// --check also runs qa-check.js in the page (clipping, contrast, minimum font, dir) and prints one JSON line per spec; exit code 1 when any issue is found.
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { build, ALL } = require("./fixtures-v2.cjs");

const args = process.argv.slice(process.argv.indexOf("--") >= 0 ? process.argv.indexOf("--") + 1 : 2).filter((a) => !a.startsWith("--inspect"));
const check = args.includes("--check");
const rest = args.filter((a) => a !== "--check");
const outDir = rest.shift() || "/tmp/wingman-overlay-snaps";
const specs = rest.length ? rest : ALL;
const LANG = (process.env.WINGMAN_OVERLAY_LANG || "en") === "he" ? "he" : "en";
const QA = fs.readFileSync(path.join(__dirname, "qa-check.js"), "utf8");
/** What the page sends back to main: "act" (rate / pin / dismiss) and "copy". main.cjs is not involved; this is the record the tests read. */
let ipc = [];
ipcMain.on("act", (_e, m) => ipc.push(["act", m]));
ipcMain.on("copy", (_e, t) => ipc.push(["copy", String(t)]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.platform === "darwin") {
  try {
    app.setActivationPolicy("accessory");
    app.dock && app.dock.hide();
  } catch {
    /* no dock */
  }
}

let shared;
/** One hidden window for the whole run (a new renderer per spec is slow and, in a sandboxed shell, unreliable). Each spec reloads the page. */
function getWin() {
  if (shared && !shared.isDestroyed()) return shared;
  shared = new BrowserWindow({
    width: 760,
    height: 900,
    show: false,
    paintWhenInitiallyHidden: true,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  shared.webContents.on("console-message", (e) => {
    const level = e.level;
    if (/Electron Security Warning/.test(e.message)) return;
    if (level === "error" || level === "warning" || level >= 2)
      console.error(`page ${level}: ${e.message} (${path.basename(e.sourceId || "")}:${e.lineNumber})`);
  });
  return shared;
}

async function one(spec) {
  const [name, keyStr = ""] = spec.split(":");
  const keys = keyStr.split(",").filter(Boolean);
  const theme = keys.includes("light") ? "light" : "dark";
  const size = ["s", "m", "l"].find((k) => keys.includes(k)) || "m";
  const sc = build(name, LANG);
  ipc = [];
  const win = getWin();
  const wc = win.webContents;
  await win.loadURL("about:blank"); // a clean page and a fresh preload for every spec
  await win.loadFile(path.join(__dirname, "index.html"), { query: { lang: LANG, layout: "focus", theme, size } });
  const send = (ch, payload) => wc.send(ch, payload);
  send("config", {
    language: LANG,
    layout: "focus",
    showLastLine: true,
    rewindSeconds: 30,
    maxCards: 4,
    fontPt: 30,
    liveTextPt: 22,
    hotkeys: {
      clear: "Control+Alt+C",
      pause: "Control+Alt+P",
      rewind: "Control+Alt+R",
      copy: "Control+Alt+K",
      checklist: "Control+Alt+L",
      ask: "Control+Alt+A",
    },
    theme,
    textSize: size,
  });
  if (sc.phase === "starting") send("phase", { phase: "starting", liveAt: 0 });
  else send("phase", { phase: "live", liveAt: Date.now() - 95000 });
  if (sc.frame) send("frame", sc.frame);
  for (const l of sc.lines || []) send("line", l);
  for (const r of sc.rows || []) send("card", r);
  await sleep(450);
  for (const st of sc.steps || []) {
    if (st.click) await wc.executeJavaScript(`(() => { const e = document.querySelector(${JSON.stringify(st.click)}); if (e) e.click(); return !!e; })()`);
    else if (st.key) send(st.key);
    else if (st.send) send(st.send[0], st.send[1]);
    else if (st.wait) await sleep(st.wait);
    await sleep(250);
  }
  await sleep(250);
  await wc.insertCSS("*,*::before,*::after{animation:none!important;transition:none!important}"); // a hidden window can freeze an animation half way; snapshots show the end state
  wc.invalidate();
  await sleep(250);
  await wc.capturePage(); // the first capture after a change can still return the previous frame of a hidden window
  wc.invalidate();
  await sleep(100);
  const png = path.join(outDir, spec.replace(/[:,]/g, "-") + ".png");
  fs.writeFileSync(png, (await wc.capturePage()).toPNG());
  let result = { spec, png, lang: LANG, ipc };
  if (check) {
    const qa = await wc.executeJavaScript(QA + "\n;WingmanQa.run()");
    result = { ...result, ...qa };
  }
  return result;
}

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  let bad = 0;
  for (const spec of specs) {
    try {
      const r = await one(spec);
      if (check) {
        console.log(JSON.stringify(r));
        if (r.issues.length) bad++;
      } else console.log(r.png);
    } catch (e) {
      console.log(JSON.stringify({ spec, error: String((e && e.message) || e), issues: [{ type: "error", sel: "", detail: String(e) }] }));
      bad++;
    }
  }
  app.exit(bad ? 1 : 0);
});
