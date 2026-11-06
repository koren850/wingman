// Crash-safety helpers for overlay/main.cjs, kept apart (no Electron) so tests can run them:
//  - readNewRows: tail a JSONL file, at most MAX_READ bytes per tick, fd always closed, never throws
//  - Seen: bounded set of row keys, so the same card arriving by disk AND by the stdin pipe shows once
//  - StdinRows: splits the pipe from call.ts (one JSON row per line) into rows
//  - Backlog: the last pipe rows, replayed after a window reload / call switch (they may exist nowhere on disk)
//  - ReloadGate: how long to wait before reloading a crashed page (fast at first, slower when it keeps crashing)
const fs = require("node:fs");
const { StringDecoder } = require("node:string_decoder");

const MAX_READ = 512 * 1024;

/** Canonical identity of a row (card id + content + time): the same row read from disk or from the pipe gives the same key. */
function rowKey(row) { try { return JSON.stringify(row); } catch { return ""; } }

/** New complete JSONL rows since tail.offset (advances it). Reads at most `max` bytes; a half-written last line waits for the next tick;
 *  a single row bigger than `max` is skipped. A shrunk file (replaced) restarts at 0. Returns [] on any error. */
function readNewRows(tail, max = MAX_READ) {
  let fd;
  try {
    let size;
    try { size = fs.statSync(tail.file).size; } catch { return []; }
    if (size < tail.offset) tail.offset = 0;
    if (size <= tail.offset) return [];
    fd = fs.openSync(tail.file, "r");
    const len = Math.min(size - tail.offset, max);
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, tail.offset);
    const chunk = buf.subarray(0, n);
    const lastNl = chunk.lastIndexOf(10);
    if (lastNl < 0) { if (n >= max) tail.offset += n; return []; }
    tail.offset += lastNl + 1;
    const rows = [];
    for (const line of chunk.subarray(0, lastNl).toString("utf8").split("\n")) { try { rows.push(JSON.parse(line)); } catch { /* half row or junk */ } }
    return rows;
  } catch { return []; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* gone */ } } }
}

/** Insertion-ordered set of the last `cap` keys. add() returns false when the key was already there. */
class Seen {
  constructor(cap = 3000) { this.cap = cap; this.set = new Set(); }
  add(key) {
    if (!key || this.set.has(key)) return false;
    this.set.add(key);
    if (this.set.size > this.cap) this.set.delete(this.set.values().next().value);
    return true;
  }
  clear() { this.set.clear(); }
  get size() { return this.set.size; }
}

/** Bytes -> JSON rows (one per line). Bad lines and over-long lines are dropped. */
class StdinRows {
  constructor(max = 1_000_000) { this.rest = ""; this.max = max; this.dec = new StringDecoder("utf8"); }   // the decoder keeps a letter split across two reads whole
  push(chunk) {
    this.rest += typeof chunk === "string" ? chunk : this.dec.write(chunk);
    const parts = this.rest.split("\n");
    this.rest = parts.pop();
    if (this.rest.length > this.max) this.rest = "";
    const rows = [];
    for (const l of parts) { if (!l.trim() || l.length > this.max) continue; try { const r = JSON.parse(l); if (r && typeof r === "object") rows.push(r); } catch { /* skip */ } }
    return rows;
  }
}

/** The last `cap` rows that arrived through the pipe. */
class Backlog {
  constructor(cap = 300) { this.cap = cap; this.rows = []; }
  add(row) { this.rows.push(row); if (this.rows.length > this.cap) this.rows.shift(); }
  all() { return this.rows.slice(); }
}

/** Delay before reloading a page whose render process died: 300 ms, but 5 s once it died 4+ times within a minute. Never gives up. */
class ReloadGate {
  constructor(now = Date.now) { this.now = now; this.times = []; }
  next() {
    const t = this.now();
    this.times = [...this.times.filter((x) => t - x < 60_000), t];
    return this.times.length > 4 ? 5000 : 300;
  }
}

module.exports = { MAX_READ, rowKey, readNewRows, Seen, StdinRows, Backlog, ReloadGate };
