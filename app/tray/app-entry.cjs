"use strict";
// Entry point of the packaged Wingman.app (the "main" of the app's package.json). Not used by the dev setup (pnpm tray, make-app.sh).
// The packaged app carries its own engine, so it needs no Node and no checkout:
//   Wingman                                   starts the menu-bar app (tray/main.cjs) and, from Finder, opens the window
//   Wingman --wingman-tool <name> -- <args>   runs one bundled tool (src/<name>.mjs) in this Electron process: the call, the readiness check, ...
//   Wingman --wingman-overlay -- <args>       runs the answer window (overlay/main.cjs)
// Only the names in shared/bin.cjs PACKED_TOOLS can run: no path from the command line is ever loaded. The RunAsNode fuse stays off.
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app } = require("electron");
const { PACKED_TOOLS } = require("../shared/bin.cjs");

const ROOT = path.join(__dirname, "..");
const argv = process.argv.slice(1);
const toolAt = argv.indexOf("--wingman-tool");
const overlay = argv.includes("--wingman-overlay");

// Finder gives apps only /usr/bin:/bin. ffmpeg (microphone) and pdftotext (optional) are looked up on the PATH, so add the usual places.
// Children (the engine, the answer window) inherit this.
process.env.PATH = [...new Set([...(process.env.PATH || "").split(":"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean))].join(":");
process.env.WINGMAN_APP = "1";

/** After "--": the arguments of the tool. */
const afterDash = (list) => {
  const i = list.indexOf("--");
  return i < 0 ? [] : list.slice(i + 1);
};
/** Background process: no Dock icon, and its own Chromium folder (the menu-bar app owns the main one). */
function backgroundProcess() {
  try {
    app.setActivationPolicy("accessory");
    app.dock && app.dock.hide();
  } catch {
    /* no dock */
  }
  app.setPath("userData", path.join(app.getPath("appData"), "Wingman-helper"));
}
/** Flushes stdout and stderr, then ends the process. */
function finish(code) {
  process.exitCode = code;
  process.stdout.write("", () => process.stderr.write("", () => app.exit(code)));
}
/** A crash must never raise Electron's error dialog (it could appear on a shared screen): print one line and exit. */
function quietCrashes() {
  const die = (e) => {
    console.error(`wingman: ${String((e && e.stack) || e).slice(0, 2000)}`);
    finish(1);
  };
  process.on("uncaughtException", die);
  process.on("unhandledRejection", die);
}
/** Short tools end when they have nothing left to do (a long call ends itself with process.exit). Only the stdio pipes may stay open. */
function exitWhenIdle() {
  let quiet = 0;
  const tick = () => {
    const res = process.getActiveResourcesInfo();
    res.splice(res.indexOf("Timeout"), 1); // this check's own timer is still listed while it runs
    const busy = res.filter((r) => r !== "PipeWrap" && r !== "TTYWrap");
    quiet = busy.length ? 0 : quiet + 1;
    if (quiet >= 3) return finish(process.exitCode || 0);
    setTimeout(tick, 100);
  };
  setTimeout(tick, 100);
}
const ONE_SHOT = new Set(["summary", "settings-edit-cli", "profile-edit-cli", "mics-cli", "settings-cli", "doctor"]);

if (toolAt >= 0) {
  const name = String(argv[toolAt + 1] || "");
  if (!PACKED_TOOLS.includes(name)) {
    console.error(`wingman: unknown tool "${name.slice(0, 40)}"`);
    app.exit(2);
  } else {
    backgroundProcess();
    quietCrashes();
    globalThis.__wmTool = name; // the bundled files that run only when started directly check this
    const file = path.join(ROOT, "src", name + ".mjs");
    process.argv = [process.execPath, file, ...afterDash(argv.slice(toolAt + 2))]; // what the tool would see under node
    import(pathToFileURL(file).href).then(
      () => ONE_SHOT.has(name) && exitWhenIdle(),
      (e) => {
        console.error(`wingman: ${name} failed to start: ${String((e && e.stack) || e).slice(0, 2000)}`);
        finish(1);
      },
    );
  }
} else if (overlay) {
  backgroundProcess();
  process.argv = [process.argv[0], path.join(ROOT, "overlay", "main.cjs"), ...afterDash(argv)];
  require("../overlay/main.cjs");
} else {
  // The menu-bar app. Opened from Finder or Launchpad (no flag from a script): show the window, like the dev app does.
  if (!process.env.WINGMAN_DASHBOARD_SNAPSHOT) process.argv.push("--open-window");
  require("./main.cjs");
}
