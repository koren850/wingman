"use strict";
// Wingman window, main process side of the r3 features (pure fs, no Electron, so tests can run it). window.cjs wraps these in IPC handlers.
//   modeArg(kind, custom)                 a mode choice from the page -> "auto" | a kind | a custom mode id, or null (anything else is refused)
//   setMode(controller, kind, custom)     the mode command for the running call: { ok, error? } (the controller sends it down the control socket)
//   readHeld(callsDir, id)                the ratings of held-back moments of one finished call (heldback.json)
//   rateHeld(callsDir, id, key, rating)   store one rating; returns { ok, ratings, learnTag } where learnTag is the moment kind to tell learn.ts about (once per moment)
// The page never sends a file path and never names the kind of moment: the tag is read again from the call's own events.jsonl.
const fs = require("node:fs");
const path = require("node:path");
const Trust = require("./trustlib.js");

const KINDS = ["client", "support", "vendor", "team", "consult", "personal", "interview", "other"];
const ID_RE = /^[0-9A-Za-z_-]{8,40}$/;
const HELD_FILE = "heldback.json";
const MAX_BYTES = 64 * 1024;

/** "auto", a built-in kind, or the id of a custom mode in `custom` ([{ id }]). Null for anything else. */
function modeArg(kind, custom) {
  if (typeof kind !== "string") return null;
  if (kind === "auto" || KINDS.includes(kind)) return kind;
  return (Array.isArray(custom) ? custom : []).some((m) => m && m.id === kind) && /^[A-Za-z0-9_-]{1,20}$/.test(kind) ? kind : null;
}

/** Sends the mode to the running call through the controller (control socket command "mode"). The engine refuses a model change when the kind is locked; the user's choice always wins. */
function setMode(controller, kind, custom) {
  const k = modeArg(kind, custom);
  if (!k) return { ok: false, error: "bad-kind" };
  if (!controller || typeof controller.mode !== "function") return { ok: false, error: "unavailable" };
  let sent = false;
  try {
    sent = !!controller.mode(k);
  } catch {
    sent = false;
  }
  return sent ? { ok: true, kind: k } : { ok: false, error: "no-call" };
}

function dirOf(callsDir, id) {
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
function readJsonl(dir, f) {
  try {
    return fs
      .readFileSync(path.join(dir, f), "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}
function readHeldFile(dir) {
  try {
    const f = path.join(dir, HELD_FILE),
      st = fs.lstatSync(f);
    if (!st.isFile() || st.size > MAX_BYTES) return { ratings: {}, applied: [] };
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    return {
      ratings: Trust.heldRatings(j && j.ratings),
      applied: (Array.isArray(j && j.applied) ? j.applied : []).filter((k) => typeof k === "string" && /^[A-Za-z0-9:_.-]{1,80}$/.test(k)).slice(0, 200),
    };
  } catch {
    return { ratings: {}, applied: [] };
  }
}

function readHeld(callsDir, id) {
  const dir = dirOf(callsDir, id);
  return dir ? readHeldFile(dir).ratings : {};
}

/**
 * Stores a rating ("wanted" | "fine", or null to clear) for one held-back moment. `key` comes from trustlib.heldBack. The moment is looked up again in the call's events.jsonl;
 * learnTag is its kind of card when the rating is "wanted", it has a kind, and learning was not told about this moment before. At most 200 ratings are kept per call.
 */
function rateHeld(callsDir, id, key, rating) {
  const dir = dirOf(callsDir, id);
  if (!dir) return { ok: false, error: "no-call" };
  if (typeof key !== "string" || !/^[A-Za-z0-9:_.-]{1,80}$/.test(key)) return { ok: false, error: "bad-key" };
  if (rating !== null && rating !== "wanted" && rating !== "fine") return { ok: false, error: "bad-rating" };
  const m = /:(\d+)$/.exec(key);
  const ev = m ? readJsonl(dir, "events.jsonl")[Number(m[1])] : undefined;
  const held = ev ? Trust.heldBack([ev], [], {}) : [];
  if (!held.length) return { ok: false, error: "not-held-back" };
  const cur = readHeldFile(dir);
  if (rating) cur.ratings[key] = rating;
  else delete cur.ratings[key];
  const tag = held[0].tag;
  const learnTag = rating === "wanted" && tag && !cur.applied.includes(key) ? tag : "";
  if (learnTag) cur.applied.push(key);
  if (Object.keys(cur.ratings).length > 200) return { ok: false, error: "too-many" };
  const tmp = path.join(dir, `.${HELD_FILE}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(cur), { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, HELD_FILE));
  return { ok: true, ratings: cur.ratings, learnTag };
}

module.exports = { modeArg, setMode, readHeld, rateHeld, KINDS, HELD_FILE };
