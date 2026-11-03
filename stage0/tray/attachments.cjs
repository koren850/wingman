"use strict";
// Background files for "Plan a call": .txt, .md, and .pdf (only when `pdftotext` is already on this Mac; nothing is ever installed),
// plus pasted text. Only the extracted TEXT is stored, in data/private/briefs/attachments/ (mode 600, folder 700), capped at
// MAX_CHARS in total, and it expires with the brief (6 h). Used as background by the frame / tips / reflex prompts.
// Everything is validated here (type, size, file name); the content is never logged and never printed.
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const MAX_BYTES = 2 * 1024 * 1024;       // one uploaded file
const MAX_CHARS = 40_000;                // all attachments together
const MAX_FILES = 12;
const MAX_AGE_MS = 6 * 3600_000;
const MIN_USEFUL = 200;                  // less room than this left: refuse instead of storing a stub
const NAME_RE = /^(a[0-9a-z]{6,12})__(.{1,80})\.txt$/;

/** Plain, short, safe display name: no path parts, no control or bidi characters. */
function safeName(name) {
  const base = String(name == null ? "" : name).split(/[\\/]/).pop();
  const clean = base.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "").replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/\s+/g, " ").replace(/^[. ]+/, "").trim().slice(0, 60);
  return clean || "file";
}
const extOf = (n) => { const m = /\.([A-Za-z0-9]{1,5})$/.exec(n); return m ? m[1].toLowerCase() : ""; };
/** Text from a decoded file: control and bidi-override characters out, line breaks kept. */
function cleanText(t) {
  return String(t).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮]/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Looks for an executable `pdftotext` on PATH plus the usual Homebrew/system dirs (a packaged Electron app has a short PATH). Returns "" if none. */
function findPdftotext(env = process.env) {
  const dirs = String(env.PATH || "").split(path.delimiter).concat(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]);
  for (const d of dirs) { if (!d) continue; const f = path.join(d, "pdftotext"); try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* not here */ } }
  return "";
}

/**
 * Makes the attachment store. o: { dir, now?, maxChars?, maxAgeMs?, pdftotext? } (now/limits/pdftotext are overridable for tests).
 * Returns { list, addFile, addPaste, remove, clear, readAll, used, pdfAvailable }. All results are {ok, ...}; errors are user-facing English.
 */
function createStore(o) {
  const dir = o.dir, now = o.now || Date.now, maxChars = o.maxChars || MAX_CHARS, maxAge = o.maxAgeMs || MAX_AGE_MS;
  const pdftotext = o.pdftotext === undefined ? findPdftotext() : o.pdftotext;   // "" = not available
  const ensure = () => { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ } };

  /** Valid files in dir, oldest first. Side effect: deletes expired files. Names that do not match NAME_RE are ignored. */
  function entries() {
    let names = []; try { names = fs.readdirSync(dir); } catch { return []; }
    const out = [];
    for (const n of names) {
      const m = NAME_RE.exec(n); if (!m) continue;
      try {
        const f = path.join(dir, n), st = fs.lstatSync(f);
        if (!st.isFile()) continue;
        if (now() - st.mtimeMs >= maxAge) { fs.rmSync(f, { force: true }); continue; }   // expired with the brief
        out.push({ id: m[1], name: m[2], file: f, mtimeMs: st.mtimeMs, bytes: st.size });
      } catch { /* gone */ }
    }
    return out.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.id < b.id ? -1 : 1));
  }
  const chars = (e) => { try { return fs.readFileSync(e.file, "utf8").length; } catch { return 0; } };

  function list() {
    const es = entries();
    return { files: es.map((e) => ({ id: e.id, name: e.name, chars: chars(e), expiresInMs: Math.max(0, maxAge - (now() - e.mtimeMs)) })), maxChars, pdf: !!pdftotext };
  }
  function used() { return entries().reduce((a, e) => a + chars(e), 0); }

  /** Cleans, caps to the remaining room and writes one attachment (mode 600, "wx" so an id clash fails instead of overwriting). */
  function store(name, text) {
    const es = entries();
    if (es.length >= MAX_FILES) return { ok: false, error: `At most ${MAX_FILES} background files.` };
    const room = maxChars - es.reduce((a, e) => a + chars(e), 0);
    const clean = cleanText(text);
    if (!clean) return { ok: false, error: "That file has no readable text." };
    if (room < MIN_USEFUL) return { ok: false, error: "The background limit is reached. Remove a file first." };
    const cut = clean.length > room;
    const body = cut ? clean.slice(0, room) : clean;
    ensure();
    const id = "a" + now().toString(36).slice(-7) + Math.floor(Math.random() * 36 ** 3).toString(36).padStart(3, "0");
    const f = path.join(dir, `${id}__${safeName(name).replace(/\.(txt|md|pdf)$/i, "")}.txt`);
    fs.writeFileSync(f, body, { mode: 0o600, flag: "wx" });
    try { fs.chmodSync(f, 0o600); } catch { /* best effort */ }
    return { ok: true, id, chars: body.length, truncated: cut };
  }

  /** bytes: Buffer | Uint8Array | ArrayBuffer from the renderer (untrusted). */
  async function addFile(name, bytes) {
    if (typeof name !== "string" || !name || name.length > 300) return { ok: false, error: "Bad file name." };
    const buf = bytes instanceof ArrayBuffer ? Buffer.from(bytes) : ArrayBuffer.isView(bytes) ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
    if (!buf) return { ok: false, error: "Bad file." };
    if (buf.length === 0) return { ok: false, error: "The file is empty." };
    if (buf.length > MAX_BYTES) return { ok: false, error: "Files can be 2 MB at most." };
    const ext = extOf(safeName(name));
    if (ext === "txt" || ext === "md") {
      if (buf.includes(0)) return { ok: false, error: "That is not a text file." };
      return store(name, buf.toString("utf8"));
    }
    if (ext === "pdf") {
      if (!buf.subarray(0, 5).equals(Buffer.from("%PDF-"))) return { ok: false, error: "That is not a PDF file." };
      if (!pdftotext) return { ok: false, error: "PDF needs the pdftotext tool, which is not installed on this Mac. Paste the text instead, or use .txt or .md." };
      ensure();
      // pdftotext needs a real file; the temp name starts with "." so entries() never lists it, and finally{} removes it.
      const tmp = path.join(dir, `.pdf-${process.pid}-${now().toString(36)}.pdf`);
      fs.writeFileSync(tmp, buf, { mode: 0o600 });
      try {
        const text = await new Promise((resolve, reject) => execFile(pdftotext, ["-q", "-layout", "-enc", "UTF-8", tmp, "-"], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(String(out)))));
        return store(name, text);
      } catch { return { ok: false, error: "Could not read that PDF (scanned or protected?). Paste the text instead." }; }
      finally { fs.rmSync(tmp, { force: true }); }
    }
    return { ok: false, error: "Only .txt, .md and .pdf files." };
  }
  /** Stores pasted text as an attachment named "pasted text". */
  function addPaste(text) {
    if (typeof text !== "string") return { ok: false, error: "Bad text." };
    if (text.length > 200_000) return { ok: false, error: "That is too much text to paste." };
    return store("pasted text", text);
  }
  /** Deletes one attachment by id. Throws on a malformed id (the id comes from the renderer). */
  function remove(id) {
    if (typeof id !== "string" || !/^a[0-9a-z]{6,12}$/.test(id)) throw new Error("bad attachment id");
    for (const e of entries()) if (e.id === id) fs.rmSync(e.file, { force: true });
    return true;
  }
  function clear() { for (const e of entries()) fs.rmSync(e.file, { force: true }); }
  /** All texts, oldest first, trimmed to `limit` characters in total. consume: delete the files (one brief = one call). */
  function readAll(opts = {}) {
    const limit = Math.max(0, opts.limit == null ? maxChars : opts.limit);
    const out = []; let left = limit;
    for (const e of entries()) {
      if (left <= 0) break;
      let t = ""; try { t = fs.readFileSync(e.file, "utf8"); } catch { continue; }
      t = t.slice(0, left); left -= t.length; out.push({ name: e.name, text: t });
    }
    if (opts.consume) clear();
    return out;
  }
  return { list, addFile, addPaste, remove, clear, readAll, used, pdfAvailable: !!pdftotext };
}

module.exports = { createStore, safeName, cleanText, findPdftotext, MAX_BYTES, MAX_CHARS, MAX_FILES, MAX_AGE_MS };
