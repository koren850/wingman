// Hidden snapshots of the answer window v2 (never shows a window): electron snap2.cjs <outDir> [--check] <spec>...
// spec = <scenario>[:key,key] with keys light | dark | s | m | l (look), fit (the content-sized window: the window is set to the height the page reports), reduce (prefers-reduced-motion). Scenarios: fixtures-v2.cjs. Language: WINGMAN_OVERLAY_LANG=en|he.
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
let sizes = []; // content heights the page reported on the "size" channel (fit mode); main.cjs would set the window to these
ipcMain.on("size", (_e, h) => sizes.push(h));
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
  if (name.startsWith("v2-fit") && !keys.includes("fit")) keys.push("fit"); // the fit scenarios always run content-sized
  const theme = keys.includes("light") ? "light" : "dark";
  const size = ["s", "m", "l"].find((k) => keys.includes(k)) || "m";
  const sc = build(name, LANG);
  const fit = keys.includes("fit");
  const reduce = keys.includes("reduce");
  ipc = [];
  sizes = [];
  const win = getWin();
  const wc = win.webContents;
  await win.loadURL("about:blank"); // a clean page and a fresh preload for every spec
  win.setContentSize(760, 900);
  if (reduce) {
    // the same switch the OS flips: the page must run no animation
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    await wc.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  } else if (wc.debugger.isAttached()) {
    await wc.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  }
  await win.loadFile(path.join(__dirname, "index.html"), { query: { lang: LANG, layout: "focus", theme, size, ...(fit ? { fit: "1" } : {}) } });
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
    else if (st.focus)
      // a hidden window has no page focus, so the browser sends no focus events: send the focusin the page would get when the window has the keyboard
      await wc.executeJavaScript(
        `(() => { const e = document.querySelector(${JSON.stringify(st.focus)}); if (e) { e.focus(); e.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); } return !!e; })()`,
      );
    else if (st.press)
      await wc.executeJavaScript(
        `document.activeElement && document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(st.press)}, bubbles: true, cancelable: true }))`,
      );
    else if (st.key) send(st.key);
    else if (st.send) send(st.send[0], st.send[1]);
    else if (st.wait) await sleep(st.wait);
    await sleep(250);
  }
  await sleep(250);
  const animations = await wc.executeJavaScript("document.getAnimations().filter((a) => a.playState === 'running').length");
  // the hero's CSS animation name: still set after a short pulse ends, so a slow machine that samples late sees it too
  const heroAnim = await wc.executeJavaScript(
    "(() => { const h = document.querySelector('#hero .hcard'); return h ? getComputedStyle(h).animationName : 'none'; })()",
  );
  const live = await wc.executeJavaScript("document.getElementById('live').textContent");
  // a few facts about the page for the tests: what is on screen and where
  const probe = await wc.executeJavaScript(`(() => {
    const q = (s) => document.querySelector(s), all = (s) => [...document.querySelectorAll(s)];
    const vis = (e) => !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().height > 0;
    const x = (e) => (e ? Math.round(e.getBoundingClientRect().left) : null);
    const hero = q("#hero .hcard");
    return {
      hero: hero ? hero.querySelector(".hsay").textContent : "",
      heroClass: hero ? hero.className : "",
      heroDir: hero ? getComputedStyle(hero).direction : "",
      age: q("#hero .hage") ? q("#hero .hage").textContent : "",
      labels: all("#chips .rail .chip .ct").map((e) => e.textContent),
      newDots: all("#chips .rail .chip .ndot").length,
      more: q("#chips .morecards") ? q("#chips .morecards").textContent : "",
      sources: all("#chips .src").map((e) => e.textContent),
      pillX: x(q("#hero .pill")), ctlX: x(q("#hero .hctl")), heroX: x(hero), heroW: hero ? Math.round(hero.getBoundingClientRect().width) : 0,
      pillsX: all("#chips .pills .chip").map((e) => x(e)), railX: all("#chips .rail .chip").map((e) => x(e)),
      topX: x(q("#top .name")), wrapW: Math.round(innerWidth),
      because: q("#hero .hwhy .lk") ? { text: q("#hero .hwhy .lk").textContent, bidi: getComputedStyle(q("#hero .hwhy .lk")).unicodeBidi } : null,
      ask: q("#hero .hask") ? q("#hero .hask").textContent : "",
      note: vis(q("#note")) ? q("#note").textContent : "",
      strips: [vis(q("#last")) ? q("#last").textContent : "", vis(q("#lastme")) ? q("#lastme").textContent : ""],
      menuOpen: vis(q("#hero .hmenu")),
      skeleton: all("#recap .rs.skel").length,
      recapSections: all("#recap .rs").length,
      recapTop: q("#recap") && vis(q("#recap")) ? Math.round(q("#recap").getBoundingClientRect().top) : null,
      captionBottom: vis(q("#last")) ? Math.round(q("#last").getBoundingClientRect().bottom) : null,
      bar: document.body.classList.contains("bar"),
      iconOnly: all("#hero .b.ib").every((b) => !b.textContent.trim() && b.getAttribute("aria-label")),
      // is the hero text clamped or cut
      heroClamped: hero ? hero.querySelector(".hsay").classList.contains("clamp") : false,
      heroCut: hero ? hero.querySelector(".hsay").scrollHeight > hero.querySelector(".hsay").clientHeight + 1 : false,
      moreBtn: hero && hero.querySelector(".b.more") ? hero.querySelector(".b.more").textContent : "",
      about: q("#hero .habout") ? q("#hero .habout").textContent : "",
      ageWarn: !!q("#hero .hage.warn"),
      chipKinds: all("#chips .rail .chip").map((e) => (e.className.match(/k-([a-z]+)/) || ["", "more"])[1]),
      chipAges: all("#chips .rail .chip .cage").map((e) => e.textContent),
      chipMarks: all("#chips .rail .chip .kmark").length,
      chipKdots: all("#chips .kdot").length,
      chipNdots: all("#chips .rail .chip .ndot").length,
      ctx: q("#chips .ctxbtn") ? { text: q("#chips .ctxbtn").textContent, badge: q("#chips .ctxbtn .cbadge") ? q("#chips .ctxbtn .cbadge").textContent : "", font: q("#chips .ctxbtn .cbadge") ? getComputedStyle(q("#chips .ctxbtn .cbadge")).fontFamily : "", chipFont: getComputedStyle(q("#chips .ctxbtn")).fontFamily } : null,
      primaries: all("#chips .primary, #recap .primary, #wlist .primary").length,
      primaryText: q("#chips .primary") ? q("#chips .primary").textContent : "",
      listText: q("#wlist") && vis(q("#wlist")) ? q("#wlist").textContent : "",
      flash: hero ? hero.classList.contains("flash") : false,
      slides: all("#chips .chip.slide").length,
      keyHints: all("#keys kbd").length,
      keysDir: (document.getElementById("keys") || {}).dir || "",
      firstKeyText: ((document.querySelector("#keys .it") || {}).textContent || "").replace(/\\s+/g, ""),
      ctlOpacity: hero ? getComputedStyle(hero.querySelector(".hctl")).opacity : "",
      active: document.activeElement ? { cls: document.activeElement.className, fk: document.activeElement.dataset.fk || "", outline: getComputedStyle(document.activeElement).outlineStyle, outlineW: getComputedStyle(document.activeElement).outlineWidth } : null,
      heroFont: hero ? parseFloat(getComputedStyle(hero.querySelector(".hsay")).fontSize) : 0,
      lastFont: vis(q("#last")) ? parseFloat(getComputedStyle(q("#last .txt")).fontSize) : 0,
      lastLines: vis(q("#last")) ? Math.round(q("#last .txt").getBoundingClientRect().height / parseFloat(getComputedStyle(q("#last .txt")).lineHeight)) : 0,
      ageDir: q("#hero .hage") ? { dir: q("#hero .hage").dir, bidi: getComputedStyle(q("#hero .hage")).unicodeBidi } : null,
      aiPaused: document.body.classList.contains("ai-paused") && vis(q("#aipill")),
      aiOffline: document.body.classList.contains("ai-offline") && vis(q("#aibar")),
      kindPill: vis(q("#kindpill")) ? { text: q("#kindpill").textContent, title: q("#kindpill").title, locked: q("#kindpill").dataset.locked } : null,
      nudge: vis(q("#nudge")) ? q("#nudge").textContent : "",
      legacyCards: all("#cards .card").length,
      menuBtns: all("#hero .hmenu .b").map((b) => b.textContent),
    };
  })()`);
  let fitInfo;
  if (fit) {
    // a hidden window paints late: wait until the page has stopped reporting new heights
    for (let n = 0, seen = -1; n < 5 && seen !== sizes.length;) {
      seen = sizes.length;
      await sleep(250);
      n = seen === sizes.length ? n + 5 : n + 1;
    }
    const h1 = sizes[sizes.length - 1] || 0;
    win.setContentSize(760, Math.max(40, Math.min(900, h1))); // what main.cjs does, inside a 900 px work area
    await sleep(700);
    const h2 = sizes[sizes.length - 1] || 0;
    const inner = await wc.executeJavaScript("window.innerHeight");
    fitInfo = { reported: h1, after: h2, inner, stable: Math.abs(h2 - h1) <= 2, reports: sizes.length };
  }
  await wc.insertCSS("*,*::before,*::after{animation:none!important;transition:none!important}"); // a hidden window can freeze an animation half way; snapshots show the end state
  wc.invalidate();
  await sleep(250);
  await wc.capturePage(); // the first capture after a change can still return the previous frame of a hidden window
  wc.invalidate();
  await sleep(100);
  const png = path.join(outDir, spec.replace(/[:,]/g, "-") + ".png");
  fs.writeFileSync(png, (await wc.capturePage()).toPNG());
  /** @type {any} */
  let result = {
    spec,
    png,
    lang: LANG,
    ipc,
    animations,
    heroAnim,
    live,
    probe,
    focusable: win.isFocusable(),
    focused: win.isFocused(),
    ...(fitInfo ? { fit: fitInfo } : {}),
  };
  if (check) {
    const qa = await wc.executeJavaScript(QA + "\n;WingmanQa.run()");
    result = { ...result, ...qa };
    if (fitInfo && !fitInfo.stable)
      result.issues.push({ type: "fit", sel: "#wrap", detail: `height keeps changing: ${fitInfo.reported} then ${fitInfo.after}` });
    if (fitInfo && fitInfo.inner < fitInfo.reported && fitInfo.reported <= 900)
      result.issues.push({ type: "fit", sel: "#wrap", detail: `window ${fitInfo.inner}px is shorter than content ${fitInfo.reported}px` });
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
