"use strict";
// Home: start or plan a call, run the live call, and see what is waiting. Shares helpers with app.js (classic scripts).
// The page only asks the main process for fixed commands (start, consent, quiet, client, note, stop). All call text goes in via textContent.

const H = { attach: null, attachDirty: false, panelKey: "", timer: null, brief: undefined, editing: false, dismissed: "", doctorBusy: false, tickBound: false, lastHealth: "" };
const isRunning = () => !!(state.call && state.call.running);
const phaseOf = () => (state.call ? state.call.phase : "idle");
const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
const hrs = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`; };

/** Run a controller command; say plainly when it did not happen. */
async function act(fn, what) {
  let r; try { r = await fn(); } catch (e) { fail(`${what}: ${e.message}`); return false; }
  if (r && r.cancelled) return false;
  if (r && r.ok === false) { fail(r.error === "preview" ? "This is a preview, nothing was started." : `${what} did not work right now.`); return false; }
  return true;
}

/* ---------- header: call chip + live state ---------- */
function onCallState(s) {
  const was = state.call && state.call.running;
  state.call = s;
  if (was && !s.running) loadList().then(() => { if (state.view === "home") renderSide(); });
  renderCallSlot();
  if (state.view === "home") {
    updateCallPanel();
    const k = `${!!s.doctorRunning}|${s.doctor ? s.doctor.at : 0}|${!!s.briefReady}|${!!s.running}`;
    if (k !== H.sideKey) { const first = H.sideKey === undefined; H.sideKey = k; if (!first && !H.editing && !document.querySelector("#side-col form :focus")) renderSide(); }
  }
}
function renderCallSlot() {
  const slot = $("call-slot"); slot.textContent = "";
  if (!isRunning()) return;
  const s = state.call, ph = s.phase;
  const label = ph === "live" ? (s.practice ? "Practice " : "Call ") + clock(Date.now() - s.liveAt) : ph === "waiting" ? "Waiting for consent" : ph === "stopping" ? "Saving…" : "Starting…";
  const bad = Object.values(s.health || {}).some((x) => x.level === "red");
  slot.append(h("button", { type: "button", id: "call-chip", class: "chip go " + (ph === "live" ? (bad ? "bad" : "good") : "warn"), onclick: () => { if (state.view !== "home") viewHome(); else window.scrollTo({ top: 0 }); }, "aria-label": `${label}. Open Home to control the call`, title: "Go to the live call" }, h("span", { class: "dot pulse" }), h("span", { class: "ctr" }, label), ico("chevron")));
}
function ensureTick() {
  if (H.tickBound) return; H.tickBound = true;
  setInterval(() => {
    if (!isRunning()) return;
    const c = $("call-chip"); if (c) { const t = c.querySelector(".ctr"), s = state.call; if (t && s.phase === "live") t.textContent = (s.practice ? "Practice " : "Call ") + clock(Date.now() - s.liveAt); }
    const big = $("big-timer"); if (big && state.call.phase === "live") big.textContent = clock(Date.now() - state.call.liveAt);
    const w = $("wait-timer"); if (w) w.textContent = clock(Date.now() - state.call.startedAt);
  }, 1000);
}

/* ---------- Home view ---------- */
async function viewHome(focus) {
  if (SK()) return viewHome2(focus);
  closePopover(false);
  state.view = "home"; state.gen++; setNav(); busy();
  const main = $("main"); main.textContent = "";
  const leftCol = h("div", { class: "hcol" }, h("div", { id: "call-col", class: "hcol" }), h("div", { id: "ready-slot" }));
  const sideCol = h("div", { id: "side-col", class: "hcol" });
  main.append(h("div", { class: "page-head" }, h("h1", {}, "Home")), h("div", { class: "home" }, leftCol, sideCol));
  H.panelKey = ""; H.sideKey = undefined;
  ensureTick();
  if (!state.call) { try { state.call = await api.callState(); } catch { state.call = null; } }
  H.brief = await api.getBrief().catch(() => null);
  H.attach = await api.attachList().catch(() => null);
  H.editing = false;
  if (state.view !== "home") return;
  renderCallSlot(); updateCallPanel(true); renderSide();
  ready();
  if (focus === "plan") { const f = $("plan-who") || $("plan-edit"); if (f) { f.scrollIntoView({ block: "center" }); f.focus({ preventScroll: true }); } } else focusTop();
}

function renderSide() {
  if (SK()) return renderSide2();
  const side = $("side-col"), slot = $("ready-slot"); if (!side) return;
  side.textContent = ""; slot.textContent = "";
  if (isRunning()) { side.append(liveFeedPanel()); return; }
  slot.append(readinessCard());
  side.append(planCard(), waitingCard());
}

/* call column: rebuilt when the phase changes, patched in place while it stays the same (so a note being typed is never lost) */
function updateCallPanel(force) {
  const col = $("call-col"); if (!col) return;
  const s = state.call || { phase: "idle", health: {} };
  const running = isRunning();
  const after = !running && s.callId && s.callId !== H.dismissed ? (s.deleted ? "deleted" : "after") : "";
  const key = (running ? s.phase : "idle") + "|" + after + "|" + (H.brief ? "b" : "") + "|" + !!s.practice;
  if (force || key !== H.panelKey) {
    const wasRunning = H.panelKey && /^(starting|waiting|live|stopping)/.test(H.panelKey);
    H.panelKey = key; col.textContent = ""; H.lastHealth = "";
    if (running) col.append(livePanel(s)); else { if (after) col.append(afterCard(s, after)); col.append(SK() ? idleHero() : idleCard()); }
    if (!force && wasRunning !== running) renderSide();
  }
  if (running) patchLive(s);
}

/* ---- idle ---- */
function idleCard() {
  const lg = (label, o) => h("button", { type: "button", class: "btn lg " + (o.cls || ""), id: o.id, onclick: o.onclick }, ico(o.icon), h("span", {}, label));
  const startBtn = lg("Start call", { cls: "primary", id: "start-call", icon: "phone", onclick: async (e) => { const b = e.currentTarget; b.disabled = true; await act(api.start, "Start"); b.disabled = false; } });
  const noAi = btn("Start without AI", { icon: "play", cls: "", id: "start-noai", onclick: () => act(api.startNoAi, "Start without AI") });
  const prac = btn("Practice call (offline, free)", { icon: "play", cls: "", id: "practice", onclick: () => act(api.practice, "Practice call") });
  return h("section", { class: "card-big startcard", "aria-labelledby": "start-h" },
    h("div", { class: "starthead" }, h("span", { class: "capy", "aria-hidden": "true" }), h("div", {}, h("h2", { id: "start-h" }, "Ready when your call is"), null)),
    startBtn,
    H.brief ? h("p", { class: "briefnote" }, chip("Briefing ready", "good", { dot: true }), " ", H.brief.who ? `for ${H.brief.who}` : "for this call", " will be used.") : h("p", { class: "briefnote faint" }, "No briefing yet. Use Plan a call to give the AI context."),
    h("p", { class: "briefnote faint" }, "Wingman listens to any call or meeting and helps live. During a call press ", h("kbd", {}, "Ctrl"), " ", h("kbd", {}, "Opt"), " ", h("kbd", {}, "A"), " and ask it anything."),
    h("div", { class: "startmore" },
      h("div", { class: "opt" }, noAi, h("p", {}, "Bank cards only. Nothing goes to Anthropic; no summary is written.")),
      h("div", { class: "opt" }, prac, h("p", {}, "A pretend call plays through the real answer window on your second screen. No cost, nothing leaves the Mac."))));
}

function afterCard(s, kind) {
  const dismiss = btn("", { icon: "x", cls: "ghost sm icon", aria: "Dismiss", title: "Dismiss", onclick: () => { H.dismissed = s.callId; updateCallPanel(true); } });
  if (kind === "deleted") return h("section", { class: "afterbar", role: "status" }, ico("trash"), h("div", { class: "grow" }, h("b", {}, "Call deleted."), " Nothing from it was kept."), dismiss);
  const known = state.calls.some((c) => c.id === s.callId);
  const go = (tab) => async () => { await loadList(); openCall(s.callId, { tab }); };
  return h("section", { class: "afterbar good", role: "status" }, ico("check"),
    h("div", { class: "grow" }, h("b", {}, s.summaryOk ? "Summary ready." : s.endedCleanly ? "Call saved." : "The call ended with a problem."), " ", s.summaryOk ? "Next steps and a draft follow-up email are waiting." : s.endedCleanly ? "No summary was written (the call was short, or summaries are off). You can still rate the cards." : (s.lastError ? s.lastError.slice(0, 120) : "Check the call for what was saved.")),
    s.summaryOk ? btn("Open follow-up", { cls: "positive", icon: "follow", onclick: go("followup") }) : btn(known || s.endedCleanly ? "Open the call" : "Open calls", { cls: "positive", onclick: go(undefined) }), dismiss);
}

/* ---- live ---- */
function livePanel(s) {
  const ph = s.phase;
  const wrap = h("section", { class: "card-big livecard", "aria-labelledby": "live-h", id: "livecard" });
  const head = h("div", { class: "livehead" }, h("div", {}, h("div", { class: "label", id: "live-h" }, s.practice ? "Practice call" : "Call"), h("div", { class: "phase", id: "phase" })), ph === "live" ? h("div", { class: "bigtime", id: "big-timer", "aria-label": "Call time" }) : chip(ph === "waiting" ? "Nothing is sent yet" : ph === "stopping" ? "Saving…" : "Starting…", ph === "waiting" ? "good" : "warn", { dot: true }));
  wrap.append(head, h("div", { id: "off-banner" }), h("div", { id: "health-box" }));
  if (ph === "starting") wrap.append(h("p", { class: "sub" }, SK() ? "Opening the answer window…" : "Starting the call and opening the answer window… this takes a few seconds."));
  if (ph === "waiting") {
    wrap.append(h("div", { class: "waitbox" },
      h("p", {}, SK() ? "Say the consent line (first card in the answer window), wait for a clear yes, then:" : "Say the consent line to the other person (it is the first card in the answer window), wait for a clear yes, then click:"),
      h("button", { type: "button", id: "consent", class: "btn lg primary", onclick: (e) => { const b = e.currentTarget; b.disabled = true; act(api.consent, "Consent").then((ok) => { if (!ok) b.disabled = false; }); } }, ico("check"), h("span", {}, "Consent given")),
      SK() ? h("p", { class: "sub" }, h("kbd", {}, "Ctrl"), " ", h("kbd", {}, "Opt"), " ", h("kbd", {}, "Return"), " from any app · waiting ", h("span", { class: "ltr", id: "wait-timer" }, "00:00")) : h("p", { class: "sub" }, h("kbd", {}, "Ctrl"), " ", h("kbd", {}, "Opt"), " ", h("kbd", {}, "Return"), " does the same from any app. Nothing is sent to the cloud before this. Waiting for ", h("span", { class: "ltr", id: "wait-timer" }, "00:00"), ".")));
  }
  if (ph === "live" || ph === "waiting") wrap.append(h("div", { id: "client-box" }));
  if (ph === "live") {
    const note = h("input", { type: "text", id: "note-in", maxlength: "300", autocomplete: "off", placeholder: SK() ? "Add a note for the AI" : "Add a note for the AI, e.g. this is about the shop migration", "aria-label": "Note for the AI" });
    const send = async () => { const v = note.value.trim(); if (!v) return; if (await act(() => api.note(v), "Note")) { note.value = ""; announce("Note added"); } };
    note.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); send(); } });
    wrap.append(
      h("div", { class: "liverow" },
        h("button", { type: "button", id: "quiet", class: "switch", role: "switch", "aria-checked": "false", onclick: (e) => { const on = e.currentTarget.getAttribute("aria-checked") !== "true"; act(() => api.quiet(on), "Quiet mode"); } }, h("span", { class: "knob", "aria-hidden": "true" }), h("span", { class: "sl" }, "Quiet mode"), h("span", { class: "faint", id: "quiet-note" })),
        SK() ? tip("Cards are still saved for the review, but the answer window shows nothing.") : h("p", { class: "sub" }, "Cards are still saved for the review, but the answer window shows nothing.")),
      h("div", { class: "noterow" }, note, btn("Add note", { cls: "", id: "note-add", onclick: send }), h("span", { class: "sub", id: "note-count" })));
  }
  const stopRow = h("div", { class: "stoprow" },
    btn(ph === "stopping" ? "Stopping…" : "Stop call", { id: "stop", icon: "stop", cls: "", onclick: () => act(api.stop, "Stop") }),
    btn("Stop and delete", { id: "stop-del", icon: "trash", cls: "danger", onclick: () => act(api.stopDelete, "Stop and delete") }));
  if (ph !== "starting") wrap.append(stopRow);
  if (ph === "stopping") wrap.append(h("p", { class: "sub", id: "saving" }, SK() ? "Saving and writing the summary, up to 20 seconds." : "Saving the call and writing the summary. This can take up to 20 seconds. You can leave this window."));
  return wrap;
}
function patchLive(s) {
  const ph = s.phase, now = Date.now();
  const phase = $("phase"); if (phase) phase.textContent = ph === "waiting" ? "Waiting for consent" : ph === "live" ? "Listening" : ph === "stopping" ? "Stopping" : "Starting";
  const big = $("big-timer"); if (big) big.textContent = clock(now - s.liveAt);
  const wt = $("wait-timer"); if (wt) wt.textContent = clock(now - s.startedAt);
  const q = $("quiet"); if (q) { q.setAttribute("aria-checked", s.quiet ? "true" : "false"); const n = $("quiet-note"); if (n) n.textContent = s.quiet ? "On: cards are hidden" : "Off"; }
  const nc = $("note-count"); if (nc) nc.textContent = s.notes ? plural(s.notes, "note") + " added" : "";
  const st = $("stop"), sd = $("stop-del"); if (st) st.disabled = ph === "stopping"; if (sd) sd.disabled = ph === "stopping";
  if (st) st.querySelector("span").textContent = ph === "stopping" ? "Stopping…" : "Stop call";
  // client proposal
  const cb = $("client-box");
  if (cb) {
    const k = (s.client ? "c:" + s.client : s.proposed ? "p:" + s.proposed : "");
    if (cb.dataset.k !== k) {
      cb.dataset.k = k; cb.textContent = "";
      if (s.client) cb.append(h("div", { class: "clientrow" }, chip("Who", "info"), h("b", {}, s.client), h("span", { class: "faint" }, "confirmed, the AI uses it")));
      else if (s.proposed) cb.append(h("div", { class: "clientrow ask" }, ico("help"), h("div", { class: "grow" }, "Looks like ", h("b", { dir: dirOf(s.proposed), lang: langOf(s.proposed) }, s.proposed), ". Is this who the call is with?"), btn("Confirm client", { cls: "primary", id: "confirm-client", onclick: () => act(api.confirmClient, "Confirm client") })));
    }
  }
  // health and problems in plain words
  const items = [];
  if (s.offReason) items.push(["bad", "Wingman turned itself off: " + s.offReason + ". It is not listening any more. The call so far is saved."]);
  for (const hh of Object.values(s.health || {})) items.push([hh.level === "red" ? "bad" : "warn", hh.text]);
  if (s.overlayDown) items.push(["warn", s.overlayDown === "one-screen" ? "No answer window: only one screen is connected, so it stays closed to keep it out of screen share. Still listening; cards are saved." : "The answer window closed. Still listening; cards are saved."]);
  if (s.lastError && ph !== "live") items.push(["warn", s.lastError.slice(0, 160)]);
  const hk = JSON.stringify(items);
  if (hk !== H.lastHealth) {
    H.lastHealth = hk;
    const box = $("health-box"); if (box) { box.textContent = ""; if (items.length) box.append(h("ul", { class: "healthlist", "aria-label": "Warnings" }, items.map(([lvl, t]) => h("li", { class: lvl }, ico("warning"), h("span", {}, t))))); }
    if (items.some((i) => i[0] === "bad")) announce("Wingman problem: " + items.find((i) => i[0] === "bad")[1]);
  }
}

/* ---------- Plan a call ---------- */
function planCard() {
  const sec = h("section", { class: "card-big plan", "aria-labelledby": "plan-h" });
  sec.append(h("h2", { id: "plan-h" }, ico("plan"), "Plan a call"));
  if (H.brief && !H.editing) {
    const b = H.brief;
    const line = (k, v) => v ? h("div", { class: "pl" }, h("span", { class: "k" }, k), h("span", { class: "v", dir: dirOf(v), lang: langOf(v) }, v)) : null;
    sec.append(
      h("div", { class: "briefready", role: "status" }, ico("check"), h("span", {}, h("b", {}, "Briefing ready for your next call"), ` (expires in ${hrs(b.expiresInMs)})`)),
      h("div", { class: "plsum" }, line("Who", b.who), line("Goal", b.goal), line("Notes", b.notes.split("\n").join(" · ")), line("Must cover", b.mustCover.split("\n").join(" · "))),
      h("div", { class: "actions" }, btn("Edit", { id: "plan-edit", icon: "plan", onclick: () => { H.editing = true; renderSide(); const f = $("plan-who"); if (f) f.focus(); } }),
        btn("Clear", { id: "plan-clear", icon: "x", cls: "ghost", onclick: async () => { await api.clearBrief(); H.brief = null; H.attach = null; H.editing = false; renderSide(); updateCallPanel(true); announce("Briefing cleared"); } })));
    return sec;
  }
  const f = (id, label, help, el) => h("div", { class: "field" }, h("label", { for: id }, label), el, help ? h("p", { class: "help", id: id + "-h" }, help) : null);
  const b = H.brief || { who: "", goal: "", notes: "", mustCover: "" };
  const who = h("input", { type: "text", id: "plan-who", maxlength: "120", autocomplete: "off", value: b.who, placeholder: "Who is on the call?", "aria-describedby": "plan-who-h" });
  const goal = h("input", { type: "text", id: "plan-goal", maxlength: "200", autocomplete: "off", value: b.goal, placeholder: "What do you want out of it?", "aria-describedby": "plan-goal-h" });
  const notes = h("textarea", { id: "plan-notes", maxlength: "600", rows: "2", placeholder: "One per line, e.g. they run a WooCommerce shop on old hosting", "aria-describedby": "plan-notes-h" }); notes.value = b.notes;
  const must = h("textarea", { id: "plan-must", maxlength: "600", rows: "2", placeholder: "One per line, e.g. budget, timeline", "aria-describedby": "plan-must-h" }); must.value = b.mustCover;
  const err = h("div", { class: "formerr", role: "alert", id: "plan-err" });
  const form = h("form", { id: "plan-form", novalidate: true },
    f("plan-who", "Who is on the call", "Name of the person or company. The AI and the fact cards use it.", who),
    f("plan-goal", "Goal", "The one outcome that makes this call a success.", goal),
    f("plan-notes", "Notes for the AI", "Background it should know. It never reads these out loud.", notes),
    f("plan-must", "Must cover", "You get a reminder in the answer window if one of these has not come up after 15 minutes.", must),
    attachField(),
    err,
    h("div", { class: "actions" }, h("button", { type: "submit", class: "btn", id: "plan-save" }, ico("check"), h("span", {}, "Save briefing")), H.editing ? btn("Cancel", { onclick: () => { H.editing = false; renderSide(); } }) : null),
    h("p", { class: "sub" }, "Saved briefings are used by the next call that starts within 6 hours."));
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); err.textContent = "";
    let r; try { r = await api.saveBrief({ who: who.value, goal: goal.value, notes: notes.value, mustCover: must.value }); } catch (x) { err.textContent = "Could not save: " + x.message; return; }
    if (!r.ok) { err.textContent = r.error || "Could not save."; return; }
    H.brief = r.brief; H.editing = false; renderSide(); updateCallPanel(true); announce("Briefing saved for your next call");
    const ed = $("plan-edit"); if (ed) ed.focus();
  });
  sec.append(form);
  return sec;
}

/* ---------- Readiness (doctor) ---------- */
function readinessCard() {
  const d = (state.call && state.call.doctor) || null;
  const running = !!(state.call && state.call.doctorRunning) || H.doctorBusy;
  const sec = h("section", { class: "card-big ready", "aria-labelledby": "ready-h", id: "ready-card" });
  const verdict = running ? chip("Checking…", "warn", { dot: true }) : !d ? chip("Not checked yet", "") : d.ok ? chip(d.verdict === "READY" ? "READY" : "READY, with warnings", "good", { dot: true }) : chip(d.verdict === "BUSY" ? "BUSY" : "NOT READY", d.verdict === "BUSY" ? "warn" : "bad", { dot: true });
  sec.append(h("div", { class: "rhead" }, h("h2", { id: "ready-h" }, ico("mic"), "Ready for a call?"), verdict, h("span", { class: "grow" }),
    h("button", { type: "button", class: "btn sm", id: "recheck", disabled: running, onclick: runCheck }, ico("refresh"), h("span", {}, running ? "Checking…" : d ? "Re-check" : "Run check"))));
  if (running) sec.append(h("p", { class: "sub" }, "Testing the microphone, system audio, the speech service and the AI. About 20 seconds, a few cents."));
  else if (!d) sec.append(h("p", { class: "sub" }, "Run this before a call. It tests the microphone, system audio, your keys, the speech service and the AI."));
  else {
    sec.append(h("p", { class: "sub" }, `Checked ${ago(d.at)}.` + (d.ok ? (d.warnings.length ? " You can call; fix these if you can:" : " Everything needed for a call works.") : " Fix these before the call:")));
    const list = [...d.failing.map((x) => ["bad", x]), ...d.warnings.map((x) => ["warn", x])];
    if (list.length) sec.append(h("ul", { class: "issues2" }, list.map(([lvl, x]) => h("li", { class: lvl }, ico(lvl === "bad" ? "x" : "warning"), h("div", {}, h("div", {}, x.text), x.fix ? h("div", { class: "fix" }, "Fix: " + x.fix) : null)))));
    if (!d.ok && d.verdict !== "BUSY") sec.append(h("p", { class: "sub" }, "Keys and options are on the ", h("button", { type: "button", class: "linkbtn", id: "to-settings", onclick: () => viewSettings() }, "Settings page"), "."));
  }
  return sec;
}
async function runCheck() {
  H.doctorBusy = true; renderSide(); announce("Checking everything. About 20 seconds.");
  let r = null; try { r = await api.runDoctor(); } catch (e) { fail("Check failed: " + e.message); }
  H.doctorBusy = false;
  if (r && state.call) state.call.doctor = r;
  if (state.view === "home") renderSide();
  if (r) announce(r.ok ? "Ready for a call" : "Not ready: " + (r.failing[0] ? r.failing[0].text : r.verdict));
}

/* ---------- Waiting for you ---------- */
function waitingCard() {
  const todo = state.calls.filter((c) => !c.crashed && (pendingOf(c) > 0 || c.hasSummary)).slice(0, 5);
  const sec = h("section", { class: "card-big waiting", "aria-labelledby": "wait-h" });
  const nP = todo.reduce((a, c) => a + pendingOf(c), 0);
  sec.append(h("div", { class: "rhead" }, h("h2", { id: "wait-h" }, SK() ? null : ico("inbox"), "Waiting for you", SK() && todo.length ? h("span", { class: "cnt" }, nP ? plural(nP, "card") : todo.length) : null), h("span", { class: "grow" }), btn("All calls", { cls: "ghost sm", onclick: () => { loadList().then(() => viewInbox()); } })));
  if (!todo.length) { sec.append(h("p", { class: "sub" }, SK() ? "You're all caught up." : state.calls.length ? "Nothing to rate or send. You're all caught up." : "After your first call, cards to rate and follow-up emails appear here.")); return sec; }
  sec.append(h("ul", { class: "waitlist" }, todo.map((c) => {
    const p = pendingOf(c), go = (o) => openCall(c.id, o);
    const tab = c.mode === "live" && p ? "rate" : c.hasSummary ? "followup" : "rate";
    return h("li", { class: "wl go", onclick: (e) => { if (!e.target.closest("button")) go({ tab, filter: tab === "rate" ? "unrated" : undefined }); } },
      h("button", { type: "button", class: "rowlink", onclick: () => go({ tab, filter: tab === "rate" ? "unrated" : undefined }) }, dayLabel(c.startedAt), h("span", { class: "tm" }, tm(c.startedAt)), h("span", { class: "tm" }, mins(c.durationMs))),
      h("span", { class: "wait" },
        p ? linkChip([h("span", { class: "ctr" }, p), " to rate"], "warn", () => go({ tab: "rate", filter: "unrated" }), `${p} to rate, open Rate`) : null,
        c.hasSummary ? linkChip("Send summary", "info", () => go({ tab: "followup" }), "Summary ready, open Follow-up") : null));
  })));
  return sec;
}

/* =====================================================================
   Skinned Home (data-skin a|b|c). Same data and commands as above, different structure:
   greeting header with a readiness pill, one big Start, a compact Plan strip (the form opens as a sheet), Waiting for you above the fold.
   ===================================================================== */
async function viewHome2(focus) {
  closePopover(false); closeSheet();
  state.view = "home"; state.gen++; setNav(); busy();
  const main = $("main"); main.textContent = "";
  main.append(h("header", { id: "home-head", class: "hh" }), h("div", { class: "home home2" }, h("div", { class: "hcol hleft" }, h("div", { id: "call-col", class: "hcol" }), h("div", { id: "plan-slot" })), h("div", { id: "side-col", class: "hcol hside" })));
  H.panelKey = ""; H.sideKey = undefined; H.readyOpen = false;
  ensureTick();
  if (!state.call) { try { state.call = await api.callState(); } catch { state.call = null; } }
  H.brief = await api.getBrief().catch(() => null);
  H.attach = await api.attachList().catch(() => null);
  H.editing = false;
  if (state.view !== "home") return;
  renderCallSlot(); updateCallPanel(true); renderSide();
  ready();
  if (focus === "plan") openPlanSheet(); else focusTop();
}

function renderSide2() {
  const side = $("side-col"); if (!side) return;
  side.textContent = "";
  renderHead();
  const ps = $("plan-slot"); if (ps) { ps.textContent = ""; if (!isRunning()) ps.append(planStrip()); }
  side.append(isRunning() ? liveFeedPanel() : waitingCard());
}

/* header: date, greeting, the next thing to do, and the readiness pill */
function renderHead() {
  const hd = $("home-head"); if (!hd) return;
  hd.textContent = "";
  if (isRunning()) { hd.classList.add("live"); hd.append(h("h1", { class: "sr" }, "Call in progress")); return; }
  hd.classList.remove("live");
  const now = new Date(), hr = now.getHours();
  const greet = hr < 5 ? "Still up" : hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
  const c = state.calls.find((x) => !x.crashed && (pendingOf(x) > 0 || x.hasSummary));
  let next;
  if (c) {
    const p = pendingOf(c), tab = c.mode === "live" && p ? "rate" : c.hasSummary ? "followup" : "rate";
    const label = tab === "rate" ? `Rate ${plural(p, "card")} from ${dayLabel(c.startedAt).toLowerCase()} ${tm(c.startedAt)}` : `Send the summary from ${dayLabel(c.startedAt).toLowerCase()} ${tm(c.startedAt)}`;
    next = h("button", { type: "button", class: "nextact", id: "next-action", onclick: () => openCall(c.id, { tab, filter: tab === "rate" ? "unrated" : undefined }) }, h("span", { class: "k" }, "Next"), h("span", {}, label), ico("chevron"));
  } else next = h("p", { class: "nextact none" }, "Nothing waiting. Start whenever you are ready.");
  hd.append(h("div", { class: "hh-text" }, h("div", { class: "hh-date" }, fullDay(now.getTime())), h("h1", {}, `${greet}, Dan`), next), h("div", { class: "hh-act" }, readyPill()));
}

function readyPill() {
  const d = (state.call && state.call.doctor) || null, running = !!(state.call && state.call.doctorRunning) || H.doctorBusy;
  let cls = "", label;
  if (running) { cls = "warn"; label = "Checking…"; }
  else if (!d) { cls = ""; label = "Not checked"; }
  else if (d.ok) { cls = d.warnings.length ? "warn" : "good"; label = d.warnings.length ? `Ready · ${plural(d.warnings.length, "warning")}` : "Ready"; }
  else { cls = d.verdict === "BUSY" ? "warn" : "bad"; label = d.verdict === "BUSY" ? "Busy" : "Not ready"; }
  const wrap = h("div", { class: "rwrap" });
  const b = h("button", { type: "button", class: "rpill " + cls, id: "ready-pill", "aria-haspopup": "dialog", "aria-expanded": H.readyOpen ? "true" : "false", "aria-controls": "ready-pop", onclick: () => { H.readyOpen = !H.readyOpen; renderSide(); const nb = $("ready-pill"); if (nb && H.readyOpen) { const pop = $("ready-pop"); if (pop) pop.focus({ preventScroll: true }); } else if (nb) nb.focus(); } },
    h("span", { class: "dot" + (running ? " pulse" : "") }), h("span", {}, label), ico("chevron"));
  b.title = "Microphone, keys, speech service and AI";
  wrap.append(b);
  if (H.readyOpen) wrap.append(readyPop(d, running));
  return wrap;
}
function readyPop(d, running) {
  const pop = h("div", { class: "rpop", id: "ready-pop", role: "dialog", "aria-label": "Readiness", tabindex: "-1" });
  const close = () => { H.readyOpen = false; renderSide(); const b = $("ready-pill"); if (b) b.focus(); };
  pop.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
  pop.append(h("div", { class: "rpop-h" }, h("b", {}, "Ready for a call?"), tip("Tests the microphone, system audio, your keys, the speech service and the AI. About 20 seconds, a few cents.", true)));
  if (running) pop.append(h("p", { class: "sub" }, "Testing… about 20 seconds."));
  else if (!d) pop.append(h("p", { class: "sub" }, "Not checked yet. Run it before a call."));
  else {
    pop.append(h("p", { class: "sub" }, `Checked ${ago(d.at)}.` + (d.ok ? (d.warnings.length ? " You can call; fix these if you can." : " Everything works.") : " Fix these first.")));
    const list = [...d.failing.map((x) => ["bad", x]), ...d.warnings.map((x) => ["warn", x])];
    if (list.length) pop.append(h("ul", { class: "issues2" }, list.map(([lvl, x]) => h("li", { class: lvl }, ico(lvl === "bad" ? "x" : "warning"), h("div", {}, h("div", {}, x.text), x.fix ? h("div", { class: "fix" }, "Fix: " + x.fix) : null)))));
  }
  pop.append(h("div", { class: "actions" }, h("button", { type: "button", class: "btn sm", id: "recheck", disabled: running, onclick: runCheck }, ico("refresh"), h("span", {}, running ? "Checking…" : d ? "Re-check" : "Run check")),
    d && !d.ok && d.verdict !== "BUSY" ? h("button", { type: "button", class: "btn ghost sm", id: "to-settings", onclick: () => viewSettings() }, "Open Settings") : null));
  if (!pop._bound) { pop._bound = true; const out = (e) => { if (!$("ready-pop")) { document.removeEventListener("pointerdown", out, true); return; } if (!e.target.closest(".rwrap")) { H.readyOpen = false; document.removeEventListener("pointerdown", out, true); renderSide(); } }; document.addEventListener("pointerdown", out, true); }
  return pop;
}

/* the one big action */
function idleHero() {
  const startBtn = h("button", { type: "button", class: "btn lg primary start", id: "start-call", onclick: async (e) => { const b = e.currentTarget; b.disabled = true; await act(api.start, "Start"); b.disabled = false; } }, ico("phone"), h("span", {}, "Start call"));
  const alt = (label, id, icon, fn, why) => h("span", { class: "alt" }, h("button", { type: "button", class: "btn ghost sm", id, onclick: fn }, ico(icon), h("span", {}, label)), tip(why));
  const today = state.calls.filter((c) => !c.crashed && dayStart(c.startedAt) === dayStart(Date.now()));
  const bits = [today.length ? `${plural(today.length, "call")} today, ${hrs(today.reduce((a, c) => a + c.durationMs, 0))}` : "No calls yet today", H.brief ? `briefing for ${H.brief.who || "this call"}` : null].filter(Boolean);
  const ctx = h("p", { class: "hero-ctx" }, bits.join(" · "));
  return h("section", { class: "hero", "aria-labelledby": "start-h" },
    h("div", { class: "hero-top" }, h("span", { class: "capy", "aria-hidden": "true" }), h("div", {}, h("h2", { id: "start-h" }, "Ready when your call is"))),
    startBtn, ctx,
    h("div", { class: "hero-alts" },
      alt("Start without AI", "start-noai", "play", () => act(api.startNoAi, "Start without AI"), "Bank cards only. Nothing goes to Anthropic; no summary is written."),
      alt("Practice call", "practice", "play", () => act(api.practice, "Practice call"), "Offline and free. A pretend call plays through the real answer window on your second screen. Nothing leaves the Mac.")));
}

/* compact plan: a strip, not a form */
function planStrip() {
  const b = H.brief;
  const body = b
    ? h("div", { class: "plan2-txt" }, h("b", {}, "Briefing ready"), h("span", { class: "plan2-sum", dir: dirOf((b.who || "") + (b.goal || "")), lang: langOf((b.who || "") + (b.goal || "")) }, [b.who, b.goal].filter(Boolean).join(" · ") || "for your next call"), h("span", { class: "plan2-exp" }, `expires in ${hrs(b.expiresInMs)}${H.attach && H.attach.files.length ? " · " + plural(H.attach.files.length, "background file") : ""}`))
    : h("div", { class: "plan2-txt" }, h("b", {}, "Plan a call"), h("span", { class: "plan2-sum" }, "Who, goal, context and background files for the AI"));
  return h("section", { class: "plan2" + (b ? " has" : ""), "aria-label": "Plan a call" }, h("span", { class: "plan2-ico" }, ico(b ? "check" : "plan")), body,
    h("div", { class: "plan2-act" },
      b ? btn("Clear", { id: "plan-clear", cls: "ghost sm", onclick: async () => { await api.clearBrief(); H.brief = null; H.attach = null; renderSide(); updateCallPanel(true); announce("Briefing cleared"); } }) : null,
      btn(b ? "Edit" : "Plan", { id: b ? "plan-edit" : "plan-open", cls: "sm", icon: "plan", onclick: openPlanSheet })));
}

function closeSheet(restore) {
  const s = $("sheet"); if (!s) return;
  const t = s._opener; s.remove();
  if (H.attachDirty) { H.attachDirty = false; renderSide(); }
  if (restore && t && document.contains(t)) t.focus();
}
/** Background files and pasted text for the next call. Added right away (not with Save); the AI reads them as background only. */
function attachField() {
  const list = h("ul", { class: "att-list", "aria-label": "Background files" });
  const meter = h("div", { class: "sub", id: "att-meter" });
  const msg = h("div", { class: "formerr", role: "status", id: "att-msg" });
  const file = h("input", { type: "file", id: "att-file", multiple: "", hidden: "", accept: ".txt,.md,text/plain,text/markdown" });
  const paste = h("textarea", { id: "att-paste", rows: "2", maxlength: "20000", placeholder: "Or paste text here: an email, an offer, notes" });
  const draw = (st) => {
    if (!st) return;
    H.attach = st; H.attachDirty = true;
    file.accept = st.pdf ? ".txt,.md,.pdf,text/plain,text/markdown,application/pdf" : ".txt,.md,text/plain,text/markdown";
    list.textContent = "";
    for (const a of st.files) list.append(h("li", {}, h("span", { class: "att-name", dir: dirOf(a.name), lang: langOf(a.name) }, a.name), h("span", { class: "faint att-n" }, `${a.chars.toLocaleString("en")} characters`),
      h("button", { type: "button", class: "btn ghost sm", "aria-label": "Remove " + a.name, onclick: async () => { try { draw(await api.attachRemove(a.id)); msg.textContent = ""; announce("File removed"); } catch (x) { msg.textContent = "Could not remove: " + x.message; } } }, ico("x"), h("span", {}, "Remove"))));
    const used = st.files.reduce((n, a) => n + a.chars, 0);
    meter.textContent = `${used.toLocaleString("en")} of ${st.maxChars.toLocaleString("en")} characters used. They expire with the briefing (6 hours).${st.pdf ? "" : " PDF needs the pdftotext tool, which this Mac does not have: paste the text instead."}`;
  };
  const report = (r, what) => { if (!r.ok) { msg.textContent = r.error === "preview" ? "Not available in a preview." : (r.error || "Could not add that."); return; } msg.textContent = r.truncated ? `${what} was cut to fit the limit.` : ""; announce(`${what} added`); };
  file.addEventListener("change", async () => {
    for (const f of [...file.files]) {
      if (f.size > 2 * 1024 * 1024) { msg.textContent = `${f.name}: files can be 2 MB at most.`; continue; }
      try { const r = await api.attachAdd(f.name, new Uint8Array(await f.arrayBuffer())); draw(r.state); report(r, f.name); } catch (x) { msg.textContent = "Could not add: " + x.message; }
    }
    file.value = "";
  });
  const addPaste = async () => {
    if (!paste.value.trim()) return;
    try { const r = await api.attachPaste(paste.value); draw(r.state); report(r, "Text"); if (r.ok) paste.value = ""; } catch (x) { msg.textContent = "Could not add: " + x.message; }
  };
  if (H.attach) draw(H.attach); else api.attachList().then(draw).catch(() => {});
  H.attachDirty = false;
  return h("div", { class: "field attach" },
    h("label", { for: "att-paste" }, "Background files", tip("Notes, an offer or an email the AI should know about. It uses them only as background for answers, tips and the call summary; it never reads them out.")),
    list, meter,
    h("div", { class: "att-actions" }, btn("Add file", { id: "att-add", icon: "plan", cls: "sm", onclick: () => file.click() }), file, paste, btn("Add pasted text", { id: "att-paste-add", cls: "sm", onclick: addPaste })),
    msg);
}
function openPlanSheet() {
  closeSheet();
  const opener = document.activeElement;
  const b = H.brief || { who: "", goal: "", notes: "", mustCover: "" };
  const f = (id, label, why, el) => h("div", { class: "field" }, h("label", { for: id }, label, tip(why)), el);
  const who = h("input", { type: "text", id: "plan-who", maxlength: "120", autocomplete: "off", value: b.who, placeholder: "Who is on the call?" });
  const goal = h("input", { type: "text", id: "plan-goal", maxlength: "200", autocomplete: "off", value: b.goal, placeholder: "What do you want out of it?" });
  const notes = h("textarea", { id: "plan-notes", maxlength: "600", rows: "3", placeholder: "One per line" }); notes.value = b.notes;
  const must = h("textarea", { id: "plan-must", maxlength: "600", rows: "3", placeholder: "One per line, e.g. budget, timeline" }); must.value = b.mustCover;
  const err = h("div", { class: "formerr", role: "alert", id: "plan-err" });
  const form = h("form", { id: "plan-form", novalidate: true },
    h("div", { class: "frow" }, f("plan-who", "Who", "Name of the person or company. The AI and the fact cards use it.", who), f("plan-goal", "Goal", "The one outcome that makes this call a success.", goal)),
    f("plan-notes", "Notes for the AI", "Background it should know. It never reads these out loud.", notes),
    f("plan-must", "Must cover", "You get a reminder in the answer window if one of these has not come up after 15 minutes.", must),
    err,
    h("div", { class: "actions sheet-actions" }, h("span", { class: "sub" }, "Used by the next call within 6 hours."), h("span", { class: "grow" }), btn("Cancel", { onclick: () => closeSheet(true) }), h("button", { type: "submit", class: "btn primary", id: "plan-save" }, ico("check"), h("span", {}, "Save briefing"))));
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); err.textContent = "";
    let r; try { r = await api.saveBrief({ who: who.value, goal: goal.value, notes: notes.value, mustCover: must.value }); } catch (x) { err.textContent = "Could not save: " + x.message; return; }
    if (!r.ok) { err.textContent = r.error || "Could not save."; return; }
    H.brief = r.brief; closeSheet(false); renderSide(); updateCallPanel(true); announce("Briefing saved for your next call");
    const ed = $("plan-edit"); if (ed) ed.focus();
  });
  const panel = h("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "sheet-h", tabindex: "-1" }, h("div", { class: "sheet-head" }, h("h2", { id: "sheet-h" }, "Plan a call"), h("button", { type: "button", class: "btn ghost sm icon", "aria-label": "Close", onclick: () => closeSheet(true) }, ico("x"))), form);
  const ov = h("div", { class: "sheet-ov", id: "sheet" }, panel); ov._opener = opener;
  ov.addEventListener("pointerdown", (e) => { if (e.target === ov) closeSheet(true); });
  ov.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closeSheet(true); return; }
    if (e.key === "Tab") { const els = [...panel.querySelectorAll("button, input, textarea")].filter((x) => !x.disabled); const first = els[0], last = els[els.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }
  });
  $("pop-slot").append(ov);
  who.focus();
}
