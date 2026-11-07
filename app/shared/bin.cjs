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

/**
 * Command and arguments to run a local tool: spawn(cmd, args). `name` is "tsx" or "electron".
 * o.platform / o.path / o.fs / o.execPath / o.env are injectable for tests.
 */
function binCommand(name, args, root, o = {}) {
  const platform = o.platform || process.platform;
  const path = o.path || (platform === "win32" ? nodePath.win32 : nodePath.posix);
  const list = Array.isArray(args) ? args : [];
  if (platform !== "win32") return { cmd: path.join(root, "node_modules", ".bin", name), args: list };
  if (name === "tsx") return { cmd: o.execPath || process.execPath, args: [tsxCli(root, path), ...list] };
  if (name === "electron") return { cmd: electronExe(root, { path, fs: o.fs, env: o.env }), args: list };
  return { cmd: path.join(root, "node_modules", ".bin", name + ".cmd"), args: list };
}

module.exports = { binCommand, tsxCli, electronExe };
