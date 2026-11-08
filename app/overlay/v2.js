"use strict";
// Answer window v2 model: pure logic, no DOM. Classic script in the page (window.WingmanV2), require() in tests.
// It decides which card is the hero, which ones wait as chips, how a card dims and leaves, and what the card controls send.
// Rows follow the card row v2 contract (PLAN section 3.3): kind, value, why, more, ref, closes, pinned. Rows without those fields are legacy and are not handled here.
(function (root) {
  const KINDS = ["answer", "prompt", "check", "fact"];
  /** Check is never hidden by the cap and wins the hero; Fact is a chip only. */
  const KIND_RANK = { check: 3, answer: 2, prompt: 1, fact: 0 };
  const CLOSES = ["answered", "topic", "time", "dismissed"];
  const MAX_HEAD_WORDS = 14;
  const MAX_DETAIL = 4;
  const DIM_MS = 4000; // a closed card stays visible this long, with its reason
  const FACT_MS = 5 * 60 * 1000; // a fact chip lives five minutes
  const MAX_CHIPS = 4; // waiting cards (not counting checks); older ones go to history
  const MAX_HISTORY = 20;
  const RATINGS = ["useful", "not_useful", "none"];
  const EVENTS = ["pin", "unpin", "dismiss", "recap"];

  const isObj = (x) => x && typeof x === "object";
  const str = (x) => (typeof x === "string" ? x : "");

  /** Card kind of a row: its own `kind`, else derived from the legacy badge. */
  function kindOf(row) {
    if (isObj(row) && KINDS.includes(row.kind)) return row.kind;
    const b = isObj(row) ? row.badge : "";
    if (b === "careful" || b === "fix") return "check";
    if (b === "fact") return "fact";
    return "answer";
  }

  /** True for a card row that carries any v2 field. Health, tip, side and start rows are never v2 cards. */
  function isV2(row) {
    if (!isObj(row) || row.health || row.badge === "tip" || row.turnId === "side" || row.turnId === "start") return false;
    if (row.type && row.type !== "card") return false;
    return (
      KINDS.includes(row.kind) ||
      row.value != null ||
      !!str(row.why) ||
      (Array.isArray(row.more) && row.more.length > 0) ||
      CLOSES.includes(row.closes) ||
      row.pinned != null ||
      !!str(row.ref)
    );
  }

  const valueOf = (row) => {
    const v = Number(row && row.value);
    return Number.isFinite(v) ? Math.max(0, Math.min(3, Math.round(v))) : 1;
  };
  const rankOf = (kind, value) => (KIND_RANK[kind] ?? 0) * 10 + value;

  /** Splits a say-line into the bold headline (at most `max` words) and the rest. A sentence end inside the limit wins over a hard cut. */
  function splitHeadline(text, max = MAX_HEAD_WORDS) {
    const clean = str(text).replace(/\s+/g, " ").trim();
    if (!clean) return { head: "", rest: "" };
    const words = clean.split(" ");
    if (words.length <= max) return { head: clean, rest: "" };
    let cut = -1;
    for (let i = 0; i < max; i++) if (/[.!?…:]["')\]]?$/.test(words[i])) cut = i;
    if (cut >= 3) return { head: words.slice(0, cut + 1).join(" "), rest: words.slice(cut + 1).join(" ") };
    return {
      head:
        words
          .slice(0, max)
          .join(" ")
          .replace(/[,;:\s]+$/, "") + "…",
      rest: words.slice(max).join(" "),
    };
  }

  /** Builds the board entry for a row. */
  function makeEntry(row, now) {
    const kind = kindOf(row);
    const value = valueOf(row);
    const sp = splitHeadline(row.say);
    const more = (Array.isArray(row.more) ? row.more : [])
      .map(str)
      .map((s) => s.trim())
      .filter(Boolean);
    const detail = [...(sp.rest ? [sp.rest] : []), ...more].slice(0, MAX_DETAIL);
    // Legacy supporting facts of a v2 row read as detail too.
    if (Array.isArray(row.facts)) for (const f of row.facts) if (detail.length < MAX_DETAIL && str(f).trim()) detail.push(str(f).trim());
    return {
      id: String(row.id),
      kind,
      value,
      rank: rankOf(kind, value),
      at: Number(row.at) || now,
      head: sp.head,
      detail,
      why: str(row.why).trim(),
      ref: str(row.ref),
      question: str(row.question),
      state: "live", // "live" | "dim"
      reason: "", // answered | topic | time, while dim
      dimAt: 0,
      pinned: row.pinned === true,
      rating: "", // "" | useful | not_useful
      row,
    };
  }

  /** The card board: one hero, the waiting chips, and the history. All times are passed in, so tests need no clock. */
  class Board {
    constructor() {
      this.cards = new Map(); // id -> entry (live or dim)
      this.heroId = "";
      this.history = []; // newest first: { id, kind, head, reason, at }
      this.ratings = new Map(); // id -> rating, kept after the card left
    }
    get hero() {
      return this.cards.get(this.heroId) || null;
    }
    /** Waiting cards, newest first. Facts included. */
    get chips() {
      return [...this.cards.values()].filter((e) => e.id !== this.heroId).sort((a, b) => b.at - a.at);
    }
    has(id) {
      return this.cards.has(String(id));
    }
    /** Applies a row. A row with `closes` for a known card closes it; any other v2 row adds or updates a card. Returns the entry or null. */
    apply(row, now = Date.now()) {
      if (!isObj(row) || row.id == null) return null;
      const id = String(row.id);
      const old = this.cards.get(id);
      if (CLOSES.includes(row.closes)) {
        if (!old) return null;
        this.close(id, row.closes, now);
        return old;
      }
      if (row.withdraw) {
        this.remove(id, "", now, false);
        return null;
      }
      const e = makeEntry(row, now);
      if (old) {
        e.at = old.at; // updates (streaming) keep their age and place
        e.pinned = old.pinned || e.pinned;
        e.rating = old.rating;
        if (old.state === "dim") Object.assign(e, { state: "dim", reason: old.reason, dimAt: old.dimAt });
      } else {
        e.rating = this.ratings.get(id) || "";
        this.cards.set(id, e);
      }
      this.cards.set(id, e);
      if (e.id !== this.heroId) this._place(e);
      this._trim(now);
      return e;
    }
    _place(e) {
      if (e.kind === "fact" || e.state !== "live") return;
      const hero = this.hero;
      if (!hero || hero.state === "dim") {
        this.heroId = e.id;
        return;
      }
      if (hero.pinned && e.kind !== "check") return;
      if (e.rank > hero.rank || (e.rank === hero.rank && e.at >= hero.at)) this.heroId = e.id;
    }
    /** Best waiting card for the hero seat: not a fact, not dim; a pinned card first, then check, then value, then newest. */
    _best() {
      /** @type {any} */
      let best = null;
      const score = (e) => e.rank + (e.pinned ? 100 : 0);
      for (const e of this.cards.values()) {
        if (e.kind === "fact" || e.state !== "live" || e.id === this.heroId) continue;
        if (!best || score(e) > score(best) || (score(e) === score(best) && e.at > best.at)) best = e;
      }
      return best;
    }
    _fill() {
      if (!this.heroId || !this.cards.has(this.heroId)) {
        const b = this._best();
        this.heroId = b ? b.id : "";
      }
    }
    /** Keeps the chip cap: oldest waiting cards go to history. Checks and pinned cards stay. */
    _trim(now) {
      this._fill();
      const waiting = this.chips.filter((e) => e.kind !== "check" && e.kind !== "fact" && !e.pinned);
      for (const e of waiting.slice(MAX_CHIPS)) this.remove(e.id, "cap", now);
    }
    /** A card that is answered, off topic or timed out dims for DIM_MS with its reason, then goes to history. A pinned card stays. */
    close(id, reason, now = Date.now()) {
      const e = this.cards.get(String(id));
      if (!e) return;
      if (reason === "dismissed") return this.remove(e.id, "dismissed", now);
      if (e.pinned || e.state === "dim") return;
      e.state = "dim";
      e.reason = CLOSES.includes(reason) ? reason : "time";
      e.dimAt = now;
    }
    /** Takes a card off the board; `toHistory` false drops it silently (withdrawn rows). */
    remove(id, reason, now = Date.now(), toHistory = true) {
      const e = this.cards.get(String(id));
      if (!e) return;
      this.cards.delete(e.id);
      if (toHistory && e.kind !== "fact") {
        this.history.unshift({ id: e.id, kind: e.kind, head: e.head, reason: reason || e.reason || "", at: now });
        this.history.length = Math.min(this.history.length, MAX_HISTORY);
      }
      if (this.heroId === e.id) {
        this.heroId = "";
        this._fill();
      }
    }
    /** Moves time forward: dim cards leave after DIM_MS, facts after FACT_MS. Returns true when something changed. */
    tick(now = Date.now()) {
      let changed = false;
      for (const e of [...this.cards.values()]) {
        if (e.state === "dim" && now - e.dimAt >= DIM_MS) {
          this.remove(e.id, e.reason, now);
          changed = true;
        } else if (e.kind === "fact" && !e.pinned && now - e.at >= FACT_MS) {
          this.remove(e.id, "time", now);
          changed = true;
        }
      }
      return changed;
    }
    /** Tap on a chip: it takes the hero seat and the old hero waits as a chip. */
    promote(id) {
      const e = this.cards.get(String(id));
      if (!e || e.kind === "fact") return false;
      this.heroId = e.id;
      return true;
    }
    togglePin(id) {
      const e = this.cards.get(String(id));
      if (!e) return false;
      e.pinned = !e.pinned;
      if (e.pinned && e.state === "dim") {
        e.state = "live";
        e.reason = "";
      }
      return e.pinned;
    }
    /** Same rating again clears it. Returns the new rating ("" = none). */
    rate(id, rating) {
      const e = this.cards.get(String(id));
      const next = e ? (e.rating === rating ? "" : rating) : "";
      if (e) e.rating = next;
      this.ratings.set(String(id), next);
      return next;
    }
    clear() {
      this.cards.clear();
      this.heroId = "";
      this.history.length = 0;
      this.ratings.clear();
    }
  }

  // ---- view rows: { type: "view", now|topic, kind, open[], promises[], cover[], recap{}, ai } ----
  const items = (x) =>
    (Array.isArray(x) ? x : [])
      .map((i) => (isObj(i) ? str(i.text) : str(i)))
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 12);
  /** Cleans a view row. Unknown or malformed fields become empty values; it never throws. */
  function normView(row) {
    const r = isObj(row) ? row : {};
    const rc = isObj(r.recap) ? r.recap : {};
    return {
      topic: str(r.now || r.topic).trim(),
      kind: str(r.kind),
      open: items(r.open),
      promises: items(r.promises),
      cover: items(r.cover),
      ai: ["ok", "offline", "paused"].includes(r.ai) ? r.ai : "ok",
      recap: {
        where: str(rc.where).trim(),
        decided: items(rc.decided),
        open: items(rc.open),
        promised: items(rc.promised),
        asked: items(rc.asked),
      },
    };
  }
  const recapEmpty = (rc) => !rc.where && !rc.decided.length && !rc.open.length && !rc.promised.length && !rc.asked.length;

  // ---- controls: what the buttons on a card send to the main process ----
  /** `send(kind, payload)` is the bridge (window.wingman.act); `copy(text)` is window.wingman.copy. */
  function createControls(send, copy) {
    return {
      rate: (cardId, rating) => send("rate", { cardId: String(cardId), rating: RATINGS.includes(rating) ? rating : "none" }),
      pin: (cardId, on) => send("event", { name: on ? "pin" : "unpin", cardId: String(cardId) }),
      dismiss: (cardId) => send("event", { name: "dismiss", cardId: String(cardId) }),
      recap: () => send("event", { name: "recap", cardId: "recap" }), // asks the engine for a fresh Catch me up (it answers with recap rows)
      copy: (text) => copy(String(text)),
    };
  }
  /** The text Copy puts on the clipboard: the headline and its detail. */
  const copyText = (e) => [e.head, ...e.detail].filter(Boolean).join("\n");

  /** Validates a message from the page (main side and preload use the same rule). Returns a clean { kind, ...payload } or null. */
  function cleanAct(kind, payload) {
    const p = isObj(payload) ? payload : {};
    const cardId = typeof p.cardId === "string" ? p.cardId.slice(0, 200) : "";
    if (!cardId) return null;
    if (kind === "rate" && RATINGS.includes(p.rating)) return { kind, cardId, rating: p.rating };
    if (kind === "event" && EVENTS.includes(p.name)) return { kind, cardId, name: p.name };
    return null;
  }

  const api = {
    KINDS,
    KIND_RANK,
    CLOSES,
    RATINGS,
    EVENTS,
    MAX_HEAD_WORDS,
    DIM_MS,
    FACT_MS,
    MAX_CHIPS,
    kindOf,
    isV2,
    rankOf,
    splitHeadline,
    makeEntry,
    Board,
    normView,
    recapEmpty,
    createControls,
    copyText,
    cleanAct,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WingmanV2 = api;
})(typeof window !== "undefined" ? window : globalThis);
