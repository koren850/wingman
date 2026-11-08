"use strict";
// Answer window v2 view: draws the hero card, the WATCHING chips, the idle view, the Catch me up sheet and the AI bars.
// Classic script (loaded before app.js). app.js calls createV2View(deps) once and routes rows to it. Text is always set with textContent / text nodes (card text comes from the call).
// The model (which card is hero, lifetime, controls) lives in v2.js; this file only draws it.
/* global WingmanV2, WingmanMemView, WingmanText */
function createV2View(d) {
  const { tr, mixed, div, span } = d;
  const V = WingmanV2;
  const board = new V.Board();
  let view = V.normView({});
  let hasView = false;
  let openList = ""; // "" | open | promises | cover | history
  const expanded = new Set(); // ids whose detail is open
  let drawnHero = ""; // id of the hero drawn last (the rise animation plays only for a new one)
  let listTimer;
  let recapTimer;
  let copiedAt = 0;

  const heroBox = document.getElementById("hero"),
    watchBox = document.getElementById("watch"),
    chipsBox = document.getElementById("chips"),
    listBox = document.getElementById("wlist"),
    idleBox = document.getElementById("idle"),
    recapBox = document.getElementById("recap"),
    aiBar = document.getElementById("aibar"),
    aiPill = document.getElementById("aipill");

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

  // ---- hero ----
  let menuFor = ""; // id of the card whose overflow menu is open
  let menuTimer;
  const closeMenu = () => {
    menuFor = "";
    clearTimeout(menuTimer);
  };
  /** Thumbs and the overflow button. Pin, Copy and Dismiss wait in the menu row (hmenu), which is always built so the keyboard hotkeys can press them. */
  function ctl(e, dir) {
    const row = div("hctl", dir);
    row.append(
      iconButton("up", "up", tr("v2.useful"), () => rate(e, "useful"), e.rating === "useful"),
      iconButton("down", "down", tr("v2.notUseful"), () => rate(e, "not_useful"), e.rating === "not_useful"),
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
    row.append(m);
    return row;
  }
  function menuRow(e, dir) {
    const row = div("hmenu", dir);
    row.style.display = menuFor === e.id ? "flex" : "none";
    const add = (cls, label, onClick, pressed) => {
      const b = button("b " + cls, label, () => (closeMenu(), onClick()));
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
  const freshClass = (e, now) => (e.pinned || e.state === "dim" ? "" : " age-" + V.freshLevel(now - e.at));

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
    const cd = WingmanText.isLatin(e.head) ? "ltr" : "rtl"; // the card follows the direction of its own text; the rail and pills follow the window language
    const el = div(`hcard k-${e.kind}${e.state === "dim" ? " dim" : ""}${e.pinned ? " pinned" : ""}${isNew ? " pulse" : ""}${freshClass(e, now)}`, cd);
    el.dataset.id = e.id;
    if (e.detail.length) {
      el.classList.add("tappable");
      el.title = tr("v2.tap");
      el.setAttribute("aria-expanded", String(expanded.has(e.id)));
      el.addEventListener("click", () => {
        closeMenu();
        expanded.has(e.id) ? expanded.delete(e.id) : expanded.add(e.id);
        draw();
      });
    } else el.addEventListener("click", () => menuFor && (closeMenu(), draw()));
    const top = div("htop", cd);
    const pill = span("pill");
    pill.append(span("gl", GLYPH[e.kind]), document.createTextNode(kindLabel(e.kind)));
    top.append(pill);
    const age = span("hage", ageText(now - e.at));
    age.setAttribute("aria-hidden", "true");
    top.append(age);
    if (e.state === "dim") top.append(span("dimwhy", dimLabel(e.reason)));
    else if (e.pinned) top.append(span("pinmark", tr("v2.pin")));
    if (e.detail.length) {
      const c = span("hexp", expanded.has(e.id) ? "▴" : "▾");
      c.setAttribute("aria-hidden", "true");
      top.append(c);
    }
    top.append(ctl(e, cd));
    el.append(top);
    const say = div("hsay", "auto");
    mixed(say, e.head);
    if (e.kind === "prompt") {
      // a prompt is something to say: it reads as speech, "Ask: ..."
      const k = document.createElement("bdi");
      k.className = "lk hask";
      k.textContent = tr("v2.ask");
      say.prepend(k, document.createTextNode(" "));
    }
    el.append(say);
    if (expanded.has(e.id) && e.detail.length) {
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
    if (e.why) {
      const w = div("hwhy", "auto");
      labelled(w, tr("v2.why"), e.why);
      el.append(w);
    }
    el.append(menuRow(e, cd));
    heroBox.append(el);
    if (isNew && e.state === "live") d.announce(kindLabel(e.kind), e.head, true);
    drawnHero = e.id;
  }
  /** Once a second: the age text and the fade level of the hero, without rebuilding it (a rebuild would restart the pulse and re-announce). */
  function tickAge(now) {
    const e = board.hero;
    const el = heroBox.firstElementChild;
    if (!e || !el) return;
    const t = el.querySelector(".hage");
    const txt = ageText(now - e.at);
    if (t && t.textContent !== txt) t.textContent = txt;
    for (const n of [1, 2, 3]) el.classList.remove("age-" + n);
    const f = freshClass(e, now).trim();
    if (f) el.classList.add(f);
  }

  // ---- rail (one row of at most 3 labelled chips), "+N", and the pills row ----
  const counts = () => [
    ["open", view.open, "v2.open", "v2.list.open"],
    ["promises", view.promises, "v2.promises", "v2.list.promises"],
    ["cover", view.cover, "v2.cover", "v2.list.cover"],
  ];
  function toggleList(name) {
    openList = openList === name ? "" : name;
    clearTimeout(listTimer);
    if (openList) listTimer = setTimeout(() => ((openList = ""), draw()), 20000);
    draw();
  }
  function chipFor(e) {
    const isNew = !e.seen && e.state === "live";
    const c = button(`chip card k-${e.kind}${e.state === "dim" ? " dim" : ""}${isNew ? " isnew" : ""}`, null, () => {
      if (e.kind === "fact") return;
      board.promote(e.id);
      draw();
    });
    c.append(span("kdot"));
    const t = span("ct");
    t.dir = "auto";
    mixed(t, e.label);
    c.append(t);
    if (e.kind === "fact" && e.src) {
      const s = span("src", tr("v2.src." + e.src));
      c.append(s);
    }
    if (isNew) {
      const n = span("ndot");
      n.setAttribute("aria-hidden", "true");
      c.append(n);
    }
    c.title = e.head;
    c.setAttribute("aria-label", tr("v2.chip.show", { text: e.label }) + (isNew ? ", " + tr("v2.chip.new") : ""));
    return c;
  }
  function drawChips() {
    chipsBox.replaceChildren();
    const { shown, more } = board.rail();
    const rail = div("rail");
    for (const e of shown) rail.append(chipFor(e));
    if (more.length) {
      const anyNew = more.some((e) => !e.seen && e.state === "live");
      const b = button("chip count morecards" + (openList === "cards" ? " on" : "") + (anyNew ? " isnew" : ""), tr("v2.chip.more", { n: more.length }), () =>
        toggleList("cards"),
      );
      b.setAttribute("aria-expanded", String(openList === "cards"));
      if (anyNew) b.append(span("ndot"));
      rail.append(b);
    }
    rail.style.display = shown.length ? "flex" : "none";
    chipsBox.append(rail);
    const pills = div("pills");
    for (const [name, list, key] of counts()) {
      if (!list.length) continue;
      const b = button("chip count " + name + (openList === name ? " on" : ""), tr(key, { n: list.length }), () => toggleList(name));
      b.setAttribute("aria-expanded", String(openList === name));
      pills.append(b);
    }
    if (board.history.length)
      pills.append(
        button("chip count hist" + (openList === "history" ? " on" : ""), tr("v2.list.history") + " " + board.history.length, () => toggleList("history")),
      );
    pills.append(button("chip recapbtn", tr("v2.recap.button"), () => toggleRecap()));
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
    const li = (content) => {
      const x = document.createElement("li");
      x.dir = "auto";
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
        b.append(span("kdot"));
        const t = span("ct");
        t.dir = "auto";
        mixed(t, e.head);
        b.append(t);
        li(b);
      }
    } else if (openList === "history") {
      title = tr("v2.list.history");
      const now = Date.now();
      board.history.slice(0, 8).forEach((h, i) => {
        const x = li(h.head + (h.reason && h.reason !== "cap" && h.reason !== "dismissed" ? " (" + dimLabel(h.reason) + ")" : ""));
        if (i === 0 && h.entry && now - h.at <= V.UNDO_MS)
          x.append(
            " ",
            button("b undo", tr("v2.undo"), () => restoreLast()),
          );
      });
    } else {
      const c = counts().find((x) => x[0] === openList);
      title = tr(c[3]);
      for (const t of c[1].slice(0, 6)) li(t);
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
    aiBar.replaceChildren();
    aiBar.style.display = view.ai === "offline" ? "flex" : "none";
    if (view.ai === "offline") aiBar.append(span("", tr("v2.ai.offline")));
    aiPill.style.display = view.ai === "paused" ? "" : "none";
    aiPill.textContent = view.ai === "paused" ? tr("v2.ai.paused") : "";
    document.body.classList.toggle("ai-offline", view.ai === "offline");
    document.body.classList.toggle("ai-paused", view.ai === "paused");
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
  // recapLive: null = nothing asked; { phase: start | delta | done | error, text, recap, offline, notes } = the engine's answer so far.
  let recapLive = null;
  const recapOpen = () => recapBox.style.display === "flex";
  /** `arrived` = how many of the five sections have started to come in (the rest show a skeleton while loading). */
  const liveRecap = () => {
    const fromNotes = V.recapEmpty(view.recap) ? 0 : 5;
    if (!recapLive) return { recap: view.recap, status: "", arrived: 5 };
    if (recapLive.recap) return { recap: recapLive.recap, status: recapLive.offline || recapLive.notes ? "notes" : "", arrived: 5 };
    if (recapLive.text) {
      const p = WingmanMemView.parseRecapText(recapLive.text);
      if (p.labels) {
        const going = recapLive.phase === "delta" || recapLive.phase === "start";
        return { recap: p.recap, status: going ? "loading" : "", arrived: going ? p.labels : 5 };
      }
    }
    if (recapLive.phase === "error") return { recap: view.recap, status: "error", arrived: 5 };
    if (recapLive.offline || recapLive.notes) return { recap: view.recap, status: "notes", arrived: 5 };
    return { recap: view.recap, status: "loading", arrived: fromNotes };
  };
  function toggleRecap(on) {
    const open = on === undefined ? !recapOpen() : on;
    clearTimeout(recapTimer);
    recapBox.style.display = open ? "flex" : "none";
    if (!open) return;
    recapBox.replaceChildren();
    const h = div("rh", "auto");
    h.append(
      span("rt", tr("v2.recap.title")),
      button("b x", tr("v2.recap.close"), () => toggleRecap(false)),
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
    recapTimer = setTimeout(() => toggleRecap(false), 45000);
  }
  /** Opens the sheet (from notes at once) and asks the engine for a fresh recap. */
  function requestRecap() {
    recapLive = { phase: "start", text: "", recap: null, offline: false, notes: false };
    d.controls.recap();
    toggleRecap(true);
  }
  recapBox.addEventListener("click", (ev) => {
    if (ev.target.closest && ev.target.closest(".retry")) return;
    toggleRecap(false);
  });
  const CONTROL_CLASS = { pin: "pin", useful: "up", notuseful: "down", dismiss: "x" };

  // ---- one draw ----
  function draw() {
    drawHero();
    drawChips();
    drawList();
    drawAi();
    const any = !!board.hero || board.chips.length > 0 || hasView;
    document.body.classList.toggle("has-v2", any);
    watchBox.style.display = board.chips.length || hasView || board.history.length ? "flex" : "none";
    document.body.classList.toggle("has-hero", !!board.hero);
    if (recapOpen()) toggleRecap(true);
    d.onChange();
  }

  setInterval(() => {
    const now = Date.now();
    const a = board.tick(now);
    const b = board.markSeen(now); // a rail chip loses its "new" dot after SEEN_MS on the rail
    if (a || b) draw();
    else tickAge(now);
  }, 1000);

  return {
    board,
    /** Routes a card row. Returns true when v2 took it (a v2 card, or a closing/withdraw row for a card it holds). */
    handleCard(row) {
      if (!row || typeof row !== "object") return false;
      const known = board.has(row.id);
      if (!V.isV2(row) && !(known && (row.withdraw || V.CLOSES.includes(row.closes)))) return false;
      if (V.isV2(row) && V.CLOSES.includes(row.closes) && !known) return true; // update row for a card that already left: nothing to do
      board.apply(row, Date.now());
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
    toggleRecap,
    requestRecap,
    /** The hotkey: closes the sheet when it is open, else opens it and asks for a fresh recap. */
    hotkeyRecap: () => (recapOpen() ? toggleRecap(false) : requestRecap()),
    /** A { phase, text, recap } payload from the engine's recap rows. */
    handleRecap(p) {
      if (!p || typeof p !== "object") return;
      if (p.phase === "start") recapLive = { phase: "start", text: "", recap: null, offline: false, notes: false };
      else recapLive = { phase: p.phase, text: p.text || (recapLive && recapLive.text) || "", recap: p.recap || null, offline: !!p.offline, notes: !!p.notes };
      toggleRecap(true);
    },
    /** A card control pressed on the keyboard (the window never takes focus): does what the button on the hero does. */
    control(name) {
      if (name === "more") {
        // tap on the card: open or close the detail
        const e = board.hero;
        if (!e || !e.detail.length) return false;
        expanded.has(e.id) ? expanded.delete(e.id) : expanded.add(e.id);
        draw();
        return true;
      }
      const cls = CONTROL_CLASS[name];
      const b = cls && heroBox.querySelector(".hcard .b." + cls);
      if (b) b.click();
      return !!b;
    },
    restoreLast,
    redraw: draw,
    hasContent: () => !!board.hero || board.chips.length > 0,
    reset() {
      board.clear();
      view = V.normView({});
      hasView = false;
      openList = "";
      closeMenu();
      expanded.clear();
      drawnHero = "";
      recapBox.style.display = "none";
      recapLive = null;
      draw();
    },
  };
}
