// Dashboard data layer: pure fs, no electron. main.cjs wraps these in IPC handlers.
// Formats and gate math mirror src/tag.ts (tags.jsonl rows {id, useful: "y"|"n", badge}).
const fs = require("node:fs");
const path = require("node:path");

const ID_RE = /^[0-9A-Z]{26}$/;
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
    if (c.badge !== "info" && !c.health) byId.set(c.id, c);
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

function costOf(usage) {
  const s = usage.filter((u) => u.role === "summary").at(-1);
  if (s && typeof s.totalUsd === "number") return s.totalUsd;
  return usage.reduce((a, u) => a + (typeof u.usd === "number" ? u.usd : 0), 0);
}

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
    id, startedAt: started, durationMs: Math.max(0, ended - started), mode: meta.mode || "?", profile: meta.profile || "", noAi: !!meta.noAi,
    crashed: !!meta.crashed, hasSummary: !!readSummary(dir), questions: lat.length, cardsShown: cards.filter((c) => !c.hidden).length, cardsTotal: cards.length,
    rated: g.rated, useful: g.useful, hours: g.hours, perHour: g.perHour, bankShare: g.bankShare, costUsd: costOf(usage),
  };
}

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
  const steps = (Array.isArray(o.nextSteps) ? o.nextSteps : []).filter((n) => n && typeof n.what === "string" && n.what).slice(0, 12)
    .map((n) => ({ who: n.who === "לקוח" ? "לקוח" : "דן", what: n.what.slice(0, 400), when: typeof n.when === "string" && n.when ? n.when.slice(0, 80) : undefined }));
  return {
    generatedAt: typeof o.generatedAt === "string" ? o.generatedAt : "", model: typeof o.model === "string" ? o.model.slice(0, 80) : "",
    summary: strs(o.summary, 6), decisions: strs(o.decisions, 12), nextSteps: steps, openQuestions: strs(o.openQuestions, 12),
    followUpEmail: typeof o.followUpEmail === "string" ? o.followUpEmail.slice(0, 3000) : "",
    guardReplaced: o.guard && Number.isFinite(o.guard.replaced) ? o.guard.replaced : 0, costUsd: Number.isFinite(o.costUsd) ? o.costUsd : 0,
  };
}

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
    summary: summarize(callsDir, id), meta: readJson(dir, "call.json"), callSummary: readSummary(dir),
    transcript: read(dir, "transcript.jsonl").map((r) => ({ t: r.t, ch: r.ch, text: r.text })),
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

function deleteCall(callsDir, id) {
  const dir = callDir(callsDir, id);
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { ID_RE, callDir, ratableCards, gateNumbers, listCalls, getCall, setTag, searchCalls, deleteCall };
