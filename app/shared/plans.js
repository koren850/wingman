"use strict";
// Prepared meetings: the pure rules (housekeeping, order, "next", "due now", time parsing, labels) shared by the store (tray/plans.cjs),
// the menu bar, the CLI and the window. No file or DOM access here: everything takes plain meeting objects and a clock.
// Classic script in the window, require() in the tray, the CLI and the tests.
//
// A meeting (a "plan" in the window) is { id, title, who, goal, kind, topic, notes[], mustCover[], at (epoch ms, 0 = no time), createdAt, updatedAt,
//   liveAt (0 = no call went live with it), usedAt (0 = no call saved its first memory with it), uses (how many calls), callId (the last call) }.
// A plan does NOT expire and is NOT used up: a call reads it, it stays, and it can start the next call too. Only housekeeping removes a plan nobody touched for 180 days.
(function (root) {
  const HOUR = 3600_000,
    DAY = 24 * HOUR;
  /** The few time rules in one place. See docs/DECISIONS.md (ADR "Quick call and prepared meetings", and the round 12 note on plans that do not expire). */
  const RULES = {
    housekeepingMs: 180 * DAY, // a plan nobody opened, edited or used for this long is cleaned up (this is housekeeping, not an expiry)
    dueWindowMs: 30 * 60_000, // plain `wingman start` picks the one meeting scheduled within +/- this
    maxAheadMs: 90 * DAY, // a time further away than this is refused (probably a typo)
    maxMeetings: 50,
  };

  /** The last time anything happened to a plan (epoch ms). */
  const touched = (m) => Math.max(m.updatedAt || 0, m.createdAt || 0, m.usedAt || 0, m.liveAt || 0);
  /** When housekeeping may remove the plan (epoch ms). */
  function expiresAt(m) {
    return touched(m) + RULES.housekeepingMs;
  }
  /** "ready" (can start a call, again and again) or "expired" (housekeeping: untouched for 180 days). */
  function statusOf(m, now) {
    return now >= expiresAt(m) ? "expired" : "ready";
  }
  /** Name for lists and menus: title, else who, else goal, else topic, else the first words of the pasted context. */
  function label(m) {
    return m.title || m.who || m.goal || m.topic || m.preview || "Untitled plan";
  }

  /** Soonest first: timed meetings by time, then untimed ones, most recently edited first. Returns a new array. */
  function order(list) {
    return [...list].sort((a, b) => {
      if (!!a.at !== !!b.at) return a.at ? -1 : 1;
      if (a.at) return a.at - b.at || (a.id < b.id ? -1 : 1);
      return (b.updatedAt || 0) - (a.updatedAt || 0) || (a.id < b.id ? -1 : 1);
    });
  }
  /** Meetings that can start a call, in order(). */
  const ready = (list, now) => order(list.filter((m) => statusOf(m, now) === "ready"));
  /** A call already ran for this time slot (it saved its first memory around the planned time). The plan is still reusable, but it is not "next" any more. */
  const doneForSlot = (m) => !!(m.usedAt && m.at && m.usedAt >= m.at - RULES.dueWindowMs);
  /** The soonest timed meeting that is not already more than the due window in the past and was not already held, or null. This is the "Next: ..." one. */
  function nextMeeting(list, now) {
    return ready(list, now).find((m) => m.at && m.at >= now - RULES.dueWindowMs && !doneForSlot(m)) || null;
  }
  /** Meetings scheduled within +/- dueWindowMs of now (what plain `wingman start` may pick). */
  function dueNow(list, now) {
    return ready(list, now).filter((m) => m.at && Math.abs(m.at - now) <= RULES.dueWindowMs && !doneForSlot(m));
  }
  /** The meeting a practice call uses when none is named: the next one, else the only ready one, else null (a quick practice). */
  function practiceDefault(list, now) {
    const n = nextMeeting(list, now);
    if (n) return n;
    const r = ready(list, now);
    return r.length === 1 ? r[0] : null;
  }

  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p2 = (n) => String(n).padStart(2, "0");
  /** "14:30" (local time). */
  const clock = (ms) => {
    const d = new Date(ms);
    return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  };
  /** "Today 14:30", "Tomorrow 09:00", "Yesterday 16:00", else "Thu 5 Nov 14:30" (local time). "" when there is no time. */
  function formatAt(ms, now) {
    if (!ms) return "";
    const d = new Date(ms),
      n = new Date(now);
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(d) - day(n)) / DAY);
    const t = clock(ms);
    if (diff === 0) return `Today ${t}`;
    if (diff === 1) return `Tomorrow ${t}`;
    if (diff === -1) return `Yesterday ${t}`;
    return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${t}`;
  }
  /** "2026-11-03T14:30" (local time) for an <input type="datetime-local">; "" for no time. */
  function toInputValue(ms) {
    if (!ms) return "";
    const d = new Date(ms);
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
  }

  /**
   * Parses a meeting time typed by a person or an agent. Accepts "2026-11-03 14:30" or "2026-11-03T14:30" (local time),
   * an ISO time with Z or an offset, and "14:30" (today, local). "" / "none" / "-" mean no time (returns 0).
   * Throws an Error with a plain message when it is not a time, is not a real date, or is too far ahead. A time in the past is fine (the plan can be reused).
   */
  function parseAt(text, now) {
    const t = String(text == null ? "" : text).trim();
    if (!t || /^(none|no|-)$/i.test(t)) return 0;
    let ms = NaN,
      m;
    if ((m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(t))) {
      const [y, mo, d, h, mi] = m.slice(1).map(Number);
      const dt = new Date(y, mo - 1, d, h, mi);
      if (dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d && h < 24 && mi < 60) ms = dt.getTime();
    } else if ((m = /^(\d{1,2}):(\d{2})$/.exec(t))) {
      const n = new Date(now),
        h = Number(m[1]),
        mi = Number(m[2]);
      if (h < 24 && mi < 60) ms = new Date(n.getFullYear(), n.getMonth(), n.getDate(), h, mi).getTime();
    } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(t)) {
      ms = Date.parse(t);
    }
    if (!Number.isFinite(ms)) throw new Error(`"${t.slice(0, 40)}" is not a time. Use "2026-11-03 14:30" (your local time), or "14:30" for today, or "none".`);
    if (ms - now > RULES.maxAheadMs) throw new Error("That time is more than 90 days away. Check the date.");
    return ms;
  }

  /** Compact text for one meeting in menus and lists: "Dana · Acme  (Today 14:30)". */
  function menuLabel(m, now, max = 64) {
    const t = m.at ? ` (${formatAt(m.at, now)})` : "";
    const base = label(m).replace(/\s+/g, " ");
    const room = Math.max(12, max - t.length);
    return (base.length > room ? base.slice(0, room - 1) + "…" : base) + t;
  }
  /** Changes whenever a list of meetings changes in a way the menu or the window shows. Used to know when to redraw. */
  function signature(list) {
    return list
      .map((m) => [m.id, m.title, m.who, m.goal, m.at, m.updatedAt, m.usedAt, m.liveAt, m.uses, (m.mustCover || []).length, m.files || 0].join("\u0001"))
      .join("\u0002");
  }

  const api = {
    RULES,
    expiresAt,
    touched,
    doneForSlot,
    statusOf,
    label,
    order,
    ready,
    nextMeeting,
    dueNow,
    practiceDefault,
    clock,
    formatAt,
    toInputValue,
    parseAt,
    menuLabel,
    signature,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WingmanPlans = api;
})(typeof window !== "undefined" ? window : globalThis);
