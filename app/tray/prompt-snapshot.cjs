"use strict";
// Hidden snapshot of the note window (prompt.html): never shows a window, no call, no network.
// Usage: electron tray/prompt-snapshot.cjs <outDir> [kind]    kind = note | brief (default note)
// Writes <outDir>/prompt-<kind>-<lang>-<theme>.png and .json for English and Hebrew, light and dark. The json has the clip and contrast checks:
// { lang, dir, theme, overflow: bool, clipped: [ids], contrast: { min, pairs } }. src/r3-app-ux.test.ts runs it when WINGMAN_DASH_SNAP=1.
const { app, BrowserWindow, nativeTheme } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const out = process.argv[2];
const kind = process.argv[3] === "brief" ? "brief" : "note";
if (!out) {
  console.error("usage: electron prompt-snapshot.cjs <outDir> [note|brief]");
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true, mode: 0o700 });

/** Runs in the page: size checks and the contrast of the main text pairs. */
const CHECK = `(() => {
  const lum = (c) => { const m = c.match(/[\\d.]+/g).map(Number); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (c && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(c)) return c; } return "rgb(255,255,255)"; };
  const pairs = [];
  const form = document.querySelector("form:not([hidden])");
  const els = [...form.querySelectorAll("h1, p, label, input, textarea, button")].filter((e) => e.offsetParent !== null && getComputedStyle(e).clipPath === "none");
  for (const e of els) pairs.push({ id: e.id || e.tagName.toLowerCase() + ":" + (e.textContent || "").slice(0, 12), ratio: Math.round(ratio(getComputedStyle(e).color, bgOf(e)) * 100) / 100 });
  const clipped = els.filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== "visible").map((e) => e.id || e.tagName);
  const de = document.documentElement;
  return { lang: de.lang, dir: de.dir, overflow: de.scrollWidth > de.clientWidth + 1 || de.scrollHeight > innerHeight + 1, clipped, minContrast: Math.min(...pairs.map((p) => p.ratio)), pairs, empty: els.filter((e) => /^(H1|P|LABEL|BUTTON)$/.test(e.tagName) && !e.textContent.trim()).length };
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 460, height: kind === "brief" ? 470 : 230, webPreferences: { sandbox: true, contextIsolation: true } });
  for (const lang of ["en", "he"])
    for (const theme of ["light", "dark"]) {
      nativeTheme.themeSource = /** @type {"light" | "dark"} */ (theme);
      await win.loadFile(path.join(__dirname, "prompt.html"), { query: { kind, lang } });
      for (let i = 0; i < 40 && !(await win.webContents.executeJavaScript("document.body.dataset.ready === '1'")); i++)
        await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 200));
      const r = await win.webContents.executeJavaScript(CHECK);
      const base = path.join(out, `prompt-${kind}-${lang}-${theme}`);
      fs.writeFileSync(base + ".json", JSON.stringify({ ...r, theme }, null, 1));
      fs.writeFileSync(base + ".png", (await win.webContents.capturePage()).toPNG());
    }
  win.destroy();
  app.quit();
});
