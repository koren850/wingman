"use strict";
// Home: the live conversation during a call. Who says what (Them / Me, mm:ss), each answer card pinned under the line it answered (a "For you" card sits under Dan's own question).
// Data comes from the main process (it tails transcript.jsonl and cards.jsonl) over the guarded "live:update" channel; the feed module
// validates and caps everything again here. Call text only ever enters the page through textContent / text nodes.
const LV = { feed: WingmanLive.create(), callId: "", auto: true, els: new Map(), raf: 0, lastSeen: 0, hydrating: "" };
const LV_BADGE = { bank: ["Bank", "good"], ai: ["AI", "info"], stall: ["Stall", "warn"], tip: ["Tip", "me"], me: ["For you", "me"] };
const LV_KIND = { client: "Client", support: "Support", vendor: "Vendor", team: "Team", consult: "Consult", personal: "Personal", other: "Other" };

function liveApply(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return;
  if (typeof p.callId !== "string" || p.callId.length > 60) return;
  if (p.reset) { LV.feed.clear(); LV.lastSeen = 0; }
  LV.callId = p.callId;
  if (p.frame) LV.feed.setFrame(p.frame);
  const arr = (a, n) => (Array.isArray(a) ? a.slice(-n) : []);
  LV.feed.addLines(arr(p.lines, WingmanLive.MAX_LINES));
  LV.feed.addCards(arr(p.cards, 200));
  liveSchedule();
}
function liveSchedule() { if (!LV.raf) LV.raf = requestAnimationFrame(() => { LV.raf = 0; liveRender(); }); }

/** The right-hand column of Home while a call runs. Rebuilt with the column; its content comes from the feed kept in memory. */
function liveFeedPanel() {
  LV.els = new Map();
  const box = h("div", { id: "lf-scroll", class: "lf-scroll", role: "log", "aria-label": "Live conversation", "aria-live": "off", tabindex: "0" });
  box.addEventListener("scroll", liveOnScroll, { passive: true });
  const jump = h("button", { type: "button", id: "lf-jump", class: "btn primary sm lf-jump", hidden: "", onclick: () => liveToEnd(true) }, ico("chevron"), h("span", { id: "lf-jump-t" }, "Jump to latest"));
  const sec = h("section", { class: "card-big lf", "aria-labelledby": "lf-h" },
    h("div", { class: "rhead" }, h("h2", { id: "lf-h" }, "Live conversation"), h("span", { class: "grow" }), h("span", { id: "lf-state", class: "lf-state faint" })),
    h("div", { id: "lf-frame", class: "lf-frame", hidden: "" }),
    h("div", { class: "lf-body" }, box, h("div", { id: "lf-empty", class: "lf-empty" }), jump));
  LV.auto = true;
  const id = state.call && state.call.callId;
  if (id && LV.callId !== id && LV.hydrating !== id) {          // window opened mid-call: ask for what was heard so far
    LV.hydrating = id;
    api.liveGet(id).then((p) => { LV.hydrating = ""; if (p && p.callId === id) liveApply({ ...p, reset: true }); }).catch(() => { LV.hydrating = ""; });
  }
  requestAnimationFrame(liveRender);
  return sec;
}

const liveNearEnd = (b) => b.scrollHeight - b.scrollTop - b.clientHeight < 48;
function liveOnScroll() {
  const b = $("lf-scroll"); if (!b) return;
  const near = liveNearEnd(b);
  if (near !== LV.auto) { LV.auto = near; liveChrome(); }
  if (near) { const v = LV.feed.lines; LV.lastSeen = v.length ? v[v.length - 1].n : 0; liveChrome(); }
}
function liveToEnd(announceIt) {
  const b = $("lf-scroll"); if (!b) return;
  LV.auto = true; b.scrollTop = b.scrollHeight;
  const v = LV.feed.lines; LV.lastSeen = v.length ? v[v.length - 1].n : 0;
  liveChrome(); if (announceIt) b.focus({ preventScroll: true });
}
function liveChrome() {
  const jump = $("lf-jump"), st = $("lf-state"); if (!jump || !st) return;
  const lines = LV.feed.lines, fresh = lines.filter((l) => l.n > LV.lastSeen).length;
  jump.hidden = LV.auto;
  const t = $("lf-jump-t"); if (t) t.textContent = fresh ? `Jump to latest (${fresh} new)` : "Jump to latest";
  st.textContent = !lines.length ? "" : LV.auto ? "Following" : "Paused: you scrolled up";
}

function liveLineEl(l, t0) {
  const me = l.ch === "me";
  return h("div", { class: "lf-row " + (me ? "me" : "them"), role: "article", "aria-label": `${me ? "Me" : "Other side"} at ${WingmanLive.stamp(l.t, t0)}` },
    h("div", { class: "lf-meta" }, chip(me ? "Me" : "Them", me ? "me" : "info"), h("span", { class: "lf-ts" }, WingmanLive.stamp(l.t, t0))),
    h("div", { class: "lf-tx", dir: dirOf(l.text), lang: langOf(l.text) }, rich(l.text)));
}
function liveCardEl(c) {
  const [label0, tone] = LV_BADGE[c.badge] || [c.badge, ""];
  const label = c.badge === "ai" && c.source === "calc" ? "Calc" : label0;
  const el = h("div", { class: `lf-card ${c.badge === "tip" ? "tipc" : c.badge}${c.dim ? " dim" : ""}`, role: "note", "aria-label": `${label} answer` },
    chip(label, tone, { dot: true }), h("div", { class: "lf-say", dir: dirOf(c.say), lang: langOf(c.say) }, rich(c.say)));
  el._sig = c.badge + "|" + c.say + "|" + !!c.dim;
  return el;
}

/** Call frame header: kind, topic, goal and the checklist with ticks. Rebuilt only when the frame changed. */
function liveFrameRender() {
  const el = $("lf-frame"); if (!el) return;
  const f = LV.feed.frame, sig = JSON.stringify(f);
  if (el._sig === sig) return;
  el._sig = sig; el.textContent = "";
  if (!f) { el.hidden = true; return; }
  const p = WingmanLive.frameProgress(f);
  const topic = f.topic || "";
  el.append(h("div", { class: "lf-fhead" },
    chip(LV_KIND[f.kind] || "Other", "info", { dot: true }),
    h("span", { class: "lf-ftopic", dir: dirOf(topic), lang: langOf(topic) }, rich(topic)),
    h("span", { class: "grow" }),
    p.total ? h("span", { class: "lf-fprog" + (p.done === p.total ? " all" : ""), "aria-label": `${p.done} of ${p.total} checklist items covered` }, `${p.done}/${p.total}`) : null));
  if (f.goal) el.append(h("div", { class: "lf-fgoal", dir: dirOf(f.goal), lang: langOf(f.goal) }, rich(f.goal)));
  if (p.total) el.append(h("ul", { class: "lf-check", "aria-label": "Call checklist" }, f.checklist.map((c) =>
    h("li", { class: c.done ? "done" : "" }, h("span", { class: "lf-tick", "aria-hidden": "true" }, c.done ? ico("check") : null), h("span", { dir: dirOf(c.item), lang: langOf(c.item) }, rich(c.item)), h("span", { class: "sr" }, c.done ? " (covered)" : " (not covered yet)")))));
  el.hidden = false;
}

function liveRender() {
  const box = $("lf-scroll"); if (!box) return;
  liveFrameRender();
  const { items, loose } = LV.feed.view();
  const t0 = WingmanLive.startOf(state.call && state.call.liveAt, items.length ? items[0].t : 0);
  const want = [];
  const keepCard = (c) => {
    const k = "c" + c.id; let el = LV.els.get(k);
    const sig = c.badge + "|" + c.say + "|" + !!c.dim;
    if (!el || el._sig !== sig) { const n = liveCardEl(c); if (el) el.replaceWith(n); el = n; LV.els.set(k, el); }
    want.push([k, el]);
  };
  for (const it of items) {
    const k = "l" + it.n; let el = LV.els.get(k);
    if (!el) { el = liveLineEl(it, t0); LV.els.set(k, el); }
    want.push([k, el]);
    it.cards.forEach(keepCard);
  }
  loose.forEach(keepCard);
  const keys = new Set(want.map((w) => w[0]));
  for (const [k, el] of LV.els) if (!keys.has(k)) { el.remove(); LV.els.delete(k); }
  let prev = null;
  for (const [, el] of want) {
    const at = prev ? prev.nextSibling : box.firstChild;
    if (at !== el) box.insertBefore(el, at);
    prev = el;
  }
  const empty = $("lf-empty");
  if (empty) { empty.hidden = !!want.length; if (!want.length && !empty.textContent) empty.textContent = state.call && state.call.phase === "waiting" ? "Waiting to start listening." : "Listening. What is said shows up here, with the answer cards under the line they answer."; }
  if (LV.auto) { box.scrollTop = box.scrollHeight; const v = LV.feed.lines; LV.lastSeen = v.length ? v[v.length - 1].n : 0; }
  liveChrome();
}

api.onLive((p) => liveApply(p));
