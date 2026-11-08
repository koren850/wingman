"use strict";
// Call memory -> what the screens show. Pure functions, no DOM and no files. Classic script in the windows, require() in main processes and tests.
// Input is untrusted: session.json is a local file but the text in it came from a call, so every string is cleaned and clipped here.
//
//   viewFromMemory(mem)        the small MemoryView the relay carries ({ ver, topic, soFar, open, promises, coverLeft, numbers }); same output as src/session/view.ts
//   cleanView(v)               a MemoryView that arrived over the relay -> the same shape, cleaned (null when it is not a view)
//   recapFromMemory(mem, o)    the "Catch me up" sheet made from notes alone (no AI): { where, decided[], open[], promised[], asked[] }
//   parseRecapText(text)       the streamed reply of the recap call (labelled lines) -> the same shape; partial text is fine
//   overlayViewRow(src, o)     the { type: "view" } row the answer window draws; src is a full memory or a MemoryView
//   openLoops(mem, o)          what is still open after the call: { questions[], promises[], theirs[], cover[] }
//   followupDraft(mem, o)      a plain follow-up note from the open loops (no AI; text comes from the memory lines)
//
// "Me" is known from the roster (side "me"), the literal "me", and o.meNames. There are no word lists here.
(function (root) {
  const BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;
  const str = (v, n) => (typeof v === "string" ? v.replace(BAD, "").replace(/\s+/g, " ").trim().slice(0, n) : "");
  const clip = (s, n) => {
    const c = Array.from(String(s));
    return c.length <= n
      ? String(s)
      : c
          .slice(0, n - 1)
          .join("")
          .trimEnd() + "…";
  };
  const num = (id) => Number(String(id).slice(1)) || 0;
  /** The call kinds (the list is in src/session/types.ts; a test keeps both equal) and the shape of a custom mode id (pack modes.yaml). */
  const KINDS = ["client", "support", "vendor", "team", "consult", "personal", "interview", "other"];
  const MODE_ID = /^[a-z0-9][a-z0-9-]{0,23}$/;
  const arr = (v) => (Array.isArray(v) ? v : []);
  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();

  /** A call mode id: a built-in kind or the id of a custom mode (letters, digits, dash, underscore). Anything else is "other". */
  const kindId = (k) => (typeof k === "string" && /^[A-Za-z0-9_-]{1,24}$/.test(k) ? k : "other");

  /** Same output as toView in src/session/view.ts (a test keeps them equal). */
  function viewFromMemory(m) {
    const mem = obj(m);
    const so = [
      ...arr(mem.decisions)
        .slice()
        .sort((a, b) => num(b.id) - num(a.id))
        .map((d) => d.text),
      ...arr(mem.facts)
        .filter((f) => f.src !== "brief")
        .sort((a, b) => num(b.id) - num(a.id))
        .map((f) => f.text),
    ];
    return {
      ver: Number(mem.ver) || 0,
      kind: kindId(mem.kind),
      kindLocked: mem.kindLocked === true,
      ...(typeof mem.modeId === "string" && MODE_ID.test(mem.modeId) ? { modeId: mem.modeId } : {}),
      topic: clip(str(obj(mem.topic).now, 400), 80),
      soFar: so.slice(0, 4).map((t) => clip(t, 140)),
      open: arr(mem.openQuestions)
        .filter((q) => q.status === "open")
        .map((q) => ({ id: q.id, text: clip(q.text, 140) })),
      promises: arr(mem.commitments)
        .filter((c) => c.status === "open")
        .map((c) => ({ id: c.id, who: clip(c.who, 40), text: clip(c.what, 140) })),
      coverLeft: arr(mem.mustCover)
        .filter((x) => !x.done)
        .map((x) => ({ id: x.id, text: clip(x.text, 140) })),
      numbers: arr(mem.numbers)
        .slice(-6)
        .map((n) => ({ id: n.id, what: clip(n.what, 60), value: clip(n.value, 40) })),
    };
  }

  const items = (v, n, textKey) =>
    arr(v)
      .slice(0, 30)
      .flatMap((x) => {
        const o = obj(x);
        const id = str(o.id, 12);
        const text = str(typeof x === "string" ? x : o[textKey || "text"], 200);
        return text ? [{ id, text, ...(o.who !== undefined ? { who: str(o.who, 40) } : {}) }] : [];
      });
  /** A view that came over the relay: only known fields, plain strings, capped. Null when it is not an object with a ver or a topic. */
  function cleanView(v) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    if (v.ver === undefined && v.topic === undefined) return null;
    return {
      ver: Number.isFinite(v.ver) ? Math.max(0, Math.round(v.ver)) : 0,
      kind: v.kind === undefined ? "" : kindId(v.kind), // a view from an older engine has no kind: the screens show no pill then
      kindLocked: v.kindLocked === true,
      ...(typeof v.modeId === "string" && MODE_ID.test(v.modeId) ? { modeId: v.modeId } : {}),
      topic: str(v.topic, 120),
      soFar: arr(v.soFar)
        .map((t) => str(t, 200))
        .filter(Boolean)
        .slice(0, 4),
      open: items(v.open, 20),
      promises: items(v.promises, 20),
      coverLeft: items(v.coverLeft, 20),
      numbers: arr(v.numbers)
        .slice(0, 6)
        .map((n) => ({ id: str(obj(n).id, 12), what: str(obj(n).what, 60), value: str(obj(n).value, 40) }))
        .filter((n) => n.what || n.value),
    };
  }

  const meSet = (mem, o) => {
    const s = new Set(["me"]);
    for (const p of arr(obj(mem).roster)) if (p && p.side === "me") s.add(norm(p.name));
    for (const n of arr(o && o.meNames)) s.add(norm(n));
    return s;
  };
  const isMe = (set, who) => set.has(norm(who));

  /** The recap sheet from notes alone. Used when the AI is off or slow, and as the first thing on screen. */
  function recapFromMemory(m, o) {
    const mem = obj(m),
      me = meSet(mem, o);
    const openQs = arr(mem.openQuestions).filter((q) => q.status === "open");
    return {
      where: str(obj(mem.topic).now, 160) || str(mem.summary, 160),
      decided: arr(mem.decisions)
        .slice(-3)
        .map((d) => str(d.text, 160))
        .filter(Boolean),
      open: [
        ...openQs.filter((q) => isMe(me, q.asker)).map((q) => str(q.text, 160)),
        ...arr(mem.mustCover)
          .filter((x) => !x.done)
          .map((x) => str(x.text, 160)),
      ]
        .filter(Boolean)
        .slice(0, 3),
      promised: arr(mem.commitments)
        .filter((c) => c.status === "open" && isMe(me, c.who))
        .map((c) => str(c.what, 160))
        .filter(Boolean)
        .slice(0, 3),
      asked: openQs
        .filter((q) => !isMe(me, q.asker))
        .map((q) => str(q.text, 160))
        .filter(Boolean)
        .slice(0, 3),
    };
  }

  const LABELS = { WHERE: "where", DECIDED: "decided", OPEN: "open", PROMISED: "promised", ASKED: "asked" };
  /**
   * The streamed recap reply. Labelled lines: "WHERE: ...", then "DECIDED: a; b", "OPEN: ...", "PROMISED: ...", "ASKED: ...". Items split on " | " or ";" or new lines under a label
   * (a leading "-" is dropped). Unknown lines and a half-written last line are fine: the labels are keys of the call grammar, not language words, so Hebrew text works the same.
   * Returns the recap so far and how many labels were seen.
   */
  function parseRecapText(text) {
    const out = { where: "", decided: [], open: [], promised: [], asked: [] };
    let cur = "",
      seen = 0;
    for (const raw of String(text || "").split(/\r?\n/)) {
      const m = /^\s*(WHERE|DECIDED|OPEN|PROMISED|ASKED)\s*[:=]\s*(.*)$/i.exec(raw);
      let body = raw;
      if (m) {
        cur = LABELS[m[1].toUpperCase()];
        seen++;
        body = m[2];
      } else if (!cur) continue;
      const parts = body
        .split(/\s\|\s|;/)
        .map((p) => str(p.replace(/^\s*[-•*]\s*/, ""), 200))
        .filter(Boolean);
      if (cur === "where") out.where = [out.where, ...parts].filter(Boolean).join(" ").slice(0, 240);
      else out[cur].push(...parts);
    }
    for (const k of ["decided", "open", "promised", "asked"]) out[k] = out[k].slice(0, 3);
    return { recap: out, labels: seen };
  }

  /** session.json text -> a memory object or null. Schema: the shape the page needs; deeper checks are the engine's job (src/session/store.ts). */
  function parseMemory(text) {
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      return null;
    }
    if (!j || typeof j !== "object" || Array.isArray(j) || j.v !== 1) return null;
    for (const k of ["facts", "openQuestions", "commitments", "decisions", "mustCover", "numbers"]) if (!Array.isArray(j[k])) return null;
    if (!j.topic || typeof j.topic !== "object") return null;
    return j;
  }

  const AI = ["ok", "offline", "paused"];
  /** The view row for the answer window. src: a full memory (preferred: it carries the recap) or a MemoryView. o: { ai, at, recap (replaces the notes recap) }. */
  function overlayViewRow(src, o) {
    const opt = o || {};
    const s = obj(src);
    const full = Array.isArray(s.openQuestions) || Array.isArray(s.facts);
    const v = full ? viewFromMemory(s) : cleanView(s) || { kind: "", kindLocked: false, topic: "", soFar: [], open: [], promises: [], coverLeft: [] };
    const recap =
      opt.recap ||
      (full
        ? recapFromMemory(s, opt)
        : {
            where: v.topic,
            decided: v.soFar.slice(0, 3),
            open: v.open.map((x) => x.text).slice(0, 3),
            promised: v.promises.map((x) => x.text).slice(0, 3),
            asked: [],
          });
    return {
      type: "view",
      at: opt.at !== undefined ? opt.at : Date.now(),
      now: v.topic,
      kind: v.kind,
      kindLocked: v.kindLocked,
      soFar: v.soFar,
      open: v.open.map((x) => x.text),
      promises: v.promises.map((x) => (x.who ? x.who + ": " : "") + x.text),
      cover: v.coverLeft.map((x) => x.text),
      recap,
      ai: AI.includes(opt.ai) ? opt.ai : "ok",
    };
  }

  /** What is still open: for the after-call view. Texts only; ids stay for removal. */
  function openLoops(m, o) {
    const mem = obj(m),
      me = meSet(mem, o);
    const qs = arr(mem.openQuestions).filter((q) => q.status === "open");
    const cs = arr(mem.commitments).filter((c) => c.status === "open");
    return {
      questions: qs.map((q) => ({ id: q.id, text: str(q.text, 200), who: str(q.asker, 40), mine: isMe(me, q.asker) })),
      promises: cs.filter((c) => isMe(me, c.who)).map((c) => ({ id: c.id, text: str(c.what, 200), who: str(c.who, 40), due: str(c.due, 40) })),
      theirs: cs.filter((c) => !isMe(me, c.who)).map((c) => ({ id: c.id, text: str(c.what, 200), who: str(c.who, 40), due: str(c.due, 40) })),
      cover: arr(mem.mustCover)
        .filter((x) => !x.done)
        .map((x) => ({ id: x.id, text: str(x.text, 200) })),
    };
  }

  /**
   * A plain follow-up note built from the open loops and the decisions. Every line is a memory line, nothing is invented.
   * o.labels: { hello, decided, youOwe, weOwe, open, bye } the words of the note in the window's language (the caller passes them from its string table).
   */
  function followupDraft(m, o) {
    const mem = obj(m);
    return draftText({ decisions: arr(mem.decisions).map((d) => str(d.text, 200)), loops: openLoops(mem, o) }, o && o.labels);
  }
  /** The same note from plain parts (what the Wingman window gets from its main process): { decisions: string[], loops: openLoops() } and the labels. */
  function draftText(parts, labels) {
    const L = labels || {};
    const loops = obj(parts).loops || { questions: [], promises: [], theirs: [] };
    const lines = [];
    if (L.hello) lines.push(L.hello, "");
    const dec = arr(parts && parts.decisions)
      .slice(-5)
      .filter(Boolean);
    if (dec.length) lines.push(L.decided || "", ...dec.map((t) => "- " + t), "");
    if (arr(loops.promises).length) lines.push(L.weOwe || "", ...loops.promises.map((p) => "- " + p.text + (p.due ? " (" + p.due + ")" : "")), "");
    if (arr(loops.theirs).length)
      lines.push(L.youOwe || "", ...loops.theirs.map((p) => "- " + (p.who ? p.who + ": " : "") + p.text + (p.due ? " (" + p.due + ")" : "")), "");
    if (arr(loops.questions).length) lines.push(L.open || "", ...loops.questions.map((q) => "- " + q.text), "");
    if (L.bye) lines.push(L.bye);
    const text = lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { text, empty: !dec.length && !arr(loops.promises).length && !arr(loops.theirs).length && !arr(loops.questions).length };
  }

  // Health bars that mean "the model is not helping right now". The ids are the engine's (src/engine/out.ts health(id, ...)); a ladder bar is "paused" at amber and "offline" at red.
  const AI_BARS = { "health-ai": "paused", "health-cost": "paused", "health-spend": "paused", "health-ladder": "ladder" };
  /** bars: Map or object of health-bar id -> "red" | "amber" (only bars that are set). -> "ok" | "paused" | "offline". */
  function aiState(bars) {
    const entries = bars instanceof Map ? [...bars] : Object.entries(obj(bars));
    let next = "ok";
    for (const [id, lvl] of entries) {
      const kind = AI_BARS[id];
      if (kind === "ladder") next = lvl === "red" ? "offline" : next === "ok" ? "paused" : next;
      else if (kind) next = next === "offline" ? next : "paused";
    }
    return next;
  }

  const api = {
    parseMemory,
    AI_BARS,
    aiState,
    str,
    clip,
    viewFromMemory,
    cleanView,
    recapFromMemory,
    parseRecapText,
    overlayViewRow,
    openLoops,
    followupDraft,
    draftText,
    isMe,
    meSet,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WingmanMemView = api;
})(typeof window !== "undefined" ? window : globalThis);
