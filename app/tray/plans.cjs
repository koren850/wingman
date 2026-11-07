"use strict";
// Prepared meetings: the store behind "Prepare a meeting" (window), `wingman plan ...` (CLI) and Start prepared meeting (menu bar).
// Several meetings can wait at once. Each has its own who / kind / topic / goal / notes / must-cover, an optional title and time,
// and its own background files. Layout inside the private briefs folder (owner-only: folders 700, files 600):
//   plans/<id>/meeting.json     the meeting
//   plans/<id>/files/           its background files (tray/attachments.cjs stores the text only)
//   plans/<id>/brief.yaml       written by exportBrief() for the engine (src/brief.ts reads it with --brief)
//   plans/_draft/files/         background files of a meeting that is being written and is not saved yet
// The rules (expiry, order, "next", "due now") are in shared/plans.js. A call uses a meeting only when it is started with it
// explicitly; markUsed() is called when that call really goes live, and then drops the background files (one meeting = one real call).
// The old single Plan (latest.yaml plus flat attachments/) is turned into one meeting the first time the store is opened (migrate()).
// No Electron import: unit-tested in src/plans.test.ts. Content is never logged.
const fs = require("node:fs");
const path = require("node:path");
const P = require("../shared/plans.js");
const attachments = require("./attachments.cjs");

const ID_RE = /^m[0-9a-z]{6,12}$/;
const DRAFT = "_draft";
const KIND_PREFIX = "Call kind: ",
  TOPIC_PREFIX = "Topic: ";
const FLAT_FILE_RE = /^(a[0-9a-z]{6,12})__(.{1,80})\.txt$/;
const LONG_AGE_MS = 400 * 24 * 3600_000; // the attachment store's own 6 h expiry is switched off here: the meeting's expiry decides
const DRAFT_KEEP_MS = 24 * 3600_000;
const LIMITS = { title: 80, who: 120, goal: 200, topic: 120, item: 200, items: 12 };

/** Plain one-line text: no control or bidi-override characters, trimmed, capped. */
function clean(t, max) {
  if (typeof t !== "string") return "";
  return t
    .replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
/**
 * An array of strings, or text split on ";" and line breaks, as up to 12 clean items.
 * @param {any} v
 * @returns {string[]}
 */
function items(v) {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[;\n]/) : [];
  return arr
    .map((x) => clean(x, LIMITS.item))
    .filter(Boolean)
    .slice(0, LIMITS.items);
}

/**
 * Makes the store. o: { dir (the briefs folder), now?, readOnly? (never migrate, sweep or write: snapshots), pdftotext? (tests) }.
 * Every method returns plain data; failures are { ok:false, error } with user-facing English, never an exception for bad input.
 */
function createPlanStore(o) {
  const base = o.dir,
    root = path.join(base, "plans"),
    now = o.now || Date.now,
    readOnly = !!o.readOnly;
  const ensure = (d) => {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(d, 0o700);
    } catch {
      /* best effort */
    }
  };
  const dirOf = (id) => path.join(root, id);
  const fileOf = (id) => path.join(dirOf(id), "meeting.json");
  const filesStore = (id) =>
    attachments.createStore({
      dir: path.join(dirOf(id), "files"),
      now,
      maxAgeMs: LONG_AGE_MS,
      ...(o.pdftotext !== undefined ? { pdftotext: o.pdftotext } : {}),
    });

  /** Writes a file atomically (temp name, then rename), mode 600. */
  function writeAtomic(file, text) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  function readMeeting(id) {
    try {
      const j = JSON.parse(fs.readFileSync(fileOf(id), "utf8"));
      if (!j || typeof j !== "object" || j.id !== id) return null;
      const n = (x) => (Number.isFinite(x) && x > 0 ? Math.round(x) : 0);
      return {
        id,
        title: clean(j.title, LIMITS.title),
        who: clean(j.who, LIMITS.who),
        goal: clean(j.goal, LIMITS.goal),
        kind: clean(j.kind, 20),
        topic: clean(j.topic, LIMITS.topic),
        notes: items(j.notes),
        mustCover: items(j.mustCover),
        at: n(j.at),
        createdAt: n(j.createdAt),
        updatedAt: n(j.updatedAt) || n(j.createdAt),
        usedAt: n(j.usedAt),
        callId: clean(j.callId, 60),
      };
    } catch {
      return null;
    }
  }
  const save = (m) => {
    ensure(dirOf(m.id));
    writeAtomic(fileOf(m.id), JSON.stringify(m, null, 1) + "\n");
  };

  /** A meeting plus what the lists show: status, expiry, and how many background files it has. */
  function view(m) {
    const t = now();
    let files = [],
      chars = 0;
    try {
      files = filesStore(m.id).list().files;
      chars = files.reduce((a, f) => a + f.chars, 0);
    } catch {
      /* none */
    }
    return {
      ...m,
      status: P.statusOf(m, t),
      expiresAt: P.expiresAt(m),
      files: files.length,
      fileList: files.map((f) => ({ id: f.id, name: f.name, chars: f.chars })),
      fileChars: chars,
    };
  }

  // ---- first run: the old single Plan becomes one meeting ----
  /**
   * latest.yaml (the single Plan of earlier versions) and the flat attachments/ files become ONE meeting, then the old files are removed.
   * The meeting id comes from the file time, so a crash between "write the meeting" and "remove latest.yaml" cannot create a second copy.
   */
  function migrate() {
    if (readOnly) return;
    const latest = path.join(base, "latest.yaml"),
      flat = path.join(base, "attachments");
    /** @type {any} */
    let brief = null;
    let mtime = 0;
    try {
      mtime = fs.statSync(latest).mtimeMs;
      brief = require("yaml").parse(fs.readFileSync(latest, "utf8")) || {};
    } catch {
      brief = null;
    }
    let flatNames = [];
    try {
      flatNames = fs.readdirSync(flat).filter((n) => FLAT_FILE_RE.test(n) && fs.lstatSync(path.join(flat, n)).isFile());
    } catch {
      flatNames = [];
    }
    if (!brief && !flatNames.length) return;
    const stamp = brief
      ? mtime
      : Math.max(
          ...flatNames.map((n) => {
            try {
              return fs.statSync(path.join(flat, n)).mtimeMs;
            } catch {
              return 0;
            }
          }),
        );
    const id =
      "m" +
      Math.floor(stamp / 1000)
        .toString(36)
        .padStart(6, "0")
        .slice(-8);
    if (!fs.existsSync(fileOf(id))) {
      let kind = "",
        topic = "";
      const notes = [];
      for (const n of items(brief && brief.notes)) {
        if (n.startsWith(KIND_PREFIX)) kind = n.slice(KIND_PREFIX.length);
        else if (n.startsWith(TOPIC_PREFIX)) topic = n.slice(TOPIC_PREFIX.length);
        else notes.push(n);
      }
      const m = {
        id,
        title: brief ? "" : "Imported background files",
        who: clean(brief && brief.who, LIMITS.who),
        goal: clean(brief && brief.goal, LIMITS.goal),
        kind: clean(kind, 20),
        topic: clean(topic, LIMITS.topic),
        notes,
        mustCover: items(brief && brief.mustCover),
        at: 0,
        createdAt: Math.round(stamp),
        updatedAt: Math.round(stamp),
        usedAt: 0,
        callId: "",
      };
      save(m);
      if (flatNames.length) {
        const dest = path.join(dirOf(id), "files");
        ensure(dest);
        for (const n of flatNames) {
          try {
            fs.renameSync(path.join(flat, n), path.join(dest, n));
          } catch {
            /* left behind; harmless */
          }
        }
      }
    }
    if (brief) {
      try {
        fs.rmSync(latest, { force: true });
      } catch {
        /* retried next time */
      }
    }
  }

  /** Removes expired meetings and stale drafts. */
  function sweep() {
    if (readOnly) return;
    let names = [];
    try {
      names = fs.readdirSync(root);
    } catch {
      return;
    }
    const t = now();
    for (const n of names) {
      if (n === DRAFT) {
        try {
          if (t - fs.statSync(dirOf(n)).mtimeMs > DRAFT_KEEP_MS) fs.rmSync(dirOf(n), { recursive: true, force: true });
        } catch {
          /* gone */
        }
        continue;
      }
      if (!ID_RE.test(n)) continue;
      const m = readMeeting(n);
      if (!m) {
        try {
          if (!fs.existsSync(fileOf(n)) && t - fs.statSync(dirOf(n)).mtimeMs > DRAFT_KEEP_MS) fs.rmSync(dirOf(n), { recursive: true, force: true });
        } catch {
          /* gone */
        }
        continue;
      }
      if (P.statusOf(m, t) === "expired") {
        try {
          fs.rmSync(dirOf(n), { recursive: true, force: true });
        } catch {
          /* retried next time */
        }
      }
    }
  }
  const prep = () => {
    try {
      migrate();
    } catch {
      /* a broken old file must not hide the new store */
    }
    sweep();
  };

  /** Meetings in order (soonest first). includeUsed: also the ones a real call already used (kept for the Calls view). */
  function list(opts = {}) {
    prep();
    let names = [];
    try {
      names = fs.readdirSync(root);
    } catch {
      return [];
    }
    const all = names
      .filter((n) => ID_RE.test(n))
      .map(readMeeting)
      .filter(Boolean)
      .map(view)
      .filter((m) => m.status !== "expired" && (opts.includeUsed || m.status === "ready"));
    const ord = P.order(all);
    return opts.includeUsed ? [...ord.filter((m) => m.status === "ready"), ...ord.filter((m) => m.status === "used").sort((a, b) => b.usedAt - a.usedAt)] : ord;
  }
  /** Finds a meeting by exact id or by a unique prefix (3+ characters). { meeting } or { error: "not_found" | "ambiguous", matches? }. */
  function resolve(idLike, opts = { includeUsed: true }) {
    const q = String(idLike == null ? "" : idLike)
      .trim()
      .toLowerCase();
    if (!q || !/^[0-9a-z]+$/.test(q)) return { error: "not_found" };
    const all = list(opts);
    const exact = all.find((m) => m.id === q);
    if (exact) return { meeting: exact };
    if (q.length < 3) return { error: "not_found" };
    const hits = all.filter((m) => m.id.startsWith(q));
    if (hits.length === 1) return { meeting: hits[0] };
    return hits.length ? { error: "ambiguous", matches: hits } : { error: "not_found" };
  }
  const get = (id, opts) => resolve(id, opts).meeting || null;

  /** Reads and checks the fields the caller gave. Only keys that are present are returned (a patch). */
  function fields(f) {
    const out = {};
    if (f.title !== undefined) out.title = clean(f.title, LIMITS.title);
    if (f.who !== undefined) out.who = clean(f.who, LIMITS.who);
    if (f.goal !== undefined) out.goal = clean(f.goal, LIMITS.goal);
    if (f.topic !== undefined) out.topic = clean(f.topic, LIMITS.topic);
    if (f.kind !== undefined) out.kind = clean(f.kind, 20);
    if (f.notes !== undefined) out.notes = items(f.notes);
    if (f.mustCover !== undefined) out.mustCover = items(f.mustCover);
    if (f.at !== undefined) out.at = typeof f.at === "number" ? (f.at > 0 ? Math.round(f.at) : 0) : P.parseAt(f.at, now());
    return out;
  }
  const hasContent = (m) => !!(m.title || m.who || m.goal || m.topic || m.notes.length || m.mustCover.length);

  /** Saves a new meeting. fields: { title, who, goal, topic, kind, notes, mustCover, at } (notes / mustCover: array or text split on ";" / lines; at: epoch ms or text). adoptDraft: move the unsaved draft's background files in. */
  function create(f, opts = {}) {
    prep();
    let patch;
    try {
      patch = fields(f || {});
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const t = now();
    if (list({ includeUsed: false }).length >= P.RULES.maxMeetings)
      return { ok: false, error: `At most ${P.RULES.maxMeetings} prepared meetings. Delete one first.` };
    const m = {
      id: "",
      title: "",
      who: "",
      goal: "",
      kind: "",
      topic: "",
      notes: [],
      mustCover: [],
      at: 0,
      createdAt: t,
      updatedAt: t,
      usedAt: 0,
      callId: "",
      ...patch,
    };
    if (!hasContent(m)) return { ok: false, error: "Fill in at least one field." };
    if (m.at && m.at + P.RULES.afterMeetingMs <= t) return { ok: false, error: "That time is more than 6 hours ago, so the meeting would expire at once." };
    for (let i = 0; i < 5 && !m.id; i++) {
      const id =
        "m" +
        t.toString(36).slice(-6) +
        Math.floor(Math.random() * 36 ** 3)
          .toString(36)
          .padStart(3, "0");
      if (!fs.existsSync(dirOf(id))) m.id = id;
    }
    if (!m.id) return { ok: false, error: "Could not make an id. Try again." };
    save(m);
    if (opts.adoptDraft) adoptDraft(m.id);
    return { ok: true, meeting: get(m.id) };
  }
  /** Changes some fields of a meeting that is still ready. */
  function update(idLike, f) {
    const r = resolve(idLike);
    if (!r.meeting) return { ok: false, error: r.error === "ambiguous" ? "That id matches more than one meeting." : "No such prepared meeting." };
    if (r.meeting.status !== "ready") return { ok: false, error: "That meeting was already used by a call. Prepare a new one." };
    let patch;
    try {
      patch = fields(f || {});
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const cur = readMeeting(r.meeting.id);
    const m = { ...cur, ...patch, updatedAt: now() };
    if (!hasContent(m)) return { ok: false, error: "A meeting cannot be empty." };
    if (patch.at && patch.at + P.RULES.afterMeetingMs <= now())
      return { ok: false, error: "That time is more than 6 hours ago, so the meeting would expire at once." };
    save(m);
    return { ok: true, meeting: get(m.id) };
  }
  /** Deletes a meeting and its background files. */
  function remove(idLike) {
    const r = resolve(idLike);
    if (!r.meeting) return { ok: false, error: r.error === "ambiguous" ? "That id matches more than one meeting." : "No such prepared meeting." };
    if (!readOnly) fs.rmSync(dirOf(r.meeting.id), { recursive: true, force: true });
    return { ok: true, id: r.meeting.id };
  }
  /** A real call went live with this meeting: mark it used (kept 7 days for the Calls view) and drop its background files. */
  function markUsed(id, callId) {
    const m = ID_RE.test(String(id)) ? readMeeting(id) : null;
    if (!m || m.usedAt) return false;
    save({ ...m, usedAt: now(), callId: clean(callId, 60) });
    try {
      filesStore(id).clear();
    } catch {
      /* best effort */
    }
    return true;
  }

  /** Background files of a meeting, or of the unsaved draft (id "" or "draft"). Same {ok,...} store as tray/attachments.cjs. */
  function files(idLike) {
    if (idLike === "" || idLike === "draft" || idLike === DRAFT) {
      ensure(dirOf(DRAFT));
      return filesStore(DRAFT);
    }
    const r = resolve(idLike);
    if (!r.meeting) return null;
    return filesStore(r.meeting.id);
  }
  /** Moves the draft's background files into a saved meeting (up to the meeting's own limits). */
  function adoptDraft(id) {
    const from = path.join(dirOf(DRAFT), "files"),
      to = path.join(dirOf(id), "files");
    let names = [];
    try {
      names = fs.readdirSync(from).filter((n) => FLAT_FILE_RE.test(n));
    } catch {
      return 0;
    }
    ensure(to);
    let n = 0;
    for (const f of names) {
      try {
        fs.renameSync(path.join(from, f), path.join(to, f));
        n++;
      } catch {
        /* skipped */
      }
    }
    return n;
  }
  /** Throws the unsaved draft's background files away (Cancel in the editor). */
  function discardDraft() {
    if (!readOnly)
      try {
        fs.rmSync(dirOf(DRAFT), { recursive: true, force: true });
      } catch {
        /* nothing */
      }
  }

  /**
   * Files for one call: writes plans/<id>/brief.yaml (who, goal, notes with kind/topic as prefixed notes, mustCover: what src/brief.ts reads)
   * and returns { briefFile, attachDir } for the engine (--brief and WINGMAN_ATTACH_DIR). Only a ready meeting can be exported.
   */
  function exportBrief(idLike) {
    const m = get(idLike);
    if (!m || m.status !== "ready") return null;
    const y = (v) => JSON.stringify(v); // JSON strings are valid YAML scalars
    const notes = [...(m.kind ? [KIND_PREFIX + m.kind] : []), ...(m.topic ? [TOPIC_PREFIX + m.topic] : []), ...m.notes];
    const lines = [`planId: ${y(m.id)}`];
    if (m.title) lines.push(`title: ${y(m.title)}`);
    if (m.who) lines.push(`who: ${y(m.who)}`);
    if (m.goal) lines.push(`goal: ${y(m.goal)}`);
    lines.push(`notes: ${y(notes)}`, `mustCover: ${y(m.mustCover)}`, `createdAt: ${y(new Date(m.createdAt).toISOString())}`);
    ensure(dirOf(m.id));
    const briefFile = path.join(dirOf(m.id), "brief.yaml");
    writeAtomic(briefFile, lines.join("\n") + "\n");
    return { briefFile, attachDir: path.join(dirOf(m.id), "files"), meeting: m };
  }

  const nextMeeting = () => P.nextMeeting(list(), now());
  const dueNow = () => P.dueNow(list(), now());
  const practiceDefault = () => P.practiceDefault(list(), now());
  /** Changes whenever what the menu or the window shows changes. */
  const signature = () => P.signature(list());

  return {
    list,
    resolve,
    get,
    create,
    update,
    remove,
    markUsed,
    files,
    adoptDraft,
    discardDraft,
    exportBrief,
    nextMeeting,
    dueNow,
    practiceDefault,
    signature,
    migrate,
    dirOf,
  };
}

module.exports = { createPlanStore, clean, items, ID_RE, KIND_PREFIX, TOPIC_PREFIX, LIMITS };
