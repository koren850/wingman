"use strict";
// Start-up checks of the packaged app (tray/app-entry.cjs). No Electron here, so they are unit-tested.
const cp = require("node:child_process");
const nodeCrypto = require("node:crypto");

/**
 * Command-line switches that hand control of the app to another program. Chromium reads them before our code runs and accepts one or two dashes.
 * The RunAsNode / NODE_OPTIONS / inspect fuses do not cover these.
 *  - remote debugging and inspector: a local program could drive every window (and the keys and settings behind them)
 *  - js-flags, load-extension, renderer/utility/gpu launchers: run foreign code in our processes
 *  - web security, certificate, proxy and host-rule switches: redirect or weaken the network of the app
 *  - no-sandbox: removes the renderer sandbox
 */
const REFUSED_SWITCH =
  /^--?(remote-debugging|remote-allow-origins|inspect|debug-brk|js-flags|load-extension|disable-extensions-except|disable-web-security|disable-site-isolation|no-sandbox|disable-gpu-sandbox|host-rules|host-resolver-rules|proxy-server|proxy-pac-url|proxy-bypass-list|ignore-certificate-errors|ignore-urlfetcher-cert-requests|allow-running-insecure-content|allow-file-access-from-files|unsafely-treat-insecure-origin-as-secure|renderer-cmd-prefix|utility-cmd-prefix|gpu-launcher|ppapi-plugin-launcher|enable-blink-features)/i;

/** The first argument that is a refused switch, or null. */
function refusedSwitch(argv) {
  for (const a of argv) if (typeof a === "string" && REFUSED_SWITCH.test(a)) return a.split("=")[0].slice(0, 60);
  return null;
}

/** A fresh secret for one tray run. Children get it in their environment (WINGMAN_TOOL_TOKEN). */
const newToken = () => nodeCrypto.randomBytes(24).toString("hex");

/**
 * The program that runs as `pid`, or "" when unknown. macOS/Linux: the path from ps. Windows: only the image name from tasklist
 * (for example "Wingman.exe"); callerProblem compares names there. `run` is injectable for tests.
 */
function exeOf(pid, platform = process.platform, run = cp.execFileSync) {
  try {
    if (platform === "win32") {
      const root = process.env.SystemRoot || "C:\\Windows";
      const out = run(root + "\\System32\\tasklist.exe", ["/FI", `PID eq ${Number(pid)}`, "/FO", "CSV", "/NH"], {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      });
      const m = String(out)
        .trim()
        .match(/^"([^"]+)","(\d+)"/); // "Wingman.exe","1234",...  (no match: "INFO: No tasks are running ...")
      return m && Number(m[2]) === Number(pid) ? m[1] : "";
    }
    return run("/bin/ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8", timeout: 3000 }).trim();
  } catch {
    return "";
  }
}

/** True when the process image `found` (a path, or a bare image name on Windows) is the running executable `execPath`. */
function sameProgram(found, execPath, platform = process.platform) {
  if (!found) return false;
  if (platform !== "win32") return found === execPath;
  const base = (x) => String(x).split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return base(found) === base(execPath);
}

/**
 * Tools and the answer window may only be started by a Wingman process (the menu-bar app or another tool of it).
 * Needs both the per-run token in the environment and a parent that is this same executable. `open -a Wingman --args ...` or a shell
 * has neither. Returns null when allowed, else a one-line reason.
 * The background summary outlives the call that started it, so its parent may be gone (ppid 1): then the pid the spawner left in
 * WINGMAN_PARENT_PID must be a Wingman process or no process at all.
 */
function callerProblem({ env, ppid, execPath, tool = "", exe = exeOf, platform = process.platform }) {
  if (!/^[0-9a-f]{48}$/.test(String(env.WINGMAN_TOOL_TOKEN || ""))) return "this part of Wingman can only be started by the Wingman app itself";
  if (!execPath) return "this part of Wingman was not started by the Wingman app";
  const parent = exe(ppid);
  if (sameProgram(parent, execPath, platform)) return null;
  const spawner = /^[1-9][0-9]{0,9}$/.test(String(env.WINGMAN_PARENT_PID || "")) ? Number(env.WINGMAN_PARENT_PID) : 0;
  // A finished parent: macOS/Linux hand the child to pid 1; Windows keeps the old pid number, which no process has any more.
  const orphan = platform === "win32" ? parent === "" : ppid === 1;
  const spawnerExe = spawner > 1 ? exe(spawner) : null;
  if (tool === "summary" && orphan && spawnerExe !== null && (spawnerExe === "" || sameProgram(spawnerExe, execPath, platform))) return null;
  return "this part of Wingman was not started by the Wingman app";
}

module.exports = { refusedSwitch, newToken, callerProblem, exeOf, REFUSED_SWITCH };
