// Dashboard data layer: pure fs, no electron. window.cjs wraps these in IPC handlers.
// Call folders hold untrusted-ish JSONL; every read is tolerant (bad lines skipped) and ids are checked before touching disk.
// Formats and gate math mirror src/tag.ts (tags.jsonl rows {id, useful: "y"|"n", badge}).
const fs = require("node:fs");
const path = require("node:path");

const feedLib = require("./livefeed.js");
const ID_RE = /^[0-9A-Z]{26}$/;
// JSONL file -> array of parsed rows; missing file or bad lines give []/skipped, never throw.
const read = (dir, f) => {
  try {
    return fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  } catch { return []; }
};
const readJson = (dir, f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return {}; } };

/** Resolve a call folder strictly inside callsDir; throws on a bad id. */
function callDir(callsDir, id) {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Error("bad call id");
  const base = fs.realpathSync(callsDir);
  const dir = path.join(base, id);
  if (path.dirname(dir) !== base) throw new Error("bad call path");
  const st = fs.lstatSync(dir); // lstat: a symlink (calls/latest) is not a call folder
  if (!st.isDirectory()) throw new Error("not a call folder");
  return dir;
}

/** Last version of each card wins; withdraw removes; info and health rows are skipped (same filter as tag.ts). */
function ratableCards(rows) {
  const byId = new Map();
  for (const c of rows) {
    if (c.type === "capture" || !c.id) continue;
    if (c.withdraw) { byId.delete(c.id); continue; }
    if (c.badge !== "info" && c.badge !== "note" && !c.health) byId.set(c.id, c);   // notes: 59 of 69 useful on 5 Nov, rating them is busywork
  }
  return [...byId.values()];
}

/** Useful-cards/hour over the event time span, min 1 minute; bank share from latency rows (tag.ts). */
function gateNumbers(events, lat, tags) {
  const times = events.map((e) => e.t).filter(Boolean);
  const hours = times.length ? Math.max((Math.max(...times) - Math.min(...times)) / 3_600_000, 1 / 60) : 1;
  const useful = tags.filter((t) => t.useful === "y").length;
  const bankHits = lat.filter((l) => l.bankAt).length;
  return { hours, useful, rated: tags.length, perHour: useful / hours, questions: lat.length, bankShare: lat.length ? bankHits / lat.length : 0 };
}

/** Cost of a call: the summary row's total when present (it includes everything), else the sum of per-request rows. */
function costOf(usage) {
  const s = usage.filter((u) => u.role === "summary").at(-1);
  if (s && typeof s.totalUsd === "number") return s.totalUsd;
  return usage.reduce((a, u) => a + (typeof u.usd === "number" ? u.usd : 0), 0);
}

/** The call's name: call.json "title" (set by hand), else the plan used on a live call, else "". Control and bidi characters stripped, 80 chars max. */
function callName(meta, events) {
  const clean = (v) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, 80) : "");
  const own = clean(meta && meta.title);
  if (own) return own;
  if (!meta || meta.mode !== "live") return "";
  const plan = (events || []).filter((e) => e && e.type === "plan.used").at(-1);
  return clean(plan && plan.title);
}

/** One list row for a call (times, counts, ratings, cost) from its files. Throws on a bad id. Used by the list, and again after a rating changes. */
function summarize(callsDir, id) {
  const dir = callDir(callsDir, id);
  const meta = readJson(dir, "call.json");
  const events = read(dir, "events.jsonl"), lat = read(dir, "latency.jsonl"), usage = read(dir, "usage.jsonl");
  const cards = ratableCards(read(dir, "cards.jsonl"));
  const ids = new Set(cards.map((c) => c.id));
  const tags = read(dir, "tags.jsonl").filter((t) => ids.has(t.id) && (t.useful === "y" || t.useful === "n"));
  const g = gateNumbers(events, lat, tags);
  const started = Date.parse(meta.startedAt) || (events[0] && events[0].t) || 0;
  const ended = Date.parse(meta.endedAt) || (events.length ? Math.max(...events.map((e) => e.t || 0)) : started);
  return {
    id, name: callName(meta, events), startedAt: started, durationMs: Math.max(0, ended - started), mode: meta.mode || "?", profile: meta.profile || "", noAi: !!meta.noAi,
    crashed: !!meta.crashed, hasSummary: !!readSummary(dir), questions: lat.length, cardsShown: cards.filter((c) => !c.hidden).length, cardsTotal: cards.length,
    rated: g.rated, useful: g.useful, hours: g.hours, perHour: g.perHour, bankShare: g.bankShare, costUsd: costOf(usage),
  };
}

/** Summaries of every call folder, newest first. Folders that fail to read are left out. */
function listCalls(callsDir) {
  let names = [];
  try { names = fs.readdirSync(callsDir); } catch {}
  const out = [];
  for (const n of names) {
    if (n === "latest" || !ID_RE.test(n)) continue;
    try { out.push(summarize(callsDir, n)); } catch {}
  }
  return out.sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : -1));
}

/** summary.json (written by src/summary.ts), re-validated: the renderer only ever gets plain strings and short arrays. Null when missing or unreadable. */
function readSummary(dir) {
  const o = readJson(dir, "summary.json");
  if (!o || typeof o !== "object" || Array.isArray(o) || o.v !== 1) return null;
  const strs = (x, n) => (Array.isArray(x) ? x : []).filter((v) => typeof v === "string" && v).slice(0, n).map((v) => v.slice(0, 600));
  // nextSteps[].who: the client, another name (control and bidi characters stripped), or by default the user. Hebrew labels are the stored values.
  const steps = (Array.isArray(o.nextSteps) ? o.nextSteps : []).filter((n) => n && typeof n.what === "string" && n.what).slice(0, 12)
    .map((n) => ({ who: n.who === "לקוח" ? "לקוח" : typeof n.who === "string" && n.who && n.who !== "אני" ? n.who.replace(/[\u0000-\u001f\u202a-\u202e]/g, "").slice(0, 40) : "אני", what: n.what.slice(0, 400), when: typeof n.when === "string" && n.when ? n.when.slice(0, 80) : undefined }));
  return {
    generatedAt: typeof o.generatedAt === "string" ? o.generatedAt : "", model: typeof o.model === "string" ? o.model.slice(0, 80) : "",
    summary: strs(o.summary, 6), decisions: strs(o.decisions, 12), nextSteps: steps, openQuestions: strs(o.openQuestions, 12),
    followUpEmail: typeof o.followUpEmail === "string" ? o.followUpEmail.slice(0, 3000) : "",
    guardReplaced: o.guard && Number.isFinite(o.guard.replaced) ? o.guard.replaced : 0, costUsd: Number.isFinite(o.costUsd) ? o.costUsd : 0,
  };
}

/** The last call frame logged in events.jsonl, cleaned, with its checklist result: {frame, done, total, missed[]} or null. */
function readFrame(events) {
  const last = events.filter((e) => e && e.type === "frame").at(-1);
  const frame = last ? feedLib.cleanFrame(last) : null;
  return frame ? { frame, ...feedLib.frameProgress(frame) } : null;
}

const cleanName = (v) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, 40).trim() : "");
/** Speaker names from cards.jsonl "speaker" rows, in order (a later row wins; "" = cleared, kept so it also overrides names written on older lines): { "2": "Dana" }. Only voices 1-20 with a text name. */
function speakerNames(rows) {
  const out = {};
  for (const r of rows) if (r && r.type === "speaker" && Number.isInteger(r.spk) && r.spk >= 1 && r.spk <= 20 && typeof r.name === "string") { const n = cleanName(r.name); out[r.spk] = n; }
  return out;
}

/** Everything the call view needs: summary, meta, call summary, frame, transcript, cards (last version each), captures, events, latency, usage (provider internals removed) and ratings by card id. */
function getCall(callsDir, id) {
  const dir = callDir(callsDir, id);
  const rows = read(dir, "cards.jsonl");
  const final = new Map();
  for (const c of rows) {
    if (c.type === "capture" || !c.id) continue;
    if (c.withdraw) { final.delete(c.id); continue; }
    final.set(c.id, c);
  }
  const tags = {};
  for (const t of read(dir, "tags.jsonl")) if (t && t.id && (t.useful === "y" || t.useful === "n")) tags[t.id] = t.useful;
  return {
    summary: summarize(callsDir, id), meta: readJson(dir, "call.json"), callSummary: readSummary(dir), callFrame: readFrame(read(dir, "events.jsonl")),
    transcript: read(dir, "transcript.jsonl").map((r) => ({ t: r.t, ch: r.ch, text: r.text, ...(Number.isInteger(r.spk) && r.spk >= 1 && r.spk <= 20 ? { spk: r.spk } : {}), ...(cleanName(r.name) ? { name: cleanName(r.name) } : {}) })),
    speakers: speakerNames(rows),
    cards: [...final.values()], captures: rows.filter((c) => c.type === "capture"),
    events: read(dir, "events.jsonl"), latency: read(dir, "latency.jsonl"),
    usage: read(dir, "usage.jsonl").map((u) => { const { usage: _u, providerMetadata: _p, ...rest } = u; return rest; }),
    tags,
  };
}

/** Writes tags.jsonl in tag.ts format, preserving every other tag. useful null removes the tag. */
function setTag(callsDir, id, cardId, useful) {
  const dir = callDir(callsDir, id);
  if (typeof cardId !== "string" || !cardId || cardId.length > 200) throw new Error("bad card id");
  if (useful !== "y" && useful !== "n" && useful !== null) throw new Error("bad rating");
  const card = ratableCards(read(dir, "cards.jsonl")).find((c) => c.id === cardId);
  if (!card) throw new Error("card not ratable");
  const tags = read(dir, "tags.jsonl").filter((t) => t && t.id && t.id !== cardId);
  if (useful) tags.push({ id: cardId, useful, badge: card.badge });
  const tmp = path.join(dir, `.tags.jsonl.${process.pid}.tmp`);
  fs.writeFileSync(tmp, tags.length ? tags.map((t) => JSON.stringify(t)).join("\n") + "\n" : "", { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, "tags.jsonl"));
  return summarize(callsDir, id);
}

/** One hit per call whose transcript contains the query (case-insensitive): {id, line, at, ch, text}. text is a snippet around the match; at is ms from call start. Newest call first. */
function searchCalls(callsDir, q) {
  if (typeof q !== "string") throw new Error("bad query");
  const needle = q.trim().toLowerCase();
  if (!needle || needle.length > 200) return [];
  const hits = [];
  for (const n of fs.readdirSync(callsDir).sort().reverse()) {
    if (!ID_RE.test(n)) continue;
    try {
      const dir = callDir(callsDir, n);
      const rows = read(dir, "transcript.jsonl");
      const line = rows.findIndex((r) => String(r.text).toLowerCase().includes(needle));
      if (line < 0) continue;
      const meta = readJson(dir, "call.json");
      const t0 = Date.parse(meta.startedAt) || (rows[0] && rows[0].t) || 0;
      const text = String(rows[line].text), i = text.toLowerCase().indexOf(needle);
      const from = Math.max(0, i - 60), to = Math.min(text.length, i + needle.length + 100);
      hits.push({ id: n, line, at: Math.max(0, (rows[line].t || t0) - t0), ch: rows[line].ch === "me" ? "me" : "them", text: (from ? "…" : "") + text.slice(from, to) + (to < text.length ? "…" : "") });
    } catch {}
  }
  return hits;
}

/** Remove a call folder for good. The id is validated by callDir; the confirm dialog is in window.cjs. */
function deleteCall(callsDir, id) {
  const dir = callDir(callsDir, id);
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Recent plans: the last few saved, newest first, so an expired or repeated plan can be reused. Pure list handling; the file is read and written in window.cjs. */
const PLAN_KEYS = ["who", "goal", "notes", "mustCover"], RECENT_MAX = 5;
function cleanPlan(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const o = {};
  for (const k of PLAN_KEYS) { if (typeof p[k] !== "string" || p[k].length > 1500) return null; o[k] = p[k].replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim(); }
  return PLAN_KEYS.some((k) => o[k]) ? o : null;
}
// Two plans with the same "who|goal" count as the same plan (the newer one replaces the older in the recent list).
const planKey = (p) => (p.who + "|" + p.goal).toLowerCase();
function recentAdd(list, plan) {
  const p = cleanPlan(plan); if (!p) return recentClean(list);
  return [p, ...recentClean(list).filter((x) => planKey(x) !== planKey(p))].slice(0, RECENT_MAX);
}
function recentClean(raw) { return (Array.isArray(raw) ? raw : []).map(cleanPlan).filter(Boolean).slice(0, RECENT_MAX); }

module.exports = { callName, cleanPlan, recentAdd, recentClean, RECENT_MAX, readFrame, ID_RE, callDir, ratableCards, gateNumbers, listCalls, getCall, setTag, searchCalls, deleteCall };
