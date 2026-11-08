"use strict";
// A small iCalendar (.ics) reader for the Meeting context box. No dependency, no network, pure functions.
// It reads what a person needs before a call: title, start, end, all-day, attendees, organizer, place, description.
// Repeat rules (RRULE) are NOT expanded: the first DTSTART of the event is the time, and `recurring` says a rule was there.
// The typed entry point is src/brief-ics.ts. This file is CommonJS because the tray (Electron main) cannot load TypeScript.
// Calendar text is untrusted: everything is returned as plain strings with control and bidi-override characters removed.

const MAX_EVENTS = 200;
const MAX_ATTENDEES = 200;

/** Windows time zone names that Intl does not know, mapped to IANA names (the few that matter most). */
const WIN_TZ = {
  "Israel Standard Time": "Asia/Jerusalem",
  UTC: "UTC",
  "GMT Standard Time": "Europe/London",
  "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "Pacific Standard Time": "America/Los_Angeles",
};

const stripCtl = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, "");
const oneLine = (s, max) => stripCtl(s).replace(/\s+/g, " ").trim().slice(0, max);

/** iCalendar TEXT value: \n \N newline, \, \; \\ . */
function unescapeText(v) {
  return String(v).replace(/\\([nN,;\\])/g, (m, c) => (c === "n" || c === "N" ? "\n" : c));
}

/** Lines of the file with folded continuation lines joined. */
function unfold(text) {
  return String(text)
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");
}

/** "NAME;P=1;Q=\"a:b\":value" -> { name, params, value }. Null when the line has no colon outside quotes. */
function parseLine(line) {
  let q = false,
    colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ":" && !q) {
      colon = i;
      break;
    }
  }
  if (colon < 1) return null;
  const head = line.slice(0, colon),
    value = line.slice(colon + 1);
  const parts = [];
  let cur = "";
  q = false;
  for (const c of head) {
    if (c === '"') q = !q;
    if (c === ";" && !q) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  const name = parts.shift().toUpperCase();
  const params = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 1) continue;
    params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

/** Milliseconds for a wall-clock time in an IANA zone, or NaN when the zone is unknown. */
function zonedToMs(y, mo, d, h, mi, s, tz) {
  const zone = WIN_TZ[tz] || tz;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    const wall = Date.UTC(y, mo - 1, d, h, mi, s);
    const offsetAt = (t) => {
      const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
      return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t;
    };
    let t = wall - offsetAt(wall);
    t = wall - offsetAt(t); // second pass settles the offset around a clock change
    return t;
  } catch {
    return NaN;
  }
}

/** { ms, allDay } for a DTSTART or DTEND line; ms 0 when it cannot be read. */
function parseDate(p) {
  const v = String(p.value).trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) {
    const [y, mo, d] = m.slice(1).map(Number);
    return { ms: new Date(y, mo - 1, d).getTime(), allDay: true };
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z?)$/.exec(v);
  if (!m) return { ms: 0, allDay: false };
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number);
  const s = Number(m[6] || 0);
  if (m[7]) return { ms: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false };
  const tz = p.params.TZID;
  if (tz) {
    const z = zonedToMs(y, mo, d, h, mi, s, tz);
    if (Number.isFinite(z)) return { ms: z, allDay: false };
  }
  return { ms: new Date(y, mo - 1, d, h, mi, s).getTime(), allDay: false }; // floating time, or an unknown zone: local time
}

/** A person from an ORGANIZER or ATTENDEE line: { name, email, role, status }. The name is the CN, else the part of the mail address before "@". */
function person(p) {
  const email = oneLine(String(p.value).replace(/^mailto:/i, ""), 120);
  const cn = oneLine(p.params.CN || "", 80);
  const name = cn || oneLine(email.split("@")[0].replace(/[._]+/g, " "), 80);
  return { name, email, role: oneLine(p.params.ROLE || "", 20).toUpperCase(), status: oneLine(p.params.PARTSTAT || "", 20).toUpperCase() };
}

/** Plain description: links become [link] (join links can carry passwords), HTML tags out, blank runs squeezed. */
function cleanDescription(t) {
  return stripCtl(unescapeText(t))
    .replace(/<[^>]{1,200}>/g, " ")
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 8000);
}

/**
 * Reads a calendar text. Returns { events } with at most 200 events. Never throws.
 * event: { title, startMs, endMs, allDay, attendees[], organizer|null, location, description, recurring, cancelled }.
 */
function parseIcs(text) {
  /** @type {any[]} */
  const events = [];
  /** @type {any} */
  let cur = null;
  let depth = 0; // nested components (VALARM) inside a VEVENT are skipped
  for (const raw of unfold(text)) {
    const p = parseLine(raw);
    if (!p) continue;
    if (p.name === "BEGIN") {
      const what = p.value.trim().toUpperCase();
      if (what === "VEVENT" && !cur)
        cur = {
          title: "",
          startMs: 0,
          endMs: 0,
          allDay: false,
          attendees: [],
          organizer: null,
          location: "",
          description: "",
          recurring: false,
          cancelled: false,
        };
      else if (cur) depth++;
      continue;
    }
    if (p.name === "END") {
      const what = p.value.trim().toUpperCase();
      if (cur && depth > 0) depth--;
      else if (cur && what === "VEVENT") {
        events.push(cur);
        cur = null;
        if (events.length >= MAX_EVENTS) break;
      }
      continue;
    }
    if (!cur || depth > 0) continue;
    switch (p.name) {
      case "SUMMARY":
        cur.title = oneLine(unescapeText(p.value), 120);
        break;
      case "DTSTART": {
        const d = parseDate(p);
        cur.startMs = d.ms;
        cur.allDay = d.allDay;
        break;
      }
      case "DTEND":
        cur.endMs = parseDate(p).ms;
        break;
      case "LOCATION":
        cur.location = oneLine(unescapeText(p.value), 160);
        break;
      case "DESCRIPTION":
        cur.description = cleanDescription(p.value);
        break;
      case "ORGANIZER":
        cur.organizer = person(p);
        break;
      case "ATTENDEE":
        if (cur.attendees.length < MAX_ATTENDEES) cur.attendees.push(person(p));
        break;
      case "RRULE":
      case "RDATE":
        cur.recurring = true;
        break;
      case "STATUS":
        cur.cancelled = /^CANCELLED$/i.test(p.value.trim());
        break;
      default:
    }
  }
  return { events };
}

/** The event to use from a calendar with several: the soonest one that is not over, else the first one. Cancelled events come last. */
function pickEvent(events, now) {
  const live = events.filter((e) => !e.cancelled);
  const pool = live.length ? live : events;
  const upcoming = pool.filter((e) => (e.endMs || e.startMs) >= now).sort((a, b) => a.startMs - b.startMs);
  return upcoming[0] || pool[0] || null;
}

const p2 = (n) => String(n).padStart(2, "0");
const day = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};

/**
 * Plan fields and background text from one event.
 * fields: { title, at (epoch ms, 0 for an all-day event), who }. text: a short readable block that is stored as background.
 * `who` is a list of names (the organizer first), at most 6, then "+N". Mail addresses never leave the file.
 */
function eventToPlan(ev) {
  /** @type {string[]} */
  const names = [];
  const add = (x) => x && x.name && !names.includes(x.name) && names.push(x.name);
  add(ev.organizer);
  for (const a of ev.attendees) if (a.status !== "DECLINED") add(a);
  const who = names.slice(0, 6).join(", ") + (names.length > 6 ? ` +${names.length - 6}` : "");
  /** @type {string[]} */
  const lines = [];
  if (ev.title) lines.push(`Meeting: ${ev.title}`);
  if (ev.startMs) {
    const when = ev.allDay
      ? `${day(ev.startMs)} (all day)`
      : `${day(ev.startMs)} ${p2(new Date(ev.startMs).getHours())}:${p2(new Date(ev.startMs).getMinutes())}`;
    lines.push(`When: ${when}${ev.endMs && !ev.allDay ? ` to ${p2(new Date(ev.endMs).getHours())}:${p2(new Date(ev.endMs).getMinutes())}` : ""}`);
  }
  if (ev.recurring) lines.push("This is a repeating meeting. Only the first date is shown.");
  if (ev.location) lines.push(`Where: ${ev.location}`);
  if (ev.organizer && ev.organizer.name) lines.push(`Organizer: ${ev.organizer.name}`);
  if (names.length) lines.push(`Invited: ${names.join(", ")}`);
  if (ev.description) lines.push("", ev.description);
  return { fields: { title: ev.title, at: ev.allDay ? 0 : ev.startMs, who }, text: lines.join("\n").trim() };
}

module.exports = { parseIcs, pickEvent, eventToPlan, unescapeText, unfold, parseLine };
