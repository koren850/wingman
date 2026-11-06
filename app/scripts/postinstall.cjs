// postinstall: downloads the Electron binary (Electron 45 does not do it on its own) and builds .app/Wingman.app.
// Failures are NOT swallowed: they stop `pnpm install` with the reason and the fix. Skip on purpose with WINGMAN_SKIP_APP=1 (CI, tests only).
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const appDir = path.join(__dirname, "..");
const fail = (what, fix) => {
  console.error(`\nWingman: ${what}\n  Fix: ${fix}\n`);
  process.exit(1);
};

if (process.env.WINGMAN_SKIP_APP === "1") {
  console.log("Wingman: WINGMAN_SKIP_APP=1, skipping the Electron download and the app build.");
  process.exit(0);
}
if (process.platform !== "darwin") {
  console.log("Wingman: not macOS, skipping the Electron download and the app build.");
  process.exit(0);
}

const electronApp = path.join(appDir, "node_modules", "electron", "dist", "Electron.app");
if (!fs.existsSync(electronApp)) {
  console.log("Wingman: downloading the Electron runtime (about 110 MB, once)...");
  const r = spawnSync(process.execPath, [path.join(appDir, "node_modules", "electron", "install.js")], { cwd: appDir, stdio: "inherit" });
  if (r.status !== 0 || !fs.existsSync(electronApp)) {
    fail(
      "could not download the Electron runtime (see the error above).",
      "check your internet connection or proxy, then run:  cd app && node node_modules/electron/install.js && pnpm run make-app",
    );
  }
}
const r = spawnSync(path.join(appDir, "scripts", "make-app.sh"), [], { cwd: appDir, stdio: "inherit" });
if (r.status !== 0) fail("could not build .app/Wingman.app (see the error above).", "cd app && pnpm run make-app   (or run install.sh from the repo root)");
