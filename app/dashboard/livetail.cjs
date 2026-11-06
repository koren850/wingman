"use strict";
// Main-process tail of the live call's transcript.jsonl and cards.jsonl, for the Home "live conversation" view.
// Call content is read from the files and sent over a guarded IPC channel only. It is NEVER put on the @@wingman status lines
// (tray.log records those) and never logged. Polls every 150 ms while a call runs (that is also the batching), stops when it ends.
const nodeFs = require("node:fs");
const nodePath = require("node:path");
const feedLib = require("./livefeed.js");

const ID_RE = /^[0-9A-Za-z_-]{8,40}$/;
const MAX_READ = 512 * 1024,
  MAX_DELTA = 200;

/**
 * o: { callsDir, send(payload), interval?, fs?, path?, setInterval?, clearInterval? } (the last four are test seams).
 * Returns { sync, stop, snapshot, active, tick }. Payloads: { callId, reset, lines, cards, frame? } (+ ended on stop).
 */
function createLiveTail(o) {
  const fs = o.fs || nodeFs,
    path = o.path || nodePath,
    calls = o.callsDir,
    send = o.send;
  const every = o.interval || 150,
    setT = o.setInterval || setInterval,
    clearT = o.clearInterval || clearInterval;
  let cur = null,
    timer = null;

  const fresh = (id) => ({ id, feed: feedLib.create(), files: { transcript: { off: 0, carry: Buffer.alloc(0) }, cards: { off: 0, carry: Buffer.alloc(0) } } });

  /** New complete JSONL rows of <name>.jsonl since the last read (st = { off, carry }); at most MAX_READ bytes per call. [] on any error. */
  function readNew(dir, name, st) {
    let fd, size;
    try {
      const f = path.join(dir, name + ".jsonl"),
        ls = fs.lstatSync(f);
      if (!ls.isFile()) return [];
      size = ls.size;
      if (size < st.off) {
        st.off = 0;
        st.carry = Buffer.alloc(0);
      } // truncated: start over
      if (size === st.off) return [];
      const n = Math.min(size - st.off, MAX_READ);
      fd = fs.openSync(f, "r");
      const buf = Buffer.alloc(n);
      const got = fs.readSync(fd, buf, 0, n, st.off);
      st.off += got;
      // Bytes, not text: cut at the last newline so a multibyte character split across two reads is never decoded half.
      const data = Buffer.concat([st.carry, buf.subarray(0, got)]),
        nl = data.lastIndexOf(10);
      if (nl < 0) {
        st.carry = data.length > 20000 ? Buffer.alloc(0) : data;
        return [];
      }
      st.carry = data.subarray(nl + 1);
      return feedLib.parseJsonl("", data.subarray(0, nl + 1).toString("utf8")).rows;
    } catch {
      return [];
    } finally {
      if (fd !== undefined)
        try {
          fs.closeSync(fd);
        } catch {
          /* closed */
        }
    }
  }

  /** Call folder for id, strictly inside callsDir (lstat: a symlink such as calls/latest is rejected). Throws if missing. */
  function dirFor(id) {
    const base = fs.realpathSync(calls),
      dir = path.join(base, id);
    if (path.dirname(dir) !== base || !fs.lstatSync(dir).isDirectory()) throw new Error("not a call folder");
    return dir;
  }

  /** One poll: read new rows, update the feed, send a delta (or a full reset when a burst is too big). */
  function tick() {
    if (!cur) return;
    let dir;
    try {
      dir = dirFor(cur.id);
    } catch {
      return;
    } // not created yet
    const lr = readNew(dir, "transcript", cur.files.transcript),
      cr = readNew(dir, "cards", cur.files.cards);
    if (!lr.length && !cr.length) return;
    const lines = cur.feed.addLines(lr),
      cards = cur.feed.addCards(cr),
      frame = cur.feed.addFrameRows(cr),
      names = cur.feed.addSpeakerRows(cr);
    if (!lines.length && !cards.length && !frame && !names) return;
    if (lines.length > MAX_DELTA) {
      const s = cur.feed.snapshot();
      send({ callId: cur.id, reset: true, lines: s.lines, cards: s.cards, frame: s.frame, names: s.names });
    } else send({ callId: cur.id, reset: false, lines, cards, ...(frame ? { frame } : {}), ...(names ? { names } : {}) });
  }

  const api = {
    /** Follow the controller state: tail while a call with an id runs, stop (after one last read) when it does not. */
    sync(s) {
      const id = s && s.running && typeof s.callId === "string" && ID_RE.test(s.callId) ? s.callId : "";
      if (id && (!cur || cur.id !== id)) {
        api.stop();
        cur = fresh(id);
        send({ callId: id, reset: true, lines: [], cards: [], frame: null });
        timer = setT(tick, every);
        tick();
      } else if (!id && cur) api.stop();
    },
    stop() {
      if (!cur) return;
      tick();
      if (timer) clearT(timer);
      timer = null;
      const id = cur.id;
      cur = null;
      send({ callId: "", reset: true, lines: [], cards: [], ended: id });
    },
    /** Full current content for a window that was (re)opened mid-call. */
    snapshot(id) {
      return cur && cur.id === id ? { callId: id, reset: true, ...cur.feed.snapshot() } : { callId: "", reset: true, lines: [], cards: [] };
    },
    get active() {
      return cur ? cur.id : "";
    },
    tick,
  };
  return api;
}

module.exports = { createLiveTail, ID_RE };
