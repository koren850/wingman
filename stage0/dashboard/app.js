"use strict";
// Renderer: all call text goes in through textContent only (call text is untrusted).
const api = window.wingman;
const $ = (id) => document.getElementById(id);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") el.className = v; else if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}
const ltr = (s) => h("span", { class: "ltr" }, s);
const pad = (n) => String(n).padStart(2, "0");
const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };
const dur = (ms) => { const s = Math.round(ms / 1000); return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : mmss(ms); };
const dt = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const usd = (n) => (n < 0.01 ? "$" + n.toFixed(4) : "$" + n.toFixed(2));
const sec = (ms) => (ms == null || isNaN(ms) ? "-" : (ms / 1000).toFixed(2) + "s");
const pct = (arr, p) => { const a = arr.filter((x) => x != null && !isNaN(x)).sort((x, y) => x - y); if (!a.length) return null; return a[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)]; };

const state = { calls: [], view: "list", id: null, tab: "transcript", detail: null, search: "", hits: null, gen: 0 };

function renderGate() {
  const live = state.calls.filter((c) => c.mode === "live" && c.rated > 0);
  const el = $("gate"); el.textContent = "";
  const hours = live.reduce((a, c) => a + c.hours, 0), useful = live.reduce((a, c) => a + c.useful, 0);
  const ph = hours ? useful / hours : null;
  const liveAll = state.calls.filter((c) => c.mode === "live").length;
  el.append(
    h("span", { class: "muted" }, "שער התועלת (שיחות חיות)"),
    h("span", { class: "big" }, ltr(ph == null ? "-" : ph.toFixed(1)), " ", h("span", { class: "muted" }, "שימושיים/שעה")),
    h("span", { class: "pill " + (ph == null ? "na" : ph >= 2 ? "pass" : "fail") }, ph == null ? "אין דירוגים" : ph >= 2 ? "עובר" : "נכשל", " (מעל 2)"),
    h("span", { class: "muted" }, `${live.length} מתוך ${liveAll} שיחות חיות מדורגות · ${useful} שימושיים ב-`, ltr(hours.toFixed(2) + "h")),
    h("span", { class: "muted" }, "הדמיות קובץ לא נספרות"));
}

async function loadList() {
  state.calls = await api.listCalls();
  renderGate();
}

function viewList() {
  state.view = "list"; setNav();
  const main = $("main"); main.textContent = "";
  const input = h("input", { type: "search", placeholder: "חיפוש בתמלול…", value: state.search });
  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => { state.search = input.value; state.hits = state.search.trim() ? new Set(await api.searchCalls(state.search)) : null; draw(); }, 200);
  });
  const body = h("div");
  main.append(h("div", { class: "bar" }, input, h("button", { onclick: async () => { await loadList(); draw(); } }, "רענון"), h("span", { class: "muted", id: "count" })), body);
  function draw() {
    body.textContent = "";
    const rows = state.calls.filter((c) => !state.hits || state.hits.has(c.id));
    $("count").textContent = `${rows.length} שיחות`;
    if (!rows.length) { body.append(h("div", { class: "empty" }, state.calls.length ? "אין שיחות שמתאימות לחיפוש" : "אין שיחות עדיין. pnpm call")); return; }
    const th = (t, c) => h("th", { class: c || "" }, t);
    const tbl = h("table", {}, h("thead", {}, h("tr", {}, th("תאריך"), th("משך"), th("סוג"), th("פרופיל"), th("שאלות", "num"), th("כרטיסים", "num"), th("דורגו/שימושיים", "num"), th("שימושיים/שעה", "num"), th("עלות", "num"), th(""))),
      h("tbody", {}, rows.map((c) => h("tr", { class: "click", onclick: () => openCall(c.id) },
        h("td", {}, ltr(dt(c.startedAt))), h("td", {}, ltr(dur(c.durationMs))),
        h("td", {}, h("span", { class: "tag " + (c.mode === "live" ? "live" : "") }, c.mode === "live" ? "חי" : "קובץ")),
        h("td", {}, c.profile ? ltr(c.profile) : "", c.noAi ? " (בלי AI)" : ""),
        h("td", { class: "num" }, c.questions), h("td", { class: "num" }, c.cardsShown),
        h("td", { class: "num" }, ltr(`${c.rated}/${c.useful}`)), h("td", { class: "num" }, c.rated ? ltr(c.perHour.toFixed(1)) : "-"),
        h("td", { class: "num" }, ltr(usd(c.costUsd))), h("td", {}, c.crashed ? h("span", { class: "tag crash" }, "קרס") : "")))));
    body.append(tbl);
  }
  draw();
}

async function openCall(id) {
  state.view = "detail"; state.id = id; state.tab = "transcript"; setNav();
  const gen = ++state.gen;
  $("main").textContent = "";
  const d = await api.getCall(id);
  if (gen !== state.gen) return;
  state.detail = d; viewDetail();
}

const TABS = [["transcript", "תמלול"], ["cards", "כרטיסים"], ["side", "צד"], ["speed", "מהירות"], ["cost", "עלות"], ["events", "אירועים"]];
function viewDetail() {
  const d = state.detail, s = d.summary, main = $("main");
  main.textContent = "";
  main.append(
    h("div", { class: "head" },
      h("button", { onclick: async () => { await loadList(); viewList(); } }, "← חזרה"),
      h("b", {}, ltr(dt(s.startedAt))), h("span", { class: "tag " + (s.mode === "live" ? "live" : "") }, s.mode === "live" ? "חי" : "קובץ"),
      h("span", { class: "muted" }, "משך ", ltr(dur(s.durationMs)), " · ", `${s.questions} שאלות · `, "עלות ", ltr(usd(s.costUsd)), s.profile ? " · " : "", s.profile ? ltr(s.profile) : ""),
      h("span", { id: "rsum" }),
      h("span", { style: "flex:1" }),
      h("button", { class: "danger", onclick: async () => { if (await api.deleteCall(state.id)) { await loadList(); viewList(); } } }, "מחיקת שיחה")),
    h("div", { class: "tabs" }, TABS.map(([k, t]) => h("button", { class: state.tab === k ? "on" : "", onclick: () => { state.tab = k; viewDetail(); } }, t))),
    h("div", { id: "pane" }));
  updateRsum();
  const pane = $("pane");
  ({ transcript: tTranscript, cards: tCards, side: tSide, speed: tSpeed, cost: tCost, events: tEvents })[state.tab](pane, d);
}
function updateRsum() {
  const s = state.detail.summary, el = $("rsum"); if (!el) return;
  el.textContent = `דורגו ${s.rated}/${s.cardsTotal} · שימושיים ${s.useful} · ${s.perHour.toFixed(1)}/שעה · הבנק ענה ${Math.round(s.bankShare * 100)}%`;
  el.className = "muted";
}

function tTranscript(pane, d) {
  const t0 = Date.parse(d.meta.startedAt) || (d.transcript[0] && d.transcript[0].t) || 0;
  if (!d.transcript.length) return pane.append(h("div", { class: "empty" }, "אין תמלול"));
  for (const r of d.transcript) pane.append(h("div", { class: "row " + (r.ch === "me" ? "me" : "them") }, h("span", { class: "ts" }, mmss(r.t - t0)), h("span", { class: "who" }, r.ch === "me" ? "אני" : "הם"), h("span", {}, r.text)));
}

function cardEl(c) {
  const rated = state.detail.tags[c.id];
  const rateable = c.badge !== "info" && !c.health;
  const rate = h("span", { class: "rate" });
  if (rateable) {
    const mk = (v, label) => h("button", { class: v + (rated === v ? " on" : ""), onclick: async () => {
      const next = state.detail.tags[c.id] === v ? null : v;
      try { state.detail.summary = await api.setTag(state.id, c.id, next); } catch (e) { alert("שמירה נכשלה: " + e.message); return; }
      if (next) state.detail.tags[c.id] = next; else delete state.detail.tags[c.id];
      viewDetail();
    } }, label);
    rate.append(mk("y", "שימושי"), " ", mk("n", "לא שימושי"));
  }
  return h("div", { class: "card " + c.badge + (c.hidden ? " hidden" : "") },
    c.question ? h("div", { class: "q" }, c.question) : null, h("div", { class: "say" }, c.say || ""),
    c.facts && c.facts.length ? h("ul", {}, c.facts.map((f) => h("li", {}, f))) : null,
    h("div", { class: "meta" }, h("span", { class: "tag" }, c.badge), c.hidden ? h("span", { class: "tag" }, "מוסתר: " + (c.hiddenReason || "")) : null, c.dim ? h("span", { class: "tag" }, "עמום") : null, rate));
}
function tCards(pane, d) {
  const cs = d.cards.filter((c) => c.turnId !== "side" && !c.health);
  if (!cs.length) return pane.append(h("div", { class: "empty" }, "אין כרטיסים"));
  cs.forEach((c) => pane.append(cardEl(c)));
}
function tSide(pane, d) {
  const cs = d.cards.filter((c) => c.turnId === "side" && !c.health);
  pane.append(h("h3", {}, "כרטיסי צד"));
  cs.length ? cs.forEach((c) => pane.append(cardEl(c))) : pane.append(h("div", { class: "empty" }, "אין"));
  pane.append(h("h3", {}, "נתפס (טלפון / מייל / דומיין)"));
  d.captures.length ? pane.append(h("table", {}, h("tbody", {}, d.captures.map((c) => h("tr", {}, h("td", {}, c.kind), h("td", {}, ltr(c.value)))))))
    : pane.append(h("div", { class: "empty" }, "אין"));
  pane.append(h("h3", {}, "הערות הקשר ואישורי לקוח"));
  const ev = d.events.filter((e) => e.type === "context.note" || e.type === "client.confirmed");
  ev.length ? ev.forEach((e) => pane.append(h("div", { class: "row" }, h("span", { class: "tag" }, e.type), h("span", {}, e.text || e.note || JSON.stringify(e, (k, v) => (k === "t" || k === "type" ? undefined : v))))))
    : pane.append(h("div", { class: "empty" }, "אין"));
}

function firstCard(l) { const ts = [l.bankAt, l.stallAt, l.cardAt].filter(Boolean); return ts.length ? Math.min(...ts) : null; }
function tSpeed(pane, d) {
  const rows = d.latency.map((l) => ({ l, fin: l.finalAt && l.speechEnd ? l.finalAt - l.speechEnd : null, card: firstCard(l) && l.speechEnd ? firstCard(l) - l.speechEnd : null, tag: l.tagAt && l.speechEnd ? l.tagAt - l.speechEnd : null }));
  const stat = (k) => { const a = rows.map((r) => r[k]); return [pct(a, 0.5), pct(a, 0.95)]; };
  if (!rows.length) pane.append(h("div", { class: "empty" }, "אין נתוני מהירות"));
  else pane.append(h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "שאלה"), h("th", { class: "num" }, "סוף דיבור → סופי"), h("th", { class: "num" }, "→ כרטיס ראשון"), h("th", { class: "num" }, "→ תג Haiku"), h("th", {}, "תג"))),
    h("tbody", {}, rows.map((r) => h("tr", {}, h("td", {}, r.l.text || r.l.turnId), h("td", { class: "num" }, ltr(sec(r.fin))), h("td", { class: "num" }, ltr(r.card == null ? "ללא כרטיס" : sec(r.card))), h("td", { class: "num" }, ltr(sec(r.tag))), h("td", {}, r.l.tag ? ltr(r.l.tag) : "")))),
    h("tfoot", {}, ["p50", "p95"].map((p, i) => h("tr", {}, h("th", {}, p), ["fin", "card", "tag"].map((k) => h("th", { class: "num" }, ltr(sec(stat(k)[i])))), h("th", {}))))));
  pane.append(h("h3", {}, "למה אין כרטיס? (זיהוי שאלות)"));
  const lat = d.latency;
  const det = d.events.filter((e) => e.type === "detect");
  const noCard = det.filter((e) => { const l = lat.find((x) => x.text === e.text); return !l || !firstCard(l); });
  if (!noCard.length) return pane.append(h("div", { class: "empty" }, "לכל מה שזוהה יש כרטיס"));
  pane.append(h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "טקסט"), h("th", {}, "שאלה?"), h("th", {}, "סיבה"))),
    h("tbody", {}, noCard.map((e) => h("tr", {}, h("td", {}, e.text), h("td", {}, e.isQuestion ? "כן (בלי כרטיס)" : "לא"), h("td", {}, ltr(e.reason || "")))))));
}

function tCost(pane, d) {
  const sum = d.usage.filter((u) => u.role === "summary").at(-1);
  const byRole = {};
  for (const u of d.usage) if (u.role !== "summary") { const r = (byRole[u.role] ||= { n: 0, usd: 0 }); r.n++; r.usd += u.usd || 0; }
  if (!Object.keys(byRole).length && !sum) return pane.append(h("div", { class: "empty" }, "אין נתוני עלות"));
  pane.append(h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "תפקיד"), h("th", { class: "num" }, "קריאות"), h("th", { class: "num" }, "עלות"))),
    h("tbody", {}, Object.entries(byRole).map(([k, r]) => h("tr", {}, h("td", {}, ltr(k)), h("td", { class: "num" }, r.n), h("td", { class: "num" }, ltr(usd(r.usd))))))));
  if (sum) pane.append(h("p", {}, "סה״כ ", h("b", {}, ltr(usd(sum.totalUsd))), h("span", { class: "muted" }, " (LLM ", ltr(usd(sum.llmUsd || 0)), " · STT ", ltr(usd(sum.sttUsd || 0)), ")")));
}

function tEvents(pane, d) {
  const f = h("input", { type: "text", placeholder: "סינון לפי סוג או טקסט…" });
  const list = h("div");
  const draw = () => {
    list.textContent = ""; const q = f.value.trim().toLowerCase();
    const evs = d.events.filter((e) => !q || (e.type + " " + JSON.stringify(e)).toLowerCase().includes(q)).slice(0, 1000);
    evs.forEach((e) => list.append(h("div", { class: "ev" }, `${mmss(e.t - (Date.parse(d.meta.startedAt) || d.events[0].t))} ${e.type} ${JSON.stringify(e, (k, v) => (k === "t" || k === "type" ? undefined : v))}`)));
  };
  f.addEventListener("input", draw); draw();
  pane.append(h("details", {}, h("summary", {}, `אירועים גולמיים (${d.events.length})`), h("div", { class: "bar" }, f), list));
}

async function viewSettings() {
  state.view = "settings"; setNav();
  const main = $("main"); main.textContent = "";
  const out = h("pre", {}, "טוען…");
  const run = async (fn) => { out.textContent = "מריץ…"; try { const r = await fn(); out.textContent = r.text.trim() || "(אין פלט)"; } catch (e) { out.textContent = "שגיאה: " + e.message; } };
  main.append(h("div", { class: "bar" }, h("button", { onclick: () => run(api.settingsText) }, "pnpm settings"), h("button", { onclick: () => run(api.doctorOffline) }, "Doctor (offline)"), h("span", { class: "muted" }, "קריאה בלבד · מפתחות לא מוצגים")), out);
  run(api.settingsText);
}

function setNav() { $("nav-list").className = "tab" + (state.view !== "settings" ? " on" : ""); $("nav-settings").className = "tab" + (state.view === "settings" ? " on" : ""); }
$("nav-list").addEventListener("click", async () => { await loadList(); viewList(); });
$("nav-settings").addEventListener("click", viewSettings);
loadList().then(() => {
  const q = new URLSearchParams(location.search); // dev aid for screenshots: ?call=<id>&tab=cards
  if (q.get("call")) { state.tab = q.get("tab") || "transcript"; return openCall(q.get("call")).then(() => { if (q.get("tab")) { state.tab = q.get("tab"); viewDetail(); } }); }
  viewList();
}).catch((e) => { $("main").textContent = "שגיאה בטעינה: " + e.message; });
