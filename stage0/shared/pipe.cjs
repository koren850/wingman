"use strict";
// Local IPC endpoint names. macOS and Linux use Unix sockets (a private folder, owner-only modes). Windows has no Unix sockets in Node's net
// module, so the same code listens on a named pipe  \\.\pipe\wingman-<user>-<name>  (a pipe is per-user by its name and ACL in the profile session).
// `platform` is a parameter so the Windows branch is unit-tested on any machine.
const nodeOs = require("node:os");

/** True when endpoints are named pipes instead of socket files. */
const usesPipes = (platform = process.platform) => platform === "win32";

/** \\.\pipe\wingman-<user>-<name>; user and name are reduced to [A-Za-z0-9_-] so the name is always a valid, predictable pipe name. */
function pipeName(name, user, platform = process.platform) {
  void platform;
  let u = user;
  if (u === undefined) { try { u = nodeOs.userInfo().username; } catch { u = process.env.USERNAME || process.env.USER || "user"; } }
  const clean = (s) => String(s || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48) || "x";
  return `\\\\.\\pipe\\wingman-${clean(u)}-${clean(name)}`;
}

/** The endpoint to listen on or connect to: a pipe name on Windows, else the given socket file path. */
const endpoint = (name, filePath, platform = process.platform, user) => (usesPipes(platform) ? pipeName(name, user, platform) : filePath);

module.exports = { usesPipes, pipeName, endpoint };
