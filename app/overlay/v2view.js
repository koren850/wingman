"use strict";
// Answer window v2 view: draws the hero card, the WATCHING chips, the idle view, the Catch me up sheet and the AI bars.
// Classic script (loaded before app.js). app.js calls createV2View(deps) once and routes rows to it. Text is always set with textContent / text nodes (card text comes from the call).
// The model (which card is hero, lifetime, controls) lives in v2.js; this file only draws it.
/* global WingmanV2 */
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
  const kindLabel = (k) => tr("v2.kind." + k);
  const dimLabel = (r) => tr("v2.dim." + (r === "answered" || r === "topic" ? r : "time"));
  const shortText = (s) => String(s).split(/\s+/).slice(0, 6).join(" ");

  // ---- hero ----
  function ctl(e) {
    const row = div("hctl", "auto");
    const add = (cls, label, onClick, pressed) => {
      const b = button("b " + cls, label, onClick);
      if (pressed !== undefined) b.setAttribute("aria-pressed", String(pressed));
      row.append(b);
      return b;
    };
    if (e.detail.length)
      add(
        "more",
        expanded.has(e.id) ? tr("v2.less") : tr("v2.more"),
        () => (expanded.has(e.id) ? expanded.delete(e.id) : expanded.add(e.id), draw()),
        expanded.has(e.id),
      );
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
    add("up", tr("v2.useful"), () => rate(e, "useful"), e.rating === "useful");
    add("down", tr("v2.notUseful"), () => rate(e, "not_useful"), e.rating === "not_useful");
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

  function drawHero() {
    const e = board.hero;
    heroBox.replaceChildren();
    heroBox.style.display = e ? "block" : "none";
    if (!e) {
      drawnHero = "";
      return;
    }
    const el = div(`hcard k-${e.kind}${e.state === "dim" ? " dim" : ""}${e.pinned ? " pinned" : ""}${drawnHero !== e.id ? " rise" : ""}`, "auto");
    const top = div("htop", "auto");
    const pill = span("pill");
    pill.append(span("gl", GLYPH[e.kind]), document.createTextNode(kindLabel(e.kind)));
    top.append(pill);
    if (e.state === "dim") top.append(span("dimwhy", dimLabel(e.reason)));
    else if (e.pinned) top.append(span("pinmark", tr("v2.pin")));
    el.append(top);
    const say = div("hsay", "auto");
    mixed(say, e.head);
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
      mixed(w, tr("v2.because", { why: e.why }));
      el.append(w);
    }
    el.append(ctl(e));
    heroBox.append(el);
    if (drawnHero !== e.id && e.state === "live") d.announce(kindLabel(e.kind), e.head);
    drawnHero = e.id;
  }

  // ---- watching chips + their list ----
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
  function drawChips() {
    chipsBox.replaceChildren();
    for (const [name, list, key] of counts()) {
      if (!list.length) continue;
      const b = button("chip count " + name + (openList === name ? " on" : ""), tr(key, { n: list.length }), () => toggleList(name));
      b.setAttribute("aria-expanded", String(openList === name));
      chipsBox.append(b);
    }
    for (const e of board.chips) {
      const c = button(`chip card k-${e.kind}${e.state === "dim" ? " dim" : ""}`, null, () => {
        if (e.kind === "fact") return;
        board.promote(e.id);
        draw();
      });
      c.append(span("gl", GLYPH[e.kind]));
      const t = span("ct");
      t.dir = "auto";
      t.textContent = shortText(e.head);
      c.append(t);
      c.title = e.head;
      c.setAttribute("aria-label", tr("v2.chip.show", { text: e.head }));
      chipsBox.append(c);
    }
    if (board.history.length)
      chipsBox.append(
        button("chip count hist" + (openList === "history" ? " on" : ""), tr("v2.list.history") + " " + board.history.length, () => toggleList("history")),
      );
    chipsBox.append(button("chip recapbtn", tr("v2.recap.button"), () => toggleRecap()));
  }
  function drawList() {
    listBox.replaceChildren();
    if (!openList) {
      listBox.style.display = "none";
      return;
    }
    let title = "",
      rows = [];
    if (openList === "history") {
      title = tr("v2.list.history");
      rows = board.history.slice(0, 8).map((h) => h.head + (h.reason && h.reason !== "cap" && h.reason !== "dismissed" ? " (" + dimLabel(h.reason) + ")" : ""));
    } else {
      const c = counts().find((x) => x[0] === openList);
      title = tr(c[3]);
      rows = c[1];
    }
    const lh = span("lh", title);
    lh.dir = "auto";
    listBox.append(lh);
    const ul = document.createElement("ul");
    ul.dir = "auto";
    for (const t of rows.slice(0, 6)) {
      const li = document.createElement("li");
      li.dir = "auto";
      mixed(li, t);
      ul.append(li);
    }
    if (!rows.length) {
      const li = document.createElement("li");
      li.textContent = tr("v2.list.empty");
      ul.append(li);
    }
    listBox.append(ul);
    listBox.style.display = "block";
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
  const recapOpen = () => recapBox.style.display === "flex";
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
    const rc = view.recap;
    const sec = (key, content) => {
      const s = div("rs", "auto");
      s.append(span("rk", tr(key)));
      const body = div("rb", "auto");
      if (Array.isArray(content) && content.length) {
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
  recapBox.addEventListener("click", () => toggleRecap(false));

  // ---- one draw ----
  function draw() {
    drawHero();
    drawChips();
    drawList();
    drawAi();
    const any = !!board.hero || board.chips.length > 0 || hasView;
    document.body.classList.toggle("has-v2", any);
    watchBox.style.display = board.chips.length || hasView || board.history.length ? "flex" : "none";
    if (recapOpen()) toggleRecap(true);
    d.onChange();
  }

  setInterval(() => {
    if (board.tick(Date.now())) draw();
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
    redraw: draw,
    hasContent: () => !!board.hero || board.chips.length > 0,
    reset() {
      board.clear();
      view = V.normView({});
      hasView = false;
      openList = "";
      expanded.clear();
      drawnHero = "";
      recapBox.style.display = "none";
      draw();
    },
  };
}
