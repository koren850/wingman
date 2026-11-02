// Pure helpers for the menu-bar app (unit-tested in src/tray.test.ts).
const fs = require("node:fs");
const path = require("node:path");

const PREFIX = "@@wingman ";

function initialState() {
  return { offReason: "", phase: "idle", startedAt: 0, liveAt: 0, quiet: false, proposed: "", client: "", notes: 0, health: {}, briefReady: false, doctorRunning: false, endedCleanly: false, lastError: "", callId: "", deleted: false, summaryOk: false, practice: false, overlayDown: "", doctor: null };
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
    case "starting": Object.assign(n, initialState(), { phase: "starting", startedAt: Date.now(), briefReady: s.briefReady, doctor: s.doctor, practice: !!m.practice }); break;
    case "waiting": n.phase = "waiting"; n.callId = m.id || ""; break;
    case "consented": n.phase = "live"; n.liveAt = Date.now(); n.briefReady = false; if (m.id) n.callId = String(m.id); break;   // file/practice calls never pass "waiting": the id comes here
    case "propose": n.proposed = String(m.title || ""); break;
    case "client": n.client = String(m.title || ""); break;
    case "quiet": n.quiet = !!m.on; break;
    case "note": n.notes = m.count | 0; break;
    case "health": if (m.level === "red" || m.level === "amber") n.health[m.id] = { level: m.level, text: String(m.text || "") }; break;
    case "health.clear": delete n.health[m.id]; break;
    case "stopping": n.phase = "stopping"; break;
    case "ended": n.endedCleanly = !m.crashed; n.phase = "stopping"; if (m.id) n.callId = String(m.id); if (m.deleted) n.deleted = true; break;
    case "stopdelete": n.deleted = true; break;
    case "summary": n.summaryOk = !!m.ok; break;
    case "overlay": n.overlayDown = m.restarting ? "" : (m.reason || "closed"); break;
    case "off": n.offReason = (m.reasons || []).join(", ") || "health"; break;
    case "stderr": { const t = String(m.text || "").trim(); if (t) n.lastError = t.split("\n").pop(); break; }
    case "exit": n.phase = "idle"; n.health = {}; n.overlayDown = ""; n.proposed = ""; n.client = ""; n.quiet = false; break;
    case "brief": n.briefReady = true; break;
    case "doctor.start": n.doctorRunning = true; break;
    case "doctor.end": n.doctorRunning = false; if (m.result) n.doctor = m.result; break;
  }
  return n;
}

/** Notifications to show for a state change. */
function notifications(before, after, m) {
  const out = [];
  if (m.ev === "waiting") out.push({ title: "Wingman is ready", body: "Say the consent line, then press Ctrl+Opt+Return (or ✅ Consent given in the menu bar). Nothing is sent before that." });
  if (m.ev === "propose" && !before.proposed) out.push({ title: "Client spotted", body: `Looks like ${after.proposed}. Confirm it in the Wingman window or the menu bar.` });
  if (m.ev === "overlay" && !m.restarting) out.push({ title: "Answer window is not showing", body: m.reason === "one-screen" ? "Only one screen: the window stays closed so it never shows in a screen share. Still listening; cards are saved." : "It closed. Still listening; cards are saved for the dashboard." });
  if (m.ev === "summary") out.push(m.ok ? { title: "Call summary ready", body: "Summary, next steps and a draft follow-up email: click here to open the Follow-up tab." } : { title: "No call summary", body: "It could not be written. Make one later: pnpm summary latest" });
  if (m.ev === "off") out.push({ title: "Wingman turned itself off", body: `Not listening any more: ${(m.reasons || []).join(", ") || "health"}` });
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
  if (s.phase === "live") { title = ` ${mark}${s.practice ? "◌ practice " : "● "}${mmss(now - s.liveAt)}${s.quiet ? " quiet" : ""}`; status = `${s.practice ? "Practice call (pretend caller) · " : ""}Listening${s.client ? ` · ${s.client}` : ""}${s.notes ? ` · ${s.notes} notes` : ""}`; }
  if (s.phase === "stopping") { title = " saving…"; status = "Saving the call and writing the summary…"; }
  const healthLines = [...(s.overlayDown ? [s.overlayDown === "one-screen" ? "🟠 No answer window (only one screen)" : "🟠 Answer window closed"] : []), ...Object.values(s.health).map((h) => `${h.level === "red" ? "🔴" : "🟠"} ${h.text}`.slice(0, 90))];
  return { title, statusLine: status, healthLines, tooltip: status };
}

/** Plain one-line text: no control characters, trimmed, capped. */
function cleanText(t, max) {
  if (typeof t !== "string") return "";
  return t.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
const list = (t) => (typeof t === "string" ? t : "").split(/[;\n]/).map((x) => cleanText(x, 200)).map((x) => x.trim()).filter(Boolean).slice(0, 12);

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

/** The saved briefing if it is still fresh (6 h from the file time): {who, goal, notes[], mustCover[], expiresInMs}. */
function readBrief(file, now = Date.now(), maxAgeMs = 6 * 3600_000) {
  try {
    const age = now - fs.statSync(file).mtimeMs;
    if (age >= maxAgeMs) return null;
    const o = require("yaml").parse(fs.readFileSync(file, "utf8")) || {};
    const strs = (a) => (Array.isArray(a) ? a : []).filter((x) => typeof x === "string").map((x) => cleanText(x, 200)).filter(Boolean).slice(0, 12);
    return { who: cleanText(o.who, 120), goal: cleanText(o.goal, 200), notes: strs(o.notes), mustCover: strs(o.mustCover), expiresInMs: Math.max(0, maxAgeMs - age) };
  } catch { return null; }
}
function clearBrief(dir) { try { fs.rmSync(path.join(dir, "latest.yaml"), { force: true }); } catch { /* nothing to clear */ } }

function doctorVerdict(out) {
  const ok = /\bREADY\b/.test(out) && !/NOT READY/.test(out);
  return { ok };
}
/** doctor output -> what Dan sees: verdict plus failing checks and warnings with their fix line. */
function doctorSummary(out) {
  const text = String(out).replace(/\u001b\[[0-9;]*m/g, "");
  const failing = [], warnings = [], lines = text.split("\n");
  let verdict = "";
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], m = /^\s+(❌|⚠️|⚠)\s+(.*)$/.exec(l);
    if (m) {
      const f = /^\s+fix:\s*(.*)$/.exec(lines[i + 1] || "");
      const item = { text: cleanText(m[2], 220), fix: f ? cleanText(f[1], 200) : "" };
      (m[1] === "❌" ? failing : warnings).push(item);
    }
    const v = /^(NOT READY|READY WITH WARNINGS|READY)\b/.exec(l.trim());
    if (v) verdict = v[1];
  }
  const ran = !!verdict;
  return { ran, ok: ran && verdict !== "NOT READY", verdict: verdict || "NO RESULT", failing: failing.slice(0, 8), warnings: warnings.slice(0, 8), at: Date.now() };
}
const tail = (s, n) => (s.length > n ? "…" + s.slice(-n) : s).replace(/\u001b\[[0-9;]*m/g, "");

/** Menu items depend only on these fields: rebuild the menu when they change, not every second. */
function menuKey(s, running) { return JSON.stringify([running, s.overlayDown, s.phase, s.proposed, s.client, s.quiet, s.briefReady, s.doctorRunning, Object.keys(s.health).sort(), Object.values(s.health).map((h) => h.text)]); }

/** 16 kHz stereo 16-bit silence: the clock for a practice call in file mode. */
function writeSilentWav(file, seconds) {
  const data = 16000 * 2 * 2 * seconds;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(16000 * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data, 40);
  fs.writeFileSync(file, Buffer.concat([h, Buffer.alloc(data)]));
}

module.exports = { writeSilentWav, menuKey, PREFIX, initialState, parseStatus, reduce, notifications, view, cleanText, briefFrom, writeBrief, briefReady, readBrief, clearBrief, doctorVerdict, doctorSummary, tail, mmss };
