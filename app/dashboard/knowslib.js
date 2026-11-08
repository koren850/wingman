"use strict";
// "What Wingman knows": the data side of the panel (pure functions, no DOM). The page draws it in knows.js.
// Round 12 wave 1 feeds it from fixtures (and, before a call, from the saved meeting context). Wave 2 feeds it from the digest and the call memory.
// The shape is a small view of the session memory (see PLAN section 3.1): every line has an id, a text, and may be edited or removed by the user.
//
//   model = { mode: "before" | "live", source: "fixture" | "saved" | "digest" | "memory", ver, topic, sections: { <name>: [{ id, text, who?, done? }] } }
//   before the call: roster (people), agenda, facts, mustCover        live on Home: soFar, decisions, open, promises, mustCover (left to cover)
//
// toModelText() renders the lines in the order the model reads them, so "Show what the model sees" is the same text and not a guess.
(function (root) {
  const SECTIONS = {
    before: ["roster", "agenda", "facts", "mustCover"],
    live: ["soFar", "decisions", "open", "promises", "mustCover"],
  };
  const MAX_TEXT = 200;
  const clean = (t) =>
    String(t == null ? "" : t)
      .replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_TEXT);

  const item = (id, text, extra) => ({ id, text, ...(extra || {}) });
  /** Invented sample models for previews, snapshots and tests. lang "he" gives Hebrew lines (card text is not translated by the app, so a Hebrew call has Hebrew lines). */
  function fixture(mode, lang) {
    const he = lang === "he";
    if (mode === "live")
      return {
        mode: "live",
        source: "fixture",
        ver: 7,
        topic: he ? "מחיר החידוש ומועד ההעברה" : "Renewal price and the move date",
        sections: {
          soFar: he
            ? [
                item("s1", "הלקוחה רוצה להעביר את האתר עד סוף החודש."),
                item("s2", "המחיר הנוכחי עולה ב-4% בכל שנה."),
                item("s3", "היא מעדיפה לקבל הצעה בוואטסאפ."),
              ]
            : [
                item("s1", "Dana wants the site moved before the end of the month."),
                item("s2", "The current price rises 4% each year."),
                item("s3", "She prefers to get the offer on WhatsApp."),
              ],
          decisions: he ? [item("d1", "ההעברה תהיה ביום חמישי בבוקר.")] : [item("d1", "The move will be on Thursday morning.")],
          open: he
            ? [item("q1", "האם הגיבוי היומי כלול במחיר?"), item("q2", "מי מטפל בתעודת האבטחה?")]
            : [item("q1", "Is the daily backup included in the price?"), item("q2", "Who handles the security certificate?")],
          promises: he
            ? [item("c1", "אני שולח הצעה מעודכנת עד מחר.", { who: "אני" })]
            : [item("c1", "I will send an updated offer by tomorrow.", { who: "me" }), item("c2", "Dana checks the domain login.", { who: "Dana" })],
          mustCover: he ? [item("m1", "מועד השבתה", { done: false })] : [item("m1", "Downtime window", { done: false })],
        },
      };
    return {
      mode: "before",
      source: "fixture",
      ver: 1,
      topic: he ? "העברת אחסון" : "Hosting move",
      sections: {
        roster: he
          ? [item("p1", "דנה לוי", { role: "לקוחה, בעלת סטודיו" }), item("p2", "נועם בר", { role: "טכני" })]
          : [item("p1", "Dana Levi", { role: "client, studio owner" }), item("p2", "Noam Bar", { role: "technical" })],
        agenda: he
          ? [item("a1", "מצב האתר היום"), item("a2", "מחיר ותנאים"), item("a3", "תאריך ההעברה")]
          : [item("a1", "Where the site is today"), item("a2", "Price and terms"), item("a3", "Move date")],
        facts: he
          ? [item("f1", "12 אתרי וורדפרס על שרת אחד.", { src: "brief" }), item("f2", "החוזה הנוכחי מתחדש במרץ.", { src: "brief" })]
          : [item("f1", "12 WordPress sites on one server.", { src: "brief" }), item("f2", "The current contract renews in March.", { src: "brief" })],
        mustCover: he
          ? [item("m1", "מחיר", { done: false }), item("m2", "מועד השבתה", { done: false })]
          : [item("m1", "Price", { done: false }), item("m2", "Downtime window", { done: false })],
      },
    };
  }

  /**
   * A "before the call" model from the saved meeting alone (no digest yet): the people from "who joins", the must-cover lines, nothing invented.
   * plan: { who, goal, mustCover (text, one per line), title }. rawChars: how much pasted text is kept as plain background.
   */
  function fromSaved(plan) {
    const p = plan || {};
    const lines = (v) =>
      String(v || "")
        .split(/[\n;]/)
        .map(clean)
        .filter(Boolean);
    const people = String(p.who || "")
      .split(/[,\n;]/)
      .map(clean)
      .filter(Boolean);
    return {
      mode: "before",
      source: "saved",
      ver: 0,
      topic: clean(p.goal || p.title || ""),
      sections: {
        roster: people.map((n, i) => item("p" + (i + 1), n)),
        agenda: [],
        facts: [],
        mustCover: lines(p.mustCover).map((t, i) => item("m" + (i + 1), t, { done: false })),
      },
    };
  }

  /**
   * The live model from a full call memory (calls/<id>/session.json). Lines keep the memory ids (f3, q2, c1), so an edit or a remove can name the line.
   * soFar = what was said on the call (facts that did not come from the brief), oldest first; the card shows the newest four.
   */
  function fromMemory(mem) {
    const m = mem && typeof mem === "object" ? mem : {};
    const arr = (v) => (Array.isArray(v) ? v : []);
    const line = (id, text, extra) => item(String(id), clean(text), extra);
    return {
      mode: "live",
      source: "memory",
      ver: Number(m.ver) || 0,
      topic: clean(m.topic && m.topic.now),
      sections: {
        soFar: arr(m.facts)
          .filter((f) => f && f.src !== "brief")
          .map((f) => line(f.id, f.text, f.who ? { who: clean(f.who) } : undefined)),
        decisions: arr(m.decisions).map((d) => line(d.id, d.text)),
        open: arr(m.openQuestions)
          .filter((q) => q && q.status === "open")
          .map((q) => line(q.id, q.text, q.asker ? { who: clean(q.asker) } : undefined)),
        promises: arr(m.commitments)
          .filter((c) => c && c.status === "open")
          .map((c) => line(c.id, c.what, c.who ? { who: clean(c.who) } : undefined)),
        mustCover: arr(m.mustCover).map((x) => line(x.id, x.text, { done: !!x.done })),
      },
    };
  }

  /** The "before the call" model from a digest ({ roster, agenda, facts, ... }, see src/session/seed.ts). Ids are the ones the memory will get (p1, f1, m1), so they stay stable. */
  function fromDigest(d) {
    const g = d && typeof d === "object" ? d : {};
    const arr = (v) => (Array.isArray(v) ? v : []);
    const text = (x) => clean(typeof x === "string" ? x : x && x.text);
    return {
      mode: "before",
      source: "digest",
      ver: 1,
      topic: clean(arr(g.agenda)[0] && text(g.agenda[0])),
      sections: {
        roster: arr(g.roster)
          .filter((p) => p && clean(p.name))
          .map((p, i) => item("p" + (i + 1), clean(p.name), p.role ? { role: clean(p.role) } : undefined)),
        agenda: arr(g.agenda)
          .map(text)
          .filter(Boolean)
          .map((t, i) => item("m" + (i + 1), t)),
        facts: arr(g.facts)
          .map(text)
          .filter(Boolean)
          .map((t, i) => item("f" + (i + 1), t, { src: "brief" })),
        mustCover: [],
      },
    };
  }

  /** Which memory list a window section writes to when the user adds a line (the same table as shared/memedit.cjs SECTION_LIST). */
  const SECTION_LIST = {
    soFar: "facts",
    decisions: "decisions",
    open: "openQuestions",
    promises: "commitments",
    mustCover: "mustCover",
    facts: "facts",
    agenda: "mustCover",
  };
  /** The edit message for the main process: from what the user did. ops: { op: "edit", id, text } | { op: "remove", id } | { op: "add", sec, text }. Null when the section cannot take a new line. */
  function toEdit(o) {
    if (!o) return null;
    if (o.op === "add") return SECTION_LIST[o.sec] ? { op: "add", list: SECTION_LIST[o.sec], text: o.text } : null;
    if (o.op === "edit") return { op: "edit", id: o.id, text: o.text };
    if (o.op === "remove") return { op: "remove", id: o.id };
    return null;
  }

  const order = (model) => SECTIONS[model && model.mode === "live" ? "live" : "before"];
  /** Total lines in the model. */
  const count = (model) => order(model).reduce((a, k) => a + ((model.sections && model.sections[k]) || []).length, 0);

  /** A copy of the model without one line. Unknown section or id: the model is returned unchanged. */
  function removeItem(model, sec, id) {
    const list = model && model.sections && model.sections[sec];
    if (!Array.isArray(list) || !list.some((x) => x.id === id)) return model;
    return { ...model, sections: { ...model.sections, [sec]: list.filter((x) => x.id !== id) } };
  }
  /** A copy with one line's text changed. Empty text, unknown section or id: { ok:false, model } and the model is unchanged. */
  function editItem(model, sec, id, text) {
    const list = model && model.sections && model.sections[sec];
    const t = clean(text);
    if (!t || !Array.isArray(list) || !list.some((x) => x.id === id)) return { ok: false, model };
    return { ok: true, model: { ...model, sections: { ...model.sections, [sec]: list.map((x) => (x.id === id ? { ...x, text: t } : x)) } } };
  }
  /** A copy with one new line. Empty text, unknown section or more than 30 lines in it: { ok:false, model }. */
  function addItem(model, sec, text) {
    const t = clean(text);
    const list = model && model.sections && model.sections[sec];
    if (!t || !Array.isArray(list) || list.length >= 30) return { ok: false, model };
    const used = new Set(list.map((x) => x.id));
    let n = list.length + 1;
    while (used.has("u" + n)) n++;
    return { ok: true, model: { ...model, sections: { ...model.sections, [sec]: [...list, item("u" + n, t, { src: "user" })] } } };
  }

  const HEAD = {
    roster: "People",
    agenda: "Agenda",
    facts: "Facts",
    mustCover: "Must cover",
    soFar: "So far",
    decisions: "Decided",
    open: "Open questions",
    promises: "Promises",
  };
  /** The text the model reads for this model: fixed order, one line per item, untrusted text kept as plain text. Same input, same output. */
  function toModelText(model) {
    if (!model) return "";
    const out = [`Call memory (${model.mode === "live" ? "live" : "before the call"})`];
    if (model.topic) out.push(`Topic: ${model.topic}`);
    for (const k of order(model)) {
      const list = (model.sections && model.sections[k]) || [];
      if (!list.length) continue;
      out.push("", `${HEAD[k]}:`);
      for (const x of list) {
        const who = x.who ? `${x.who}: ` : "";
        const role = k === "roster" && x.role ? ` (${x.role})` : "";
        const box = k === "mustCover" ? (x.done ? "[x] " : "[ ] ") : "- ";
        out.push(`${box}${who}${x.text}${role}`);
      }
    }
    return out.join("\n");
  }

  const api = {
    SECTIONS,
    MAX_TEXT,
    SECTION_LIST,
    clean,
    fixture,
    fromSaved,
    fromMemory,
    fromDigest,
    toEdit,
    count,
    removeItem,
    editItem,
    addItem,
    toModelText,
    order,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WingmanKnows = api;
})(typeof window !== "undefined" ? window : globalThis);
