"use strict";
// Answer window v2 model: pure logic, no DOM. Classic script in the page (window.WingmanV2), require() in tests.
// It decides which card is the hero, which ones wait as chips, how a card dims and leaves, and what the card controls send.
// Rows follow the card row v2 contract: kind, value, why, more, ref, closes, pinned. Rows without those fields are legacy and are not handled here.
(function (root) {
  const KINDS = ["answer", "prompt", "check", "fact"];
  /** Check is never hidden by the cap and wins the hero; Fact is a chip only. */
  const KIND_RANK = { check: 3, answer: 2, prompt: 1, fact: 0 };
  const CLOSES = ["answered", "topic", "time", "dismissed"];
  const MAX_HEAD_WORDS = 14;
  const MAX_DETAIL = 4;
  const DIM_MS = 4000; // a closed card stays visible this long, with its reason ("answered"); see DIM_BY for the other reasons
  /** A card that closed because you answered it can go fast. One that closed by topic or time may still be in your eyes, so it stays longer. */
  const DIM_BY = { answered: DIM_MS, topic: 9000, time: 12000 };
  const FACT_MS = 5 * 60 * 1000; // a fact chip lives five minutes
  const MAX_CHIPS = 4; // waiting cards (not counting checks); older ones go to history
  const MAX_RAIL = 3; // chips on the rail row; the rest sit behind "+N"
  const MAX_CHECKS = 3; // open checks; the oldest goes to history
  const SEEN_MS = 6000; // a rail chip is "new" until it has been on the rail this long, or was tapped
  const UNDO_MS = 30000; // a card that left can be brought back this long
  const LABEL_WORDS = 4;
  const LABEL_CHARS = 28;
  const ABOUT_WORDS = 8;
  const ABOUT_CHARS = 60;
  const VAL_WORDS = 4;
  const VAL_CHARS = 28;
  const STALE_MS = 3 * 60 * 1000; // after this an answer fades, shows its age as a warning and an "about:" tag
  const COLLAPSE_MS = 6 * 60 * 1000; // after this an answer or prompt is only a chip (checks and pinned cards stay)
  const PAUSE_MS = 90 * 1000; // a card after this much quiet is the "first after a pause": the screen reader hears it
  const HINT_CARDS = 3; // the key hints show for this many cards of the app's life
  const SRC = ["brief", "call", "you", "notes", "past"];
  const MAX_HISTORY = 20;
  const RATINGS = ["useful", "not_useful", "fewer", "none"];
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
    // A legacy tip has badge "tip" and no kind. The engine's v2 prompt card also has badge "tip" (for old tools) but carries kind "prompt": it is a v2 card.
    if (!isObj(row) || row.health || (row.badge === "tip" && !KINDS.includes(row.kind)) || row.turnId === "side" || row.turnId === "start") return false;
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

  /** The line to say, whole: spaces folded, nothing cut. The page clamps long text to 3 lines and offers More; the model never sees an ellipsis we added. */
  function cleanSay(text) {
    return str(text).replace(/\s+/g, " ").trim();
  }
  const wordCount = (t) => (t ? t.split(" ").length : 0);

  /** Cuts at a word boundary: at most `words` words and `chars` characters. Never inside a word (a single word longer than `chars` stays whole). */
  function cutWords(text, words, chars) {
    const w = str(text).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    const out = [];
    for (const x of w.slice(0, words)) {
      if (out.length && out.join(" ").length + 1 + x.length > chars) break;
      out.push(x);
    }
    return out.join(" ").replace(/[\s,;:.!?…\-–—"'()]+$/u, "");
  }
  /** Chip label: the model's `label` (2 to 4 words), else "". The page then shows the kind word. The first words of the line are never used. */
  function labelOf(row) {
    return cutWords(row && row.label, LABEL_WORDS, LABEL_CHARS);
  }
  /** The chip text: a fact with a value reads "label: value"; any card without a label reads as its kind word (the page passes the translated word). */
  function chipText(e, kindWord) {
    const name = e.label || kindWord;
    return e.kind === "fact" && e.val ? name + ": " + e.val : name;
  }
  /** Age of a card as a unit and a number, language free: { unit: "now" | "s" | "min", n }. Seconds step by 5 so the text does not flicker. */
  function ageParts(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 8) return { unit: "now", n: 0 };
    if (s < 60) return { unit: "s", n: Math.min(55, Math.round(s / 5) * 5) };
    return { unit: "min", n: Math.floor(s / 60) };
  }
  /** How old a card is: 0 fresh, 1 stale (3 min: faded, age in the warning colour, "about:" tag), 2 old (6 min: an answer or prompt is only a chip). */
  function staleLevel(ms) {
    return ms < STALE_MS ? 0 : ms < COLLAPSE_MS ? 1 : 2;
  }
  /** The first card ever, a check, and the first card after PAUSE_MS of quiet are announced to a screen reader. The rest are not (they would talk over the call). */
  function shouldAnnounce(kind, lastCardAt, now) {
    return kind === "check" || !lastCardAt || now - lastCardAt >= PAUSE_MS;
  }
  /** What a key does to the card in focus. Returns an action name or "". Modifier keys are never ours. */
  function keyAction(ev) {
    if (!ev || ev.ctrlKey || ev.metaKey || ev.altKey) return "";
    switch (ev.key) {
      case "Enter":
        return "more";
      case "Escape":
        return "dismiss";
      case "p":
      case "P":
        return "pin";
      case "1":
        return "useful";
      case "2":
        return "notuseful";
      default:
        return "";
    }
  }

  /** Builds the board entry for a row. */
  function makeEntry(row, now) {
    const kind = kindOf(row);
    const value = valueOf(row);
    const head = cleanSay(row.say);
    const detail = (Array.isArray(row.more) ? row.more : [])
      .map(str)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_DETAIL);
    // Legacy supporting facts of a v2 row read as detail too.
    if (Array.isArray(row.facts)) for (const f of row.facts) if (detail.length < MAX_DETAIL && str(f).trim()) detail.push(str(f).trim());
    return {
      id: String(row.id),
      kind,
      value,
      rank: rankOf(kind, value),
      at: Number(row.at) || now,
      head,
      // longer than 14 words, or the engine says the line had to be cut: the page clamps it to 3 lines and offers More
      long: row.fit === false || wordCount(head) > MAX_HEAD_WORDS,
      detail,
      why: str(row.why).trim(),
      about: cutWords(row.about, ABOUT_WORDS, ABOUT_CHARS) || (kind === "answer" ? cutWords(row.question, ABOUT_WORDS, ABOUT_CHARS) : ""),
      val: cutWords(row.val, VAL_WORDS, VAL_CHARS),
      conf: row.conf === "low" ? "low" : "high",
      ref: str(row.ref),
      question: str(row.question),
      state: "live", // "live" | "dim"
      reason: "", // answered | topic | time, while dim
      dimAt: 0,
      pinned: row.pinned === true,
      opened: false, // a collapsed card the user tapped stays open
      rating: "", // "" | useful | not_useful | fewer
      label: labelOf(row),
      src: SRC.includes(row.src) ? row.src : "",
      seen: false, // a rail chip shows a bold "new" dot until it was on the rail for SEEN_MS or was tapped
      railAt: 0,
      dimMs: DIM_MS,
      row,
    };
  }
  /** True when an answer or prompt is old enough to be only a chip. Checks, facts and pinned cards never collapse. */
  const isCollapsed = (e, now) => (e.kind === "answer" || e.kind === "prompt") && !e.pinned && !e.opened && e.state === "live" && now - e.at >= COLLAPSE_MS;

  /** The card board: one hero, the waiting chips, and the history. All times are passed in, so tests need no clock. */
  class Board {
    constructor() {
      this.cards = new Map(); // id -> entry (live or dim)
      this.heroId = "";
      this.history = []; // newest first: { id, kind, head, reason, at }
      this.ratings = new Map(); // id -> rating, kept after the card left
      this.clock = 0; // the newest time the board was told (apply or tick): collapse is judged against it
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
      this.clock = now;
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
      if (!old && e.kind === "check") this._mergeChecks(e, now);
      if (old) {
        e.at = old.at; // updates (streaming) keep their age and place
        e.pinned = old.pinned || e.pinned;
        e.rating = old.rating;
        e.seen = old.seen;
        e.railAt = old.railAt;
        e.opened = old.opened;
        if (old.state === "dim") Object.assign(e, { state: "dim", reason: old.reason, dimAt: old.dimAt });
      } else {
        e.rating = this.ratings.get(id) || "";
        this.cards.set(id, e);
      }
      this.cards.set(id, e);
      e.collapsed = isCollapsed(e, now);
      if (e.id !== this.heroId) this._place(e);
      else if (e.collapsed) this.heroId = "";
      this._trim(now);
      return e;
    }
    /** A new check about the same thing (same ref, or the same words) replaces the older open check: one card, not two. */
    _mergeChecks(e, now) {
      const key = (x) => x.ref || x.head.toLowerCase().replace(/\s+/g, " ");
      for (const o of [...this.cards.values()]) {
        if (o.kind !== "check" || o.id === e.id || o.state !== "live" || o.pinned) continue;
        if (key(o) && key(o) === key(e)) {
          e.seen = o.seen;
          this.remove(o.id, "merged", now, false);
        }
      }
    }
    /** Only the newest check can take the hero seat. Any other kind needs a higher rank, or the same rank and a newer time. */
    _place(e) {
      if (e.kind === "fact" || e.state !== "live" || e.collapsed) return;
      const hero = this.hero;
      if (!hero || hero.state === "dim") {
        this.heroId = e.id;
        return;
      }
      if (e.kind === "check") {
        const newer = [...this.cards.values()].some((c) => c.kind === "check" && c.state === "live" && c.id !== e.id && c.at > e.at);
        if (newer) return;
        if (hero.kind === "check" && !hero.pinned) {
          this.heroId = e.id;
          return;
        }
      }
      if (hero.pinned && e.kind !== "check") return;
      if (e.rank > hero.rank || (e.rank === hero.rank && e.at >= hero.at)) this.heroId = e.id;
    }
    /** Best waiting card for the hero seat: not a fact, not dim; a pinned card first, then the newest check, then rank, then newest. */
    _best() {
      /** @type {any} */
      let best = null;
      const score = (e) => e.rank + (e.pinned ? 100 : 0) + (e.kind === "check" ? e.at / 1e15 : 0);
      for (const e of this.cards.values()) {
        if (e.kind === "fact" || e.state !== "live" || e.id === this.heroId || e.collapsed) continue;
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
    /** Keeps the caps: at most MAX_CHIPS waiting answers and prompts, and at most MAX_CHECKS open checks (the oldest check goes to history). Pinned cards stay. */
    _trim(now) {
      this._fill();
      const waiting = this.chips.filter((e) => e.kind !== "check" && e.kind !== "fact" && !e.pinned);
      for (const e of waiting.slice(MAX_CHIPS)) this.remove(e.id, "cap", now);
      const checks = [...this.cards.values()].filter((e) => e.kind === "check" && e.state === "live" && !e.pinned).sort((a, b) => b.at - a.at);
      for (const e of checks.slice(MAX_CHECKS)) this.remove(e.id, "cap", now);
    }
    /** The rail: the chips that fit on one row (checks first, then newest), and how many wait behind "+N". */
    rail(max = MAX_RAIL) {
      const all = this.chips.sort(
        (a, b) => Number(b.kind === "check") - Number(a.kind === "check") || Number(b.kind !== "fact") - Number(a.kind !== "fact") || b.at - a.at,
      );
      return { shown: all.slice(0, max), more: all.slice(max) };
    }
    /** A chip is "seen" after it was on the rail for SEEN_MS. Returns true when a dot cleared. */
    markSeen(now = Date.now()) {
      const { shown, more } = this.rail();
      let changed = false;
      for (const e of more) e.railAt = 0;
      for (const e of shown) {
        if (e.seen) continue;
        if (!e.railAt) e.railAt = now;
        else if (now - e.railAt >= SEEN_MS) {
          e.seen = true;
          changed = true;
        }
      }
      return changed;
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
      e.dimMs = DIM_BY[e.reason] || DIM_MS;
    }
    /** Takes a card off the board; `toHistory` false drops it silently (withdrawn rows). */
    remove(id, reason, now = Date.now(), toHistory = true) {
      const e = this.cards.get(String(id));
      if (!e) return;
      this.cards.delete(e.id);
      if (toHistory && e.kind !== "fact") {
        this.history.unshift({ id: e.id, kind: e.kind, head: e.head, label: e.label, reason: reason || e.reason || "", at: now, entry: e });
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
      this.clock = now;
      for (const e of [...this.cards.values()]) {
        const col = isCollapsed(e, now);
        if (col !== !!e.collapsed) {
          e.collapsed = col; // an old answer becomes a chip; the next best card takes the hero seat
          if (col && this.heroId === e.id) {
            this.heroId = "";
            this._fill();
          }
          changed = true;
        }
        if (e.state === "dim" && now - e.dimAt >= (e.dimMs || DIM_MS)) {
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
      e.opened = true; // a card the user brought back does not collapse again
      e.collapsed = false;
      this.heroId = e.id;
      e.seen = true;
      return true;
    }
    /** Brings back the card that left last, when it left less than UNDO_MS ago. It takes the hero seat when nothing live holds it. Returns the entry or null. */
    restoreLast(now = Date.now()) {
      const i = this.history.findIndex((h) => h.entry && now - h.at <= UNDO_MS);
      if (i < 0) return null;
      const [h] = this.history.splice(i, 1);
      const e = h.entry;
      if (this.cards.has(e.id)) return null;
      e.state = "live";
      e.reason = "";
      e.dimAt = 0;
      e.seen = false;
      e.railAt = 0;
      e.opened = true; // the user asked for it back: it does not collapse again
      e.collapsed = false;
      this.cards.set(e.id, e);
      const hero = this.hero;
      if (!hero || hero.state === "dim" || e.kind === "check") this.heroId = e.id;
      this._trim(now);
      return e;
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
      // "fewer like this" is a one-way signal: pressing it again does not clear it
      const next = e ? (e.rating === rating && rating !== "fewer" ? "" : rating) : "";
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
      kindLocked: r.kindLocked === true,
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
    SRC,
    MAX_RAIL,
    MAX_CHECKS,
    SEEN_MS,
    UNDO_MS,
    DIM_BY,
    labelOf,
    chipText,
    cleanSay,
    cutWords,
    ageParts,
    staleLevel,
    isCollapsed,
    shouldAnnounce,
    keyAction,
    STALE_MS,
    COLLAPSE_MS,
    PAUSE_MS,
    HINT_CARDS,
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
