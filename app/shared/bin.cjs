"use strict";
// Where to find the tools Wingman spawns (tsx for the engine, electron for the answer window).
// macOS and Linux: node_modules/.bin/<name>, as before. Windows: .bin/<name> is a .cmd shim and Node refuses to spawn a .cmd without a
// shell, so tsx runs as `node <tsx>/dist/cli.mjs` and electron runs as its real executable (node_modules/electron/dist/electron.exe).
// `platform` is a parameter (default process.platform) so the Windows branch is unit-tested on any machine.
const nodePath = require("node:path");
const nodeFs = require("node:fs");

/** Path of the tsx CLI entry inside node_modules (the "bin" of the tsx package). */
const tsxCli = (root, path = nodePath) => path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

/** The real Electron executable on Windows: node_modules/electron/path.txt names it relative to dist/. */
function electronExe(root, { path = nodePath, fs = nodeFs, env = process.env } = {}) {
  const dir = path.join(root, "node_modules", "electron");
  let rel = "electron.exe";
  try {
    rel = fs.readFileSync(path.join(dir, "path.txt"), "utf8").trim() || rel;
  } catch {
    /* not downloaded yet: the default name */
  }
  return env.ELECTRON_OVERRIDE_DIST_PATH ? path.join(env.ELECTRON_OVERRIDE_DIST_PATH, rel) : path.join(dir, "dist", rel);
}

/** The tools the packaged app can run (the bundled engine, src/<name>.mjs). Anything else is refused. */
const PACKED_TOOLS = [
  "call",
  "run",
  "doctor",
  "summary",
  "settings-edit-cli",
  "profile-edit-cli",
  "mics-cli",
  "settings-cli",
  "prepare-cli",
  "export-cli",
  "features-cli",
];

/** True inside the packaged app: the build writes packaged.json next to the code. A checkout never has it. */
function isPackaged(root, fs = nodeFs) {
  try {
    return fs.existsSync(nodePath.join(root, "packaged.json"));
  } catch {
    return false;
  }
}

/**
 * Packaged app (no Node, no node_modules): the app's own executable runs the bundled engine.
 * tsx tool  -> Wingman --wingman-tool <name> -- <args>     (see tray/app-entry.cjs)
 * electron  -> Wingman --wingman-overlay -- <args>         (the answer window)
 */
function packedCommand(name, list, o) {
  const cmd = o.execPath || process.execPath;
  if (name === "electron") return { cmd, args: ["--wingman-overlay", "--", ...list.slice(1)] };
  const tool =
    String(list[0] || "")
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.ts$/, "") ?? ""; // a Windows path has backslashes
  if (name !== "tsx" || !PACKED_TOOLS.includes(tool)) throw new Error(`"${tool || name}" is not part of the packaged app`);
  return { cmd, args: ["--wingman-tool", tool, "--", ...list.slice(1)] };
}

/**
 * Command and arguments to run a local tool: spawn(cmd, args). `name` is "tsx" or "electron".
 * o.platform / o.path / o.fs / o.execPath / o.env / o.packaged are injectable for tests.
 */
function binCommand(name, args, root, o = {}) {
  if (o.packaged ?? isPackaged(root, o.fs)) return packedCommand(name, Array.isArray(args) ? args : [], o);
  const platform = o.platform || process.platform;
  const path = o.path || (platform === "win32" ? nodePath.win32 : nodePath.posix);
  const list = Array.isArray(args) ? args : [];
  if (platform !== "win32") return { cmd: path.join(root, "node_modules", ".bin", name), args: list };
  if (name === "tsx") return { cmd: o.execPath || process.execPath, args: [tsxCli(root, path), ...list] };
  if (name === "electron") return { cmd: electronExe(root, { path, fs: o.fs, env: o.env }), args: list };
  return { cmd: path.join(root, "node_modules", ".bin", name + ".cmd"), args: list };
}

module.exports = { binCommand, tsxCli, electronExe, isPackaged, PACKED_TOOLS };
