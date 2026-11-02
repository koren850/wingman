// Renders brand/jobs.json (from build.py) to PNGs with an offscreen Electron window.
// Run via brand/build.sh. Hidden: no window, no Dock icon, never takes focus.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

app.dock && app.dock.hide();
app.disableHardwareAcceleration();

let win;
async function render(job) {
  const svg = fs.readFileSync(job.svg, "utf8").replace(/width="[^"]*" height="[^"]*"/, `width="${job.w}" height="${job.h}"`);
  const html = `<!doctype html><html><head><meta charset="utf-8"><link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@600;800&family=Unbounded:wght@700&display=swap" rel="stylesheet">
<style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block}</style></head><body>${svg}</body></html>`;
  // One window for all jobs (a new renderer per job fails under the macOS sandbox).
  if (!win) {
    win = new BrowserWindow({ show: false, width: job.w, height: job.h, useContentSize: true, frame: false, transparent: true,
      enableLargerThanScreen: true, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true } });
    win.webContents.setFrameRate(10);
  }
  win.setContentSize(job.w, job.h);
  const tmp = path.join(app.getPath("temp"), `wingman-brand-${process.pid}.html`);
  fs.writeFileSync(tmp, html);
  await win.loadFile(tmp);
  fs.rmSync(tmp, { force: true });
  await win.webContents.executeJavaScript("document.fonts.ready.then(() => new Promise(r => setTimeout(r, 300)))");
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: job.w, height: job.h });
  const out = img.getSize().width === job.w ? img : img.resize({ width: job.w, height: job.h, quality: "best" });
  fs.mkdirSync(path.dirname(job.out), { recursive: true });
  fs.writeFileSync(job.out, out.toPNG());
}

app.whenReady().then(async () => {
  const arg = process.argv.find((a) => a.endsWith(".json"));
  const jobs = JSON.parse(fs.readFileSync(arg || path.join(__dirname, "jobs.json"), "utf8"));
  for (const j of jobs) await render(j);
  console.log(`rendered ${jobs.length} PNGs`);
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });
