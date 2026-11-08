"use strict";
// Wingman window, main process side of the call memory (pure fs, no Electron, so tests can run it). window.cjs wraps these in IPC handlers.
//   readMemory(callsDir, id)          calls/<id>/session.json -> the memory or null (a symlink, a big file or a torn file is null)
//   knowsLive(callsDir, id)           the live "What Wingman knows" model for a call
//   editMemory(callsDir, id, raw)     a validated edit from the page -> calls/<id>/user-edits.jsonl (the engine applies it; see src/session/useredit.ts)
//   afterCall(callsDir, id, o)        open loops and decisions for the after-call view
// The page never gets a file path and never writes session.json. Every failure is a result, not a throw.
const nodeFs = require("node:fs");
const nodePath = require("node:path");
const MV = require("../shared/memview.js");
const ME = require("../shared/memedit.cjs");
const K = require("./knowslib.js");

const ID_RE = /^[0-9A-Za-z_-]{8,40}$/;
const MAX_BYTES = 512 * 1024;
const EDITS_FILE = "user-edits.jsonl";
const MAX_EDIT_ROWS = 500; // a flood of edits stops here; the window says "too many changes"

/** The call folder, strictly inside callsDir (a symlink such as calls/latest is not a call). Null when it is not one. */
function dirOf(callsDir, id, fs = nodeFs, path = nodePath) {
  if (typeof id !== "string" || !ID_RE.test(id)) return null;
  try {
    const base = fs.realpathSync(callsDir),
      dir = path.join(base, id);
    if (path.dirname(dir) !== base || !fs.lstatSync(dir).isDirectory()) return null;
    return dir;
  } catch {
    return null;
  }
}

function readMemory(callsDir, id, o = {}) {
  const fs = o.fs || nodeFs,
    path = o.path || nodePath;
  const dir = dirOf(callsDir, id, fs, path);
  if (!dir) return null;
  try {
    const f = path.join(dir, "session.json"),
      ls = fs.lstatSync(f);
    if (!ls.isFile() || ls.size > MAX_BYTES) return null;
    return MV.parseMemory(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

/** { ok: true, model, ver } with model null when the call has no memory yet. */
function knowsLive(callsDir, id, o) {
  const mem = readMemory(callsDir, id, o);
  return { ok: true, model: mem ? K.fromMemory(mem) : null, ver: mem ? Number(mem.ver) || 0 : 0 };
}

/** raw: what the page sent. Returns { ok: true } or { ok: false, error }. Nothing is written when the edit is not valid or the call is not a call folder. */
function editMemory(callsDir, id, raw, o = {}) {
  const fs = o.fs || nodeFs,
    path = o.path || nodePath;
  const chk = ME.validateEdit(raw);
  if (!chk.ok) return { ok: false, error: "bad edit: " + chk.reason };
  const dir = dirOf(callsDir, id, fs, path);
  if (!dir) return { ok: false, error: "no call" };
  try {
    const f = path.join(dir, EDITS_FILE);
    let n = 0;
    try {
      n = fs.readFileSync(f, "utf8").split("\n").length - 1;
    } catch {
      /* no queue yet */
    }
    if (n >= MAX_EDIT_ROWS) return { ok: false, error: "too many changes" };
    fs.appendFileSync(f, JSON.stringify({ at: o.now || Date.now(), edit: chk.edit }) + "\n", { mode: 0o600 });
    return { ok: true, queued: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}

/** For the after-call view: the open loops and the decisions (the page builds the draft text with its own words: MV.draftText). null when the call has no memory. */
function afterCall(callsDir, id, o = {}) {
  const mem = readMemory(callsDir, id, o);
  if (!mem) return null;
  const loops = MV.openLoops(mem, { meNames: o.meNames });
  const decisions = (mem.decisions || []).slice(-5).map((d) => MV.str(d.text, 200));
  return { ver: Number(mem.ver) || 0, loops, decisions, empty: MV.draftText({ decisions, loops }).empty };
}

module.exports = { dirOf, readMemory, knowsLive, editMemory, afterCall, EDITS_FILE, MAX_EDIT_ROWS };
