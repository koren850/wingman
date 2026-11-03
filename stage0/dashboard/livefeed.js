"use strict";
// Live conversation feed: pure functions shared by the main process (tailing) and the renderer (classic script), unit-tested in src/livefeed.test.ts.
// Input is untrusted JSONL from calls/<id>/{transcript,cards}.jsonl. Everything is validated and capped here; nothing touches the DOM.
// Used by livetail.cjs / livefixture.cjs (main process) and live.js (renderer, as window.WingmanLive).
(function (root) {
  const MAX_LINES = 400, MAX_CARDS = 150, MAX_TEXT = 600, MAX_SAY = 900, MAX_Q = 300, MAX_ROW_BYTES = 20000;
  const SHOWN = { bank: 1, ai: 1, stall: 1, tip: 1, me: 1, careful: 1, fix: 1 };   // fact/note/reminder/info/warn cards live in the answer window only
  // Clean a string field: drop control chars and bidi controls (LRM/RLM, embeddings, overrides, isolates) so call text cannot reorder what is shown around it; then cap length.
  const str = (v, n) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f‎‏‪-‮⁦-⁩]/g, "").slice(0, n) : "");
  // Loose form for comparing a card question with a transcript line: lowercase, punctuation (incl. Hebrew maqaf/geresh/gershayim) to single spaces.
  const norm = (s) => String(s || "").toLowerCase().replace(/[\s.,!?;:"'()־׳״-]+/g, " ").trim();

  /** Split a JSONL chunk into parsed rows. `carry` is the incomplete last line of the previous chunk. Bad or oversized rows are skipped. */
  function parseJsonl(carry, chunk) {
    const text = (carry || "") + String(chunk || "");
    const cut = text.lastIndexOf("\n");
    if (cut < 0) return { rows: [], carry: text.length > MAX_ROW_BYTES ? "" : text };
    const rows = [];
    for (const l of text.slice(0, cut).split("\n")) {
      if (!l || l.length > MAX_ROW_BYTES) continue;
      try { const r = JSON.parse(l); if (r && typeof r === "object" && !Array.isArray(r)) rows.push(r); } catch { /* half-written or junk */ }
    }
    const rest = text.slice(cut + 1);
    return { rows, carry: rest.length > MAX_ROW_BYTES ? "" : rest };
  }

  /** transcript.jsonl row -> { t, ch, text } or null. */
  function cleanLine(r) {
    if (!r || typeof r !== "object" || (r.ch !== "me" && r.ch !== "them")) return null;
    const text = str(r.text, MAX_TEXT).trim();
    if (!text || !Number.isFinite(r.t) || r.t < 0 || r.t > 4e12) return null;
    const nm = r.ch === "them" ? str(r.name, 40).trim() : "";
    const who = r.ch === "them" ? { ...(Number.isInteger(r.spk) && r.spk >= 1 && r.spk <= 20 ? { spk: r.spk } : {}), ...(nm ? { name: nm } : {}) } : {};
    return { t: Math.round(r.t), ch: r.ch, text, ...who };
  }

  /** cards.jsonl row {type:"speaker", spk, name} -> { spk, name } (name "" = cleared) or null. */
  function cleanSpeaker(r) {
    if (!r || typeof r !== "object" || r.type !== "speaker" || !Number.isInteger(r.spk) || r.spk < 1 || r.spk > 20 || typeof r.name !== "string") return null;
    return { spk: r.spk, name: str(r.name, 40).trim() };
  }
  /** Rows (raw cards.jsonl rows) -> the names map { spk: name } after applying every valid speaker row in order, starting from `base`. */
  function applyNames(base, rows) {
    const out = { ...base };
    for (const r of rows) { const s = cleanSpeaker(r); if (s) out[s.spk] = s.name; }
    return out;
  }

  /** cards.jsonl row -> { id, badge, question, say, t, dim } | { id, withdraw: true } | null. Only bank / AI / stall answers and the "For you" answers (me) are shown. */
  function cleanCard(r) {
    if (!r || typeof r !== "object" || r.type === "capture" || r.health || r.hidden) return null;
    const id = str(r.id, 80);
    if (!id) return null;
    if (r.withdraw) return { id, withdraw: true };
    if (typeof r.badge !== "string" || !SHOWN[r.badge] || r.turnId === "side") return null;
    const tt = Number.isFinite(r.t) ? r.t : Number.isFinite(r.at) ? r.at : 0;
    const say = str(r.say, MAX_SAY).trim();
    if (!say) return null;
    const out = { id, badge: r.badge, question: str(r.question, MAX_Q).trim(), say, t: Math.round(tt), dim: !!r.dim };
    if (r.source === "calc") out.source = "calc";
    if (r.badge === "tip") out.tipType = ["ask", "clarify", "term", "remind", "note"].includes(r.tipType) ? r.tipType : "note";
    return out;
  }

  const KINDS = ["client", "support", "vendor", "team", "consult", "personal", "other"];
  /** The call frame ({kind, topic, goal, people, entities, checklist[{item, done, must}]}) from a frame row or a bare object. Plain strings only, capped. Null when unusable. */
  function cleanFrame(r) {
    const f = r && typeof r === "object" && r.frame && typeof r.frame === "object" ? r.frame : r;
    if (!f || typeof f !== "object" || Array.isArray(f)) return null;
    const kind = KINDS.includes(f.kind) ? f.kind : "other";
    const checklist = (Array.isArray(f.checklist) ? f.checklist : []).flatMap((c) => { const item = str(c && c.item, 100).trim(); return item ? [{ item, done: !!(c && c.done), must: !!(c && c.must) }] : []; }).slice(0, 12);
    const people = (Array.isArray(f.people) ? f.people : []).slice(0, 6).flatMap((p) => { const who = str(p && p.who, 40).trim(); return who ? [{ who, role: str(p && p.role, 40).trim() }] : []; });
    const entities = (Array.isArray(f.entities) ? f.entities : []).slice(0, 10).map((e) => str(e, 40).trim()).filter(Boolean);
    const out = { kind, topic: str(f.topic, 100).trim(), goal: str(f.goal, 160).trim(), people, entities, checklist };
    return out.topic || out.goal || out.checklist.length || kind !== "other" ? out : null;
  }
  /** Done / total of a cleaned frame, and its open must items. */
  function frameProgress(f) {
    const list = (f && f.checklist) || [];
    return { done: list.filter((c) => c.done).length, total: list.length, missed: list.filter((c) => c.must && !c.done).map((c) => c.item) };
  }

  /** Index of the line this card answers: same question text first, else the latest line of the right side spoken before the card (the other side's line; for a "For you" card, the user's own). -1 = none yet. */
  function pinIndex(lines, card) {
    const q = norm(card.question), ct = card.t || Infinity, side = card.badge === "me" ? "me" : "them";
    if (q.length >= 4) {
      let best = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i]; if (l.ch !== side) continue;
        const n = norm(l.text);
        if (n.length < 4) continue;
        if (n === q || q.includes(n) || n.includes(q)) { if (l.t <= ct + 2000) return i; if (best < 0) best = i; }   // a question glued from two lines ends on the later one
      }
      if (best >= 0) return best;
    }
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].ch === side && lines[i].t <= ct) return i;
    return -1;
  }

  /** In-memory feed, capped at MAX_LINES lines and MAX_CARDS cards. */
  function create() {
    // seq numbers lines for the renderer; cards is a Map so re-sent ids keep one entry.
    let lines = [], seq = 0, frame = null, names = {};
    const cards = new Map();
    const api = {
      get lines() { return lines; },
      clear() { lines = []; cards.clear(); frame = null; names = {}; },
      get names() { return names; },
      /** Apply raw cards.jsonl "speaker" rows; returns the whole names map when it changed, else null. */
      addSpeakerRows(rows) { return api.setNames(applyNames(names, rows)); },
      /** Replace-merge a names map {spk: name} (validated like speaker rows). Returns the map when it changed, else null. */
      setNames(m) {
        if (!m || typeof m !== "object" || Array.isArray(m)) return null;
        const next = applyNames(names, Object.entries(m).map(([k, v]) => ({ type: "speaker", spk: Number(k), name: v })));
        if (JSON.stringify(next) === JSON.stringify(names)) return null;
        names = next; return { ...names };
      },
      get frame() { return frame; },
      /** Newest valid frame among raw cards.jsonl rows (type "frame"); returns it when it changed, else null. */
      addFrameRows(rows) {
        let last = null;
        for (const r of rows) if (r && r.type === "frame") last = cleanFrame(r) || last;
        return api.setFrame(last);
      },
      setFrame(f) { const c = f ? cleanFrame(f) : null; if (!c || JSON.stringify(c) === JSON.stringify(frame)) return null; frame = c; return c; },
      addLines(rows) {
        const out = [];
        for (const r of rows) {
          const l = cleanLine(r);
          if (l && !lines.slice(-50).some((k) => k.t === l.t && k.ch === l.ch && k.text === l.text)) { const x = { n: ++seq, ...l }; lines.push(x); out.push(x); }
        }
        if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
        return out;
      },
      addCards(rows) {
        const out = [];
        for (const r of rows) {
          const c = cleanCard(r); if (!c) continue;
          if (c.withdraw) { if (cards.delete(c.id)) out.push(c); continue; }
          cards.delete(c.id); cards.set(c.id, c);   // re-sent (AI streaming): newest version, newest position
          out.push(c);
        }
        while (cards.size > MAX_CARDS) cards.delete(cards.keys().next().value);
        return out;
      },
      /** Lines with their answer cards attached; cards not pinned to a line yet (or older than the first kept line) are dropped / listed in `loose`. */
      view() {
        // A rename wins over the name a line was written with (so a corrected or cleared name applies to the whole call).
        const res = lines.map((l) => {
          const o = { ...l, cards: [] };
          if (l.ch === "them" && l.spk in names) { if (names[l.spk]) o.name = names[l.spk]; else delete o.name; }
          return o;
        }), loose = [];
        const first = lines.length ? lines[0].t : 0;
        for (const c of cards.values()) {
          const i = pinIndex(lines, c);
          if (i >= 0) res[i].cards.push(c); else if (!lines.length || c.t >= first) loose.push(c);
        }
        for (const r of res) r.cards.sort((a, b) => a.t - b.t);
        return { items: res, loose };
      },
      snapshot() { return { lines: lines.map((l) => ({ ...l })), cards: [...cards.values()], frame, names: { ...names } }; },
    };
    return api;
  }

  /** mm:ss (or h:mm:ss) from the call start. */
  function stamp(t, t0) {
    const s = Math.max(0, Math.round((t - t0) / 1000)), p = (n) => String(n).padStart(2, "0");
    return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${p(Math.floor(s / 60))}:${p(s % 60)}`;
  }
  /** Call start for the stamps: the live clock when it is plausible, else the first line. */
  function startOf(liveAt, firstT) { return Number.isFinite(liveAt) && liveAt > 0 && Number.isFinite(firstT) && liveAt <= firstT + 5000 ? liveAt : (firstT || 0); }

  const api = { MAX_LINES, MAX_CARDS, parseJsonl, cleanLine, cleanCard, cleanSpeaker, applyNames, cleanFrame, frameProgress, pinIndex, create, stamp, startOf, norm };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.WingmanLive = api;
})(typeof window !== "undefined" ? window : globalThis);
