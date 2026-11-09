"use strict";
// Hidden Electron helper for docs/ux pictures (run by docshots.sh; never shows a window and never takes focus).
//   electron docshots.cjs social <out.png> <windowShot.png> <lockup.png> "<tagline>"   the 1280x640 social preview
//   electron docshots.cjs crop <in.png> <out.png> <x> <y> <w> <h>                       a piece of a picture
const { app, BrowserWindow, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.dock && app.dock.hide();
app.disableHardwareAcceleration();

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const dataUri = (f) => "data:image/png;base64," + fs.readFileSync(f).toString("base64");

function socialHtml(shot, lockup, tagline) {
  return `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;width:1280px;height:640px;overflow:hidden}
  body{background:radial-gradient(900px 600px at 20% 30%,#2a1c10 0%,#150f0a 70%);color:#fdf6e8;font-family:system-ui,-apple-system,"Helvetica Neue",sans-serif;display:flex;align-items:center}
  .l{width:560px;padding-left:64px;box-sizing:border-box}
  .l img.lock{width:400px;display:block}
  .tag{margin-top:34px;font-size:27px;line-height:1.36;color:#f0e0c4;font-weight:500}
  .tech{margin-top:30px;font-size:21px;color:#f3a93c;font-weight:600}
  .r{flex:1;display:flex;justify-content:center;padding-right:24px}
  .win{width:660px;border-radius:14px;overflow:hidden;border:1px solid #5b4630;box-shadow:0 18px 50px rgba(0,0,0,.55);background:#0f1722}
  .win img{display:block;width:660px}
  </style><body><div class="l"><img class="lock" src="${dataUri(lockup)}"><div class="tag">${esc(tagline)}</div>
  <div class="tech">macOS · Windows · Electron · TypeScript · Deepgram · Claude</div></div>
  <div class="r"><div class="win"><img src="${dataUri(shot)}"></div></div></body>`;
}

async function page(w, h, html) {
  const win = new BrowserWindow({
    show: false,
    width: w,
    height: h,
    useContentSize: true,
    frame: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true },
  });
  win.webContents.setFrameRate(10);
  const tmp = path.join(app.getPath("temp"), `wingman-docshot-${process.pid}.html`);
  fs.writeFileSync(tmp, html);
  await win.loadFile(tmp);
  fs.rmSync(tmp, { force: true });
  await win.webContents.executeJavaScript("document.fonts.ready.then(() => new Promise(r => setTimeout(r, 400)))");
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: w, height: h });
  win.destroy();
  return img;
}

app.whenReady().then(async () => {
  const [cmd, ...a] = process.argv.slice(2).filter((x) => !x.startsWith("--"));
  try {
    if (cmd === "social") {
      const [out, shot, lockup, tagline] = a;
      const img = await page(1280, 640, socialHtml(shot, lockup, tagline));
      fs.writeFileSync(out, (img.getSize().width === 1280 ? img : img.resize({ width: 1280, height: 640, quality: "best" })).toPNG());
    } else if (cmd === "crop") {
      const [inp, out, x, y, w, h] = a;
      const img = nativeImage.createFromPath(inp).crop({ x: +x, y: +y, width: +w, height: +h });
      fs.writeFileSync(out, img.toPNG());
    } else throw new Error("usage: social | crop");
    app.quit();
  } catch (e) {
    console.error(String(e));
    app.exit(1);
  }
});
