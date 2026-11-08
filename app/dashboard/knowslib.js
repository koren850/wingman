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
    before: ["roster", "past", "agenda", "facts", "mustCover"],
    live: ["soFar", "past", "decisions", "open", "promises", "mustCover"],
  };
  const MAX_TEXT = 200;
  /** The call kinds the engine knows (src/session/memory.ts MemoryKind). Anything else shows as nothing, never as a guess. */
  const KINDS = ["client", "support", "vendor", "team", "consult", "personal", "interview", "other"];
  /** A built-in kind, or the id of a custom mode (letters, digits, dash, underscore; the call mode picker lists those). */
  const kindOk = (k) => typeof k === "string" && (KINDS.includes(k) || /^[A-Za-z0-9_-]{1,20}$/.test(k));
  /** The kind of a model, or "" when it has none or an unknown one. Read only: the person cannot change it here yet. */
  const kindOf = (model) => (model && kindOk(model.kind) ? model.kind : "");
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
        kind: "client",
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
          past: he
            ? [item("f9", "בפעם הקודמת, הבטחה פתוחה שלך: לשלוח את ההצעה.", { src: "past" })]
            : [item("f9", "Last time, you promised: send the offer.", { src: "past" })],
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
      kind: "client",
      ver: 1,
      topic: he ? "העברת אחסון" : "Hosting move",
      sections: {
        roster: he
          ? [item("p1", "דנה לוי", { role: "לקוחה, בעלת סטודיו" }), item("p2", "נועם בר", { role: "טכני" })]
          : [item("p1", "Dana Levi", { role: "client, studio owner" }), item("p2", "Noam Bar", { role: "technical" })],
        past: he ? [item("f9", "בפעם הקודמת עם דנה: העברת אחסון.", { src: "past" })] : [item("f9", "Last time with Dana: the hosting move.", { src: "past" })],
        agenda: he
          ? [item("a1", "מצב האתר היום"), item("a2", "מחיר ותנאים"), item("a3", "תאריך ההעברה")]
          : [item("a1", "Where the site is today"), item("a2", "Price and terms"), item("a3", "Move date")],
        facts: he
          ? [
              item("f1", "12 אתרי וורדפרס על שרת אחד.", { src: "brief", source: "כרגע יש לנו 12 אתרי וורדפרס על שרת אחד" }),
              item("f2", "החוזה הנוכחי מתחדש במרץ.", { src: "brief", source: "החוזה מתחדש במרץ" }),
            ]
          : [
              item("f1", "12 WordPress sites on one server.", { src: "brief", source: "We run 12 WordPress sites on one server" }),
              item("f2", "The current contract renews in March.", { src: "brief", source: "The contract renews in March" }),
            ],
        mustCover: he
          ? [item("m1", "מחיר", { done: false }), item("m2", "מועד השבתה", { done: false })]
          : [item("m1", "Price", { done: false }), item("m2", "Downtime window", { done: false })],
      },
    };
  }

  /** The small "before" fixture plus two facts that disagree (a price and a yes/no), for the warning in the review step: snapshots and tests. */
  function fixtureConflict(lang) {
    /** @type {any} */
    const m = fixture("before", lang);
    const he = lang === "he";
    m.sections.facts = [
      ...(m.sections.facts || []),
      item("f3", he ? "המחיר החודשי הוא 400 שקלים." : "The monthly price is 400 dollars.", {
        src: "brief",
        source: he ? "המחיר החודשי הוא 400 שקלים" : "Monthly price: 400 dollars",
      }),
      item("f4", he ? "המחיר החודשי הוא 450 שקלים." : "The monthly price is 450 dollars.", {
        src: "brief",
        source: he ? "בהצעה: 450 שקלים לחודש" : "The offer says 450 dollars a month",
      }),
    ];
    return m;
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
        past: [],
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
      ...(kindOk(m.kind) ? { kind: m.kind, kindLocked: m.kindLocked === true } : {}),
      topic: clean(m.topic && m.topic.now),
      sections: {
        soFar: arr(m.facts)
          .filter((f) => f && f.src !== "brief" && f.src !== "past")
          .map((f) => line(f.id, f.text, { ...(f.who ? { who: clean(f.who) } : {}), ...(f.src === "call" || f.src === "user" ? { src: f.src } : {}) })),
        past: arr(m.facts)
          .filter((f) => f && f.src === "past")
          .map((f) => line(f.id, f.text, { src: "past", ...(f.at ? { at: Number(f.at) || 0 } : {}) })),
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
    // a fact keeps the line of the pasted text it came from (the digest checked that it is really there)
    const facts = arr(g.facts)
      .map((x) => ({ text: text(x), source: typeof x === "object" && x ? clean(x.source) : "" }))
      .filter((x) => x.text);
    const past = arr(g.past)
      .map((x) => ({ text: text(x), who: x && typeof x === "object" ? clean(x.who) : "", at: x && typeof x === "object" ? Number(x.at) || 0 : 0 }))
      .filter((x) => x.text)
      .filter((x, i, all) => all.findIndex((y) => y.text.toLowerCase() === x.text.toLowerCase()) === i) // the memory keeps one line per text, so ids line up
      .slice(0, 5);
    return {
      mode: "before",
      source: "digest",
      ver: 1,
      ...(KINDS.includes(g.kind) ? { kind: g.kind } : {}),
      topic: clean(arr(g.agenda)[0] && text(g.agenda[0])),
      sections: {
        roster: arr(g.roster)
          .filter((p) => p && clean(p.name))
          .filter((p, i, all) => all.findIndex((q) => clean(q.name).toLowerCase() === clean(p.name).toLowerCase()) === i) // the memory keeps one person per name, so ids line up
          .map((p, i) => item("p" + (i + 1), clean(p.name), p.role ? { role: clean(p.role) } : undefined)),
        agenda: arr(g.agenda)
          .map(text)
          .filter(Boolean)
          .map((t, i) => item("m" + (i + 1), t)),
        facts: facts.map((x, i) => item("f" + (i + 1), x.text, { src: "brief", ...(x.source ? { source: x.source } : {}) })),
        past: past.map((x, i) => item("f" + (facts.length + i + 1), x.text, { src: "past", ...(x.at ? { at: x.at } : {}) })),
        mustCover: [],
      },
    };
  }

  /** Which memory list a window section writes to when the user adds a line (the same table as shared/memedit.cjs SECTION_LIST). */
  const SECTION_LIST = {
    soFar: "facts",
    past: "facts",
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
    past: "Last time",
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

  /**
   * "Wingman understood: ..." under the context box, from the model alone (no AI, no guessing): who is on the call, the topic, and how many
   * things to cover, facts and notes from earlier calls it holds. The page puts these parts into words (strings EN and HE).
   * Returns { people: string[], topic, agenda, facts, past, empty }.
   */
  function understood(model) {
    const s = (model && model.sections) || {};
    const n = (k) => (Array.isArray(s[k]) ? s[k].length : 0);
    const people = (s.roster || []).map((x) => x.text).slice(0, 6);
    const o = { people, topic: (model && model.topic) || "", agenda: n("agenda") + n("mustCover"), facts: n("facts"), past: n("past") };
    return { ...o, empty: !people.length && !o.topic && !o.agenda && !o.facts && !o.past };
  }

  // ---- local conflict check (no AI, no network) ----
  // Two facts that talk about the same thing but give different numbers, or one says it and the other denies it. A warning only: the person decides.
  // The negation words are a short list on purpose. This is a hint for a warning line, not a gate: a miss costs nothing, a false hit is one dismissable line.
  const NEGATORS = new Set(["not", "no", "never", "cannot", "cant", "isnt", "wont", "dont", "doesnt", "without", "לא", "אין", "בלי", "אינו", "אינה"]);
  const wordsOf = (t) =>
    String(t || "")
      .toLowerCase()
      .replace(/['’]/g, "")
      .match(/[\p{L}\p{N}]+(?:[.,][\p{N}]+)?/gu) || [];
  const isNum = (w) => /^\p{N}/u.test(w);
  const jaccard = (a, b) => {
    const A = new Set(a),
      B = new Set(b);
    let n = 0;
    for (const x of A) if (B.has(x)) n++;
    return { n, j: A.size + B.size - n ? n / (A.size + B.size - n) : 0 };
  };
  /** Pairs of facts (sections facts, past, soFar) that may disagree: [{ kind: "number" | "negation", a: {sec,id,text}, b: {sec,id,text}, label }]. At most 5, in reading order. */
  function conflicts(model) {
    const s = (model && model.sections) || {};
    const rows = [];
    for (const sec of ["facts", "past", "soFar"]) for (const x of s[sec] || []) rows.push({ sec, id: x.id, text: x.text, w: wordsOf(x.text) });
    const out = [];
    for (let i = 0; i < rows.length && out.length < 5; i++)
      for (let k = i + 1; k < rows.length && out.length < 5; k++) {
        const A = rows[i],
          B = rows[k];
        const nA = A.w.filter(isNum),
          nB = B.w.filter(isNum);
        const lA = A.w.filter((w) => !isNum(w) && !NEGATORS.has(w) && w.length > 1),
          lB = B.w.filter((w) => !isNum(w) && !NEGATORS.has(w) && w.length > 1);
        const { n, j } = jaccard(lA, lB);
        const ref = (r) => ({ sec: r.sec, id: r.id, text: r.text });
        const label = lA
          .filter((w) => lB.includes(w))
          .slice(0, 4)
          .join(" ");
        const sameNums = nA.length === nB.length && nA.every((w) => nB.includes(w));
        if (nA.length && nB.length && !sameNums && n >= 2 && j >= 0.5) {
          out.push({ kind: "number", a: ref(A), b: ref(B), label });
          continue;
        }
        const negA = A.w.some((w) => NEGATORS.has(w)),
          negB = B.w.some((w) => NEGATORS.has(w));
        if (negA !== negB && sameNums && n >= 2 && j >= 0.75) out.push({ kind: "negation", a: ref(A), b: ref(B), label });
      }
    return out;
  }

  /**
   * The review step before Start: the model with the unticked lines taken out and the edits applied, plus the edit messages for the call
   * (ids are the ones the memory will get, so the same ids work once the call runs). state: { off: {<id>: true}, text: {<id>: "new text"} }.
   * Returns { model, ops }; ops are { op: "remove", id } and { op: "edit", id, text } for the main process (knows:edit).
   */
  function applyReview(model, state) {
    const off = (state && state.off) || {},
      text = (state && state.text) || {};
    const ops = [];
    const sections = {};
    for (const [sec, list] of Object.entries((model && model.sections) || {})) {
      sections[sec] = [];
      for (const x of list) {
        if (off[x.id]) {
          ops.push({ op: "remove", id: x.id, was: x.text });
          continue;
        }
        const t = text[x.id] != null ? clean(text[x.id]) : "";
        if (t && t !== x.text) {
          ops.push({ op: "edit", id: x.id, text: t, was: x.text });
          sections[sec].push({ ...x, text: t });
        } else sections[sec].push(x);
      }
    }
    return { model: model ? { ...model, sections } : model, ops };
  }
  /** True when the review step has something to show: the meeting has context lines (a digest or saved text). No context is a normal state and skips it. */
  const hasContext = (model) => !!model && count(model) > 0;

  const api = {
    KINDS,
    kindOf,
    conflicts,
    applyReview,
    hasContext,
    understood,
    SECTIONS,
    MAX_TEXT,
    SECTION_LIST,
    clean,
    fixture,
    fixtureConflict,
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
