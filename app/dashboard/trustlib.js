"use strict";
// Card trust (pure functions, no DOM): the data side of "Show the line", "What this card saw" and the "Held back" list of the call review.
//   sourceLine(rows, card)     index of the transcript line a card answers (same question text first, else the right side's last line before the card), or -1
//   cardSaw(card)              what the model saw for a card, from its `ctx` row field: { legacy, memV, tokens, parts[], trimmed[], chunks[] }; legacy: true for a row without ctx
//   heldBack(events, rows, t0) the moments the engine did not show (skipped by the AI, dropped by a rule), each with its reason in plain words and the line before it
//   heldRatings(map)           the ratings map from heldback.json, cleaned
// Everything that comes from a file is untrusted: only known fields, numbers clamped, text clipped. Old rows (no ctx, no why) give a plain, honest result, never a guess.
(function (root) {
  const clip = (s, n) =>
    String(s == null ? "" : s)
      .replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, n);
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const finite = (v, lo, hi) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);

  /**
   * Which transcript row a card answers. rows: [{ ch, text, t }]. A card has `question` (the line text), `t` (when it was shown) and `badge`.
   * The same text as the question wins (the newest such line at or before the card, else the newest anywhere); without a text match the last line of the right side
   * (the user's own for a "For you" card, the other side's for the rest) before the card is used. -1 when there is none.
   */
  function sourceLine(rows, card) {
    const list = Array.isArray(rows) ? rows : [];
    if (!card || typeof card !== "object") return -1;
    const q = norm(card.question),
      ct = Number.isFinite(card.t) ? card.t : Infinity,
      side = card.badge === "me" || card.forMe ? "me" : "them";
    if (q.length >= 4) {
      let later = -1;
      for (let i = list.length - 1; i >= 0; i--) {
        const l = list[i];
        if (!l || (l.ch && l.ch !== side)) continue;
        const n = norm(l.text);
        if (n.length < 4) continue;
        if (n === q || q.includes(n) || n.includes(q)) {
          if (!(l.t > ct + 2000)) return i;
          if (later < 0) later = i;
        }
      }
      if (later >= 0) return later;
    }
    for (let i = list.length - 1; i >= 0; i--) {
      const l = list[i];
      if (l && (!l.ch || l.ch === side) && !(l.t > ct)) return i;
    }
    return -1;
  }

  /**
   * What the model saw for one card. A row written before the record existed has no `ctx`: { legacy: true } and nothing else (the window says so; it never guesses).
   * parts: the sizes of the prompt blocks in tokens (name, tokens), biggest first. trimmed: the budget steps that cut something. chunks: background pieces that were added
   * ({ id, source } or a bare id from an older record).
   */
  function cardSaw(card) {
    const c = card && typeof card === "object" && card.ctx && typeof card.ctx === "object" && !Array.isArray(card.ctx) ? card.ctx : null;
    if (!c) return { legacy: true };
    const parts = [];
    if (c.parts && typeof c.parts === "object" && !Array.isArray(c.parts))
      for (const [k, v] of Object.entries(c.parts)) {
        const n = finite(v, 0, 1e7);
        if (n !== null) parts.push({ name: clip(k, 40), tokens: Math.round(n) });
      }
    parts.sort((a, b) => b.tokens - a.tokens || (a.name < b.name ? -1 : 1));
    const chunks = (Array.isArray(c.chunks) ? c.chunks : []).slice(0, 12).flatMap((x) => {
      if (typeof x === "string") return [{ id: clip(x, 60), source: "" }];
      if (x && typeof x === "object") return [{ id: clip(x.id, 60), source: clip(x.source || x.label, 80) }];
      return [];
    });
    // chunk sources can also come as a parallel list (ctx.sources) from a newer engine
    if (Array.isArray(c.sources))
      c.sources.slice(0, chunks.length).forEach((s, i) => {
        if (typeof s === "string" && !chunks[i].source) chunks[i].source = clip(s, 80);
      });
    const memV = finite(c.memV, 0, 1e9),
      tokens = finite(c.tokens, 0, 1e8);
    return {
      legacy: false,
      role: clip(c.role, 20),
      memV: memV === null ? null : Math.round(memV),
      tokens: tokens === null ? parts.reduce((a, p) => a + p.tokens, 0) : Math.round(tokens),
      parts,
      trimmed: (Array.isArray(c.trimmed) ? c.trimmed : [])
        .slice(0, 8)
        .map((x) => clip(x, 40))
        .filter(Boolean),
      chunks,
    };
  }

  /** The names of the prompt parts and of the budget steps the engine records (src/context/build.ts). A name that is not here shows as it is, with dashes turned into spaces. */
  const PARTS = ["rules", "profile", "houseStyle", "bankIndex", "digest", "memory", "roleInstructions", "retrieved", "rawTail", "trigger"];
  const STEPS = ["shared", "retrieved", "rawTail", "memory", "memoryAll", "roleInstructions", "trigger"];
  /** Key for a trimmed step: "memory:facts" keeps its detail after the step. */
  const stepKey = (k) => String(k).split(":")[0];

  const ALLOWED = ["wanted", "fine"];
  /** The ratings of held-back moments: { key: "wanted" | "fine" }. Only plain keys and the two words. */
  function heldRatings(map) {
    const out = {};
    if (map && typeof map === "object" && !Array.isArray(map))
      for (const [k, v] of Object.entries(map)) if (/^[A-Za-z0-9:_.-]{1,80}$/.test(k) && ALLOWED.includes(v)) out[k] = v;
    return out;
  }

  /**
   * The moments that did not become a card: moment.skip (the AI chose silence) and moment.drop / moment.dropped (a rule held it back), with the reason code the engine
   * logged, the kind of card it would have been (tag), when it happened and the last line before it. rows: transcript rows [{ ch, text, t }]. Newest last, at most 60.
   * key is stable for the same event list: "<type-letter><turnId or row index>:<index>" (a rating is stored under it).
   */
  function heldBack(events, rows, ratings) {
    const list = Array.isArray(events) ? events : [];
    const lines = Array.isArray(rows) ? rows : [];
    const rate = heldRatings(ratings);
    const out = [];
    list.forEach((e, i) => {
      if (!e || typeof e.type !== "string") return;
      const group = e.type === "moment.skip" ? "skipped" : e.type === "moment.drop" || e.type === "moment.dropped" ? "dropped" : "";
      if (!group) return;
      const t = finite(e.t, 0, 1e15);
      let line = "";
      if (t !== null) {
        for (let k = lines.length - 1; k >= 0; k--) {
          const l = lines[k];
          if (l && l.t <= t && l.ch !== "me" && clip(l.text, 5)) {
            line = clip(l.text, 200);
            break;
          }
        }
      }
      const reason = clip(e.why || e.reason, 60);
      const tag = typeof e.tag === "string" && /^[A-Z]{2,8}$/.test(e.tag) ? e.tag : "";
      const key = `${group[0]}${clip(e.turnId, 20).replace(/[^A-Za-z0-9_.-]/g, "") || "x"}:${i}`;
      out.push({ key, group, reason, tag, t, line, rating: rate[key] || "", learns: !!tag });
    });
    return out.slice(-60);
  }

  const api = { sourceLine, cardSaw, heldBack, heldRatings, PARTS, STEPS, stepKey };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WingmanTrust = api;
})(typeof window !== "undefined" ? window : globalThis);
