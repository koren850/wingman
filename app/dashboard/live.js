"use strict";
// Home: the live conversation during a call. Who says what (Them / Me, mm:ss), each answer card pinned under the line it answered (a "For you" card sits under the user's own question).
// Data comes from the main process (it tails transcript.jsonl and cards.jsonl) over the guarded "live:update" channel; the feed module
// validates and caps everything again here. Call text only ever enters the page through textContent / text nodes.
// LV: feed = in-memory WingmanLive feed; auto = follow the newest line; els = DOM nodes by key ("l<n>" line, "c<id>" card) so a redraw only adds, moves or removes;
// lastSeen = last line number seen by the user (for the "N new" count); hydrating = call id whose snapshot is being fetched.
const LV = { feed: WingmanLive.create(), callId: "", auto: true, els: new Map(), raf: 0, lastSeen: 0, hydrating: "" };
const LV_KIND = {
  client: "Client",
  support: "Support",
  vendor: "Vendor",
  team: "Team",
  consult: "Consult",
  personal: "Personal",
  interview: "Interview",
  other: "Other",
};

/** Take one payload from main ("live:update" or a liveGet snapshot): { callId, reset, lines, cards, frame }. Checked again here, because the page does not trust the channel blindly. reset clears first. Redraw is batched to one animation frame. */
function liveApply(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return;
  if (typeof p.callId !== "string" || p.callId.length > 60) return;
  if (p.reset) {
    LV.feed.clear();
    LV.lastSeen = 0;
  }
  LV.callId = p.callId;
  if (p.frame) LV.feed.setFrame(p.frame);
  if (p.names) LV.feed.setNames(p.names);
  const arr = (a, n) => (Array.isArray(a) ? a.slice(-n) : []);
  LV.feed.addLines(arr(p.lines, WingmanLive.MAX_LINES));
  LV.feed.addCards(arr(p.cards, 200));
  liveSchedule();
}
// At most one pending redraw per frame, however many payloads arrive.
function liveSchedule() {
  if (!LV.raf)
    LV.raf = requestAnimationFrame(() => {
      LV.raf = 0;
      liveRender();
    });
}

/** The right-hand column of Home while a call runs. Rebuilt with the column; its content comes from the feed kept in memory. */
function liveFeedPanel() {
  if (!H.showConv) return liveHiddenPanel();
  LV.els = new Map();
  const box = h("div", { id: "lf-scroll", class: "lf-scroll", role: "log", "aria-label": "Live conversation", "aria-live": "off", tabindex: "0" });
  box.addEventListener("scroll", liveOnScroll, { passive: true });
  const jump = h(
    "button",
    { type: "button", id: "lf-jump", class: "btn primary sm lf-jump", hidden: "", onclick: () => liveToEnd(true) },
    ico("chevron"),
    h("span", { id: "lf-jump-t" }, "Jump to latest"),
  );
  const sec = h(
    "section",
    { class: "card-big lf", "aria-labelledby": "lf-h" },
    h(
      "div",
      { class: "rhead" },
      h("h2", { id: "lf-h" }, "Live conversation"),
      h("span", { class: "grow" }),
      h("span", { id: "lf-state", class: "lf-state faint" }),
      btn("Card types", {
        id: "lf-types",
        cls: "ghost sm",
        icon: "help",
        title: "What the card names and colours mean",
        onclick: () => openShortcuts("types"),
      }),
      btn("Hide", {
        id: "lf-hide",
        cls: "ghost sm",
        icon: "x",
        onclick: () => {
          H.showConv = false;
          renderSide();
          const b = $("lf-show");
          if (b) b.focus();
        },
      }),
    ),
    h("div", { id: "lf-frame", class: "lf-frame", hidden: "" }),
    h("div", { class: "lf-body" }, box, h("div", { id: "lf-empty", class: "lf-empty" }), jump),
  );
  LV.auto = true;
  const id = state.call && state.call.callId;
  if (id && LV.callId !== id && LV.hydrating !== id) {
    // window opened mid-call: ask for what was heard so far
    LV.hydrating = id;
    api
      .liveGet(id)
      .then((p) => {
        LV.hydrating = "";
        if (p && p.callId === id) liveApply({ ...p, reset: true });
      })
      .catch(() => {
        LV.hydrating = "";
      });
  }
  requestAnimationFrame(liveRender);
  return sec;
}

/** The default while a call runs: the words are kept (and saved) but not drawn, so a shared screen never shows them by accident. */
function liveHiddenPanel() {
  LV.els = new Map();
  return h(
    "section",
    { class: "card-big lf-off", "aria-labelledby": "lf-h" },
    h("h2", { id: "lf-h" }, ico("transcript"), "Live conversation is hidden"),
    h("p", { class: "sub" }, "It is hidden so nothing from the call shows if you share your screen. Wingman keeps listening and saving it."),
    btn("Show conversation", {
      id: "lf-show",
      icon: "transcript",
      cls: "primary",
      onclick: () => {
        H.showConv = true;
        renderSide();
        const s = $("lf-scroll");
        if (s) s.focus({ preventScroll: true });
      },
    }),
    h("p", { class: "sub faint" }, "It hides again at the start of the next call."),
  );
}

// Within 48 px of the bottom counts as "following"; scrolling up pauses auto-scroll and shows the "Jump to latest" button.
const liveNearEnd = (b) => b.scrollHeight - b.scrollTop - b.clientHeight < 48;
function liveOnScroll() {
  const b = $("lf-scroll");
  if (!b) return;
  const near = liveNearEnd(b);
  if (near !== LV.auto) {
    LV.auto = near;
    liveChrome();
  }
  if (near) {
    const v = LV.feed.lines;
    LV.lastSeen = v.length ? v[v.length - 1].n : 0;
    liveChrome();
  }
}
function liveToEnd(announceIt) {
  const b = $("lf-scroll");
  if (!b) return;
  LV.auto = true;
  b.scrollTop = b.scrollHeight;
  const v = LV.feed.lines;
  LV.lastSeen = v.length ? v[v.length - 1].n : 0;
  liveChrome();
  if (announceIt) b.focus({ preventScroll: true });
}
function liveChrome() {
  const jump = $("lf-jump"),
    st = $("lf-state");
  if (!jump || !st) return;
  const lines = LV.feed.lines,
    fresh = lines.filter((l) => l.n > LV.lastSeen).length;
  jump.hidden = LV.auto;
  const t = $("lf-jump-t");
  if (t) t.textContent = fresh ? `Jump to latest (${fresh} new)` : "Jump to latest";
  st.textContent = !lines.length ? "" : LV.auto ? "Following" : "Paused: you scrolled up";
}

/** One transcript line (Me / Them, mm:ss from the call start). Text via rich() only; dir is set per line for Hebrew with English terms. */
function liveLineEl(l, t0) {
  const me = l.ch === "me",
    who = me ? "Me" : speakerName(l);
  const row = h(
    "div",
    { class: "lf-row " + (me ? "me" : "them"), dir: dirOf(l.text), role: "article", "aria-label": `${me ? "Me" : who} at ${WingmanLive.stamp(l.t, t0)}` },
    h(
      "div",
      { class: "lf-meta" },
      !me && Number.isInteger(l.spk) ? liveSpeakerChip(l, who) : chip(who, me ? "me" : "info"),
      h("span", { class: "lf-ts" }, WingmanLive.stamp(l.t, t0)),
    ),
    h("div", { class: "lf-tx", dir: dirOf(l.text), lang: langOf(l.text) }, rich(l.text)),
  );
  row._who = who;
  return row;
}
/** The other side's speaker chip as a button: click (or Enter / Space) swaps it for a small text field to rename that voice. */
function liveSpeakerChip(l, who) {
  const n = l.spk;
  const btnEl = h(
    "button",
    {
      type: "button",
      class: "chip info spk-btn",
      "aria-label": `Rename Speaker ${n}`,
      title: "Rename this speaker",
      onclick: () => liveRenameOpen(btnEl, n, who),
    },
    who,
  );
  return btnEl;
}
/** Inline rename: Enter saves (empty = clear the name), Escape or leaving the field cancels. Sends through the guarded call:cmd channel; the new name comes back via the cards file. */
function liveRenameOpen(btnEl, n, who) {
  const cur = LV.feed.names[n] || (who === `Speaker ${n}` ? "" : who);
  let closed = false;
  const input = h("input", {
    type: "text",
    class: "spk-input",
    maxlength: 40,
    value: cur,
    "aria-label": `Name for Speaker ${n}`,
    placeholder: `Speaker ${n}`,
    autocomplete: "off",
    spellcheck: "false",
    onkeydown: (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        save();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      }
    },
    onblur: () => close(false),
  });
  const close = (refocus) => {
    if (closed) return;
    closed = true;
    if (input.isConnected) input.replaceWith(btnEl);
    if (refocus) btnEl.focus();
  };
  const save = async () => {
    const v = input.value.replace(/\s+/g, " ").trim().slice(0, 40);
    close(true);
    if (v === cur) return;
    if (await act(() => api.speaker(n, v), "Renaming the speaker")) announce(v ? `Speaker ${n} is now ${v}` : `Speaker ${n} name cleared`);
  };
  btnEl.replaceWith(input);
  input.focus();
  input.select();
}
/** One answer card under its line. _sig lets liveRender replace it only when its text or dim state changed (AI cards stream in as new versions). */
function liveCardEl(c) {
  const kind = c.badge === "ai" && c.source === "calc" ? "calc" : c.badge;
  const label = (BADGE[kind] || [c.badge])[0];
  const el = h(
    "div",
    { class: `lf-card ${c.badge === "tip" ? "tipc" : c.badge}${c.dim ? " dim" : ""}`, dir: dirOf(c.say), role: "note", "aria-label": `${label} answer` },
    badgeChip(kind, label),
    h("div", { class: "lf-say", dir: dirOf(c.say), lang: langOf(c.say) }, rich(c.say)),
  );
  el._sig = c.badge + "|" + c.say + "|" + !!c.dim;
  return el;
}

/** Call frame header: kind, topic, goal and the checklist with ticks. Rebuilt only when the frame changed. */
function liveFrameRender() {
  const el = $("lf-frame");
  if (!el) return;
  const f = LV.feed.frame,
    sig = JSON.stringify(f);
  if (el._sig === sig) return;
  el._sig = sig;
  el.textContent = "";
  if (!f) {
    el.hidden = true;
    return;
  }
  const p = WingmanLive.frameProgress(f);
  const topic = f.topic || "";
  el.append(
    h(
      "div",
      { class: "lf-fhead" },
      chip(LV_KIND[f.kind] || "Other", "info", { dot: true }),
      h("span", { class: "lf-ftopic", dir: dirOf(topic), lang: langOf(topic) }, rich(topic)),
      h("span", { class: "grow" }),
      p.total
        ? h(
            "span",
            { class: "lf-fprog" + (p.done === p.total ? " all" : ""), "aria-label": `${p.done} of ${p.total} checklist items covered` },
            `${p.done}/${p.total}`,
          )
        : null,
    ),
  );
  if (f.goal) el.append(h("div", { class: "lf-fgoal", dir: dirOf(f.goal), lang: langOf(f.goal) }, rich(f.goal)));
  if (p.total)
    el.append(
      h(
        "ul",
        { class: "lf-check", "aria-label": "Call checklist" },
        f.checklist.map((c) =>
          h(
            "li",
            { class: c.done ? "done" : "" },
            h("span", { class: "lf-tick", "aria-hidden": "true" }, c.done ? ico("check") : null),
            h("span", { dir: dirOf(c.item), lang: langOf(c.item) }, rich(c.item)),
            h("span", { class: "sr" }, c.done ? " (covered)" : " (not covered yet)"),
          ),
        ),
      ),
    );
  el.hidden = false;
}

/** Sync the DOM to the feed without rebuilding it: keep nodes that did not change, add new ones, drop old ones, and fix the order. Keeps scroll position unless following. */
function liveRender() {
  const box = $("lf-scroll");
  if (!box) return;
  liveFrameRender();
  const { items, loose } = LV.feed.view();
  const t0 = WingmanLive.startOf(state.call && state.call.liveAt, items.length ? items[0].t : 0);
  const want = [];
  const keepCard = (c) => {
    const k = "c" + c.id;
    let el = LV.els.get(k);
    const sig = c.badge + "|" + c.say + "|" + !!c.dim;
    if (!el || el._sig !== sig) {
      const n = liveCardEl(c);
      if (el) el.replaceWith(n);
      el = n;
      LV.els.set(k, el);
    }
    want.push([k, el]);
  };
  for (const it of items) {
    const k = "l" + it.n;
    let el = LV.els.get(k);
    const who = it.ch === "me" ? "Me" : speakerName(it);
    if (!el || el._who !== who) {
      const n = liveLineEl(it, t0);
      if (el) el.replaceWith(n);
      el = n;
      LV.els.set(k, el);
    }
    want.push([k, el]);
    it.cards.forEach(keepCard);
  }
  loose.forEach(keepCard);
  const keys = new Set(want.map((w) => w[0]));
  for (const [k, el] of LV.els)
    if (!keys.has(k)) {
      el.remove();
      LV.els.delete(k);
    }
  let prev = null;
  for (const [, el] of want) {
    const at = prev ? prev.nextSibling : box.firstChild;
    if (at !== el) box.insertBefore(el, at);
    prev = el;
  }
  const empty = $("lf-empty");
  if (empty) {
    empty.hidden = !!want.length;
    if (!want.length && !empty.textContent)
      empty.textContent =
        state.call && state.call.phase === "waiting"
          ? "Waiting to start listening."
          : "Listening. What is said shows up here, with the answer cards under the line they answer.";
  }
  if (LV.auto) {
    box.scrollTop = box.scrollHeight;
    const v = LV.feed.lines;
    LV.lastSeen = v.length ? v[v.length - 1].n : 0;
  }
  liveChrome();
}

// Register once at load; the feed fills even while the live panel is hidden, so showing it later has everything.
api.onLive((p) => liveApply(p));
