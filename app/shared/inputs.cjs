"use strict";
// Context sources for the Meeting context box: a Word file (.docx), a web page (https), a mail file (.eml) and a calendar link (a private .ics address).
// Plain CommonJS because the tray and the Wingman window (Electron main) cannot load TypeScript. The typed entry point is src/session/inputs.ts.
// No dependency: .docx text is read with the system `unzip -p`; where unzip is missing (Windows) a small built-in zip reader is used instead; the network is the
// built-in fetch. Everything here returns plain text. All of it is untrusted: control and bidi characters are removed and the tags that could
// close the transcript wrapper of a prompt are taken out (untag), so a page or a mail cannot talk to the model.
//
// Web rules (readUrl, readCalendarUrl):
//   https only, no user:pass in the address, port 443 only; 8 s limit for the whole read; at most 1 MB is read (more is cut, not an error);
//   text types only; the host name is resolved first and EVERY address must be public; each redirect (at most 4) is checked the same way,
//   so a public page cannot send us to 127.0.0.1, a 10.x address, 169.254.x (link-local, cloud metadata) or a private IPv6 address.
//   Known gap: the address is checked, then fetch resolves again. A DNS name that answers differently the second time (rebinding) is not caught.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const dns = require("node:dns");
const zlib = require("node:zlib");
const { execFile } = require("node:child_process");
const ics = require("./ics.cjs");

const WEB_TIMEOUT_MS = 8000;
const WEB_MAX_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 4;
const DOCX_MAX_BYTES = 2 * 1024 * 1024; // the file
const DOCX_XML_MAX = 6 * 1024 * 1024; // the unpacked document.xml (a zip bomb stops here)
const EML_MAX_BYTES = 2 * 1024 * 1024;
const TEXT_MAX = 200_000; // characters returned by any reader

const fail = (code, message) => Object.assign(new Error(message), { code });

/** Text from an untrusted source: control and bidi-override characters out, line breaks kept, runs of blank lines short. */
function cleanText(t) {
  return String(t == null ? "" : t)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Takes every <call_transcript> / </call_transcript> tag out of untrusted text, again and again until nothing changes (same rule as src/reflex.ts untag). */
function untag(s) {
  const re = /<\s*\/?\s*call_transcript\b[^>]*>/gi;
  let cur = String(s);
  for (let i = 0; i < 50; i++) {
    const next = cur.replace(re, "");
    if (next === cur) return cur;
    cur = next;
  }
  return cur.replace(/[<>]/g, " ");
}
const safeText = (t) => untag(cleanText(t)).slice(0, TEXT_MAX);

// ---------------------------------------------------------------- html / xml helpers
const NAMED = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  hellip: "...",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
};
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ";
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/** Readable text from an HTML page: scripts, styles and the head are dropped, block tags become line breaks. */
function htmlToText(html) {
  let h = String(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|head|iframe)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|ul|ol|table|blockquote|pre)\s*>/gi, "\n")
    .replace(/<(li)\b[^>]*>/gi, "\n- ")
    .replace(/<\/(td|th)\s*>/gi, " | ");
  h = h.replace(/<[^>]*>/g, " ");
  return decodeEntities(h)
    .split("\n")
    .map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n");
}

// ---------------------------------------------------------------- .docx
/** One entry of a zip file, read with node:zlib only (stored or deflated). Returns undefined when the entry is not there. Used where `unzip` is missing. */
function zipEntry(buf, name) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw fail("baddocx", "That Word file could not be read. Is it a .docx? Save it as .docx or paste the text.");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    if (buf.toString("utf8", p + 46, p + 46 + nameLen) === name) {
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) break;
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      if (method === 0) return data;
      if (method === 8) {
        try {
          return zlib.inflateRawSync(data, { maxOutputLength: DOCX_XML_MAX });
        } catch (e) {
          if (e && e.code === "ERR_BUFFER_TOO_LARGE") throw fail("toolarge", "That Word file is too large to read. Paste the part you need.");
          break;
        }
      }
      break;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw fail("baddocx", "That Word file could not be read. Is it a .docx? Save it as .docx or paste the text.");
}

/** Runs `unzip -p file word/document.xml`. exec is replaceable for tests. */
function runUnzip(file, exec) {
  const run = exec || execFile;
  return new Promise((resolve, reject) => {
    run("unzip", ["-p", "--", file, "word/document.xml"], { timeout: 10_000, maxBuffer: DOCX_XML_MAX, encoding: "utf8" }, (err, stdout) => {
      if (err) {
        if (err.code === "ENOENT") return reject(Object.assign(new Error("no unzip"), { noUnzip: true }));
        if (/maxBuffer/i.test(String(err.message))) return reject(fail("toolarge", "That Word file is too large to read. Paste the part you need."));
        return reject(fail("baddocx", "That Word file could not be read. Is it a .docx? Save it as .docx or paste the text."));
      }
      resolve(String(stdout));
    });
  });
}

/** The text of word/document.xml: one line per paragraph, tabs and breaks kept, field codes and deleted text left out. */
function docxXmlToText(xml) {
  const x = String(xml)
    .replace(/<w:(instrText|delText)\b[^>]*>[\s\S]*?<\/w:\1>/g, "")
    .replace(/<w:tab\s*\/>/g, "\t")
    .replace(/<w:(br|cr)\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tc>/g, " | ")
    .replace(/<[^>]*>/g, "");
  return decodeEntities(x);
}

/**
 * Text of a .docx given as bytes. The bytes are written to a private temp folder (unzip needs a file), then the folder is removed.
 * o.exec: replaces execFile (tests).
 */
async function docxText(bytes, o = {}) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length === 0) throw fail("empty", "The file is empty.");
  if (buf.length > DOCX_MAX_BYTES) throw fail("toolarge", "Files can be 2 MB at most.");
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) throw fail("baddocx", "That is not a Word (.docx) file.");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wingman-docx-"));
  try {
    const f = path.join(dir, "in.docx");
    fs.writeFileSync(f, buf, { mode: 0o600 });
    let xml;
    try {
      xml = await runUnzip(f, o.exec);
    } catch (e) {
      if (!e || !e.noUnzip) throw e;
      xml = zipEntry(buf, "word/document.xml").toString("utf8"); // no unzip on this computer: read the zip here
    }
    const text = safeText(docxXmlToText(xml));
    if (!text) throw fail("empty", "That Word file has no readable text.");
    return text;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- .eml
/** RFC 2047 encoded words in a header: =?utf-8?B?...?= and =?utf-8?Q?...?=. */
function decodeWords(s) {
  return String(s)
    .replace(/(\?=)\s+(=\?)/g, "$1$2")
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (m, cs, enc, data) => {
      try {
        const bytes = /^b$/i.test(enc) ? Buffer.from(data, "base64") : qpBytes(data.replace(/_/g, " "));
        return decodeBytes(bytes, cs);
      } catch {
        return m;
      }
    });
}
function qpBytes(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "=" && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(s.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}
function decodeBytes(buf, charset) {
  try {
    return new TextDecoder(
      String(charset || "utf-8")
        .trim()
        .toLowerCase() || "utf-8",
    ).decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

/** Header block -> { lowercase name: unfolded value } (the first of a repeated header wins). */
function parseHeaders(block) {
  const h = {};
  const lines = String(block)
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]+/g, " ")
    .split("\n");
  for (const l of lines) {
    const i = l.indexOf(":");
    if (i < 1) continue;
    const k = l.slice(0, i).trim().toLowerCase();
    if (!(k in h)) h[k] = l.slice(i + 1).trim();
  }
  return h;
}
const splitMsg = (raw) => {
  const m = /\r?\n\r?\n/.exec(raw);
  return m ? [raw.slice(0, m.index), raw.slice(m.index + m[0].length)] : [raw, ""];
};
const param = (v, name) => {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, "i").exec(v || "");
  return m ? (m[2] !== undefined ? m[2] : m[1]) : "";
};

/** Body bytes -> text for one part, by its transfer encoding and charset. */
function partText(headers, body) {
  const enc = String(headers["content-transfer-encoding"] || "")
    .trim()
    .toLowerCase();
  const charset = param(headers["content-type"], "charset") || "utf-8";
  if (enc === "base64") return decodeBytes(Buffer.from(body.replace(/\s+/g, ""), "base64"), charset);
  if (enc === "quoted-printable") return decodeBytes(qpBytes(body.replace(/=\r?\n/g, "")), charset);
  return body; // 7bit / 8bit: already text
}

/** The best text of a message: text/plain, else text/html as text; multipart is searched depth first (at most 6 levels, 40 parts). */
function bodyOf(headers, body, depth, budget) {
  const ct = String(headers["content-type"] || "text/plain").toLowerCase();
  if (ct.startsWith("multipart/") && depth < 6) {
    const b = param(headers["content-type"], "boundary");
    if (!b) return "";
    const parts = body.split(new RegExp(`\\r?\\n?--${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?[ \\t]*\\r?\\n?`)).slice(1);
    let plain = "",
      html = "";
    for (const p of parts) {
      if (budget.n-- <= 0) break;
      const [hd, bd] = splitMsg(p);
      const ph = parseHeaders(hd);
      const pct = String(ph["content-type"] || "text/plain").toLowerCase();
      if (/^attachment/i.test(String(ph["content-disposition"] || ""))) continue;
      const t = bodyOf(ph, bd, depth + 1, budget);
      if (!t.trim()) continue;
      if (pct.startsWith("text/html") || (pct.startsWith("multipart/") && !plain)) html = html || t;
      else plain = plain || t;
    }
    return plain || html;
  }
  if (ct.startsWith("text/html")) return htmlToText(partText(headers, body));
  if (ct.startsWith("text/")) return partText(headers, body);
  return "";
}

/** "Dana Levi <dana@example.com>, x@y.z" -> "Dana Levi, x@y.z" (names first; an address only when the name is missing). */
function people(v) {
  const s = decodeWords(v || "");
  const out = [];
  for (const part of s.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const m = /^\s*"?([^"<]*?)"?\s*<([^>]*)>\s*$/.exec(part);
    const name = m ? m[1].trim() : "";
    const addr = m ? m[2].trim() : part.trim();
    const x = name || addr;
    if (x) out.push(x);
  }
  return out.slice(0, 12).join(", ");
}

/** Text of a mail file (.eml): subject, who and when, then the body without the quoted reply lines at the end. */
function emlText(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length === 0) throw fail("empty", "The file is empty.");
  if (buf.length > EML_MAX_BYTES) throw fail("toolarge", "Files can be 2 MB at most.");
  if (buf.includes(0)) throw fail("bademl", "That is not a mail file.");
  const raw = buf.toString("utf8");
  const [hd, bd] = splitMsg(raw);
  const h = parseHeaders(hd);
  if (!h.subject && !h.from && !h.date && !h["content-type"])
    throw fail("bademl", "That is not a mail file. A .eml file starts with headers like From and Subject.");
  const body = bodyOf(h, bd, 0, { n: 40 });
  const lines = [];
  if (h.subject) lines.push(`Subject: ${decodeWords(h.subject)}`);
  if (h.from) lines.push(`From: ${people(h.from)}`);
  if (h.to) lines.push(`To: ${people(h.to)}`);
  if (h.cc) lines.push(`Cc: ${people(h.cc)}`);
  if (h.date) lines.push(`Date: ${h.date.replace(/\s*\(.*\)\s*$/, "")}`);
  const text = safeText(lines.join("\n") + "\n\n" + cleanText(body));
  if (!/\S\s*\n\n\S/.test(text) && !body.trim()) throw fail("empty", "That mail has no readable text.");
  return { text, subject: decodeWords(h.subject || "") };
}

// ---------------------------------------------------------------- web
/** True when an IP address (v4 or v6) is not a public address: loopback, private, link-local, carrier-grade NAT, multicast, reserved, unspecified. */
function isPrivateAddress(ip) {
  let a = String(ip || "")
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "");
  const kind = net.isIP(a);
  if (!kind) return true; // not an address: refuse
  if (kind === 4) {
    const [p, q, r] = a.split(".").map(Number);
    if (p === 0 || p === 10 || p === 127) return true;
    if (p === 100 && q >= 64 && q <= 127) return true;
    if (p === 169 && q === 254) return true;
    if (p === 172 && q >= 16 && q <= 31) return true;
    if (p === 192 && q === 0 && (r === 0 || r === 2)) return true;
    if (p === 192 && q === 168) return true;
    if (p === 198 && (q === 18 || q === 19 || (q === 51 && r === 100))) return true;
    if (p === 203 && q === 0 && r === 113) return true;
    if (p >= 224) return true;
    return false;
  }
  const g = v6groups(a);
  if (!g) return true;
  const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return isPrivateAddress(v4(g[6], g[7])); // ::ffff:a.b.c.d and ::a.b.c.d (also :: and ::1)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPrivateAddress(v4(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isPrivateAddress(v4(g[1], g[2])); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true; // link-local and site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true; // discard
  return false;
}
/** IPv6 text -> 8 numbers, or null. */
function v6groups(a) {
  let s = a.toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const b = tail[1].split(".").map(Number);
    if (b.length !== 4 || b.some((n) => !(n >= 0 && n <= 255))) return null;
    s = s.slice(0, -tail[1].length) + ((b[0] << 8) | b[1]).toString(16) + ":" + ((b[2] << 8) | b[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array(fill).fill("0"), ...rest].map((x) => parseInt(x, 16));
  return all.length === 8 && all.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? all : null;
}

const REFUSED = "That address is not allowed. Wingman only reads public web pages over https.";
/** Checks one address (no network): https, no credentials, port 443, a real host name or a public IP. Returns the URL object. */
function checkUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw fail("badurl", "That is not a web address. Use one that starts with https://");
  }
  if (u.protocol !== "https:") throw fail("badurl", "Only https:// addresses can be read.");
  if (u.username || u.password) throw fail("refused", REFUSED);
  if (u.port && u.port !== "443") throw fail("refused", REFUSED);
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) throw fail("badurl", "That is not a web address.");
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw fail("refused", REFUSED);
  } else if (host === "localhost" || /\.(localhost|local|internal|lan|home|corp|intranet)$/.test(host) || !host.includes(".")) {
    throw fail("refused", REFUSED);
  }
  return u;
}
/** Every address the host name resolves to must be public. A host that does not resolve is an error too. */
async function checkHost(u, lookup, signal) {
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return;
  let addrs;
  try {
    const look = Promise.resolve().then(() => (lookup || dns.promises.lookup)(host, { all: true }));
    const stop = new Promise((_, rej) => {
      if (signal) signal.addEventListener("abort", () => rej(fail("timeout", "The page did not answer in 8 seconds.")), { once: true });
    });
    stop.catch(() => {});
    addrs = await Promise.race([look, stop]);
  } catch (e) {
    if (e && e.code === "timeout") throw e;
    throw fail("nohost", "That address could not be found.");
  }
  const list = Array.isArray(addrs) ? addrs : [addrs];
  if (!list.length || list.some((x) => isPrivateAddress(x && x.address))) throw fail("refused", REFUSED);
}

const TEXT_TYPES = /^(text\/[a-z0-9.+-]+|application\/(xhtml\+xml|xml|json|calendar|ics))(\s*;|$)/i;
/**
 * Reads one public page. o: { fetch, lookup, timeoutMs, maxBytes, accept }. Returns { body (string), type, truncated, url (final) }.
 * Redirects are followed by hand so that every hop is checked. Throws an Error with .code and a plain message.
 */
async function fetchSafe(rawUrl, o = {}) {
  const doFetch = o.fetch || globalThis.fetch;
  const timeoutMs = o.timeoutMs || WEB_TIMEOUT_MS,
    maxBytes = o.maxBytes || WEB_MAX_BYTES;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const timeoutErr = () => fail("timeout", "The page did not answer in 8 seconds.");
  try {
    let u = checkUrl(rawUrl);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await checkHost(u, o.lookup, ctl.signal);
      let res;
      try {
        res = await doFetch(u.href, {
          method: "GET",
          redirect: "manual",
          signal: ctl.signal,
          headers: { accept: o.accept || "text/html,text/plain,text/markdown;q=0.9,*/*;q=0.1", "user-agent": "Wingman context reader" },
        });
      } catch (e) {
        if (ctl.signal.aborted) throw timeoutErr();
        if (e && e.code) throw e;
        throw fail("network", "The page could not be reached.");
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        try {
          res.body && res.body.cancel && res.body.cancel();
        } catch {
          /* done */
        }
        if (hop === MAX_REDIRECTS) throw fail("redirects", "The address sends you around too many times.");
        let next;
        try {
          next = new URL(res.headers.get("location"), u);
        } catch {
          throw fail("badurl", "The address sends you to a bad place.");
        }
        u = checkUrl(next.href); // an https page may not send us to http, to a private address or to a bad port
        continue;
      }
      if (res.status < 200 || res.status >= 300) throw fail("http", `The page answered with an error (${res.status}).`);
      const type = String(res.headers.get("content-type") || "").trim();
      if (!TEXT_TYPES.test(type)) throw fail("type", "That address is not a text page (a file, image or PDF). Download it and drop it in the box instead.");
      const len = Number(res.headers.get("content-length"));
      const chunks = [];
      let got = 0,
        truncated = Number.isFinite(len) && len > maxBytes;
      if (res.body && typeof res.body.getReader === "function") {
        const rd = res.body.getReader();
        try {
          for (;;) {
            const { done, value } = await rd.read();
            if (done) break;
            const room = maxBytes - got;
            if (value.length >= room) {
              chunks.push(Buffer.from(value.subarray(0, Math.max(0, room))));
              got = maxBytes;
              truncated = true;
              break;
            }
            chunks.push(Buffer.from(value));
            got += value.length;
          }
        } catch (e) {
          if (ctl.signal.aborted) throw timeoutErr();
          throw fail("network", "The page could not be read to the end.");
        } finally {
          try {
            await rd.cancel();
          } catch {
            /* done */
          }
        }
      } else {
        const b = Buffer.from(await res.arrayBuffer());
        if (b.length > maxBytes) truncated = true;
        chunks.push(b.subarray(0, maxBytes));
      }
      const charset = param(type, "charset") || "utf-8";
      return { body: decodeBytes(Buffer.concat(chunks), charset), type: type.split(";")[0].toLowerCase(), truncated, url: u.href };
    }
    throw fail("redirects", "The address sends you around too many times.");
  } finally {
    clearTimeout(timer);
  }
}

/** The title of an HTML page, or "". */
function htmlTitle(html) {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(String(html));
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim().slice(0, 120) : "";
}

/** Text of a public web page: { text, label, truncated }. The text starts with a line that says where it came from. */
async function readUrl(rawUrl, o = {}) {
  const r = await fetchSafe(rawUrl, o);
  const isHtml = /html/.test(r.type) || /^\s*(<!doctype html|<html)/i.test(r.body.slice(0, 200));
  const title = isHtml ? htmlTitle(r.body) : "";
  const body = isHtml ? htmlToText(r.body) : r.body;
  const host = new URL(r.url).hostname;
  const text = safeText(`Web page: ${host}${title ? ` - ${title}` : ""}\n\n${cleanText(body)}`);
  if (text.replace(/^Web page:[^\n]*\n*/, "").length < 20)
    throw fail("empty", "That page has no readable text. It may need a login or build itself with scripts.");
  return { text, label: (title || host).slice(0, 60), truncated: r.truncated };
}

// ---------------------------------------------------------------- calendar link
const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
/**
 * The repeats of a repeating event (RRULE with FREQ DAILY, WEEKLY, MONTHLY or YEARLY, INTERVAL, COUNT, UNTIL, BYDAY for weekly, EXDATE) that start
 * up to `to` and end after `from` (epoch ms), as copies of the event with the new start and end. Anything else (BYSETPOS, RDATE...) gives [] and the
 * caller uses the first date only. The clock time is kept across a clock change (local arithmetic). At most 2000 steps.
 */
function expandRepeats(ev, from, to) {
  if (!ev.rrule || !ev.startMs) return [];
  const r = {};
  for (const part of ev.rrule.split(";")) {
    const i = part.indexOf("=");
    if (i > 0)
      r[part.slice(0, i).trim().toUpperCase()] = part
        .slice(i + 1)
        .trim()
        .toUpperCase();
  }
  const freq = r.FREQ;
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return [];
  if (r.BYSETPOS || r.BYWEEKNO || r.BYYEARDAY || r.BYMONTHDAY || r.BYMONTH || (freq !== "WEEKLY" && r.BYDAY)) return [];
  const interval = Math.max(1, Math.min(1000, parseInt(r.INTERVAL || "1", 10) || 1));
  const count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
  const u = r.UNTIL ? ics.parseIcsDate(r.UNTIL) : 0;
  const until = u > 0 ? u : Infinity;
  const dur = ev.endMs && ev.endMs > ev.startMs ? ev.endMs - ev.startMs : 0;
  const ex = new Set((ev.exdates || []).filter((x) => x));
  const f = new Date(ev.startMs);
  const mk = (y, mo, d) => new Date(y, mo, d, f.getHours(), f.getMinutes(), f.getSeconds()).getTime();
  const days =
    freq === "WEEKLY" && r.BYDAY
      ? r.BYDAY.split(",")
          .map((d) => DAY_CODES.indexOf(d.slice(-2)))
          .filter((d) => d >= 0)
      : [f.getDay()];
  if (!days.length) return [];
  days.sort((a, b) => a - b);
  const out = [];
  let n = 0;
  for (let k = 0; k < 2000; k++) {
    let cands;
    if (freq === "DAILY") cands = [mk(f.getFullYear(), f.getMonth(), f.getDate() + k * interval)];
    else if (freq === "WEEKLY") cands = days.map((d) => mk(f.getFullYear(), f.getMonth(), f.getDate() - f.getDay() + k * 7 * interval + d));
    else if (freq === "MONTHLY") {
      const t = mk(f.getFullYear(), f.getMonth() + k * interval, f.getDate());
      cands = new Date(t).getDate() === f.getDate() ? [t] : []; // a 31st skips short months
    } else {
      const t = mk(f.getFullYear() + k * interval, f.getMonth(), f.getDate());
      cands = new Date(t).getMonth() === f.getMonth() ? [t] : [];
    }
    for (const t of cands) {
      if (t < ev.startMs) continue;
      if (n >= count || t > until || t > to) return out;
      n++;
      if (t + dur >= from && !ex.has(t)) out.push({ ...ev, startMs: t, endMs: dur ? t + dur : ev.endMs ? t : 0, recurring: false, rrule: "" });
    }
  }
  return out;
}

/** The event nearest to now: one that is on now, else the soonest one that has not started, else the latest one that is over. Cancelled events only if nothing else. Repeating events count at their dates from 1 day back to 60 days ahead. */
function nearestEvent(events, now) {
  const live = events.filter((e) => !e.cancelled);
  const base = live.length ? live : events;
  const pool = base.flatMap((e) => {
    const reps = expandRepeats(e, now - 86400_000, now + 60 * 86400_000);
    return reps.length ? reps : [e];
  });
  if (!pool.length) return null;
  const end = (e) => e.endMs || e.startMs;
  const on = pool.filter((e) => e.startMs <= now && end(e) >= now).sort((a, b) => b.startMs - a.startMs);
  if (on.length) return on[0];
  const next = pool.filter((e) => e.startMs > now).sort((a, b) => a.startMs - b.startMs);
  if (next.length) return next[0];
  return [...pool].sort((a, b) => end(b) - end(a))[0];
}

/** Reads a private .ics address and picks the event nearest to now: { text, label, fields, events, when (epoch ms) }. The caller shows it and asks before using it. */
async function readCalendarUrl(rawUrl, o = {}) {
  const r = await fetchSafe(rawUrl, { ...o, accept: "text/calendar,text/plain;q=0.8,*/*;q=0.1" });
  if (!/BEGIN:VCALENDAR/i.test(r.body)) throw fail("badics", "That address is not a calendar. Use the private .ics address from your calendar settings.");
  const evs = ics.parseIcs(r.body).events;
  const ev = nearestEvent(evs, o.now || Date.now());
  if (!ev) throw fail("noevent", "No meeting found in that calendar.");
  const plan = ics.eventToPlan(ev);
  return { text: safeText(plan.text), label: (ev.title || "meeting").slice(0, 60), fields: plan.fields, events: evs.length, when: ev.startMs };
}

// ---------------------------------------------------------------- one entry
/**
 * readSource(spec, o) -> { text, kind, label, ... }
 *   { type: "file", path }           a .docx, .eml, .txt, .md or .ics file (path under the caller's care; the tray checks it first)
 *   { type: "file", name, bytes }    the same, from bytes (a drop)
 *   { type: "eml", path | bytes }    a mail file
 *   { type: "url", url }             a public https page
 *   { type: "calendar", url }        a private .ics address (the nearest event)
 * o: { fetch, lookup, exec, now, timeoutMs, maxBytes } for tests.
 */
async function readSource(spec, o = {}) {
  if (!spec || typeof spec !== "object") throw fail("badspec", "Nothing to read.");
  const bytesOf = () => {
    if (spec.bytes) return Buffer.isBuffer(spec.bytes) ? spec.bytes : Buffer.from(spec.bytes);
    if (typeof spec.path !== "string" || !spec.path) throw fail("badspec", "No file given.");
    let st;
    try {
      st = fs.statSync(spec.path);
    } catch {
      throw fail("missing", `No such file: ${path.basename(spec.path)}`);
    }
    if (!st.isFile()) throw fail("missing", "That is not a regular file.");
    if (st.size > DOCX_MAX_BYTES) throw fail("toolarge", "Files can be 2 MB at most.");
    return fs.readFileSync(spec.path);
  };
  const nameOf = () => path.basename(String(spec.name || spec.path || "file"));
  switch (spec.type) {
    case "url": {
      const r = await readUrl(spec.url, o);
      return { text: r.text, kind: "url", label: r.label, truncated: r.truncated };
    }
    case "calendar": {
      const r = await readCalendarUrl(spec.url, o);
      return { text: r.text, kind: "calendar", label: r.label, fields: r.fields, when: r.when };
    }
    case "eml": {
      const r = emlText(bytesOf());
      return { text: r.text, kind: "eml", label: r.subject.slice(0, 60) || nameOf() };
    }
    case "file": {
      const name = nameOf();
      const ext = (/\.([A-Za-z0-9]{1,5})$/.exec(name) || [])[1];
      const e = ext ? ext.toLowerCase() : "";
      if (e === "docx") return { text: await docxText(bytesOf(), o), kind: "docx", label: name.replace(/\.docx$/i, "") };
      if (e === "eml") {
        const r = emlText(bytesOf());
        return { text: r.text, kind: "eml", label: r.subject.slice(0, 60) || name };
      }
      if (e === "txt" || e === "md") {
        const b = bytesOf();
        if (b.includes(0)) throw fail("badtext", "That is not a text file.");
        return { text: safeText(b.toString("utf8")), kind: "text", label: name };
      }
      if (e === "ics") {
        const evs = ics.parseIcs(bytesOf().toString("utf8")).events;
        const ev = nearestEvent(evs, o.now || Date.now());
        if (!ev) throw fail("noevent", "No meeting found in that calendar file.");
        const plan = ics.eventToPlan(ev);
        return { text: safeText(plan.text), kind: "calendar", label: ev.title || name, fields: plan.fields };
      }
      throw fail("type", `A .${e || "?"} file cannot be read here.`);
    }
    default:
      throw fail("badspec", "Unknown kind of source.");
  }
}

module.exports = {
  readSource,
  readUrl,
  readCalendarUrl,
  fetchSafe,
  docxText,
  docxXmlToText,
  emlText,
  htmlToText,
  isPrivateAddress,
  checkUrl,
  nearestEvent,
  expandRepeats,
  untag,
  cleanText,
  safeText,
  WEB_TIMEOUT_MS,
  WEB_MAX_BYTES,
};
