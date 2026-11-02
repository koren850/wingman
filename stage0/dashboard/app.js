"use strict";
// Renderer. Every piece of call text goes in through textContent / text nodes only (call text is untrusted).
// No innerHTML anywhere. Icons are built with createElementNS.
const api = window.wingman;
const $ = (id) => document.getElementById(id);

/* ---------- tiny DOM helpers ---------- */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}
const SVGNS = "http://www.w3.org/2000/svg";
const ICONS = {
  search: [["circle", { cx: 11, cy: 11, r: 6.5 }], ["path", { d: "M20 20l-4.2-4.2" }]],
  copy: [["rect", { x: 9, y: 9, width: 11, height: 11, rx: 2 }], ["path", { d: "M5 15V6a2 2 0 0 1 2-2h9" }]],
  trash: [["path", { d: "M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" }]],
  refresh: [["path", { d: "M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4" }]],
  check: [["path", { d: "M5 12.5l4.5 4.5L19 7" }]],
  x: [["path", { d: "M6 6l12 12M18 6L6 18" }]],
  warning: [["path", { d: "M12 4l9 16H3zM12 10v4M12 17.5v.01" }]],
  settings: [["path", { d: "M4 7h9M17 7h3M4 17h3M11 17h9" }], ["circle", { cx: 15, cy: 7, r: 2 }], ["circle", { cx: 9, cy: 17, r: 2 }]],
  inbox: [["path", { d: "M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5" }]],
  back: [["path", { d: "M15 6l-6 6 6 6" }]],
  chevron: [["path", { d: "M9 6l6 6-6 6" }]],
  follow: [["rect", { x: 3, y: 5, width: 18, height: 14, rx: 2 }], ["path", { d: "M3 7l9 6 9-6" }]],
  rate: [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "M8 12.5l3 3 5-6" }]],
  transcript: [["path", { d: "M4 6h16M4 12h16M4 18h10" }]],
  missed: [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "M9.7 9.5a2.4 2.4 0 1 1 3.4 2.2c-.7.4-1.1.9-1.1 1.8M12 17v.01" }]],
  details: [["path", { d: "M5 20v-9M12 20V4M19 20v-6" }]],
  jump: [["path", { d: "M7 17L17 7M9 7h8v8" }]],
  clock: [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "M12 7v5l3 2" }]],
  home: [["path", { d: "M4 11l8-7 8 7M6 10v9h12v-9M10 19v-5h4v5" }]],
  help: [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "M9.7 9.5a2.4 2.4 0 1 1 3.4 2.2c-.7.4-1.1.9-1.1 1.8M12 17v.01" }]],
  phone: [["path", { d: "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" }]],
  play: [["path", { d: "M8 5l11 7-11 7z" }]],
  stop: [["rect", { x: 6, y: 6, width: 12, height: 12, rx: 2 }]],
  plan: [["rect", { x: 4, y: 5, width: 16, height: 15, rx: 2 }], ["path", { d: "M8 3v4M16 3v4M4 10h16" }]],
  mic: [["rect", { x: 9, y: 3, width: 6, height: 11, rx: 3 }], ["path", { d: "M5 11a7 7 0 0 0 14 0M12 18v3" }]],
  folder: [["path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" }]],
  undo: [["path", { d: "M9 7L4 12l5 5M4 12h10a6 6 0 0 1 0 8" }]],
};
function ico(name, cls) {
  const s = document.createElementNS(SVGNS, "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("class", "ico" + (cls ? " " + cls : "")); s.setAttribute("aria-hidden", "true"); s.setAttribute("focusable", "false");
  for (const [t, a] of ICONS[name] || []) { const e = document.createElementNS(SVGNS, t); for (const [k, v] of Object.entries(a)) e.setAttribute(k, String(v)); s.append(e); }
  return s;
}
const chip = (text, variant, opts = {}) => h("span", { class: "chip" + (variant ? " " + variant : "") + (opts.mono ? " mono" : "") }, opts.dot ? h("span", { class: "dot" }) : null, opts.icon ? ico(opts.icon) : null, text);
/** A chip that does something: bordered, pointer, hover/pressed, trailing arrow. Plain chips (no arrow) are labels only. */
const linkChip = (kids, variant, onclick, aria, title) => h("button", { type: "button", class: "chip go" + (variant ? " " + variant : ""), onclick, "aria-label": aria, title }, kids, ico("chevron"));
const btn = (label, o = {}) => h("button", { type: "button", class: "btn" + (o.cls ? " " + o.cls : ""), onclick: o.onclick, title: o.title, "aria-label": o.aria, id: o.id }, o.icon ? ico(o.icon) : null, label ? h("span", {}, label) : null);
const ltr = (s) => h("span", { class: "ltr" }, s);
/** Visual skin: "" = the original look; "a" | "b" | "c" = the design directions (set on <html data-skin> by boot.js). */
const SK = () => document.documentElement.dataset.skin || "";
/** Small "?" that carries the long explanation (hover, focus or screen reader) so it does not sit on the page as grey text. */
const tip = (text, end) => h("button", { type: "button", class: "tip" + (end ? " end" : ""), "aria-label": text, "data-tip": text, onclick: (e) => e.stopPropagation() }, "?");

/* ---------- live region / errors ---------- */
let liveTimer;
function announce(msg) { const el = $("live"); el.textContent = ""; clearTimeout(liveTimer); liveTimer = setTimeout(() => { el.textContent = msg; }, 40); }
function fail(msg) { const el = $("alert"); el.textContent = ""; setTimeout(() => { el.textContent = msg; }, 40); }

/* ---------- text: bidi + highlight ---------- */
// Hebrew anywhere in the line = RTL (an English term at the start must not flip the line); no Hebrew = LTR.
const HEB = /[֐-׿]/;
const dirOf = (t) => (HEB.test(String(t)) ? "rtl" : /[A-Za-z]/.test(String(t)) ? "ltr" : "auto");
const langOf = (t) => (HEB.test(String(t)) ? "he" : null);
/** Latin/number/email/URL tokens inside Hebrew text keep their own direction (bdi dir=ltr). */
function rich(text) {
  const s = String(text);
  if (!HEB.test(s)) return [s];
  return window.WingmanBidi.splitBidi(s).map((seg) => (seg.ltr ? h("bdi", { dir: "ltr" }, seg.text) : seg.text));
}
function hlNodes(text, q) {
  const s = String(text), needle = (q || "").trim();
  if (!needle) return rich(s);
  const out = []; const lo = s.toLowerCase(), nl = needle.toLowerCase(); let i = 0;
  for (;;) { const j = lo.indexOf(nl, i); if (j < 0) { out.push(...rich(s.slice(i))); break; } if (j > i) out.push(...rich(s.slice(i, j))); out.push(h("mark", {}, s.slice(j, j + nl.length))); i = j + nl.length; }
  return out;
}
const textEl = (tag, cls, text, q) => h(tag, { class: cls, dir: dirOf(text), lang: langOf(text) }, hlNodes(text, q));

/* ---------- formatting ---------- */
const pad = (n) => String(n).padStart(2, "0");
const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const tm = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
function dayLabel(t) {
  const diff = Math.round((dayStart(Date.now()) - dayStart(t)) / 86400000), d = new Date(t);
  if (diff === 0) return "Today"; if (diff === 1) return "Yesterday";
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}` + (d.getFullYear() !== new Date().getFullYear() ? " " + d.getFullYear() : "");
}
const fullDay = (t) => { const d = new Date(t); return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}` + (d.getFullYear() !== new Date().getFullYear() ? " " + d.getFullYear() : ""); };
function mins(ms) { const m = Math.round(ms / 60000); if (ms < 30000) return "<1 min"; if (m < 60) return `${Math.max(1, m)} min`; return `${Math.floor(m / 60)} h ${pad(m % 60)} min`; }
const usd = (n) => (n < 0.01 ? "$" + n.toFixed(4) : "$" + n.toFixed(2));
const sec = (ms) => (ms == null || isNaN(ms) ? "-" : (ms / 1000).toFixed(2) + " s");
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
const pct = (arr, p) => { const a = arr.filter((x) => x != null && !isNaN(x)).sort((x, y) => x - y); if (!a.length) return null; return a[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)]; };
const tone = (v, good, ok) => (v == null ? "" : v <= good ? "lat-good" : v <= ok ? "lat-ok" : "lat-bad");
const toneWord = (v, good, ok) => (v == null ? "" : v <= good ? "fast" : v <= ok ? "ok" : "slow");
const TARGET = 2, GATE_CALLS = 5; // gate: 2+ useful cards per hour, decided after 5 rated live calls

const meter = (frac, cls, mark) => {
  const i = h("i", { class: cls || "" }); i.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + "%";
  const m = h("span", { class: "meter", "aria-hidden": "true" }, i);
  if (mark != null) { const u = h("u"); u.style.insetInlineStart = Math.round(mark * 100) + "%"; m.append(u); }
  return m;
};

const state = { calls: [], view: "home", call: null, view0: "home", id: null, tab: "followup", sub: "speed", detail: null, search: "", hits: null, sq: 0, gen: 0, filter: "all", sel: null, lastId: null, hl: "", line: null };
const pendingOf = (c) => Math.max(0, c.cardsTotal - c.rated);

/* ---------- shell: nav + global pending chip ---------- */
function setNav() {
  const defs = [["nav-home", "home", "Home", "home"], ["nav-list", "inbox", "Calls", "inbox"], ["nav-settings", "settings", "Settings", "settings"]];
  const cur = state.view === "call" ? "inbox" : state.view;
  for (const [id, v, label, icon] of defs) {
    const b = $(id); b.textContent = ""; b.append(ico(icon), h("span", { class: "lab" }, label)); b.setAttribute("aria-label", label);
    if (cur === v) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
}
function renderPendingChip() {
  const slot = $("pending-slot"); slot.textContent = "";
  const n = state.calls.reduce((a, c) => a + (c.crashed ? 0 : pendingOf(c)), 0);
  if (!n) return;
  slot.append(linkChip([h("span", { class: "dot" }), h("span", { class: "ctr" }, n), (n === 1 ? " card to rate" : " cards to rate")], "warn", () => { const c = state.calls.find((x) => !x.crashed && pendingOf(x) > 0); if (c) openCall(c.id, { tab: "rate", filter: "unrated" }); }, `${n} ${n === 1 ? "card" : "cards"} to rate, open the first call`, "Open the first call with unrated cards"));
}
async function loadList() { state.calls = await api.listCalls(); renderPendingChip(); }
const ready = () => { document.body.dataset.ready = "1"; };
const busy = () => { document.body.dataset.ready = "0"; };
function focusTop() { const t = $("main").querySelector("h1"); if (t) { t.setAttribute("tabindex", "-1"); t.focus({ preventScroll: true }); } }

/* ---------- usefulness gate ---------- */
function gateStats() {
  const live = state.calls.filter((c) => c.mode === "live" && c.rated > 0);
  const hours = live.reduce((a, c) => a + c.hours, 0), useful = live.reduce((a, c) => a + c.useful, 0), rated = live.reduce((a, c) => a + c.rated, 0);
  return { n: live.length, hours, useful, rated, ph: hours ? useful / hours : null };
}
function gateStrip() {
  const g = gateStats(), ok = g.ph != null && g.ph >= TARGET, none = g.ph == null, final = g.n >= GATE_CALLS;
  const scale = Math.max(TARGET * 2, Math.ceil((g.ph || 0) * 1.15));
  const S = SK();
  const verdict = none ? "No ratings yet" : S && !final ? (ok ? "On track" : "Below target") : final ? (ok ? "Passed" : "Not passed") : ok ? "On track (final after 5 calls)" : "Below target so far";
  const left = Math.max(0, GATE_CALLS - g.n);
  const tick = TARGET / scale * 100;
  const lab = h("div", { class: "scale", "aria-hidden": "true" }, h("span", { class: "l" }, "0"), h("span", { class: "t" }, `${TARGET}+ needed`), h("span", { class: "r" }, String(scale)));
  lab.querySelector(".t").style.insetInlineStart = tick + "%"; lab.querySelector(".l").style.insetInlineStart = "0";
  const el = h("section", { class: "gate go", "aria-labelledby": "gate-h" },
    h("div", { class: "stat" }, h("h2", { id: "gate-h", class: "label", style: false }, "Usefulness gate"),
      h("div", { class: "big " + (none ? "muted" : ok ? "good" : "bad") }, none ? "–" : ltr(g.ph.toFixed(1)), h("small", {}, "useful / hour"))),
    h("div", { role: "img", "aria-label": none ? "No ratings yet" : `${g.ph.toFixed(1)} useful per hour, target ${TARGET} or more` }, meter(none ? 0 : g.ph / scale, none ? "" : ok ? "good" : "bad", TARGET / scale), lab),
    h("div", { class: "facts" },
      h("div", { class: "row1" }, !none && ok ? h("span", { class: "capy", "aria-hidden": "true" }) : null, chip(verdict, none ? "" : ok ? "good" : "bad", { dot: true })),
      h("span", {}, `${g.n} of ${GATE_CALLS} calls rated · ${g.useful} useful in `, ltr(g.hours.toFixed(1) + " h")),
      S ? null : h("span", { class: "faint" }, left ? plural(left, "more call") + " to decide" : "Decision reached")),
    h("button", { type: "button", class: "btn ghost sm gate-why" + (S ? " icon" : ""), "aria-haspopup": "dialog", "aria-expanded": "false", "aria-controls": "gate-pop", "aria-label": S ? "What is the usefulness gate?" : null, title: S ? "What is this?" : null }, ico("help"), S ? null : "What is this?"));
  const why = el.querySelector(".gate-why");
  const toggle = (e) => { if (e) e.stopPropagation(); gatePopover(el, why, g, ok, none); };
  why.addEventListener("click", toggle);
  el.addEventListener("click", (e) => { if (!e.target.closest("button")) toggle(); });
  return el;
}
function closePopover(restore) {
  const p = $("gate-pop"); if (!p) return;
  const t = p._trigger; p.remove(); if (t) t.setAttribute("aria-expanded", "false");
  document.removeEventListener("pointerdown", p._outside, true);
  if (restore && t) t.focus();
}
function gatePopover(anchor, trigger, g, ok, none) {
  if ($("gate-pop")) { closePopover(true); return; }
  const first = state.calls.find((c) => !c.crashed && pendingOf(c) > 0);
  const pop = h("div", { id: "gate-pop", class: "popover", role: "dialog", "aria-label": "How the usefulness gate works", tabindex: "-1" },
    h("h3", {}, "How the usefulness gate works"),
    h("p", {}, `Wingman only gets built further if its cards help on real calls. After each call you mark every card Useful or Not useful. The gate counts useful cards per hour of live calls. It needs ${TARGET} or more, measured over ${GATE_CALLS} rated live calls.`),
    h("p", { class: "sub" }, none ? "Nothing is rated yet, so there is no number." : `Right now: ${g.useful} useful in ${g.hours.toFixed(1)} h = ${g.ph.toFixed(1)} per hour, ${ok ? "above" : "below"} the target. Practice calls are not counted.`),
    h("div", { class: "actions" }, first ? btn("Rate the next card", { cls: "primary sm", onclick: () => { closePopover(); openCall(first.id, { tab: "rate", filter: "unrated" }); } }) : null, btn("Close", { cls: "sm", onclick: () => closePopover(true) })));
  pop._trigger = trigger; trigger.setAttribute("aria-expanded", "true");
  anchor.after(pop);
  pop._outside = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) closePopover(false); };
  document.addEventListener("pointerdown", pop._outside, true);
  pop.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); closePopover(true); } });
  pop.focus({ preventScroll: true });
}

/* ---------- inbox ---------- */
function waitingChips(c) {
  const out = [], p = pendingOf(c);
  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
  if (c.crashed) out.push(linkChip([h("span", { class: "dot" }), "Crashed"], "bad", stop(() => openCall(c.id, {})), "Crashed call, open details"));
  if (!c.crashed && p) out.push(linkChip([h("span", { class: "ctr" }, p), " to rate"], "warn", stop(() => openCall(c.id, { tab: "rate", filter: "unrated" })), `${p} to rate, open on Rate`));
  if (!c.crashed && c.hasSummary) out.push(linkChip("Summary", "info", stop(() => openCall(c.id, { tab: "followup" })), "Summary ready, open Follow-up"));
  return out.length ? out : [h("span", { class: "faint" }, "–")];
}
function callTable(rows, label) {
  const th = (t, c) => h("th", { scope: "col", class: c || "" }, t);
  return h("div", { class: "tblwrap" }, h("table", { "aria-label": label },
    h("thead", {}, h("tr", {}, th("When"), th("Length", "w-len"), th("Waiting"), th("Useful/h", "num w-num"))),
    h("tbody", {}, rows.map((c) => {
      const ph = c.rated ? c.perHour : null;
      const go = () => openCall(c.id, {});
      const tr = h("tr", { class: "go" + (state.lastId === c.id ? " sel" : ""), "data-id": c.id, onclick: go },
        h("td", {}, h("button", { type: "button", class: "rowlink", onclick: (e) => { e.stopPropagation(); go(); } }, dayLabel(c.startedAt), h("span", { class: "tm" }, tm(c.startedAt)))),
        h("td", { class: "w-len" }, c.crashed && c.durationMs < 1000 ? h("span", { class: "faint" }, "–") : mins(c.durationMs)),
        h("td", {}, h("div", { class: "wait" }, waitingChips(c))),
        h("td", { class: "num val w-num " + (ph == null ? "faint" : c.mode !== "live" ? "muted" : ph >= TARGET ? "good" : "bad") }, ph == null ? "–" : ltr(ph.toFixed(1))));
      return tr;
    }))));
}
function nextUpCard() {
  const c = state.calls.find((x) => !x.crashed && (pendingOf(x) > 0 || x.hasSummary));
  if (!c) return h("section", { class: "nextup clear", "aria-label": "Next up" }, h("span", { class: "capy", "aria-hidden": "true" }), h("div", {}, h("div", { class: "eyebrow" }, "Next up"), h("div", { class: "title" }, "You're all caught up"), h("div", { class: "sub" }, SK() ? "" : "No unrated cards and no summaries waiting.")));
  const p = pendingOf(c);
  const tab = c.mode === "live" && p ? "rate" : c.hasSummary ? "followup" : "rate";
  const go = () => openCall(c.id, { tab, filter: tab === "rate" ? "unrated" : undefined });
  return h("section", { class: "nextup go", "aria-label": "Next up", onclick: (e) => { if (!e.target.closest("button")) go(); } },
    h("div", { class: "grow" }, h("div", { class: "eyebrow" }, "Next up"),
      h("div", { class: "title" }, `${dayLabel(c.startedAt)} ${tm(c.startedAt)} · ${mins(c.durationMs)}`),
      h("div", { class: "why" }, p ? chip(`${plural(p, "card")} to rate`, "warn", { dot: true }) : null, c.hasSummary ? chip("Summary ready", "info", { dot: true }) : null)),
    h("button", { type: "button", class: "btn primary", onclick: go }, "Review", ico("chevron")));
}
function callsHead() {
  const n = state.calls.reduce((a, c) => a + (c.crashed ? 0 : pendingOf(c)), 0), live = state.calls.filter((c) => c.mode === "live").length;
  return h("div", { class: "page-head ph2" }, h("div", {}, h("div", { class: "hh-date" }, `${plural(state.calls.length, "call")} · ${live} live`), h("h1", {}, n ? `${plural(n, "card")} waiting for your rating` : "All caught up")));
}
function viewInbox(restoreFocus) {
  state.view = "inbox"; closePopover(false); state.gen++; setNav(); busy();
  const main = $("main"); main.textContent = "";
  if (!state.calls.length) {
    main.append(h("h1", { class: "sr" }, "Calls"), h("div", { class: "empty-big" }, h("div", { class: "capy", "aria-hidden": "true" }), h("h2", {}, "No calls yet"), h("span", {}, "Calls show up here after they end. Practice calls too."), btn("Go to Home to start one", { icon: "home", cls: "primary", onclick: () => viewHome() }), btn("Refresh", { icon: "refresh", onclick: async () => { await loadList(); viewInbox(); announce("Refreshed"); } })));
    return ready();
  }
  const input = h("input", { type: "search", id: "q", placeholder: "Search transcripts", value: state.search, "aria-label": "Search transcripts", "aria-keyshortcuts": "/" });
  const out = h("div", { id: "inbox-out" });
  const count = h("span", { class: "sub", id: "count" });
  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value; state.search = q; const my = ++state.sq;
      if (!q.trim()) { state.hits = null; draw(); return; }
      let hits = []; try { hits = await api.searchCalls(q); } catch (e) { fail("Search failed: " + e.message); }
      if (my !== state.sq) return; // stale response
      state.hits = hits; draw(); announce(plural(hits.length, "call") + " match");
    }, 200);
  });
  main.append(
    SK() ? callsHead() : h("div", { class: "page-head" }, h("h1", {}, "Calls")),
    nextUpCard(), gateStrip(),
    h("div", { class: "bar" }, h("div", { class: "search" }, ico("search"), input), btn("", { icon: "refresh", cls: "icon ghost", aria: "Refresh calls", title: "Refresh", onclick: async () => { await loadList(); viewInbox(); announce("Refreshed"); } }), count), out);
  function draw() {
    out.textContent = "";
    if (state.hits) {
      const byId = new Map(state.calls.map((c) => [c.id, c]));
      const hits = state.hits.filter((x) => byId.has(x.id)).sort((a, b) => byId.get(b.id).startedAt - byId.get(a.id).startedAt);
      count.textContent = plural(hits.length, "call") + " match";
      if (!hits.length) { out.append(h("div", { class: "tblwrap" }, h("div", { class: "empty" }, "No call matches “" + state.search.trim() + "”"))); return; }
      out.append(h("div", { class: "results", role: "list", "aria-label": "Search results" }, hits.map((x) => {
        const c = byId.get(x.id);
        return h("button", { type: "button", role: "listitem", class: "result", onclick: () => openCall(x.id, { tab: "transcript", line: x.line, hl: state.search.trim() }) },
          h("span", { class: "when" }, dayLabel(c.startedAt), " ", h("span", { class: "tm" }, tm(c.startedAt))),
          textEl("span", "snip", x.text, state.search.trim()),
          h("span", { class: "chip mono" }, mmss(x.at)));
      })));
      return;
    }
    const live = state.calls.filter((c) => c.mode === "live" || c.crashed), practice = state.calls.filter((c) => c.mode !== "live" && !c.crashed);
    count.textContent = plural(state.calls.length, "call");
    out.append(live.length ? callTable(live, "Calls") : h("div", { class: "tblwrap" }, h("div", { class: "empty" }, "No live calls yet")));
    if (practice.length) {
      const d = h("details", { class: "collapsed" }, h("summary", {}, ico("chevron"), `Practice calls (${practice.length})`, h("span", { class: "faint" }, "· not counted in the gate")), callTable(practice, "Practice calls"));
      out.append(d);
    }
  }
  draw(); ready();
  if (restoreFocus && state.lastId) { const r = main.querySelector(`tr[data-id="${state.lastId}"] .rowlink`); if (r) { r.focus(); return; } }
  focusTop();
}

/* ---------- opening a call ---------- */
const OLD_TABS = { summary: "followup", cards: "rate", side: "rate", speed: "details", cost: "details", events: "details" };
const TABS = [["followup", "Follow-up", "follow"], ["rate", "Rate", "rate"], ["transcript", "Transcript", "transcript"], ["missed", "Missed", "missed"], ["details", "Details", "details"]];
function normTab(t, x) {
  if (!t) return { tab: null };
  const o = { tab: OLD_TABS[t] || t };
  if (t === "side") o.filter = "side"; if (t === "speed" || t === "cost" || t === "events") o.sub = t;
  if (o.tab === "rate" && /^(unrated|side|rated|useful)$/.test(x || "")) o.filter = x;
  if (o.tab === "transcript" && /^\d+$/.test(x || "")) o.line = +x;
  if (o.tab === "details" && /^(speed|cost|events)$/.test(x || "")) o.sub = x;
  if (!TABS.some((x2) => x2[0] === o.tab)) o.tab = null;
  return o;
}
function defaultTab(d) {
  const s = d.summary;
  if (s.mode === "live" && pendingOf(s) > 0) return "rate";
  if (d.callSummary) return "followup";
  return "transcript";
}
async function openCall(id, o = {}) {
  closePopover(false); state.view = "call"; state.id = id; state.lastId = id; state.sel = null; state.hl = o.hl || ""; state.line = o.line == null ? null : o.line;
  setNav(); busy();
  const gen = ++state.gen, main = $("main");
  main.textContent = ""; main.append(h("div", { class: "loading", role: "status" }, "Loading call…"));
  let d;
  try { d = await api.getCall(id); } catch (e) { if (gen === state.gen) { main.textContent = ""; main.append(h("div", { class: "empty", role: "alert" }, "Could not load the call: " + e.message)); ready(); } return; }
  if (gen !== state.gen) return;
  state.detail = d;
  const tab = o.tab && TABS.some((t) => t[0] === o.tab) ? o.tab : defaultTab(d);
  state.filter = o.filter || (tab === "rate" && pendingOf(d.summary) > 0 ? "unrated" : "all");
  if (o.sub) state.sub = o.sub;
  renderCall(tab);
}

/* ---------- call view shell ---------- */
const visibleCards = (d) => d.cards.filter((c) => c.turnId !== "side" && !c.health);
const sideCards = (d) => d.cards.filter((c) => c.turnId === "side" && !c.health);
const rateable = (c) => c.badge !== "info" && !c.health;
const firstCard = (l) => { const ts = [l.bankAt, l.stallAt, l.cardAt].filter(Boolean); return ts.length ? Math.min(...ts) : null; };
const t0Of = (d) => Date.parse(d.meta.startedAt) || (d.transcript[0] && d.transcript[0].t) || 0;
function allCards(d) { return d.cards.filter((c) => !c.health).map((c, i) => [c, i]).sort((a, b) => (a[0].t || 0) - (b[0].t || 0) || a[1] - b[1]).map((x) => x[0]); }

function renderCall(tab) {
  const d = state.detail, s = d.summary, main = $("main");
  main.textContent = "";
  const empty = !d.transcript.length && !d.events.length && !d.cards.length;
  const back = btn("Calls", { icon: "back", cls: "ghost sm", onclick: backToList, title: "Back to Calls (Esc)" });
  const delBtn = btn("Delete call", { icon: "trash", cls: "danger sm", onclick: deleteCurrent });
  const title = `${fullDay(s.startedAt)}, ${tm(s.startedAt)}`;
  if (s.crashed) {
    main.append(h("div", { class: "crumb", id: "callview" }, back),
      h("div", { class: "callcrash" }, h("div", { class: "capy", "aria-hidden": "true" }), h("h1", { class: "sr" }, title), h("h2", {}, "This call crashed"), h("span", {}, "Nothing was saved."), h("span", { class: "faint" }, title), btn("Delete call", { icon: "trash", cls: "danger", onclick: deleteCurrent })));
    ready(); focusTop(); return;
  }
  const chips = h("span", { class: "chips" }, chip(s.mode === "live" ? "Live" : "Practice", s.mode === "live" ? "good" : "", { dot: true }), s.profile ? chip(s.profile, "", { mono: true }) : null, s.noAi ? chip("No AI") : null);
  main.append(h("div", { id: "callview" },
    h("div", { class: "crumb" }, back, h("span", { class: "grow" }), empty ? null : delBtn),
    h("div", { class: "callhead" }, h("h1", {}, title), chips),
    h("p", { class: "statsline", id: "stats" })));
  renderStats();
  if (empty) {
    $("callview").append(h("div", { class: "empty-big" }, h("div", { class: "capy", "aria-hidden": "true" }), h("h2", {}, "Nothing to show"), h("span", {}, "This call has no transcript, cards or events."), btn("Delete call", { icon: "trash", cls: "danger", onclick: deleteCurrent })));
    ready(); focusTop(); return;
  }
  const tabs = h("div", { class: "tabs", role: "tablist", "aria-label": "Call sections", id: "tabs" }, TABS.map(([k, t, ic], i) => h("button", { type: "button", role: "tab", id: "tab-" + k, "data-tab": k, "aria-controls": "pane", "aria-selected": "false", tabindex: "-1", "aria-keyshortcuts": String(i + 1), onclick: () => setTab(k, {}, true) }, ico(ic), h("span", {}, t), h("span", { class: "n", "aria-hidden": "true" }))));
  tabs.addEventListener("keydown", (e) => {
    const ks = TABS.map((t) => t[0]), i = ks.indexOf(state.tab); let j = -1;
    if (e.key === "ArrowRight") j = (i + 1) % ks.length; else if (e.key === "ArrowLeft") j = (i - 1 + ks.length) % ks.length; else if (e.key === "Home") j = 0; else if (e.key === "End") j = ks.length - 1;
    if (j >= 0) { e.preventDefault(); setTab(ks[j], {}, true); $("tab-" + ks[j]).focus(); }
  });
  $("callview").append(tabs, h("div", { id: "pane", role: "tabpanel", tabindex: "-1" }));
  setTab(tab, { line: state.line }, false);
  $("tab-" + tab).focus({ preventScroll: true });
  ready();
}
function backToList() { loadList().then(() => viewInbox(true)); }
async function deleteCurrent() {
  const id = state.id; let ok = false;
  try { ok = await api.deleteCall(id); } catch (e) { fail("Could not delete: " + e.message); return; }
  if (ok) { state.lastId = null; await loadList(); viewInbox(); announce("Call deleted"); }
}

function renderStats() {
  const el = $("stats"); if (!el) return;
  const d = state.detail, s = d.summary, p = pendingOf(s); el.textContent = "";
  const stat = (text, filter, aria) => h("button", { type: "button", class: "statlink", onclick: () => setTab("rate", { filter }, true), "aria-label": aria }, text);
  const parts = [h("b", {}, mins(s.durationMs))];
  if (s.cardsTotal) parts.push(stat(plural(s.cardsTotal, "card"), "all", `${plural(s.cardsTotal, "card")}, open Rate`), stat(`${s.rated} rated`, "rated", `${s.rated} rated, open Rate filtered to rated cards`), stat(`${s.useful} useful`, "useful", `${s.useful} useful, open Rate filtered to useful cards`)); else parts.push("no cards");
  parts.forEach((x, i) => { if (i) el.append(h("span", { class: "sep", "aria-hidden": "true" }, "·")); el.append(x); });
  if (p) el.append(linkChip([h("span", { class: "ctr" }, p), " to rate"], "warn", () => setTab("rate", { filter: "unrated" }, true), `${p} to rate, open Rate`));
  // tab badges
  const set = (k, text, attn) => { const t = $("tab-" + k); if (!t) return; const n = t.querySelector(".n"); n.textContent = text == null ? "" : String(text); n.className = "n" + (attn ? " attn" : ""); };
  set("followup", d.callSummary ? "✓" : null);
  set("rate", p || (s.cardsTotal ? "✓" : null), !!p);
  set("missed", missedItems(d).length || null);
}

function setTab(k, o = {}, focusPane) {
  const d = state.detail; if (!d) return;
  state.tab = k;
  if (o.filter) state.filter = o.filter; else if (k === "rate" && !o.keep && !document.querySelector("#pane .ratebar")) state.filter = state.filter || "all";
  if (o.sub) state.sub = o.sub;
  for (const t of document.querySelectorAll("#tabs [role=tab]")) { const on = t.dataset.tab === k; t.setAttribute("aria-selected", on ? "true" : "false"); t.tabIndex = on ? 0 : -1; }
  const pane = $("pane"); pane.textContent = ""; pane.setAttribute("aria-labelledby", "tab-" + k);
  ({ followup: tFollowup, rate: tRate, transcript: tTranscript, missed: tMissed, details: tDetails })[k](pane, d, o);
  if (focusPane === true && document.activeElement && document.activeElement !== document.body && !document.activeElement.closest("#tabs")) $("tab-" + k).focus({ preventScroll: true });
}

/* ---------- copy ---------- */
function copyBtn(label, getText, o = {}) {
  const lab = h("span", {}, label);
  const b = h("button", { type: "button", class: "btn" + (o.cls ? " " + o.cls : ""), "aria-label": o.aria || label }, ico("copy"), lab);
  let timer;
  b.addEventListener("click", async () => {
    let ok = false;
    try { ok = await api.copyText(getText()); } catch { try { await navigator.clipboard.writeText(getText()); ok = true; } catch {} }
    b.replaceChildren(ico(ok ? "check" : "warning"), lab); lab.textContent = ok ? "Copied" : "Copy failed";
    if (ok) announce((o.what || "Text") + " copied to the clipboard"); else fail("Copy failed");
    clearTimeout(timer); timer = setTimeout(() => { b.replaceChildren(ico("copy"), lab); lab.textContent = label; }, 1800);
  });
  return b;
}

/* ---------- Follow-up ---------- */
const SKIP_WHY = { discard: "The call was deleted", crashed: "The call crashed", "no-ai": "The call ran without AI", disabled: "Summary is off in settings (summary.enabled)", empty: "No transcript", "cost-cap": "The call's cost cap was reached" };
function summaryWhy(d) {
  const ev = d.events.filter((e) => e.type === "summary.skipped" || e.type === "summary.error").at(-1);
  if (!ev) return "";
  if (ev.type === "summary.error") return "Summary failed: " + String(ev.error || "").slice(0, 160);
  const r = String(ev.reason || ""); return r.startsWith("short") ? "The call was too short to summarize (summary.minWords)" : (SKIP_WHY[r] || "");
}
const PH = /(\[להשלים[^\]\n]*\])/;
function emailLines(text) {
  return text.split("\n").map((ln) => {
    if (!ln.trim()) return h("div", { class: "eline gap" });
    const kids = ln.split(PH).flatMap((p, i) => (i % 2 ? [h("mark", { class: "ph" }, p)] : rich(p)));
    return h("div", { class: "eline", dir: dirOf(ln), lang: langOf(ln) }, kids);
  });
}
const stepsKey = (id) => "wm.steps." + id;
function loadSteps(id) { try { const a = JSON.parse(localStorage.getItem(stepsKey(id)) || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } }
function saveSteps(id, a) { try { localStorage.setItem(stepsKey(id), JSON.stringify(a)); } catch {} }

function tFollowup(pane, d) {
  const s = d.callSummary, box = h("div", { class: "pane" }); pane.append(box);
  const sections = [];
  if (!s) {
    const why = summaryWhy(d);
    box.append(h("div", { class: "empty-big" }, h("div", { class: "capy", "aria-hidden": "true" }), h("h2", {}, "No summary for this call"), why ? h("span", {}, why) : null, h("span", {}, "You can make one from Terminal:"), h("span", {}, h("code", {}, "pnpm summary " + state.id), " ", copyBtn("Copy", () => "pnpm summary " + state.id, { cls: "ghost sm", what: "Command", aria: "Copy command" }))));
  } else {
    const list = (items) => h("ul", { class: "bul" }, items.map((t) => h("li", { dir: dirOf(t), lang: langOf(t) }, rich(t))));
    const none = (t) => h("div", { class: "muted" }, t);
    const sec = (title, body, n) => h("section", {}, h("h2", {}, title, n ? h("span", { class: "n" }, n) : null), body);
    // next steps checklist, state in localStorage per call
    const done = loadSteps(state.id);
    const stepsUl = h("ul", { class: "steps" });
    const progress = h("span", { class: "n" });
    const upd = () => { const c = s.nextSteps.filter((_, i) => done[i]).length; progress.textContent = `${c} of ${s.nextSteps.length} done`; };
    s.nextSteps.forEach((n, i) => {
      const cb = h("input", { type: "checkbox", id: "step-" + i }); cb.checked = !!done[i];
      const row = h("label", { class: "step" + (done[i] ? " done" : ""), for: "step-" + i }, cb,
        chip(n.who === "דן" ? "Dan" : n.who === "לקוח" ? "Client" : n.who, n.who === "דן" ? "me" : "info"),
        h("span", { class: "what", dir: dirOf(n.what), lang: langOf(n.what) }, rich(n.what), n.when ? h("span", { class: "when", dir: dirOf(n.when), lang: langOf(n.when) }, n.when) : null));
      cb.addEventListener("change", () => { done[i] = cb.checked; saveSteps(state.id, done); row.classList.toggle("done", cb.checked); upd(); announce(`${cb.checked ? "Done" : "Reopened"}: ${n.what.slice(0, 60)}`); });
      stepsUl.append(h("li", {}, row));
    });
    upd();
    const stepsText = () => s.nextSteps.map((n) => `- [ ] ${n.who === "דן" ? "Dan" : n.who === "לקוח" ? "Client" : n.who}: ${n.what}${n.when ? " (" + n.when + ")" : ""}`).join("\n");
    const email = s.followUpEmail || "";
    const phN = (email.match(/\[להשלים[^\]\n]*\]/g) || []).length || s.guardReplaced || 0;
    const aside = h("aside", { class: "emailbox", "aria-label": "Follow-up email" },
      h("div", { class: "eh" }, h("h2", {}, "Follow-up email"), email ? copyBtn("Copy email", () => email, { cls: "primary", what: "Email" }) : null),
      phN ? h("div", { class: "warnrow" }, chip(`${plural(phN, "placeholder")} to fill`, "warn", { icon: "warning" })) : null,
      email ? h("div", { class: "email" }, emailLines(email)) : h("div", { class: "email muted" }, "No draft"),
      h("div", { class: "foot" }, "Draft only, never sent anywhere. ", s.model ? ltr(s.model) : null, s.costUsd ? [" · ", ltr("$" + s.costUsd.toFixed(4))] : null));
    box.append(h("div", { class: "fu" },
      h("div", { class: "fu-main" },
        frameSection(d),
        sec("Summary", s.summary.length ? list(s.summary) : none("None")),
        h("section", {}, h("div", { class: "rowh" }, h("h2", {}, "Next steps", s.nextSteps.length ? progress : null), h("span", { class: "grow" }), s.nextSteps.length ? copyBtn("Copy next steps", stepsText, { cls: "ghost sm", what: "Next steps" }) : null), s.nextSteps.length ? stepsUl : none("No next steps agreed")),
        sec("Decisions", s.decisions.length ? list(s.decisions) : none("No decisions"), s.decisions.length || null),
        sec("Open questions", s.openQuestions.length ? list(s.openQuestions) : none("No open questions"), s.openQuestions.length || null),
        capturesSection(d)),
      aside));
    return;
  }
  const cs = capturesSection(d), fs = frameSection(d); if (cs || fs) box.append(h("div", { class: "fu-main", style: false }, fs, cs));
}
/** What the call turned out to be about, and how much of its checklist was covered (6/8, with the missed items). */
const KIND_EN = { client: "Client", support: "Support", vendor: "Vendor", team: "Team", consult: "Consult", personal: "Personal", other: "Other" };
function frameSection(d) {
  const cf = d.callFrame; if (!cf) return null;
  const f = cf.frame, all = cf.total > 0 && cf.done === cf.total;
  const head = h("div", { class: "rowh" }, h("h2", {}, "About the call"), h("span", { class: "grow" }),
    cf.total ? h("span", { class: "chip " + (all ? "good" : "warn") }, `${cf.done}/${cf.total} covered`) : null);
  const topic = f.topic || "";
  const body = h("div", { class: "fr-sum" },
    h("div", { class: "fr-line" }, chip(KIND_EN[f.kind] || "Other", "info", { dot: true }), h("span", { class: "fr-topic", dir: dirOf(topic), lang: langOf(topic) }, rich(topic))),
    f.goal ? h("div", { class: "fr-goal muted", dir: dirOf(f.goal), lang: langOf(f.goal) }, rich(f.goal)) : null,
    cf.total ? h("ul", { class: "fr-list", "aria-label": "Checklist result" }, f.checklist.map((c) => h("li", { class: c.done ? "fr-done" : "fr-miss" },
      chip(c.done ? "Covered" : "Missed", c.done ? "good" : "warn"), h("span", { dir: dirOf(c.item), lang: langOf(c.item) }, rich(c.item))))) : null,
    cf.missed.length ? h("div", { class: "muted fr-note" }, "Missed must-cover items are added to Open questions.") : null);
  return h("section", {}, head, body);
}
function capturesSection(d) {
  const ev = d.events.filter((e) => e.type === "context.note" || e.type === "client.confirmed");
  if (!d.captures.length && !ev.length) return null;
  const wrap = h("div", {});
  if (d.captures.length) wrap.append(h("section", {}, h("h2", {}, "Captured on the call", h("span", { class: "n" }, d.captures.length)),
    h("div", { class: "kv" }, d.captures.map((c) => h("div", { class: "ln" }, chip(c.kind), h("span", { class: "v mono" }, ltr(c.value)), copyBtn("", () => String(c.value), { cls: "ghost sm icon", aria: "Copy " + c.kind + " " + c.value, what: "Value" }))))));
  if (ev.length) wrap.append(h("section", {}, h("h2", {}, "Notes and confirmations", h("span", { class: "n" }, ev.length)),
    h("div", { class: "kv" }, ev.map((e) => { const t = e.text || e.note || JSON.stringify(e, (k, v) => (k === "t" || k === "type" ? undefined : v)); return h("div", { class: "ln" }, chip(e.type === "client.confirmed" ? "Confirmed" : "Note", e.type === "client.confirmed" ? "good" : ""), textEl("span", "v", t)); }))));
  return wrap;
}

/* ---------- Rate ---------- */
const SRC = { me: "For you", bank: "Bank", ai: "AI", stall: "Stall", tip: "Tip", warn: "Warning", info: "Info", note: "Note", fact: "Fact", reminder: "Reminder" };
function filterCards(d) {
  const f = state.filter, all = allCards(d);
  return all.filter((c) => f === "all" || (f === "side" ? c.turnId === "side" : f === "rated" ? rateable(c) && !!d.tags[c.id] : f === "useful" ? rateable(c) && d.tags[c.id] === "y" : rateable(c) && !d.tags[c.id]));
}
function filterCounts(d, all, r) { return { all: all.length, unrated: r.filter((c) => !d.tags[c.id]).length, rated: r.filter((c) => d.tags[c.id]).length, useful: r.filter((c) => d.tags[c.id] === "y").length, side: all.filter((c) => c.turnId === "side").length }; }
function ratebar(d) {
  const all = allCards(d), r = all.filter(rateable);
  const cnt = filterCounts(d, all, r);
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Filter cards", id: "seg" });
  for (const [k, t] of [["all", "All"], ["unrated", "Unrated"], ["rated", "Rated"], ["useful", "Useful"], ["side", "Side"]]) {
    seg.append(h("button", { type: "button", "data-f": k, "aria-pressed": state.filter === k ? "true" : "false", onclick: (e) => { state.filter = k; state.sel = null; drawCards(); announce(`${t}: ${cnt[k]} cards`); e.currentTarget.focus(); } }, t, h("span", { class: "c" }, cnt[k])));
  }
  return h("div", { class: "ratebar" }, seg, SK() ? tip("Keys: Y useful, N not useful, U clear, J and K move between cards.") : null, h("span", { class: "grow" }), h("span", { class: "hints", "aria-hidden": "true" }, h("span", {}, h("kbd", {}, "Y"), " useful"), h("span", {}, h("kbd", {}, "N"), " not useful"), h("span", {}, h("kbd", {}, "U"), " clear"), h("span", {}, h("kbd", {}, "J"), h("kbd", {}, "K"), " move")));
}
function refreshSeg() {
  const d = state.detail, seg = $("seg"); if (!seg) return;
  const all = allCards(d), r = all.filter(rateable);
  const cnt = filterCounts(d, all, r);
  for (const b of seg.querySelectorAll("button")) b.querySelector(".c").textContent = cnt[b.dataset.f];
}
function tRate(pane, d) {
  const box = h("div", { class: "pane" });
  if (!allCards(d).length) { pane.append(h("div", { class: "empty-big" }, h("div", { class: "capy", "aria-hidden": "true" }), h("h2", {}, "No cards in this call"), h("span", {}, "Cards appear while the call is live."))); return; }
  box.append(ratebar(d), h("div", { class: "cardlist", id: "cardlist", role: "list", "aria-label": "Cards" }));
  pane.append(box); drawCards();
}
function jumpToCardTime(c) {
  const d = state.detail, rows = d.transcript; let line = 0;
  for (let i = 0; i < rows.length; i++) if (rows[i].t <= (c.t || 0)) line = i;
  setTab("transcript", { line }, true);
}
function cardEl(c, d, idx, total) {
  const t0 = t0Of(d), rt = h("div", { class: "rate" }), say = c.say || "";
  const first = String(say || c.question || "").slice(0, 60);
  if (rateable(c)) {
    const mk = (v, label, key) => h("button", { type: "button", class: v, "data-v": v, "aria-pressed": "false", "aria-label": `${label}: ${first}`, tabindex: "-1", onclick: () => { setCur(c.id, false); doRate(c, v, false); } }, ico(v === "y" ? "check" : "x"), h("span", {}, label), h("kbd", { class: "k", "aria-hidden": "true" }, key));
    rt.append(mk("y", "Useful", "Y"), mk("n", "Not useful", "N"));
  }
  const el = h("article", { class: "card " + c.badge + (c.hidden ? " hidden" : ""), role: "group", "aria-label": `Card ${idx + 1} of ${total}: ${first}`, tabindex: "-1", "data-id": c.id, onclick: (e) => { if (!e.target.closest("button")) setCur(c.id, false); } },
    h("div", { class: "ch" }, chip(SRC[c.badge] || c.badge, "", { dot: true }),
      c.hidden ? chip("Hidden" + (c.hiddenReason ? ": " + c.hiddenReason : ""), "") : null, c.dim ? chip("Dimmed") : null,
      c.t && t0 ? h("button", { type: "button", class: "jump", title: "Show in transcript", "aria-label": `Show in transcript at ${mmss(c.t - t0)}`, onclick: () => jumpToCardTime(c) }, mmss(c.t - t0), ico("jump")) : null,
      h("span", { class: "verdict" })),
    c.question ? textEl("div", "q", c.question) : null, textEl("div", "say", say),
    c.facts && c.facts.length ? h("ul", { dir: "rtl", lang: "he" }, c.facts.map((f) => h("li", { dir: dirOf(f), lang: langOf(f) }, rich(f)))) : null,
    rateable(c) ? rt : null);
  const src = el.querySelector(".chip .dot"); if (src) src.style.color = "var(--src)";
  paintCard(el, c);
  return el;
}
function paintCard(el, c) {
  const v = state.detail.tags[c.id] || null;
  for (const b of el.querySelectorAll(".rate button")) b.setAttribute("aria-pressed", b.dataset.v === v ? "true" : "false");
  const ve = el.querySelector(".verdict"); ve.textContent = "";
  if (v) { ve.className = "verdict " + (v === "y" ? "good" : "bad"); ve.append(ico(v === "y" ? "check" : "x"), v === "y" ? "Useful" : "Not useful"); } else ve.className = "verdict";
}
const cardEls = () => [...document.querySelectorAll("#cardlist .card")];
function drawCards() {
  const list = $("cardlist"); if (!list) return;
  const d = state.detail, cs = filterCards(d), total = cs.length; list.textContent = "";
  for (const b of document.querySelectorAll("#seg button")) b.setAttribute("aria-pressed", b.dataset.f === state.filter ? "true" : "false");
  refreshSeg();
  if (!cs.length) { list.append(h("div", { class: "empty-big" }, h("div", { class: "capy", "aria-hidden": "true" }), h("h2", {}, state.filter === "unrated" ? "All rated" : "No cards here"), h("span", {}, state.filter === "unrated" ? "Nothing left to rate on this call." : "Nothing matches this filter."), state.filter !== "all" ? btn("Show all cards", { cls: "sm", onclick: () => { state.filter = "all"; drawCards(); } }) : null)); return; }
  cs.forEach((c, i) => list.append(cardEl(c, d, i, total)));
  const firstUn = cs.find((c) => rateable(c) && !d.tags[c.id]) || cs[0];
  setCur(state.sel && cs.some((c) => c.id === state.sel) ? state.sel : firstUn.id, false);
}
function setCur(id, focus) {
  state.sel = id;
  for (const el of cardEls()) {
    const on = el.dataset.id === id; el.classList.toggle("cur", on); el.tabIndex = on ? 0 : -1;
    for (const b of el.querySelectorAll(".rate button")) b.tabIndex = on ? 0 : -1;
    if (on && focus) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: "nearest" }); }
  }
}
async function doRate(c, v, advance) {
  const d = state.detail, prev = d.tags[c.id], next = prev === v ? null : v;
  let s; try { s = await api.setTag(state.id, c.id, next); } catch (e) { fail("Could not save the rating: " + e.message); return false; }
  d.summary = s; if (next) d.tags[c.id] = next; else delete d.tags[c.id];
  const i = state.calls.findIndex((x) => x.id === state.id); if (i >= 0) state.calls[i] = s;
  const el = document.querySelector(`#cardlist .card[data-id="${CSS.escape(c.id)}"]`); if (el) paintCard(el, c);
  renderStats(); renderPendingChip(); refreshSeg();
  const left = pendingOf(s);
  announce((next === "y" ? "Marked useful" : next === "n" ? "Marked not useful" : "Rating cleared") + ". " + (left ? plural(left, "card") + " left to rate." : "All cards rated."));
  if (advance && next) {
    const ids = cardEls().map((x) => x.dataset.id), at = ids.indexOf(c.id);
    const after = [...ids.slice(at + 1), ...ids.slice(0, at)].find((id) => { const cc = d.cards.find((x) => x.id === id); return cc && rateable(cc) && !d.tags[id]; });
    if (after) setCur(after, true);
  }
  return true;
}

/* ---------- Transcript ---------- */
function tTranscript(pane, d, o) {
  const t0 = t0Of(d);
  if (!d.transcript.length) return pane.append(h("div", { class: "empty-big" }, h("div", { class: "capy", "aria-hidden": "true" }), h("h2", {}, "No transcript"), h("span", {}, "Nothing was transcribed for this call.")));
  const q = state.hl || "";
  // markers: cards land after the transcript row that precedes them; questions map to the row with the same text
  const cardsAt = new Map();
  for (const c of allCards(d)) { if (!c.t) continue; let line = -1; for (let i = 0; i < d.transcript.length; i++) if (d.transcript[i].t <= c.t) line = i; if (line >= 0) (cardsAt.get(line) || cardsAt.set(line, []).get(line)).push(c); }
  const qAt = new Map();
  for (const l of d.latency) { if (!l.text) continue; const i = d.transcript.findIndex((r) => r.ch !== "me" && String(r.text).trim() === String(l.text).trim()); if (i >= 0 && !qAt.has(i)) qAt.set(i, l); }
  const box = h("div", { class: "chat pane", role: "list", "aria-label": "Transcript" });
  d.transcript.forEach((r, i) => {
    const me = r.ch === "me", l = qAt.get(i);
    const ex = [];
    if (l) {
      const cardMs = firstCard(l) && l.speechEnd ? firstCard(l) - l.speechEnd : null, toMissed = () => setTab("missed", {}, true);
      ex.push(!firstCard(l) ? linkChip([h("span", { class: "dot" }), "Question · no card"], "bad", toMissed, "Question with no card, open Missed")
        : cardMs > 3000 ? linkChip([h("span", { class: "dot" }), `Question · card after ${sec(cardMs)}`], "warn", toMissed, "Question answered late, open Missed")
        : chip("Question", "info"));
    }
    box.append(h("div", { class: "row " + (me ? "me" : "them"), role: "listitem", id: "tr-" + i, tabindex: "-1" },
      h("span", { class: "ts" }, mmss(r.t - t0)), h("span", {}, chip(me ? "Me" : "Them", me ? "me" : "info")),
      h("div", { class: "tx", dir: dirOf(r.text), lang: langOf(r.text) }, hlNodes(r.text, q)),
      ex.length ? h("div", { class: "ex" }, ex) : null));
    for (const c of cardsAt.get(i) || []) {
      box.append(h("div", { class: "mk", role: "listitem" }, h("button", { type: "button", class: "jump", "aria-label": `Card at ${mmss((c.t || t0) - t0)}: ${String(c.say || "").slice(0, 60)}. Open on Rate`, onclick: () => { state.sel = c.id; setTab("rate", { filter: "all", keep: true }, true); const el = document.querySelector(`#cardlist .card[data-id="${CSS.escape(c.id)}"]`); if (el) setCur(c.id, true); } },
        chip(SRC[c.badge] || c.badge, c.badge === "bank" ? "good" : c.badge === "ai" ? "info" : c.badge === "stall" ? "warn" : "", { dot: true }), h("span", { class: "t", dir: dirOf(c.say), lang: langOf(c.say) }, c.say || c.question || ""))));
    }
  });
  pane.append(box);
  const line = o && o.line != null ? o.line : state.line;
  if (line != null && line >= 0) { const el = $("tr-" + line); if (el) { el.classList.add("target"); requestAnimationFrame(() => { el.scrollIntoView({ block: "center" }); el.focus({ preventScroll: true }); }); } }
  state.line = null;
}

/* ---------- Missed ---------- */
function missedItems(d) {
  const t0 = t0Of(d), seen = new Set(), out = [];
  for (const l of d.latency) {
    const f = firstCard(l), cardMs = f && l.speechEnd ? f - l.speechEnd : null, key = String(l.text || l.turnId);
    if (!f) { out.push({ t: l.t, text: key, why: "No card", bad: true }); seen.add(key); }
    else if (cardMs != null && cardMs > 3000) { out.push({ t: l.t, text: key, why: `Card came late (${sec(cardMs)})`, bad: false }); seen.add(key); }
  }
  for (const e of d.events) if (e.type === "detect" && e.isQuestion && !seen.has(String(e.text)) && !d.latency.some((l) => l.text === e.text && firstCard(l))) { out.push({ t: e.t, text: String(e.text), why: "No card", bad: true, reason: e.reason }); seen.add(String(e.text)); }
  return out.sort((a, b) => (a.t || 0) - (b.t || 0)).map((x) => ({ ...x, rel: x.t ? x.t - t0 : null }));
}
function tMissed(pane, d) {
  const items = missedItems(d);
  if (!items.length) return pane.append(h("div", { class: "empty-big" }, h("div", { class: "capy", "aria-hidden": "true" }), h("h2", {}, d.latency.length || d.events.length ? "Every question got a card" : "No question data"), h("span", {}, d.latency.length ? "No question was missed or answered late." : "This call has no recorded questions.")));
  pane.append(h("div", { class: "pane" }, h("div", { class: "section-title" }, h("h2", {}, "Questions with no card, or a late one"), h("span", { class: "sub" }, items.length)),
    h("div", { class: "missed", role: "list" }, items.map((m) => {
      const line = d.transcript.findIndex((r) => String(r.text).trim() === m.text.trim());
      const go = line >= 0 ? () => setTab("transcript", { line }, true) : null;
      return h("div", { class: "mrow" + (go ? " go" : ""), role: "listitem", onclick: go ? (e) => { if (!e.target.closest("button")) go(); } : null },
        line >= 0 && m.rel != null ? h("button", { type: "button", class: "btn ghost sm mono", title: "Show in transcript", "aria-label": `Show in transcript at ${mmss(m.rel)}`, onclick: go }, mmss(m.rel)) : h("span", { class: "ts" }, m.rel != null ? mmss(m.rel) : ""),
        h("div", {}, textEl("div", "q", m.text), h("div", { class: "why" }, chip(m.why, m.bad ? "bad" : "warn", { dot: true }), m.reason ? chip(m.reason, "", { mono: true }) : null)),
        copyBtn("Copy", () => m.text, { cls: "ghost sm", aria: "Copy question: " + m.text.slice(0, 50), what: "Question" }));
    }))));
}

/* ---------- Details: speed, cost, events ---------- */
function callMetrics(d) {
  const fin = d.latency.map((l) => (l.finalAt && l.speechEnd ? l.finalAt - l.speechEnd : null));
  const card = d.latency.map((l) => (firstCard(l) && l.speechEnd ? firstCard(l) - l.speechEnd : null));
  return { finP50: pct(fin, 0.5), cardP50: pct(card, 0.5), cardP95: pct(card, 0.95), noCard: d.latency.filter((l) => !firstCard(l)).length };
}
function tDetails(pane, d, o) {
  const s = d.summary, m = callMetrics(d), p = pendingOf(s), live = s.mode === "live";
  const st = !s.rated ? "na" : s.perHour >= TARGET ? "pass" : "fail";
  const kpi = (k, v, sub, cls) => h("div", { class: "kpi" }, h("div", { class: "k" }, k), h("div", { class: "v " + (cls || "") }, v), h("div", { class: "s" }, sub));
  const box = h("div", { class: "pane" });
  box.append(h("div", { class: "kpis" },
    kpi("Useful per hour", [s.rated ? ltr(s.perHour.toFixed(1)) : "–"], live ? (s.rated ? `${s.useful} useful in ${s.hours.toFixed(2)} h` : "No ratings yet") : "Practice, not counted", live && s.rated ? (st === "pass" ? "good" : "bad") : "muted"),
    kpi("Rated", ltr(`${s.rated}/${s.cardsTotal}`), p ? `${p} still to rate` : s.cardsTotal ? "All rated" : "No cards"),
    kpi("Bank answered", ltr(Math.round(s.bankShare * 100) + "%"), `${plural(s.questions, "question")}` + (m.noCard ? ` · ${m.noCard} without a card` : "")),
    kpi("To first card (p50)", [ltr(sec(m.cardP50))], ["p95 ", ltr(sec(m.cardP95)), m.cardP50 != null ? " · " + toneWord(m.cardP50, 1000, 3000) : ""], tone(m.cardP50, 1000, 3000)),
    kpi("Cost", ltr(usd(s.costUsd)), `length ${mins(s.durationMs)}`)));
  const content = h("div", { id: "sub-out" });
  const seg = h("div", { class: "seg subnav", role: "group", "aria-label": "Detail section" });
  const subs = [["speed", "Speed"], ["cost", "Cost"], ["events", "Events"]];
  const draw = (k) => { state.sub = k; for (const b of seg.querySelectorAll("button")) b.setAttribute("aria-pressed", b.dataset.k === k ? "true" : "false"); content.textContent = ""; ({ speed: subSpeed, cost: subCost, events: subEvents })[k](content, d); };
  for (const [k, t] of subs) seg.append(h("button", { type: "button", "data-k": k, "aria-pressed": "false", onclick: (e) => { draw(k); e.currentTarget.focus(); } }, t));
  box.append(seg, content); pane.append(box); draw(state.sub || "speed");
}
function subSpeed(out, d) {
  const rows = d.latency.map((l) => ({ l, fin: l.finalAt && l.speechEnd ? l.finalAt - l.speechEnd : null, card: firstCard(l) && l.speechEnd ? firstCard(l) - l.speechEnd : null, tag: l.tagAt && l.speechEnd ? l.tagAt - l.speechEnd : null }));
  if (!rows.length) return out.append(h("div", { class: "empty" }, "No speed data"));
  const def = [["fin", "Speech end → final", 600, 1200], ["card", "→ First card", 1000, 3000], ["tag", "→ Haiku tag", 3000, 5000]];
  const stat = (k) => { const a = rows.map((r) => r[k]); return [pct(a, 0.5), pct(a, 0.95)]; };
  out.append(h("div", { class: "tblwrap" }, h("table", { "aria-label": "Latency per question" },
    h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Question"), def.map(([, label]) => h("th", { scope: "col", class: "num" }, label)), h("th", { scope: "col" }, "Tag"))),
    h("tbody", {}, rows.map((r) => { const line = d.transcript.findIndex((x) => String(x.text).trim() === String(r.l.text || "").trim()), go = line >= 0 ? () => setTab("transcript", { line }, true) : null; return h("tr", { class: go ? "go" : "", onclick: go }, h("td", { dir: dirOf(r.l.text), lang: langOf(r.l.text) }, go ? h("button", { type: "button", class: "rowlink q", title: "Show in transcript", onclick: (e) => { e.stopPropagation(); go(); } }, r.l.text || r.l.turnId) : (r.l.text || r.l.turnId)),
      def.map(([k, , g, o]) => h("td", { class: "num " + (k === "card" && r[k] == null ? "lat-bad" : tone(r[k], g, o)) }, k === "card" && r[k] == null ? "no card" : [ltr(sec(r[k])), r[k] != null && tone(r[k], g, o) === "lat-bad" ? h("span", { class: "sr" }, " (slow)") : null])),
      h("td", {}, r.l.tag ? chip(r.l.tag, "", { mono: true }) : ""));})),
    h("tfoot", {}, [["p50", 0], ["p95", 1]].map(([lab, ix]) => h("tr", {}, h("td", {}, lab), def.map(([k, , g, o]) => { const v = stat(k)[ix]; return h("td", { class: "num " + tone(v, g, o) }, ltr(sec(v))); }), h("td")))))));
}
function subCost(out, d) {
  const sum = d.usage.filter((u) => u.role === "summary").at(-1), byRole = {};
  for (const u of d.usage) if (u.role !== "summary") { const r = (byRole[u.role] ||= { n: 0, usd: 0 }); r.n++; r.usd += u.usd || 0; }
  if (!Object.keys(byRole).length && !sum) return out.append(h("div", { class: "empty" }, "No cost data"));
  const total = sum ? sum.totalUsd : Object.values(byRole).reduce((a, r) => a + r.usd, 0), hrs = Math.max(d.summary.durationMs / 3_600_000, 1 / 60);
  out.append(h("div", { class: "kpis" },
    h("div", { class: "kpi" }, h("div", { class: "k" }, "Total"), h("div", { class: "v" }, ltr(usd(total))), h("div", { class: "s" }, ltr(usd(total / hrs)), " per hour")),
    sum ? h("div", { class: "kpi" }, h("div", { class: "k" }, "LLM"), h("div", { class: "v" }, ltr(usd(sum.llmUsd || 0)))) : null,
    sum ? h("div", { class: "kpi" }, h("div", { class: "k" }, "STT"), h("div", { class: "v" }, ltr(usd(sum.sttUsd || 0)))) : null));
  const maxUsd = Math.max(...Object.values(byRole).map((r) => r.usd), 1e-9);
  out.append(h("div", { class: "tblwrap" }, h("table", { "aria-label": "Cost per role" }, h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Role"), h("th", { scope: "col", class: "num w-num" }, "Calls"), h("th", { scope: "col", class: "num" }, "Cost"))),
    h("tbody", {}, Object.entries(byRole).map(([k, r]) => h("tr", {}, h("td", {}, h("span", { class: "mono" }, k)), h("td", { class: "num w-num" }, r.n), h("td", { class: "num" }, h("div", { class: "share" }, meter(r.usd / maxUsd), ltr(usd(r.usd))))))))));
}
function subEvents(out, d) {
  const t0 = t0Of(d);
  const evs = d.events.map((e) => ({ e, s: (e.type + " " + JSON.stringify(e)).toLowerCase() })); // precomputed once
  const f = h("input", { type: "text", placeholder: "Filter by type or text", "aria-label": "Filter events" });
  const list = h("div", { class: "evs" }), note = h("span", { class: "sub" }, `${d.events.length} events`);
  const draw = () => {
    list.textContent = ""; const q = f.value.trim().toLowerCase();
    const all = evs.filter((x) => !q || x.s.includes(q));
    all.slice(0, 1000).forEach(({ e }) => list.append(h("div", { class: "ev" }, mmss(e.t - t0) + " ", h("b", {}, e.type), " " + JSON.stringify(e, (k, v) => (k === "t" || k === "type" ? undefined : v)))));
    if (all.length > 1000) list.append(h("div", { class: "empty" }, `Showing 1000 of ${all.length}. Narrow it with the filter.`));
    if (!all.length) list.append(h("div", { class: "empty" }, "No events"));
    note.textContent = q ? `${all.length} of ${d.events.length} events` : `${d.events.length} events`;
  };
  let timer; f.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(draw, 150); });
  draw(); out.append(h("div", { class: "bar" }, h("div", { class: "search" }, ico("search"), f), note), list);
}

/* ---------- keyboard ---------- */
const typingIn = (t) => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (e.key === "Escape") { if (typingIn(t)) { t.blur(); return; } if (state.view === "call") backToList(); return; }
  if (typingIn(t)) return;
  const inMain = t === document.body || $("main").contains(t); // never from the header nav (WCAG 2.1.4: shortcuts only inside the view)
  if (!inMain) return;
  // e.code, not e.key: works on the Hebrew keyboard layout too.
  if (state.view === "inbox" && e.code === "Slash") { const q = $("q"); if (q) { e.preventDefault(); q.focus(); } return; }
  if (state.view !== "call" || !state.detail || !$("tabs")) return;
  const dig = /^Digit([1-5])$/.exec(e.code);
  if (dig) { e.preventDefault(); const k = TABS[+dig[1] - 1][0]; setTab(k, {}, false); $("tab-" + k).focus({ preventScroll: true }); return; }
  if (state.tab !== "rate" || !$("cardlist")) return;
  const els = cardEls(); if (!els.length) return;
  const ids = els.map((x) => x.dataset.id), i = Math.max(0, ids.indexOf(state.sel));
  const inList = $("cardlist").contains(t);
  if (e.code === "KeyJ" || (inList && e.key === "ArrowDown")) { e.preventDefault(); setCur(ids[Math.min(ids.length - 1, i + 1)], true); }
  else if (e.code === "KeyK" || (inList && e.key === "ArrowUp")) { e.preventDefault(); setCur(ids[Math.max(0, i - 1)], true); }
  else if (e.code === "KeyY" || e.code === "KeyN" || e.code === "KeyU") {
    if (t.closest && t.closest(".rate") && t.tagName === "BUTTON" && (e.code === "KeyY" || e.code === "KeyN")) { /* still rate */ }
    const c = state.detail.cards.find((x) => x.id === state.sel); if (!c || !rateable(c)) return;
    e.preventDefault();
    if (e.code === "KeyU") { const cur = state.detail.tags[c.id]; if (cur) doRate(c, cur, false); }
    else doRate(c, e.code === "KeyY" ? "y" : "n", true);
  }
});

