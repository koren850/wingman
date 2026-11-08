"use strict";
// Background files for the Meeting context: .txt, .md, .ics (a calendar invite, read by shared/ics.cjs) and .pdf (only when `pdftotext` is
// already on this Mac; nothing is ever installed), plus pasted text. Only the extracted TEXT is stored (mode 600, folder 700), capped at
// MAX_CHARS in total. Files do not expire: the plan that owns them decides how long they live (see tray/plans.cjs).
// A text of more than CHUNK_TOKENS tokens is also split into chunks of about 500 tokens at import and the chunks are stored next to it
// (<id>.chunks.json), so the call can pick the useful parts later without reading everything again.
// Everything is validated here (type, size, file name); the content is never logged and never printed.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");

const MAX_BYTES = 2 * 1024 * 1024; // one uploaded file
const MAX_CHARS = 40_000; // all attachments together
const MAX_FILES = 12;
const MAX_AGE_MS = Infinity; // files do not expire on their own (the plan decides); kept as an option for tests
const CHUNK_TOKENS = 500;
// The pasted "Meeting context" text of a plan is kept as one reserved attachment, so it is chunked, capped and read like any other background.
const CONTEXT_ID = "actx0000";
const CONTEXT_NAME = "meeting context";
const MIN_USEFUL = 200; // less room than this left: refuse instead of storing a stub
const NAME_RE = /^(a[0-9a-z]{6,12})__(.{1,80})\.txt$/;
const CHUNKS_RE = /^a[0-9a-z]{6,12}\.chunks\.json$/;
const ics = require("../shared/ics.cjs");

/** Plain, short, safe display name: no path parts, no control or bidi characters. */
function safeName(name) {
  const base =
    String(name == null ? "" : name)
      .split(/[\\/]/)
      .pop() ?? "";
  const clean = base
    .replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "")
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+/, "")
    .trim()
    .slice(0, 60);
  return clean || "file";
}
const extOf = (n) => {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(n);
  return m ? m[1].toLowerCase() : "";
};
/** Text from a decoded file: control and bidi-override characters out, line breaks kept. */
function cleanText(t) {
  return String(t)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The message for a file type Wingman cannot read. Names the type and the way out. */
function unsupportedMessage(name) {
  const e = extOf(safeName(name));
  const what = e ? `A .${e} file` : "That file";
  return `${what} cannot be read here. Wingman reads .txt, .md, .pdf and .ics files. Paste the text instead, or save the file as one of those.`;
}

/**
 * A rough token count without a tokenizer: 4 characters per token for plain ASCII, 2 for anything else (Hebrew and other scripts take more tokens).
 * It is an estimate for sizing chunks, never for billing.
 */
function estimateTokens(text) {
  let ascii = 0,
    other = 0;
  for (const ch of String(text)) {
    if (ch.charCodeAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4 + other / 2);
}

/** Cuts one over-long piece of text on sentence ends, then on spaces, then anywhere, so that each part fits maxTokens. */
function splitLong(piece, maxTokens) {
  if (estimateTokens(piece) <= maxTokens) return [piece];
  const sentences = piece.split(/(?<=[.!?\u05c3\u3002])\s+/u);
  const out = [];
  let cur = "";
  const flush = () => {
    if (cur) out.push(cur);
    cur = "";
  };
  for (const s of sentences) {
    if (estimateTokens(s) > maxTokens) {
      flush();
      let part = "";
      for (const w of s.split(/(\s+)/)) {
        if (estimateTokens(part + w) > maxTokens && part) {
          out.push(part.trim());
          part = "";
        }
        if (estimateTokens(w) > maxTokens) {
          // one word that is too long (a pasted blob): cut by characters
          for (let i = 0; i < w.length; i += maxTokens) out.push(w.slice(i, i + maxTokens));
        } else part += w;
      }
      if (part.trim()) out.push(part.trim());
      continue;
    }
    if (cur && estimateTokens(cur + " " + s) > maxTokens) flush();
    cur = cur ? cur + " " + s : s;
  }
  flush();
  return out;
}

/** Splits text into chunks of at most maxTokens (estimated), on paragraph breaks where it can. Empty text gives []. */
function chunkText(text, maxTokens = CHUNK_TOKENS) {
  const paras = cleanText(text)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks = [];
  let cur = "";
  for (const p of paras) {
    for (const piece of splitLong(p, maxTokens)) {
      if (cur && estimateTokens(cur + "\n\n" + piece) > maxTokens) {
        chunks.push(cur);
        cur = "";
      }
      cur = cur ? cur + "\n\n" + piece : piece;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// ---- Reading a file the user names on the command line (`wingman plan attach --file`) ----
// Any process of this user can run the CLI, so a path is never trusted: a symlink called notes.txt that points at an SSH key must not become an
// attachment (attachments are sent to the AI). Rules: no symlink as the last path part (opened with O_NOFOLLOW, so there is no swap between check and read);
// nothing in the folders that hold secrets; no key / .env style file names; nothing outside the home folder unless force is set.
// On top of those refusals, only the extensions the store can read are accepted (an allow-list, not a deny-list).
const SECRET_DIRS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".azure",
  ".kube",
  ".docker",
  ".config/wingman",
  ".config/gcloud",
  ".config/gh",
  ".local/share/keyrings",
  "Library/Keychains",
  "Library/Application Support/Wingman",
  "AppData/Roaming/Microsoft/Credentials",
  "AppData/Local/Microsoft/Credentials",
  "AppData/Roaming/Wingman",
];
const ALLOWED_EXT = Object.freeze(["txt", "md", "pdf", "ics"]);
const SECRET_NAME =
  /^(\.env(\..*)?|.*\.env|\.netrc|\.npmrc|\.pgpass|\.git-credentials|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)(\..*)?|.*\.(pem|key|p12|pfx|keychain|keychain-db|kdbx)|keys?|credentials|secrets?|\.(bash|zsh|sh|python|node|psql|mysql)_history)$/i;
// macOS (APFS/HFS+ default) and Windows compare paths without regard to case, so "~/.SSH" is the same folder as "~/.ssh".
const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";
const fold = (p) => (CASE_INSENSITIVE ? p.toLowerCase() : p);
const inside = (child, parent) => {
  const c = fold(child),
    r = fold(parent);
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
};

/** Returns the file's bytes, or throws an Error whose message is user-facing and whose .code is "symlink" | "secret" | "outside" | "missing" | "notfile" | "toolarge". */
function readSourceFile(file, o = {}) {
  // The home folder comes from the passwd entry, never from $HOME: the caller (a CLI run by any process) controls its own environment.
  // `o.home` exists for tests only.
  const home = o.home || os.userInfo().homedir,
    maxBytes = o.maxBytes || MAX_BYTES;
  const fail = (code, msg) => Object.assign(new Error(msg), { code });
  const abs = path.resolve(String(file));
  let l;
  try {
    l = fs.lstatSync(abs);
  } catch {
    throw fail("missing", `No such file: ${file}`);
  }
  if (l.isSymbolicLink()) throw fail("symlink", "That path is a symbolic link. Wingman does not follow links: give the real file.");
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw fail("missing", `No such file: ${file}`);
  }
  let realHome = home;
  try {
    realHome = fs.realpathSync(home);
  } catch {
    /* use as given */
  }
  const name = path.basename(real);
  for (const h of new Set([home, realHome]))
    for (const d of SECRET_DIRS)
      if (inside(real, path.join(h, d)) || inside(abs, path.join(h, d)))
        throw fail("secret", "That file is in a folder that holds keys or settings. It will not be attached.");
  if (SECRET_NAME.test(name) || SECRET_NAME.test(path.basename(abs)))
    throw fail("secret", "That file name looks like a key or secrets file. It will not be attached.");
  if (!ALLOWED_EXT.includes(extOf(name))) throw fail("type", unsupportedMessage(name));
  if (!o.force && !inside(real, realHome)) throw fail("outside", "That file is outside your home folder. Add --force if you really mean it.");
  let fd;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw fail("notfile", "That is not a regular file.");
    if (st.size > maxBytes) throw fail("toolarge", "Files can be 2 MB at most.");
    const buf = Buffer.alloc(st.size);
    let n = 0;
    while (n < st.size) {
      const r = fs.readSync(fd, buf, n, st.size - n, n);
      if (r <= 0) break;
      n += r;
    }
    return buf.subarray(0, n);
  } catch (e) {
    if (e && e.code && ["symlink", "notfile", "toolarge"].includes(e.code)) throw e;
    if (e && (e.code === "ELOOP" || e.code === "EMLINK"))
      throw fail("symlink", "That path is a symbolic link. Wingman does not follow links: give the real file.");
    throw fail("missing", `Cannot read that file: ${file}`);
  } finally {
    if (fd !== undefined)
      try {
        fs.closeSync(fd);
      } catch {
        /* done */
      }
  }
}

/** Looks for an executable `pdftotext` on PATH plus the usual Homebrew/system dirs (a packaged Electron app has a short PATH). Returns "" if none. */
function findPdftotext(env = process.env) {
  const dirs = String(env.PATH || "")
    .split(path.delimiter)
    .concat(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]);
  for (const d of dirs) {
    if (!d) continue;
    for (const name of process.platform === "win32" ? ["pdftotext.exe"] : ["pdftotext"]) {
      const f = path.join(d, name);
      try {
        fs.accessSync(f, fs.constants.X_OK);
        return f;
      } catch {
        /* not here */
      }
    }
  }
  return "";
}

/**
 * Makes the attachment store. o: { dir, now?, maxChars?, maxAgeMs?, pdftotext? } (now/limits/pdftotext are overridable for tests).
 * Returns { list, addFile, addPaste, remove, clear, readAll, readChunks, used, pdfAvailable }. All results are {ok, ...}; errors are user-facing English.
 */
function createStore(o) {
  const dir = o.dir,
    now = o.now || Date.now,
    maxChars = o.maxChars || MAX_CHARS,
    maxAge = o.maxAgeMs || MAX_AGE_MS;
  const pdftotext = o.pdftotext === undefined ? findPdftotext() : o.pdftotext; // "" = not available
  const ensure = () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* best effort */
    }
  };

  /** Valid files in dir, oldest first. Side effect: deletes expired files. Names that do not match NAME_RE are ignored. */
  function entries() {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const out = [];
    for (const n of names) {
      const m = NAME_RE.exec(n);
      if (!m) continue;
      try {
        const f = path.join(dir, n),
          st = fs.lstatSync(f);
        if (!st.isFile()) continue;
        if (now() - st.mtimeMs >= maxAge) {
          fs.rmSync(f, { force: true });
          continue;
        } // expired with the brief
        out.push({ id: m[1], name: m[2], file: f, mtimeMs: st.mtimeMs, bytes: st.size });
      } catch {
        /* gone */
      }
    }
    return out.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.id < b.id ? -1 : 1));
  }
  const chars = (e) => {
    try {
      return fs.readFileSync(e.file, "utf8").length;
    } catch {
      return 0;
    }
  };

  const chunkFile = (e) => path.join(dir, `${e.id}.chunks.json`);
  /** Chunks of one attachment: the stored chunk list, else the whole text as one chunk (small files have no chunk file). */
  function chunksOf(e) {
    try {
      const j = JSON.parse(fs.readFileSync(chunkFile(e), "utf8"));
      if (j && Array.isArray(j.chunks)) return j.chunks.filter((c) => typeof c === "string" && c);
    } catch {
      /* no chunk file */
    }
    try {
      const t = fs.readFileSync(e.file, "utf8");
      return t ? [t] : [];
    } catch {
      return [];
    }
  }
  const chunkCount = (e) => chunksOf(e).length;

  function list() {
    const es = entries().filter((e) => e.id !== CONTEXT_ID); // the pasted context is shown in its own box, not in the file list
    return {
      files: es.map((e) => ({ id: e.id, name: e.name, chars: chars(e), chunks: chunkCount(e) })),
      maxChars,
      pdf: !!pdftotext,
    };
  }
  function used() {
    return entries().reduce((a, e) => a + chars(e), 0);
  }

  /** Cleans, caps to the remaining room and writes one attachment (mode 600, "wx" so an id clash fails instead of overwriting). fixedId: the reserved context id. */
  function store(name, text, fixedId) {
    const es = entries();
    if (!fixedId && es.filter((e) => e.id !== CONTEXT_ID).length >= MAX_FILES) return { ok: false, error: `At most ${MAX_FILES} background files.` }; // the pasted context is not one of the files
    const room = maxChars - es.reduce((a, e) => a + chars(e), 0);
    const clean = cleanText(text);
    if (!clean) return { ok: false, error: "That file has no readable text." };
    if (room < MIN_USEFUL) return { ok: false, error: "The background limit is reached. Remove a file first." };
    const cut = clean.length > room;
    const body = cut ? clean.slice(0, room) : clean;
    ensure();
    const id =
      fixedId ||
      "a" +
        now().toString(36).slice(-7) +
        Math.floor(Math.random() * 36 ** 3)
          .toString(36)
          .padStart(3, "0");
    const f = path.join(dir, `${id}__${safeName(name).replace(/\.(txt|md|pdf)$/i, "")}.txt`);
    fs.writeFileSync(f, body, { mode: 0o600, flag: "wx" });
    try {
      fs.chmodSync(f, 0o600);
    } catch {
      /* best effort */
    }
    // A long text is also stored in chunks of about 500 tokens (the call picks the useful ones; nothing is sent twice).
    let chunks = 1;
    if (estimateTokens(body) > CHUNK_TOKENS) {
      const parts = chunkText(body);
      chunks = parts.length;
      fs.writeFileSync(path.join(dir, `${id}.chunks.json`), JSON.stringify({ v: 1, tokens: CHUNK_TOKENS, chunks: parts }), { mode: 0o600 });
    }
    return { ok: true, id, chars: body.length, truncated: cut, chunks };
  }

  /** bytes: Buffer | Uint8Array | ArrayBuffer from the renderer (untrusted). */
  async function addFile(name, bytes) {
    if (typeof name !== "string" || !name || name.length > 300) return { ok: false, error: "Bad file name." };
    const buf =
      bytes instanceof ArrayBuffer ? Buffer.from(bytes) : ArrayBuffer.isView(bytes) ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
    if (!buf) return { ok: false, error: "Bad file." };
    if (buf.length === 0) return { ok: false, error: "The file is empty." };
    if (buf.length > MAX_BYTES) return { ok: false, error: "Files can be 2 MB at most." };
    const ext = extOf(safeName(name));
    if (ext === "ics") {
      if (buf.includes(0)) return { ok: false, error: "That is not a calendar file." };
      const evs = ics.parseIcs(buf.toString("utf8")).events;
      const ev = ics.pickEvent(evs, now());
      if (!ev) return { ok: false, error: "No meeting found in that calendar file. Paste the text instead." };
      const plan = ics.eventToPlan(ev);
      const r = store(ev.title || name, plan.text);
      return r.ok ? { ...r, fields: plan.fields, events: evs.length } : r;
    }
    if (ext === "txt" || ext === "md") {
      if (buf.includes(0)) return { ok: false, error: "That is not a text file." };
      return store(name, buf.toString("utf8"));
    }
    if (ext === "pdf") {
      if (!buf.subarray(0, 5).equals(Buffer.from("%PDF-"))) return { ok: false, error: "That is not a PDF file." };
      if (!pdftotext)
        return { ok: false, error: "PDF needs the pdftotext tool, which is not installed on this Mac. Paste the text instead, or use a .txt or .md file." };
      ensure();
      // pdftotext needs a real file; the temp name starts with "." so entries() never lists it, and finally{} removes it.
      const tmp = path.join(dir, `.pdf-${process.pid}-${now().toString(36)}.pdf`);
      fs.writeFileSync(tmp, buf, { mode: 0o600 });
      try {
        const text = await new Promise((resolve, reject) =>
          execFile(pdftotext, ["-q", "-layout", "-enc", "UTF-8", tmp, "-"], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (err, out) =>
            err ? reject(err) : resolve(String(out)),
          ),
        );
        return store(name, text);
      } catch {
        return { ok: false, error: "Could not read that PDF (scanned or protected?). Paste the text instead." };
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
    return { ok: false, error: unsupportedMessage(name) };
  }
  /** Stores pasted text as an attachment named "pasted text". */
  function addPaste(text) {
    if (typeof text !== "string") return { ok: false, error: "Bad text." };
    if (text.length > 200_000) return { ok: false, error: "That is too much text to paste." };
    return store("pasted text", text);
  }
  /** The pasted Meeting context text ("" when none). */
  function getContext() {
    const e = entries().find((x) => x.id === CONTEXT_ID);
    try {
      return e ? fs.readFileSync(e.file, "utf8") : "";
    } catch {
      return "";
    }
  }
  /** Replaces the pasted Meeting context text (empty text removes it). It is background like a file: capped to the room left, chunked when long. */
  function setContext(text) {
    if (typeof text !== "string") return { ok: false, error: "Bad text." };
    if (text.length > 200_000) return { ok: false, error: "That is too much text to paste." };
    const old = entries().find((x) => x.id === CONTEXT_ID);
    const keep = old ? fs.readFileSync(old.file, "utf8") : null;
    const drop = () => {
      for (const e of entries())
        if (e.id === CONTEXT_ID) {
          fs.rmSync(e.file, { force: true });
          fs.rmSync(chunkFile(e), { force: true });
        }
    };
    drop();
    if (!cleanText(text)) return { ok: true, id: CONTEXT_ID, chars: 0, chunks: 0 };
    const r = store(CONTEXT_NAME, text, CONTEXT_ID);
    if (!r.ok && keep !== null) store(CONTEXT_NAME, keep, CONTEXT_ID); // the old text stays if the new one was refused
    return r;
  }
  /** Deletes one attachment by id. Throws on a malformed id (the id comes from the renderer). */
  function remove(id) {
    if (typeof id !== "string" || !/^a[0-9a-z]{6,12}$/.test(id)) throw new Error("bad attachment id");
    if (id === CONTEXT_ID) return true; // the context is changed with setContext
    for (const e of entries())
      if (e.id === id) {
        fs.rmSync(e.file, { force: true });
        fs.rmSync(chunkFile(e), { force: true });
      }
    return true;
  }
  function clear() {
    for (const e of entries()) {
      fs.rmSync(e.file, { force: true });
      fs.rmSync(chunkFile(e), { force: true });
    }
  }
  /** All chunks in file order: [{ file (name), id, i (index in the file), text }]. The call ranks them (BM25) and uses the best. */
  function readChunks() {
    const out = [];
    for (const e of entries()) chunksOf(e).forEach((text, i) => out.push({ id: e.id, file: e.name, i, text }));
    return out;
  }
  /** All texts, oldest first, trimmed to `limit` characters in total. consume: delete the files (one brief = one call). */
  function readAll(opts = {}) {
    const limit = Math.max(0, opts.limit == null ? maxChars : opts.limit);
    const out = [];
    let left = limit;
    for (const e of entries()) {
      if (left <= 0) break;
      let t = "";
      try {
        t = fs.readFileSync(e.file, "utf8");
      } catch {
        continue;
      }
      t = t.slice(0, left);
      left -= t.length;
      out.push({ name: e.name, text: t });
    }
    if (opts.consume) clear();
    return out;
  }
  return { list, addFile, addPaste, remove, clear, readAll, readChunks, getContext, setContext, used, pdfAvailable: !!pdftotext };
}

module.exports = {
  createStore,
  readSourceFile,
  safeName,
  cleanText,
  findPdftotext,
  chunkText,
  estimateTokens,
  unsupportedMessage,
  CHUNKS_RE,
  CONTEXT_ID,
  MAX_BYTES,
  MAX_CHARS,
  MAX_FILES,
  MAX_AGE_MS,
  CHUNK_TOKENS,
};
