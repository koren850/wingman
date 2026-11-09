"use strict";
// Answer window v2 view: draws the hero card, the WATCHING chips, the idle view, the Catch me up sheet and the AI bars.
// Classic script (loaded before app.js). app.js calls createV2View(deps) once and routes rows to it. Text is always set with textContent / text nodes (card text comes from the call).
// The model (which card is hero, lifetime, controls) lives in v2.js; this file only draws it.
/* global WingmanV2, WingmanMemView, WingmanText */
function createV2View(deps) {
  // Small hooks with defaults, so a test page may leave them out. sheet() / setSheet(name) give the one open-sheet value, which app.js owns (none | rewind | recap | more | checklist).
  const d = { cardShown: () => {}, uiDir: () => "ltr", paused: () => false, sheet: () => "none", setSheet: () => {}, ...deps };
  const { tr, mixed, div, span } = d;
  const V = WingmanV2;
  const board = new V.Board();
  let view = V.normView({});
  let hasView = false;
  let openList = ""; // "" | context | cards
  const expanded = new Set(); // ids whose detail is open
  let drawnHero = ""; // id of the hero drawn last (the rise animation plays only for a new one)
  let listTimer;
  let copiedAt = 0;

  const heroBox = document.getElementById("hero"),
    watchBox = document.getElementById("watch"),
    chipsBox = document.getElementById("chips"),
    listBox = document.getElementById("wlist"),
    idleBox = document.getElementById("idle"),
    recapBox = document.getElementById("recap"),
    aiBar = document.getElementById("aibar"),
    aiPill = document.getElementById("aipill"),
    kindPill = document.getElementById("kindpill");

  const GLYPH = { answer: "✦", prompt: "›", check: "!", fact: "ℹ" };
  const SVGNS = "http://www.w3.org/2000/svg";
  const ICON = {
    up: ["M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"],
    down: ["M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"],
    menu: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
  };
  /** A small line icon (stroke follows the text colour). Built with createElementNS, never markup. */
  function icon(name) {
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    for (const dPath of ICON[name]) {
      const p = document.createElementNS(SVGNS, "path");
      p.setAttribute("d", dPath);
      svg.append(p);
    }
    return svg;
  }
  const button = (cls, text, onClick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dir = "auto";
    b.className = cls;
    if (text != null) b.textContent = text;
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      onClick(ev);
    });
    return b;
  };
  /** A button with an icon and no visible text; the label is for screen readers and the tooltip. */
  const iconButton = (cls, name, label, onClick, pressed) => {
    const b = button("b ib " + cls, null, onClick);
    b.append(icon(name));
    b.setAttribute("aria-label", label);
    b.title = label;
    if (pressed !== undefined) b.setAttribute("aria-pressed", String(pressed));
    return b;
  };
  const kindLabel = (k) => tr("v2.kind." + k);
  const dimLabel = (r) => tr("v2.dim." + (r === "answered" || r === "topic" ? r : "time"));
  const ageText = (ms) => {
    const a = V.ageParts(ms);
    return a.unit === "now" ? tr("v2.age.now") : tr(a.unit === "s" ? "v2.age.s" : "v2.age.min", { n: a.n });
  };
  /** Text of a dynamic string with a fixed label in front: the label sits in its own isolate, so mixed scripts never reorder it. */
  const labelled = (el, label, text) => {
    mixed(el, text);
    const k = document.createElement("bdi");
    k.className = "lk";
    k.textContent = label;
    el.prepend(k, document.createTextNode(" "));
    return el;
  };

  // ---- focus: a rebuild of the hero or the chips must not drop the keyboard focus ----
  const fkOf = () => {
    const a = document.activeElement;
    return a && a.dataset && a.dataset.fk ? a.dataset.fk : "";
  };
  const refocus = (fk) => {
    if (fk)
      for (const box of [heroBox, chipsBox, listBox]) {
        const t = [...box.querySelectorAll("[data-fk]")].find((x) => x.dataset.fk === fk);
        if (t) {
          t.focus({ preventScroll: true });
          break;
        }
      }
    markFocus();
  };
  /** The focus ring and the controls follow the element that holds the keyboard focus. A class does it, because a window that never takes focus matches no :focus rule. */
  function markFocus() {
    for (const el of document.querySelectorAll(".kbf, .focus-in")) el.classList.remove("kbf", "focus-in");
    const a = document.activeElement;
    if (!a || a === document.body || !(heroBox.contains(a) || chipsBox.contains(a) || listBox.contains(a))) return;
    a.classList.add("kbf");
    const card = a.closest(".hcard");
    if (card) card.classList.add("focus-in");
  }
  document.addEventListener("focusin", markFocus);
  document.addEventListener("focusout", () => setTimeout(markFocus, 0));
  const withFk = (el, fk) => {
    el.dataset.fk = fk;
    return el;
  };

  // ---- hero ----
  let menuFor = ""; // id of the card whose overflow menu is open
  let menuTimer;
  const flashUntil = new Map(); // id -> time: a check that just arrived flashes until then
  const FLASH_MS = 4000;
  let lastCardAt = 0; // when the newest card row arrived: the first card after a long quiet is announced
  const announceIds = new Set(); // cards whose arrival a screen reader should hear
  let slideIds = new Set(); // old heroes that just moved to the rail: their chip slides in
  let slideTimer;
  const closeMenu = () => {
    menuFor = "";
    clearTimeout(menuTimer);
  };
  /** Thumbs and the overflow button. They show on hover or focus, and once the card has aged a minute. Pin, Copy, Fewer and Dismiss wait in the menu row (hmenu), which is always built so the keyboard hotkeys can press them. */
  function ctl(e, dir) {
    const row = div("hctl", dir);
    row.append(
      withFk(
        iconButton("up", "up", tr("v2.useful"), () => rate(e, "useful"), e.rating === "useful"),
        "b-up",
      ),
      withFk(
        iconButton("down", "down", tr("v2.notUseful"), () => rate(e, "not_useful"), e.rating === "not_useful"),
        "b-down",
      ),
    );
    const m = iconButton(
      "menu",
      "menu",
      tr("v2.menu"),
      () => {
        menuFor = menuFor === e.id ? "" : e.id;
        clearTimeout(menuTimer);
        if (menuFor) menuTimer = setTimeout(() => (closeMenu(), draw()), 8000);
        draw();
      },
      menuFor === e.id,
    );
    m.setAttribute("aria-haspopup", "true");
    row.append(withFk(m, "b-menu"));
    return row;
  }
  function menuRow(e, dir) {
    const row = div("hmenu", dir);
    row.style.display = menuFor === e.id ? "flex" : "none";
    const add = (cls, label, onClick, pressed) => {
      const b = withFk(
        button("b " + cls, label, () => (closeMenu(), onClick())),
        "b-" + cls,
      );
      if (pressed !== undefined) b.setAttribute("aria-pressed", String(pressed));
      row.append(b);
      return b;
    };
    add(
      "pin",
      e.pinned ? tr("v2.unpin") : tr("v2.pin"),
      () => {
        d.controls.pin(e.id, board.togglePin(e.id));
        draw();
      },
      e.pinned,
    );
    const cp = add("copy", Date.now() - copiedAt < 1200 && drawnCopy === e.id ? tr("v2.copied") : tr("v2.copy"), () => {
      d.controls.copy(V.copyText(e));
      copiedAt = Date.now();
      drawnCopy = e.id;
      draw();
      setTimeout(draw, 1250);
    });
    cp.title = V.copyText(e);
    // "Fewer like this": a strong not-useful for this kind of card; the card leaves (Undo brings it back)
    add("fewer", tr("v2.fewer"), () => {
      board.rate(e.id, "fewer");
      d.controls.rate(e.id, "fewer");
      d.controls.dismiss(e.id);
      board.remove(e.id, "dismissed");
      draw();
    });
    add("x", tr("v2.dismiss"), () => {
      d.controls.dismiss(e.id);
      board.remove(e.id, "dismissed");
      draw();
    });
    return row;
  }
  let drawnCopy = "";
  function rate(e, rating) {
    const next = board.rate(e.id, rating);
    d.controls.rate(e.id, next || "none");
    draw();
  }
  /** 0 fresh, 1 stale (3 min). Pinned and dim cards keep their own look. */
  const staleOf = (e, now) => (e.pinned || e.state === "dim" ? 0 : V.staleLevel(now - e.at));
  const agedOf = (e, now) => e.state === "live" && now - e.at >= 60000;
  /** A card has more to show when it has detail lines or its line is long (clamped to 3 lines until More is pressed). */
  const expandable = (e) => e.detail.length > 0 || e.long;
  const toggleExpand = (id) => {
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    draw();
  };
  /** The age as its own isolate in the direction of the window language: "10 s" never reads "s 10" inside a card that runs the other way. */
  const ageSpan = (cls, ms) => {
    const s = span(cls, ageText(ms));
    s.dir = d.uiDir();
    return s;
  };

  function drawHero() {
    const e = board.hero;
    heroBox.replaceChildren();
    heroBox.style.display = e ? "block" : "none";
    if (!e) {
      drawnHero = "";
      return;
    }
    const now = Date.now();
    const isNew = drawnHero !== e.id;
    if (isNew && e.kind === "check" && e.state === "live") flashUntil.set(e.id, now + FLASH_MS);
    const flash = (flashUntil.get(e.id) || 0) > now;
    const lvl = staleOf(e, now);
    const isExp = expanded.has(e.id);
    const cd = WingmanText.isLatin(e.head) ? "ltr" : "rtl"; // the card follows the direction of its own text; the rail and pills follow the window language
    const el = div(
      `hcard k-${e.kind}${e.state === "dim" ? " dim" : ""}${e.pinned ? " pinned" : ""}${isNew ? " pulse" : ""}${flash ? " flash" : ""}${lvl ? " stale" : ""}${agedOf(e, now) ? " aged" : ""}${
        menuFor === e.id ? " menu-open" : ""
      }`,
      cd,
    );
    el.dataset.id = e.id;
    el.tabIndex = 0;
    el.dataset.fk = "card";
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", kindLabel(e.kind) + (lvl ? ", " + tr("v2.stale") : ""));
    if (expandable(e)) {
      el.classList.add("tappable");
      el.title = tr("v2.tap");
      el.setAttribute("aria-expanded", String(isExp));
    }
    el.addEventListener("click", () => {
      if (menuFor) {
        closeMenu();
        draw();
      } else if (expandable(e)) toggleExpand(e.id);
    });
    const top = div("htop", cd);
    const pill = span("pill");
    pill.append(span("gl", GLYPH[e.kind]), document.createTextNode(kindLabel(e.kind)));
    top.append(pill);
    const age = ageSpan("hage" + (lvl ? " warn" : ""), now - e.at);
    age.setAttribute("aria-hidden", "true");
    top.append(age);
    if (e.state === "dim") top.append(span("dimwhy", dimLabel(e.reason)));
    else if (e.pinned) top.append(span("pinmark", tr("v2.pin")));
    top.append(ctl(e, cd));
    el.append(top);
    const say = div("hsay" + (isExp ? "" : " clamp"), "auto");
    const fillSay = (text) => {
      say.replaceChildren();
      mixed(say, text);
      if (e.kind === "prompt") {
        // a prompt is something to say: it reads as speech, "Ask: ..."
        const k = document.createElement("bdi");
        k.className = "lk hask";
        k.textContent = tr("v2.ask");
        say.prepend(k, document.createTextNode(" "));
      }
    };
    fillSay(e.head);
    el.append(say);
    if (isExp && e.detail.length) {
      const ul = document.createElement("ul");
      ul.className = "hmore";
      ul.dir = "auto";
      for (const t of e.detail) {
        const li = document.createElement("li");
        li.dir = "auto";
        mixed(li, t);
        ul.append(li);
      }
      el.append(ul);
    }
    if (e.about) {
      const ab = div("habout", "auto");
      mixed(ab, tr("v2.about", { t: e.about }));
      el.append(ab);
    }
    if (e.why) {
      const w = div("hwhy", "auto");
      labelled(w, tr("v2.why"), e.why);
      el.append(w);
    }
    el.append(menuRow(e, cd));
    heroBox.append(el);
    // More: shown when there is detail, or when the line does not fit in 3 lines (it is never cut without this button)
    let over = !isExp && say.scrollHeight > say.clientHeight + 1;
    if (over) {
      // a collapsed card ends at a sentence end: drop whole sentences from the end until it fits; More shows the rest
      const kept = WingmanText.sentencePrefix(e.head, (cand) => {
        fillSay(cand);
        return say.scrollHeight <= say.clientHeight + 1;
      });
      fillSay(kept || e.head);
      over = true;
    }
    if (e.detail.length || over || (isExp && e.long)) {
      const mb = withFk(
        button("b more", isExp ? tr("v2.less") : tr("v2.more"), () => toggleExpand(e.id)),
        "b-more",
      );
      mb.setAttribute("aria-expanded", String(isExp));
      say.after(mb);
    }
    if (isNew && e.state === "live") {
      if (announceIds.has(e.id) && !d.paused()) d.announce(kindLabel(e.kind), e.head, true); // a hidden (paused) card is not read out
      // the old hero moves to the rail with a short slide
      if (drawnHero && board.cards.has(drawnHero) && drawnHero !== e.id) {
        slideIds.add(drawnHero);
        clearTimeout(slideTimer);
        slideTimer = setTimeout(() => (slideIds = new Set()), 900);
      }
    }
    announceIds.delete(e.id);
    drawnHero = e.id;
  }
  /** Once a second: the age text and the stale look of the hero and the chips, without rebuilding them (a rebuild would restart the pulse and drop the focus). */
  function tickAge(now) {
    const e = board.hero;
    const el = heroBox.firstElementChild;
    if (e && el) {
      const t = el.querySelector(".hage");
      const txt = ageText(now - e.at);
      if (t && t.textContent !== txt) t.textContent = txt;
      const lvl = staleOf(e, now);
      el.classList.toggle("stale", lvl > 0);
      if (t) t.classList.toggle("warn", lvl > 0);
      el.classList.toggle("aged", agedOf(e, now));
      if (el.classList.contains("flash") && (flashUntil.get(e.id) || 0) <= now) el.classList.remove("flash");
    }
    for (const c of chipsBox.querySelectorAll(".cage")) {
      const txt = ageText(now - Number(c.dataset.at));
      if (c.textContent !== txt) c.textContent = txt;
    }
  }

  // ---- rail (one row of at most 3 labelled chips), "+N", and the pills row ----
  /** The open list of the Context button: Open, Promises, Not covered yet, Earlier cards. */
  const sections = () => [
    ["open", view.open, "v2.list.open"],
    ["promises", view.promises, "v2.list.promises"],
    ["cover", view.cover, "v2.list.cover"],
  ];
  const contextCount = () => view.open.length + view.promises.length + view.cover.length + board.history.length;
  function toggleList(name) {
    openList = openList === name ? "" : name;
    clearTimeout(listTimer);
    if (openList) listTimer = setTimeout(() => ((openList = ""), draw()), 20000);
    draw();
  }
  /** The chip text: the model's label, else the kind word; a fact reads "label: value"; an old answer reads what it was about. */
  const chipLabel = (e) => (e.collapsed && e.about ? e.about : V.chipText(e, kindLabel(e.kind)));
  function chipFor(e, now) {
    const isNew = !e.seen && e.state === "live";
    const c = button(
      `chip card k-${e.kind}${e.state === "dim" ? " dim" : ""}${isNew ? " isnew" : ""}${e.collapsed ? " old" : ""}${slideIds.has(e.id) ? " slide" : ""}`,
      null,
      () => {
        if (e.kind === "fact") return;
        board.promote(e.id);
        draw();
      },
    );
    c.dataset.fk = "chip-" + e.id;
    const mk = span("kmark", GLYPH[e.kind]); // the kind is a shape (a glyph), not only a colour
    mk.setAttribute("aria-hidden", "true");
    c.append(mk);
    const t = span("ct");
    t.dir = "auto";
    mixed(t, chipLabel(e));
    c.append(t);
    if (e.kind === "fact" && e.src) c.append(span("src", tr("v2.src." + e.src)));
    const ag = ageSpan("cage", now - e.at);
    ag.dataset.at = String(e.at);
    ag.setAttribute("aria-hidden", "true");
    c.append(ag);
    if (isNew) {
      // the one unseen mark: a bold dot
      const n = span("ndot");
      n.setAttribute("aria-hidden", "true");
      c.append(n);
    }
    c.title = e.head;
    c.setAttribute("aria-label", tr("v2.chip.show", { text: chipLabel(e) }) + ", " + ageText(now - e.at) + (isNew ? ", " + tr("v2.chip.new") : ""));
    return c;
  }
  function drawChips() {
    chipsBox.replaceChildren();
    const now = Date.now();
    const { shown, more } = board.rail();
    const rail = div("rail");
    for (const e of shown) rail.append(chipFor(e, now));
    if (more.length) {
      const anyNew = more.some((e) => !e.seen && e.state === "live");
      const b = withFk(
        button("chip count morecards" + (openList === "cards" ? " on" : "") + (anyNew ? " isnew" : ""), tr("v2.chip.more", { n: more.length }), () =>
          toggleList("cards"),
        ),
        "morecards",
      );
      b.setAttribute("aria-expanded", String(openList === "cards"));
      if (anyNew) b.append(span("ndot"));
      rail.append(b);
    }
    rail.style.display = shown.length ? "flex" : "none";
    chipsBox.append(rail);
    const pills = div("pills");
    const n = contextCount();
    if (n) {
      // Open, Promises, Cover and Earlier cards are one button with a count
      const b = withFk(
        button("chip ctxbtn" + (openList === "context" ? " on" : ""), null, () => toggleList("context")),
        "ctx",
      );
      b.append(span("", tr("v2.context")), span("cbadge", String(n)));
      b.setAttribute("aria-expanded", String(openList === "context"));
      b.setAttribute("aria-label", tr("v2.context.label", { n }));
      pills.append(b);
    }
    // Catch me up is the one primary button
    pills.append(
      withFk(
        button("chip recapbtn primary", tr("v2.recap.button"), () => (recapShown() ? d.setSheet("none") : d.setSheet("recap"))),
        "recap",
      ),
    );
    chipsBox.append(pills);
  }
  function drawList() {
    listBox.replaceChildren();
    if (!openList) {
      listBox.style.display = "none";
      return;
    }
    const ul = document.createElement("ul");
    ul.dir = "auto";
    let title = "";
    const li = (content, cls) => {
      const x = document.createElement("li");
      x.dir = "auto";
      if (cls) x.className = cls;
      if (typeof content === "string") mixed(x, content);
      else x.append(content);
      ul.append(x);
      return x;
    };
    if (openList === "cards") {
      title = tr("v2.list.cards");
      const { shown, more } = board.rail();
      for (const e of [...shown, ...more].slice(0, 8)) {
        if (e.kind === "fact") {
          const row = div("lrow fact", "auto");
          mixed(row, e.head);
          if (e.src) row.append(" ", span("src", tr("v2.src." + e.src)));
          li(row);
          continue;
        }
        const b = button("lrow k-" + e.kind, null, () => {
          board.promote(e.id);
          openList = "";
          draw();
        });
        b.append(span("kmark", GLYPH[e.kind]));
        const t = span("ct");
        t.dir = "auto";
        mixed(t, e.head);
        b.append(t);
        li(b);
      }
    } else {
      // context: what is open, promised, not covered, and the cards that left
      title = tr("v2.context");
      const now = Date.now();
      for (const [, list, key] of sections()) {
        if (!list.length) continue;
        li(tr(key), "lsh");
        for (const t of list.slice(0, 3)) li(t);
      }
      if (board.history.length) {
        li(tr("v2.list.history"), "lsh");
        board.history.slice(0, 3).forEach((h, i) => {
          const x = li(h.head + (h.reason && h.reason !== "cap" && h.reason !== "dismissed" ? " (" + dimLabel(h.reason) + ")" : ""));
          if (i === 0 && h.entry && now - h.at <= V.UNDO_MS)
            x.append(
              " ",
              button("b undo", tr("v2.undo"), () => restoreLast()),
            );
        });
      }
    }
    if (!ul.children.length) {
      const x = document.createElement("li");
      x.textContent = tr("v2.list.empty");
      ul.append(x);
    }
    const lh = span("lh", title);
    lh.dir = "auto";
    listBox.append(lh, ul);
    listBox.style.display = "block";
  }
  /** Brings back the card that left last (30 s window). Used by the hotkey and the history list. */
  function restoreLast() {
    const e = board.restoreLast(Date.now());
    if (e) {
      drawnHero = ""; // the pulse plays for the restored hero
      d.announce(tr("v2.restored"), e.head, true);
      draw();
    }
    return !!e;
  }

  // ---- AI state ----
  function drawAi() {
    drawKindPill();
    aiBar.replaceChildren();
    aiBar.style.display = view.ai === "offline" ? "flex" : "none";
    if (view.ai === "offline") aiBar.append(span("", tr("v2.ai.offline")));
    aiPill.style.display = view.ai === "paused" ? "inline-block" : "none"; // "" would fall back to the stylesheet's display:none and the pill never showed
    aiPill.textContent = view.ai === "paused" ? tr("v2.ai.paused") : "";
    document.body.classList.toggle("ai-offline", view.ai === "offline");
    document.body.classList.toggle("ai-paused", view.ai === "paused");
  }

  // ---- the kind of call (read only; the Wingman window changes it) ----
  const BUILTIN_KINDS = ["client", "support", "vendor", "team", "consult", "personal", "interview", "other"];
  /** The pill text for a kind id: a built-in kind in the window language, a custom mode by its own id. */
  const kindWord = (k) => (BUILTIN_KINDS.includes(k) ? tr("kind." + k) : k);
  function drawKindPill() {
    const k = view.kind;
    kindPill.style.display = k ? "inline-block" : "none";
    kindPill.textContent = k ? (view.kindLocked ? kindWord(k) : tr("mode.pill.auto", { kind: kindWord(k) })) : "";
    kindPill.title = k ? tr(view.kindLocked ? "mode.pill.title" : "mode.pill.titleAuto") : "";
    kindPill.dataset.locked = view.kindLocked ? "1" : "0";
  }

  // ---- idle: "What I understand so far" ----
  /** Fills the idle box. `frame` is the call frame row (kind, checklist) used when no view row came yet. Returns true when it shows what it knows. */
  function drawIdle(active, frame) {
    idleBox.replaceChildren();
    const kindKey = view.kind || (frame && frame.kind) || "";
    const kind = kindKey
      ? tr("kind." + (["client", "support", "vendor", "team", "consult", "personal", "interview"].includes(kindKey) ? kindKey : "other"))
      : "";
    const must = frame && Array.isArray(frame.checklist) ? frame.checklist.filter((c) => c && c.must && !c.done).map((c) => String(c.item)) : [];
    const cover = view.cover.length ? view.cover : must;
    const known = !!(view.topic || view.open.length || cover.length);
    idleBox.style.display = active && (known || kind) ? "flex" : "none";
    if (!active || !(known || kind)) return false;
    const head = span("it", known ? tr("v2.idle.title") : tr("v2.idle.listening", { kind }));
    head.dir = "auto";
    idleBox.append(head);
    const line = (key, t) => {
      const l = div("il", "auto");
      mixed(l, tr(key, { t }));
      idleBox.append(l);
    };
    if (view.topic) line("v2.idle.topic", view.topic);
    for (const o of view.open.slice(0, 2)) line("v2.idle.open", o);
    if (cover.length) line("v2.idle.cover", cover[0]);
    return known;
  }

  // ---- Catch me up sheet ----
  // The sheet shows, in this order: the streamed recap from the engine (when it came), else the recap made from the notes (view.recap).
  // recap = { status, reqId, live }. status: closed | open (notes only, nothing asked) | loading | streaming | done | error.
  // Only a request made here (the button's retry, the hotkey) lets engine rows in; with status "closed" every row is dropped, so a closed sheet stays closed
  // and an old recap replayed after a reload or a new call cannot open it. Whether the sheet is on screen is the sheet value (d.sheet), not this object.
  // live: null = nothing asked; { phase: start | delta | done | error, text, recap, offline, notes } = the engine's answer so far.
  const recap = { status: "closed", reqId: 0, live: null };
  const recapShown = () => d.sheet() === "recap";
  /** `arrived` = how many of the five sections have started to come in (the rest show a skeleton while loading). */
  const liveRecap = () => {
    const live = recap.live;
    const fromNotes = V.recapEmpty(view.recap) ? 0 : 5;
    if (!live) return { recap: view.recap, status: "", arrived: 5 };
    if (live.recap) return { recap: live.recap, status: live.offline || live.notes ? "notes" : "", arrived: 5 };
    if (live.text) {
      const p = WingmanMemView.parseRecapText(live.text);
      if (p.labels) {
        const going = live.phase === "delta" || live.phase === "start";
        return { recap: p.recap, status: going ? "loading" : "", arrived: going ? p.labels : 5 };
      }
    }
    if (live.phase === "error") return { recap: view.recap, status: "error", arrived: 5 };
    if (live.offline || live.notes) return { recap: view.recap, status: "notes", arrived: 5 };
    return { recap: view.recap, status: "loading", arrived: fromNotes };
  };
  /** The sheet changed (app.js calls this after every change of the sheet value): keeps the recap status in step and draws the content when it is open. */
  function sheetChanged(was, now) {
    if (was === "recap" && now !== "recap") {
      // closed: an unfinished request is given up, so its late rows are dropped and a reopen shows the notes
      if (recap.status === "loading" || recap.status === "streaming") recap.live = null;
      recap.status = "closed";
    } else if (now === "recap" && recap.status === "closed") recap.status = recap.live ? "done" : "open";
    if (now === "recap") drawRecap();
  }
  /** Draws the content of the sheet. Never opens or closes it, and never touches the close timer (app.js sets it once, when the sheet opens). */
  function drawRecap() {
    recapBox.replaceChildren();
    const h = div("rh", "auto");
    h.append(
      span("rt", tr("v2.recap.title")),
      button("b x", tr("v2.recap.close"), () => d.setSheet("none")),
    );
    recapBox.append(h);
    const { recap: rc, status, arrived } = liveRecap();
    if (status) {
      const st = div("rstatus " + status, "auto");
      st.setAttribute("role", "status");
      st.append(span("", tr(status === "loading" ? "v2.recap.loading" : status === "notes" ? "v2.recap.notes" : "v2.recap.error")));
      if (status === "error") st.append(button("b retry", tr("v2.recap.retry"), () => requestRecap()));
      recapBox.append(st);
    }
    let idx = 0;
    const sec = (key, content) => {
      const s = div("rs", "auto");
      s.append(span("rk", tr(key)));
      const body = div("rb", "auto");
      if (status === "loading" && idx++ >= arrived) {
        // not here yet: two grey bars instead of "..."; the sections that did arrive are already drawn above
        s.classList.add("skel");
        for (const w of ["w90", "w60"]) {
          const bar = span("sk " + w);
          bar.setAttribute("aria-hidden", "true");
          body.append(bar);
        }
      } else if (Array.isArray(content) && content.length) {
        const ul = document.createElement("ul");
        ul.dir = "auto";
        for (const t of content.slice(0, 3)) {
          const li = document.createElement("li");
          li.dir = "auto";
          mixed(li, t);
          ul.append(li);
        }
        body.append(ul);
      } else if (typeof content === "string" && content) mixed(body, content);
      else body.textContent = tr("v2.recap.none");
      s.append(body);
      recapBox.append(s);
    };
    sec("v2.recap.where", rc.where);
    sec("v2.recap.decided", rc.decided);
    sec("v2.recap.open", rc.open);
    sec("v2.recap.promised", rc.promised);
    sec("v2.recap.asked", rc.asked);
  }
  /** Opens the sheet (from notes at once) and asks the engine for a fresh recap. */
  function requestRecap() {
    recap.reqId++;
    recap.live = { phase: "start", text: "", recap: null, offline: false, notes: false };
    recap.status = "loading";
    d.controls.recap();
    if (recapShown()) drawRecap();
    else d.setSheet("recap"); // sheetChanged keeps "loading": the status is already set
  }
  recapBox.addEventListener("click", (ev) => {
    if (ev.target.closest && ev.target.closest(".retry")) return;
    d.setSheet("none");
  });
  const CONTROL_CLASS = { pin: "pin", useful: "up", notuseful: "down", dismiss: "x", fewer: "fewer" };

  // ---- one draw ----
  function draw() {
    const fk = fkOf();
    drawHero();
    drawChips();
    drawList();
    drawAi();
    refocus(fk);
    const any = !!board.hero || board.chips.length > 0 || hasView;
    document.body.classList.toggle("has-v2", any);
    watchBox.style.display = board.chips.length || hasView || board.history.length ? "flex" : "none";
    document.body.classList.toggle("has-hero", !!board.hero);
    if (recapShown()) drawRecap();
    d.onChange();
  }

  // Keys, when the window has the keyboard focus: Tab moves between the card and its buttons, Enter opens More, Esc dismisses (or closes a sheet first), P pins, 1 and 2 rate.
  document.addEventListener("keydown", (ev) => {
    if (ev.defaultPrevented) return;
    const t = ev.target;
    if (t && /^(input|textarea|select)$/i.test(t.tagName || "")) return;
    if (ev.key === "Escape" && (d.sheet() !== "none" || openList || menuFor)) {
      d.setSheet("none");
      openList = "";
      closeMenu();
      draw();
      ev.preventDefault();
      return;
    }
    const act = V.keyAction(ev);
    if (!act || !t || !heroBox.contains(t)) return;
    if (act === "more" && t !== heroBox.firstElementChild) return; // Enter on a button presses that button
    if (api.control(act)) ev.preventDefault();
  });

  setInterval(() => {
    const now = Date.now();
    const a = board.tick(now);
    const b = board.markSeen(now); // a rail chip loses its "new" dot after SEEN_MS on the rail
    if (a || b) draw();
    else tickAge(now);
  }, 1000);

  const api = {
    board,
    /** Routes a card row. Returns true when v2 took it (a v2 card, or a closing/withdraw row for a card it holds). */
    handleCard(row) {
      if (!row || typeof row !== "object") return false;
      const known = board.has(row.id);
      if (!V.isV2(row) && !(known && (row.withdraw || V.CLOSES.includes(row.closes)))) return false;
      if (V.isV2(row) && V.CLOSES.includes(row.closes) && !known) return true; // update row for a card that already left: nothing to do
      const now = Date.now();
      if (!known && V.isV2(row) && !row.withdraw && !V.CLOSES.includes(row.closes)) {
        // a new card: a Check, the first card, and the first one after a long quiet are announced to a screen reader; the others are silent
        if (V.shouldAnnounce(V.kindOf(row), lastCardAt, now)) announceIds.add(String(row.id));
        lastCardAt = now;
        if (!(Number(row.at) && now - Number(row.at) > 60000) && !d.paused()) d.cardShown(); // a hidden (paused) card does not count toward the key hints // a replayed old row (page reload) is not a new card for the hint count
      }
      board.apply(row, now);
      draw();
      return true;
    },
    handleView(row) {
      view = V.normView(row);
      hasView = true;
      draw();
    },
    get view() {
      return view;
    },
    drawIdle,
    /** A Check is on screen (live): a live nudge waits while it is. */
    checkLive: () => [...board.cards.values()].some((e) => e.kind === "check" && e.state === "live"),
    requestRecap,
    sheetChanged,
    drawRecap,
    /** The recap state, for tests and the page: { status, reqId }. */
    get recap() {
      return { status: recap.status, reqId: recap.reqId };
    },
    /** The hotkey: closes the sheet when it is open, else opens it and asks for a fresh recap. */
    hotkeyRecap: () => (recapShown() ? d.setSheet("none") : requestRecap()),
    /** A { phase, text, recap } payload from the engine's recap rows. Dropped unless a request made here is waiting (status loading or streaming). */
    handleRecap(p) {
      if (!p || typeof p !== "object") return;
      if (recap.status !== "loading" && recap.status !== "streaming") return;
      if (p.phase === "start") {
        recap.live = { phase: "start", text: "", recap: null, offline: false, notes: false };
        recap.status = "loading";
      } else {
        recap.live = { phase: p.phase, text: p.text || (recap.live && recap.live.text) || "", recap: p.recap || null, offline: !!p.offline, notes: !!p.notes };
        recap.status = p.phase === "delta" ? "streaming" : p.phase === "error" ? "error" : p.phase === "done" ? "done" : "loading";
      }
      if (recapShown()) drawRecap();
    },
    /** A card control pressed on the keyboard (the window never takes focus): does what the button on the hero does. */
    control(name) {
      if (name === "more") {
        // tap on the card: open or close the detail
        const e = board.hero;
        if (!e || !expandable(e)) return false;
        toggleExpand(e.id);
        return true;
      }
      const cls = CONTROL_CLASS[name];
      const b = cls && heroBox.querySelector(".hcard .b." + cls);
      if (b) b.click();
      return !!b;
    },
    restoreLast,
    setPins(ids) {
      board.setPins(ids);
      draw();
    },
    redraw: draw,
    hasContent: () => !!board.hero || board.chips.length > 0,
    reset() {
      board.clear();
      view = V.normView({});
      hasView = false;
      openList = "";
      closeMenu();
      expanded.clear();
      flashUntil.clear();
      announceIds.clear();
      lastCardAt = 0;
      drawnHero = "";
      recap.status = "closed";
      recap.live = null; // app.js closes the sheet itself (setSheet("none")) before this
      draw();
    },
  };
  return api;
}
