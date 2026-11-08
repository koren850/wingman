"use strict";
// Answer window, main process side of the call memory: turns session.json and `{type:"memory"}` rows into the `view` row the page draws,
// and tracks the "AI paused / offline" state from the engine's health rows. No Electron here, so tests can run it.
//
//   const feed = createMemoryFeed({ send(row) })      send gets a { type: "view", ... } row for the page
//   feed.fromDir(dir)       read dir/session.json when it changed (call about once a second); sends a row when the memory has a new version
//   feed.fromRow(row)       a { type: "memory", view, ai? } row from the engine's relay (used when session.json cannot be read, or arrives first)
//   feed.health(row)        a health card row; sets or clears the AI state; sends a row when it changed
//   feed.recap(payload)     a { type: "recap" } row -> a clean payload for the page (or null)
//   feed.reset()            a new call
const nodeFs = require("node:fs");
const nodePath = require("node:path");
const MV = require("../shared/memview.js");

const MAX_BYTES = 512 * 1024;
const parseMemory = MV.parseMemory;

function createMemoryFeed(o) {
  const fs = o.fs || nodeFs,
    path = o.path || nodePath,
    send = o.send;
  let sig = "",
    ver = -1,
    ai = "ok",
    aiBars = new Map(),
    /** @type {any} */ last = null,
    /** @type {any} */ lastMem = null,
    /** @type {any} */ lastRecap = null;

  const emit = () => {
    if (!last) return;
    const row = MV.overlayViewRow(lastMem || last, { ai, recap: lastRecap || undefined, at: o.now ? o.now() : Date.now() });
    send(row);
  };
  const recomputeAi = () => MV.aiState(aiBars);

  const api = {
    get ai() {
      return ai;
    },
    reset() {
      sig = "";
      ver = -1;
      ai = "ok";
      aiBars = new Map();
      last = null;
      lastMem = null;
      lastRecap = null;
    },
    fromDir(dir) {
      const f = path.join(dir, "session.json");
      let text;
      try {
        const ls = fs.lstatSync(f);
        if (!ls.isFile() || ls.size > MAX_BYTES) return false;
        const s = `${ls.mtimeMs}:${ls.size}`;
        if (s === sig) return false;
        text = fs.readFileSync(f, "utf8");
        sig = s;
      } catch {
        return false;
      }
      const mem = parseMemory(text);
      if (!mem) sig = ""; // torn or unreadable: read it again on the next call
      if (!mem || (Number(mem.ver) || 0) < ver) return false; // unreadable (half-written) or older than what is on screen
      ver = Number(mem.ver) || 0;
      lastMem = mem;
      last = mem;
      emit();
      return true;
    },
    fromRow(row) {
      if (!row || typeof row !== "object") return false;
      const view = MV.cleanView(row.view);
      if (!view) return false;
      let aiChanged = false;
      if (typeof row.ai === "string" && ["ok", "offline", "paused"].includes(row.ai)) {
        aiBars.clear();
        aiChanged = row.ai !== ai;
        ai = row.ai;
      }
      if (lastMem ? view.ver <= (Number(lastMem.ver) || 0) : view.ver < ver) {
        if (aiChanged) emit(); // the file (or a newer view) already gave this version; only the AI state is new
        return aiChanged;
      }
      ver = view.ver;
      last = view;
      lastMem = null;
      emit();
      return true;
    },
    health(row) {
      if (!row || typeof row.id !== "string" || !MV.AI_BARS[row.id]) return false;
      if (row.clear) aiBars.delete(row.id);
      else aiBars.set(row.id, row.level === "red" ? "red" : "amber");
      const next = recomputeAi();
      if (next === ai) return false;
      ai = next;
      if (!last) last = { ver: 0, topic: "", soFar: [], open: [], promises: [], coverLeft: [] }; // the pill must show even before the first memory
      emit();
      return true;
    },
    /** A recap row: { type:"recap", phase: "start"|"delta"|"done"|"error", text?, recap?, message? } -> the payload for the page, or null. */
    recap(row) {
      if (!row || typeof row !== "object") return null;
      const phase = ["start", "delta", "done", "error"].includes(row.phase) ? row.phase : "";
      if (!phase) return null;
      const text = typeof row.text === "string" ? row.text.slice(0, 4000) : "";
      /** @type {any} */
      let recap = null;
      if (row.recap && typeof row.recap === "object") {
        const r = row.recap;
        const l = (v) =>
          Array.isArray(v)
            ? v
                .map((x) => MV.str(x, 200))
                .filter(Boolean)
                .slice(0, 3)
            : [];
        recap = { where: MV.str(r.where, 240), decided: l(r.decided), open: l(r.open), promised: l(r.promised), asked: l(r.asked) };
      }
      return { phase, text, recap, offline: row.offline === true, notes: row.notes === true };
    },
  };
  return api;
}

module.exports = { createMemoryFeed, parseMemory, MAX_BYTES };
