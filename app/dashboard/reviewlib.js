"use strict";
// Call review: the data side (pure functions, no DOM), used by the call page in app.js and by dashboard/lib.cjs.
//   momentReport(events)  counts of moments that were skipped, dropped or shown as a small chip, with the reasons, from the moment.* rows of events.jsonl
//   cleanCoaching(raw)    the `coaching` object of summary.json (contract 3.5 of the plan), checked: plain numbers only, or null
//   coachingRows(c)       the lines the page shows for it
// Everything that comes from a file is treated as untrusted: only known fields, numbers clamped, reason words clipped.
(function (root) {
  /** Plain words for the reasons the engine logs. Unknown reasons are shown as they are, with dashes turned into spaces. */
  const REASONS = {
    "model-skip": "Nothing useful to say",
    skip: "Nothing useful to say",
    "stale-turn": "A newer question took over",
    "stale-answer": "The answer came too late",
    late: "The answer came too late",
    "agency-gated": "Left to you (a price, date or promise)",
    "stall-off": "Stall lines are off",
    "ans-off": "AI answers are off",
    "unknown-bank-id": "The prepared card was not found",
    offline: "The AI was not reachable",
    "aim-other": "Not meant for you",
    "not-novel": "Said already",
    "per-minute-cap": "Too many cards in a minute",
    "hero-holds": "A better card was already on screen",
    "leaked-tag": "The reply was not usable",
    language: "Wrong language",
    truncated: "The reply was cut off",
  };
  const clip = (s, n) =>
    String(s == null ? "" : s)
      .replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, " ")
      .trim()
      .slice(0, n);
  /** Words for one reason. A guard reason ("guard:price") is "Held back by a safety check (price)". */
  function reasonLabel(reason) {
    const r = clip(reason, 60);
    if (!r) return "No reason logged";
    if (REASONS[r]) return REASONS[r];
    const g = /^guard[:\s-]+(.+)$/.exec(r);
    if (g) return `Held back by a safety check (${g[1].replace(/[-_:]+/g, " ")})`;
    return r.replace(/[-_:]+/g, " ");
  }

  /**
   * Counts from the moment.* rows. skipped = moment.skip (the AI chose silence), dropped = moment.drop and moment.dropped (a moment was held back by a rule),
   * chipped = moment.chip (shown small instead of as a card). invalid = moment.invalid and moment.error (the model reply could not be used).
   * Each group has `reasons`: [{ reason, label, n }] most common first. total = skipped + dropped + chipped.
   */
  function momentReport(events) {
    const groups = { skipped: new Map(), dropped: new Map(), chipped: new Map() };
    let invalid = 0;
    for (const e of Array.isArray(events) ? events : []) {
      if (!e || typeof e.type !== "string") continue;
      const g =
        e.type === "moment.skip"
          ? "skipped"
          : e.type === "moment.drop" || e.type === "moment.dropped"
            ? "dropped"
            : e.type === "moment.chip"
              ? "chipped"
              : null;
      if (g) {
        const r = clip(e.why || e.reason, 60) || "";
        groups[g].set(r, (groups[g].get(r) || 0) + 1);
      } else if (e.type === "moment.invalid" || e.type === "moment.error") invalid++;
    }
    const out = { invalid };
    let total = 0;
    for (const k of Object.keys(groups)) {
      const reasons = [...groups[k].entries()]
        .map(([reason, n]) => ({ reason, label: reasonLabel(reason), n }))
        .sort((a, b) => b.n - a.n || (a.reason < b.reason ? -1 : 1));
      const n = reasons.reduce((a, x) => a + x.n, 0);
      total += n;
      out[k] = { n, reasons };
    }
    out.total = total;
    return out;
  }

  const num = (v, min, max) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : null);
  /** summary.json `coaching`: { talkSharePct, longestMonologueSec, questionsAsked, paceWpm: { me, them }, interruptions } or null. A missing number stays out of the result. */
  function cleanCoaching(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const o = {};
    const t = num(raw.talkSharePct, 0, 100);
    if (t != null) o.talkSharePct = Math.round(t);
    const m = num(raw.longestMonologueSec, 0, 86400);
    if (m != null) o.longestMonologueSec = Math.round(m);
    const q = num(raw.questionsAsked, 0, 10000);
    if (q != null) o.questionsAsked = Math.round(q);
    const p = raw.paceWpm && typeof raw.paceWpm === "object" ? raw.paceWpm : {};
    const me = num(p.me, 0, 1000),
      them = num(p.them, 0, 1000);
    if (me != null || them != null) o.paceWpm = { ...(me != null ? { me: Math.round(me) } : {}), ...(them != null ? { them: Math.round(them) } : {}) };
    const i = num(raw.interruptions, 0, 10000);
    if (i != null) o.interruptions = Math.round(i);
    return Object.keys(o).length ? o : null;
  }
  const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  /** The lines the page shows: [{ key, label, value, hint? }]. Gentle words, no scores. */
  function coachingRows(c) {
    if (!c) return [];
    const rows = [];
    if (c.talkSharePct != null) rows.push({ key: "talk", label: "You talked", value: c.talkSharePct + "% of the time" });
    if (c.longestMonologueSec != null) rows.push({ key: "mono", label: "Longest time you spoke without a break", value: mmss(c.longestMonologueSec) });
    if (c.questionsAsked != null) rows.push({ key: "q", label: "Questions you asked", value: String(c.questionsAsked) });
    if (c.paceWpm && (c.paceWpm.me != null || c.paceWpm.them != null))
      rows.push({
        key: "pace",
        label: "Pace (words a minute)",
        value: [c.paceWpm.me != null ? `you ${c.paceWpm.me}` : "", c.paceWpm.them != null ? `them ${c.paceWpm.them}` : ""].filter(Boolean).join(", "),
      });
    if (c.interruptions != null) rows.push({ key: "int", label: "Times you spoke over each other", value: String(c.interruptions) });
    return rows;
  }

  const api = { momentReport, reasonLabel, cleanCoaching, coachingRows, REASONS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WingmanReview = api;
})(typeof window !== "undefined" ? window : globalThis);
