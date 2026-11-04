// The ONE place that decides where Wingman keeps the user's own data (calls, prepared meetings, background files, client snapshot).
// Used by the engine (src/env.ts), the menu-bar app, the window, the answer window, the CLI and the scripts.
//   default            ~/Library/Application Support/Wingman/        (folders 700, files 600)
//   WINGMAN_DATA_DIR   replaces that folder (tests, QA, a second profile)
//   WINGMAN_CALLS_DIR  replaces only the calls folder;  WINGMAN_BRIEFS_DIR only the prepared-meetings folder
// Layout inside the data folder:  calls/  briefs/ (briefs/attachments/)  entities.json  (same shape as the old stage0/calls and
// stage0/data/private in the repo folder). Settings, keys, profile and pack stay in ~/.config/wingman. stage0/data/ is for shipped data only.
const os = require("node:os");
const path = require("node:path");

const STAGE0 = path.join(__dirname, "..");

/** The data folder. `env` and `home` are injectable for tests. */
function dataDir(env = process.env, home = os.homedir()) {
  const d = env.WINGMAN_DATA_DIR;
  return d && d.trim() ? path.resolve(d.trim()) : path.join(home, "Library", "Application Support", "Wingman");
}
function callsDir(env = process.env, home = os.homedir()) {
  const d = env.WINGMAN_CALLS_DIR;
  return d && d.trim() ? path.resolve(d.trim()) : path.join(dataDir(env, home), "calls");
}
function briefsDir(env = process.env, home = os.homedir()) {
  const d = env.WINGMAN_BRIEFS_DIR;
  return d && d.trim() ? path.resolve(d.trim()) : path.join(dataDir(env, home), "briefs");
}
const attachDir = (env = process.env, home = os.homedir()) => path.join(briefsDir(env, home), "attachments");
const entitiesFile = (env = process.env, home = os.homedir()) => path.join(dataDir(env, home), "entities.json");

/** The old in-repo locations (before the move to the data folder). Only the one-time migration reads them. */
function legacyDirs(stage0 = STAGE0) {
  return { calls: path.join(stage0, "calls"), private: path.join(stage0, "data", "private") };
}

/** A path from settings (facts.file): the old default "data/private/..." now lives in the data folder; "~/" is the home folder;
 *  other relative paths stay relative to the repo's stage0 folder. */
function resolveUserPath(p, env = process.env, home = os.homedir(), stage0 = STAGE0) {
  const s = String(p || "");
  if (s.startsWith("~/")) return path.join(home, s.slice(2));
  if (path.isAbsolute(s)) return s;
  const m = s.replace(/\\/g, "/").match(/^data\/private\/(.+)$/);
  if (m) return path.join(dataDir(env, home), m[1]);
  return path.join(stage0, s);
}

/** True when the environment redirects the user data (tests, QA): then nothing is migrated from the repo folder. */
const isRedirected = (env = process.env) => !!(env.WINGMAN_DATA_DIR || env.WINGMAN_CALLS_DIR || env.WINGMAN_BRIEFS_DIR);

module.exports = { STAGE0, dataDir, callsDir, briefsDir, attachDir, entitiesFile, legacyDirs, resolveUserPath, isRedirected };
