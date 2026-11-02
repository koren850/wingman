// Pure helpers for the menu-bar app (unit-tested in src/tray.test.ts).
const fs = require("node:fs");
const path = require("node:path");

const PREFIX = "@@wingman ";

function initialState() {
  return { phase: "idle", startedAt: 0, liveAt: 0, quiet: false, proposed: "", client: "", notes: 0, health: {}, briefReady: false, doctorRunning: false, endedCleanly: false, lastError: "", callId: "" };
}

/** A status line from run.ts, or undefined. */
function parseStatus(line) {
  const i = line.indexOf(PREFIX);
  if (i < 0) return undefined;
  try { const m = JSON.parse(line.slice(i + PREFIX.length)); return m && typeof m.ev === "string" ? m : undefined; } catch { return undefined; }
}

function reduce(s, m) {
  const n = { ...s, health: { ...s.health } };
  switch (m.ev) {
    case "boot": n.briefReady = !!m.briefReady; break;
    case "starting": Object.assign(n, initialState(), { phase: "starting", startedAt: Date.now(), briefReady: s.briefReady }); break;
    case "waiting": n.phase = "waiting"; n.callId = m.id || ""; break;
    case "consented": n.phase = "live"; n.liveAt = Date.now(); n.briefReady = false; break;
    case "propose": n.proposed = String(m.title || ""); break;
    case "client": n.client = String(m.title || ""); break;
    case "quiet": n.quiet = !!m.on; break;
    case "note": n.notes = m.count | 0; break;
    case "health": if (m.level === "red" || m.level === "amber") n.health[m.id] = { level: m.level, text: String(m.text || "") }; break;
    case "health.clear": delete n.health[m.id]; break;
    case "stopping": n.phase = "stopping"; break;
    case "ended": n.endedCleanly = true; n.phase = "stopping"; break;
    case "stderr": { const t = String(m.text || "").trim(); if (t) n.lastError = t.split("\n").pop(); break; }
    case "exit": n.phase = "idle"; n.health = {}; n.proposed = ""; n.client = ""; n.quiet = false; break;
    case "brief": n.briefReady = true; break;
    case "doctor.start": n.doctorRunning = true; break;
    case "doctor.end": n.doctorRunning = false; break;
  }
  return n;
}

/** Notifications to show for a state change. */
function notifications(before, after, m) {
  const out = [];
  if (m.ev === "waiting") out.push({ title: "Wingman is ready", body: "Say the consent line, then click ✅ Consent given in the menu bar. Nothing is sent before that." });
  if (m.ev === "propose" && !before.proposed) out.push({ title: "Client spotted", body: `Looks like ${after.proposed}. Confirm it from the menu bar.` });
  if (m.ev === "health" && m.level === "red" && !(before.health[m.id])) out.push({ title: "Wingman problem", body: String(m.text || "") });
  return out;
}

const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/** What the menu bar shows. */
function view(s, now) {
  const red = Object.values(s.health).some((h) => h.level === "red");
  const amber = Object.values(s.health).some((h) => h.level === "amber");
  const mark = red ? "🔴" : amber ? "🟠" : "";
  let title = "", status = "Wingman · no call";
  if (s.phase === "starting") { title = " …"; status = "Starting…"; }
  if (s.phase === "waiting") { title = " consent?"; status = "Waiting for consent: nothing is sent yet"; }
  if (s.phase === "live") { title = ` ${mark}● ${mmss(now - s.liveAt)}${s.quiet ? " quiet" : ""}`; status = `Listening · ${mmss(now - s.liveAt)}${s.client ? ` · ${s.client}` : ""}${s.notes ? ` · ${s.notes} notes` : ""}`; }
  if (s.phase === "stopping") { title = " saving…"; status = "Stopping and saving the call…"; }
  const healthLines = Object.values(s.health).map((h) => `${h.level === "red" ? "🔴" : "🟠"} ${h.text}`.slice(0, 90));
  return { title, statusLine: status, healthLines, tooltip: status };
}

/** Plain one-line text: no control characters, trimmed, capped. */
function cleanText(t, max) {
  if (typeof t !== "string") return "";
  return t.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
const list = (t) => cleanText(t, 600).split(/[;,\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 12);

/** Briefing form -> brief object (same shape as `pnpm brief`). */
function briefFrom(d) {
  if (!d || typeof d !== "object") return undefined;
  const b = { who: cleanText(d.who, 120) || undefined, goal: cleanText(d.goal, 200) || undefined, notes: list(d.notes), mustCover: list(d.mustCover), createdAt: new Date().toISOString() };
  return b.who || b.goal || b.notes.length || b.mustCover.length ? b : undefined;
}
function writeBrief(dir, b) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const y = (v) => JSON.stringify(v);   // JSON strings are valid YAML scalars
  const lines = [];
  if (b.who) lines.push(`who: ${y(b.who)}`);
  if (b.goal) lines.push(`goal: ${y(b.goal)}`);
  lines.push(`notes: ${y(b.notes)}`, `mustCover: ${y(b.mustCover)}`, `createdAt: ${y(b.createdAt)}`);
  fs.writeFileSync(path.join(dir, "latest.yaml"), lines.join("\n") + "\n", { mode: 0o600 });
}
function briefReady(file, maxAgeMs = 6 * 3600_000) {
  try { return Date.now() - fs.statSync(file).mtimeMs < maxAgeMs; } catch { return false; }
}

function doctorVerdict(out) {
  const ok = /\bREADY\b/.test(out) && !/NOT READY/.test(out);
  return { ok };
}
const tail = (s, n) => (s.length > n ? "…" + s.slice(-n) : s).replace(/\u001b\[[0-9;]*m/g, "");

module.exports = { PREFIX, initialState, parseStatus, reduce, notifications, view, cleanText, briefFrom, writeBrief, briefReady, doctorVerdict, tail, mmss };
