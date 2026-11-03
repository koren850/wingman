"use strict";
// Home: start or plan a call, run the live call, and see what is waiting. Shares helpers with app.js (classic scripts: $, h, state, api).
// Main sends call state through api.onCallState (boot.js -> onCallState below); this file never keeps its own copy of the call, only state.call.
// The page only asks the main process for fixed commands (start, start listening, quiet, client, note, stop). All call text goes in via textContent.

const HL = window.WingmanHome;
// Home view state. panelKey/sideKey are "what was drawn last": a re-render happens only when they change, so typing is never wiped.
// (H.timer and H.fullAt are not read anywhere.)
const H = { attach: null, panelKey: "", timer: null, plans: [], editId: "", editing: false, planOpen: false, draft: null, dismissed: "", doctorBusy: false, tickBound: false, lastHealth: "",
  showConv: false, keys: null, ai: null, recent: [], compose: "note", autoChecked: false, quickAt: 0, fullAt: 0, stopAt: 0 };
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
/** Handler for every controller state push (from boot.js). Redraws the header chip and, on Home, patches or rebuilds the panels. */
function onCallState(s) {
  const was = state.call && state.call.running;
  state.call = s;
  if (!!was !== !!s.running) H.showConv = false;            // the live conversation is hidden again at the start of every call
  H.stopAt = s.running && s.phase === "stopping" ? H.stopAt || Date.now() : 0;
  if (was && !s.running) loadList().then(() => { if (state.view === "home") renderSide(); });
  renderCallSlot();
  if (state.view === "home") {
    updateCallPanel();
    const k = `${!!s.doctorRunning}|${s.doctor ? s.doctor.at : 0}|${s.plansKey || ""}|${!!s.running}`;
    if (k !== H.sideKey) {
      const first = H.sideKey === undefined; H.sideKey = k;
      // The prepared meetings changed (saved here, by the CLI, used by a call or expired): read them again, then redraw (not while a form field has focus).
      if (!first && !document.querySelector("#main form :focus")) api.plansList().then((l) => { H.plans = l; if (state.view === "home") renderSide(); }).catch(() => renderSide());
    }
  }
}
/** Header chip while a call runs (clock, colour by health). Click goes to Home. */
function renderCallSlot() {
  const slot = $("call-slot"); slot.textContent = "";
  if (!isRunning()) return;
  const s = state.call, ph = s.phase;
  const label = ph === "live" ? (s.practice ? "Practice " : "Call ") + clock(Date.now() - s.liveAt) : ph === "waiting" ? "Waiting for you to start listening" : ph === "stopping" ? "Saving…" : "Starting…";
  const bad = Object.values(s.health || {}).some((x) => x.level === "red");
  slot.append(h("button", { type: "button", id: "call-chip", class: "chip go " + (ph === "live" ? (bad ? "bad" : "good") : "warn"), onclick: () => { if (state.view !== "home") viewHome(); else window.scrollTo({ top: 0 }); }, "aria-label": `${label}. Open Home to control the call`, title: "Go to the live call" }, h("span", { class: "dot pulse" }), h("span", { class: "ctr" }, label), ico("chevron")));
}
/** One 1 s interval for the whole page (set up once): clocks, the ask countdown and the stop timer. Updates text in place, no re-render. */
function ensureTick() {
  if (H.tickBound) return; H.tickBound = true;
  setInterval(() => {
    if (!isRunning()) return;
    const c = $("call-chip"); if (c) { const t = c.querySelector(".ctr"), s = state.call; if (t && s.phase === "live") t.textContent = (s.practice ? "Practice " : "Call ") + clock(Date.now() - s.liveAt); }
    const big = $("big-timer"); if (big && state.call.phase === "live") big.textContent = clock(Date.now() - state.call.liveAt);
    const w = $("wait-timer"); if (w) w.textContent = clock(Date.now() - state.call.startedAt);
    if (state.call.askArmed) patchAsk(state.call);
    const se = $("stop-elapsed"); if (se && H.stopAt) se.textContent = Math.round((Date.now() - H.stopAt) / 1000) + " s";
  }, 1000);
}

/* ---------- Home view ---------- */
/** Draw Home. focus "plan" opens the plan form. Loads brief, files, keys, settings and recent plans first; drops out if the user navigated away meanwhile. */
async function viewHome(focus) {
  closePopover(false);
  state.view = "home"; state.gen++; setNav(); busy();
  const main = $("main"); main.textContent = "";
  const leftCol = h("div", { class: "hcol" }, h("div", { id: "call-col", class: "hcol" }), h("div", { id: "ready-slot" }));
  const sideCol = h("div", { id: "side-col", class: "hcol" });
  main.append(h("div", { class: "page-head" }, h("h1", {}, "Home"), h("span", { class: "grow" }), shortcutsBtn()), h("div", { class: "home" }, leftCol, sideCol));
  H.panelKey = ""; H.sideKey = undefined;
  ensureTick();
  if (!state.call) { try { state.call = await api.callState(); } catch { state.call = null; } }
  H.plans = await api.plansList().catch(() => []);
  H.attach = null; H.editId = "";
  H.keys = await api.keysStatus().then((r) => (r && r.ok ? r : null)).catch(() => null);
  loadAiMode();
  H.recent = await api.recentPlans().catch(() => []);
  H.editing = false; H.planOpen = false; H.draft = null;
  if (state.view !== "home") return;
  renderCallSlot(); updateCallPanel(true); renderSide();
  ready();
  if (focus === "plan") { H.planOpen = true; H.editId = ""; renderSide(); const f = $("plan-who") || $("plan-edit"); if (f) { f.scrollIntoView({ block: "center" }); f.focus({ preventScroll: true }); } } else focusTop();
  autoCheck();
}

/** Redraw the right column (and the setup/plan/readiness/start cards): the live conversation during a call, otherwise the setup steps and the waiting list. Keeps focus and unsaved plan text. */
function renderSide() {
  const side = $("side-col"), slot = $("ready-slot"); if (!side) return;
  captureDraft();
  keepFocus(() => {
    side.textContent = ""; slot.textContent = "";
    if (isRunning()) { side.append(liveFeedPanel()); return; }
    // Before a call, Home reads as a sequence: 1 Readiness check, 2 Start (a quick call, or one of the prepared meetings). The Plan editor opens above when it is in use.
    const sc = setupCard();
    slot.append(h("div", { class: "hcol seqcol" }, sc, editorCard(), readinessCard(), idleCard()));
    side.append(waitingCard());
  });
}
/** The effective AI mode for the Start card, read from the current settings (the same read the Settings page uses). */
function loadAiMode() {
  api.getSettings().then((r) => { H.ai = r && r.ok ? HL.aiMode(r.items) : null; if (state.view === "home" && !isRunning()) renderSide(); }).catch(() => { H.ai = null; });
}

/* call column: rebuilt when the phase changes, patched in place while it stays the same (so a note being typed is never lost) */
/** Left column. Rebuilt only when the phase key changes; otherwise patchLive updates it in place. */
function updateCallPanel(force) {
  const col = $("call-col"); if (!col) return;
  const s = state.call || { phase: "idle", health: {} };
  const running = isRunning();
  const after = !running && s.callId && s.callId !== H.dismissed ? (s.deleted ? "deleted" : "after") : "";
  const key = (running ? s.phase : "idle") + "|" + after + "|" + !!s.practice;
  if (force || key !== H.panelKey) {
    const wasRunning = H.panelKey && /^(starting|waiting|live|stopping)/.test(H.panelKey);
    H.panelKey = key; H.lastHealth = "";
    keepFocus(() => {
      col.textContent = "";
      if (running) col.append(livePanel(s)); else { if (after) col.append(afterCard(s, after)); }   // Home draws the Start card as step 3 in renderSide
    });
    if (!force && wasRunning !== running) renderSide();
  }
  if (running) patchLive(s);
}

/* ---- idle: the Start card is step 3 ---- */
const shortcutsBtn = () => h("button", { type: "button", class: "btn ghost sm", id: "kb-open", title: "Every keyboard shortcut (press ? on this page)", onclick: () => openShortcuts() }, ico("keyboard"), h("span", {}, "Shortcuts"));
const doc = () => (state.call && state.call.doctor) || null;
const checking = () => !!(state.call && state.call.doctorRunning) || H.doctorBusy;
/** 1 Readiness check, 2 Start: which one needs the user now. */
function curStep() {
  const d = doc();
  return !d || !d.ok || checking() ? 1 : 2;
}
const seqCls = (n) => "seq" + (curStep() === n ? " cur" : "");
const stepHead = (n, id, title, why, ...rest) => h("div", { class: "rhead" }, h("span", { class: "stepn", "aria-hidden": "true" }, String(n)), h("h2", { id }, title), why ? tip(why) : null, curStep() === n ? chip("Next", "warn") : null, ...rest);

/** Step 2: the Start card. Two clear paths: Quick call (no Plan) and the Prepared meetings list (pick one). Practice and the AI-mode line sit below. */
function idleCard() {
  const now = Date.now(), paths = HL.startPaths(H.plans, now);
  const quick = h("button", { type: "button", class: "btn lg primary", id: "start-call", onclick: () => startFlow({ noAi: false }) }, ico("phone"), h("span", {}, "Quick call"));
  const noAi = btn("Quick call without AI", { icon: "play", cls: "", id: "start-noai", onclick: () => startFlow({ noAi: true }) });
  const target = HL.practiceTarget(H.plans, now);
  const prac = btn(HL.practiceLabel(target), { icon: "play", cls: "", id: "practice", onclick: () => act(() => api.practice(target ? { planId: target.id } : { quick: true }), "Practice call") });
  const nm = (r) => ({ dir: dirOf(r.name), lang: langOf(r.name) });
  const row = (r) => h("li", { class: "pm" + (r.isNext ? " next" : ""), "data-id": r.id },
    h("div", { class: "pm-main" }, h("b", { class: "pm-t", ...nm(r) }, r.name), r.sub ? h("span", { class: "faint pm-s", dir: dirOf(r.sub), lang: langOf(r.sub) }, r.sub) : null),
    h("div", { class: "pm-meta" }, r.time ? chip(r.time, r.isNext ? "warn" : "info") : chip("no time", ""), r.must ? chip(plural(r.must, "item") + " to cover", "") : null, r.files ? chip(plural(r.files, "file"), "") : null),
    h("div", { class: "pm-act" },
      btn("Start", { id: "pm-start-" + r.id, cls: "primary sm", aria: r.startLabel, onclick: () => startFlow({ planId: r.id }) }),
      btn("", { id: "pm-edit-" + r.id, icon: "pencil", cls: "ghost sm icon", aria: "Edit " + r.name, title: "Edit", onclick: () => openEditor(r.id) }),
      btn("", { id: "pm-del-" + r.id, icon: "trash", cls: "ghost sm icon", aria: "Delete " + r.name, title: "Delete", onclick: () => deletePlan(r.id, r.name) })));
  const nextBar = paths.next ? h("div", { class: "nextbar", id: "next-meeting", role: "group", "aria-label": "Next prepared meeting" }, ico("clock"), h("div", { class: "grow" }, h("b", { ...nm(paths.next) }, HL.nextText(paths.next))), btn("Start", { id: "next-start", cls: "primary", aria: paths.next.startLabel, onclick: () => startFlow({ planId: paths.next.id }) })) : null;
  return h("section", { class: "card-big startcard " + seqCls(2), "aria-labelledby": "start-h" },
    stepHead(2, "start-h", "Start", "Start listening to a real call. Choose a quick call with no Plan, or one of your prepared meetings. You can start even when the readiness check failed; Wingman warns you first."),
    nextBar,
    h("div", { class: "path" }, h("h3", {}, "Quick call"), h("p", { class: "briefnote faint" }, "Start now with no Plan. Your prepared meetings are left alone."), quick),
    h("div", { id: "start-gate" }),
    H.ai ? h("p", { class: "aimode" + (H.ai.on ? "" : " off"), id: "ai-mode" }, ico(H.ai.on ? "check" : "warning"), h("span", {}, H.ai.text, " "), h("button", { type: "button", class: "linkbtn", id: "ai-change", onclick: () => viewSettings() }, "Change")) : null,
    h("div", { class: "path prepared", role: "group", "aria-labelledby": "pm-h" },
      h("div", { class: "rhead" }, h("h3", { id: "pm-h" }, "Prepared meetings"), paths.rows.length ? chip(String(paths.rows.length), "") : null, tip("A prepared meeting is a Plan for one specific call: who it is with, what you want, a checklist and background files. Pick one to start with it. Starting one uses it up; a quick call never does."), h("span", { class: "grow" }), btn("Prepare a meeting…", { id: "plan-open", icon: "plan", onclick: () => openEditor("") })),
      paths.rows.length ? h("ul", { class: "pmlist", "aria-labelledby": "pm-h" }, paths.rows.map(row)) : h("p", { class: "briefnote faint", id: "pm-empty" }, "None yet. Prepare a meeting to give the AI context for a call: who it is with, your goal, notes and background files.")),
    h("p", { class: "briefnote faint" }, "Wingman listens to any call or meeting and helps live. During a call press ", h("kbd", {}, "Ctrl"), " ", h("kbd", {}, "Opt"), " ", h("kbd", {}, "A"), " and ask it anything."),
    h("div", { class: "startmore" },
      h("div", { class: "opt" }, noAi, h("p", {}, "Prepared cards only. Nothing goes to Anthropic; no summary is written.")),
      h("div", { class: "opt" }, prac, h("p", {}, target ? "A pretend call plays through the real answer window, with that Plan. It is not used up. No cost, nothing leaves the Mac. Always allowed." : "A pretend call plays through the real answer window on your second screen. No cost, nothing leaves the Mac. Always allowed."))));
}

/** Plan edits that were typed but not saved. Kept while the page redraws, never dropped. */
function captureDraft() {
  if (!$("plan-form")) return;
  const g = (id) => { const e = $(id); return e ? e.value : ""; };
  H.draft = { title: g("plan-title"), at: g("plan-at"), who: g("plan-who"), goal: g("plan-goal"), notes: g("plan-notes"), mustCover: g("plan-must") };
}
/** Opens the Plan editor: id "" = a new prepared meeting, else edit that one. Loads the meeting's background files. */
async function openEditor(id) {
  H.editId = id; H.editing = true; H.planOpen = true; H.draft = null; H.attach = null;
  H.attach = await api.attachList(id).catch(() => null);
  renderSide();
  const f = $("plan-title") || $("plan-who"); if (f) { f.scrollIntoView({ block: "center" }); f.focus({ preventScroll: true }); }
}
/** Closes the editor. discard: an unsaved new meeting's background files are thrown away. */
function closeEditor(discard) {
  if (discard && !H.editId) api.discardDraft().catch(() => {});
  H.editing = false; H.planOpen = false; H.draft = null; H.editId = ""; H.attach = null; renderSide();
}
async function deletePlan(id, name) {
  let r; try { r = await api.deletePlan(id); } catch (e) { fail("Could not delete: " + e.message); return; }
  if (r && r.cancelled) return;
  if (!r || !r.ok) { fail(r && r.error === "preview" ? "This is a preview, nothing was deleted." : "That meeting could not be deleted."); return; }
  H.plans = await api.plansList().catch(() => H.plans.filter((m) => m.id !== id));
  if (H.editId === id) closeEditor(false); else renderSide();
  announce(`Deleted ${name}`);
  const o = $("plan-open"); if (o) o.focus();
}
/** Starting the meeting whose editor is open saves its unsaved edits first. True means go on; false means saving failed (error shown in the form) and the call must not start. */
async function savePlanFirst(planId) {
  const f = $("plan-form"); if (!f || !planId || H.editId !== planId) return true;
  const g = (id) => { const e = $(id); return e ? e.value : ""; };
  const v = { id: planId, title: g("plan-title"), at: g("plan-at"), who: g("plan-who"), goal: g("plan-goal"), notes: g("plan-notes"), mustCover: g("plan-must") }, b = H.plans.find((m) => m.id === planId) || {};
  const changed = ["title", "who", "goal", "notes", "mustCover"].some((k) => v[k].trim() !== String(b[k] || "").trim()) || v.at !== String(b.atInput || "");
  if (!changed) return true;
  let r; try { r = await api.savePlan(v); } catch { r = null; }
  if (!r || !r.ok) { const e = $("plan-err"); if (e) e.textContent = (r && r.error) || "Could not save the plan, so the call did not start. Fix it or press Cancel, then start."; const w = $("plan-who"); if (w) w.focus(); fail("The plan was not saved, so the call did not start."); return false; }
  H.plans = await api.plansList().catch(() => H.plans); closeEditor(false); announce("Plan saved first");
  return true;
}
const blockedBy = () => HL.blockedBy(doc());
const setStartBusy = (on) => { for (const b of document.querySelectorAll("#start-call, #start-noai, #next-start, .pm-act .primary")) b.disabled = on; };
/** Start. t: { planId?, noAi? }: no planId is a quick call (no Plan). Warns when the last readiness check failed (Start anyway is always there). Practice never goes through here. */
async function startFlow(t, anyway) {
  const g = $("start-gate"); if (g) g.textContent = "";
  setStartBusy(true);
  try {
    if (!(await savePlanFirst(t.planId))) return;
    const d = anyway ? null : blockedBy();
    if (d) { showStartGate(d, t); return; }
    const m = t.planId ? H.plans.find((x) => x.id === t.planId) : null;
    const what = t.planId ? "Start " + (m ? m.title || m.who || "prepared meeting" : "prepared meeting") : t.noAi ? "Quick call without AI" : "Quick call";
    await act(() => (t.noAi ? api.startNoAi(t.planId) : api.start(t.planId)), what);
  } finally { setStartBusy(false); }
}
/** Warning under Start when the last readiness check failed: run it again, or start anyway. */
function showStartGate(d, t) {
  const slot = $("start-gate") || $("main"); slot.textContent = "";
  slot.append(h("div", { class: "startgate", role: "alert" },
    h("div", { class: "sg-h" }, ico("warning"), h("b", {}, "Not ready for a call")),
    h("p", { class: "sub" }, "The last readiness check found problems. Fix them, or start anyway:"),
    issueList(d.failing.map((x) => ["bad", x])),
    h("div", { class: "actions" },
      btn("Run readiness check", { id: "gate-check", icon: "refresh", cls: "primary", onclick: () => runCheck(false) }),
      btn("Start anyway", { id: "gate-anyway", cls: "danger", onclick: () => startFlow(t, true) }),
      btn("Cancel", { cls: "ghost", onclick: () => { slot.textContent = ""; } }))));
  const c = $("gate-check"); if (c) c.focus();
}

/** Banner after a call ended (saved / summary ready / problem) or was deleted. Dismiss is remembered by call id. */
function afterCard(s, kind) {
  const dismiss = btn("", { icon: "x", cls: "ghost sm icon", aria: "Dismiss", title: "Dismiss", onclick: () => { H.dismissed = s.callId; updateCallPanel(true); } });
  if (kind === "deleted") return h("section", { class: "afterbar", role: "status" }, ico("trash"), h("div", { class: "grow" }, h("b", {}, "Call deleted."), " Nothing from it was kept."), dismiss);
  const known = state.calls.some((c) => c.id === s.callId);
  const go = (tab) => async () => { await loadList(); openCall(s.callId, { tab }); };
  return h("section", { class: "afterbar good", role: "status" }, ico("check"),
    h("div", { class: "grow" }, h("b", {}, s.summaryOk ? "Summary ready." : s.endedCleanly ? "Call saved." : "The call ended with a problem."), " ", s.summaryOk ? "Next steps and a draft follow-up email are waiting." : s.summarySkipped ? "You skipped the summary. Open the call and choose Write summary whenever you want it." : s.endedCleanly ? "No summary was written (the call was short, or summaries are off). You can still rate the cards." : (s.lastError ? s.lastError.slice(0, 120) : "Check the call for what was saved.")),
    s.summaryOk ? btn("Open follow-up", { cls: "positive", icon: "follow", onclick: go("followup") }) : btn(known || s.endedCleanly ? "Open the call" : "Open calls", { cls: "positive", onclick: go(undefined) }), dismiss);
}

/* ---- live ---- */
/** The call card by phase (starting, waiting for consent, live, stopping). Built once per phase; patchLive fills in the changing parts by id. */
function livePanel(s) {
  const ph = s.phase;
  const wrap = h("section", { class: "card-big livecard", "aria-labelledby": "live-h", id: "livecard" });
  const head = h("div", { class: "livehead" }, h("div", {}, h("div", { class: "label", id: "live-h" }, s.practice ? "Practice call" : "Call"), h("div", { class: "phase", id: "phase" })), ph === "live" ? h("div", { class: "bigtime", id: "big-timer", "aria-label": "Call time" }) : chip(ph === "waiting" ? "Nothing is sent yet" : ph === "stopping" ? "Saving…" : "Starting…", ph === "waiting" ? "good" : "warn", { dot: true }));
  wrap.append(head, h("div", { id: "off-banner" }), h("div", { id: "health-box" }));
  if (ph === "starting") wrap.append(h("p", { class: "sub" }, "Starting the call and opening the answer window… this takes a few seconds."));
  if (ph === "waiting") {
    wrap.append(h("div", { class: "waitbox" },
      h("p", {}, "Wingman is waiting for you to start listening. Nothing is heard or sent until you click."),
      h("button", { type: "button", id: "consent", class: "btn lg primary", onclick: (e) => { const b = e.currentTarget; b.disabled = true; act(api.consent, "Start listening").then((ok) => { if (!ok) b.disabled = false; }); } }, ico("check"), h("span", {}, "Start listening")),
      h("p", { class: "sub" }, h("kbd", {}, "Ctrl"), " ", h("kbd", {}, "Opt"), " ", h("kbd", {}, "Return"), " does the same from any app. Waiting for ", h("span", { class: "ltr", id: "wait-timer" }, "00:00"), ".")));
  }
  if (ph === "live" || ph === "waiting") wrap.append(h("div", { id: "client-box" }));
  if (ph === "live") {
    wrap.append(
      h("div", { class: "liverow" },
        h("button", { type: "button", id: "quiet", class: "switch", role: "switch", "aria-checked": "false", onclick: (e) => { const on = e.currentTarget.getAttribute("aria-checked") !== "true"; act(() => api.quiet(on), "Quiet mode"); } }, h("span", { class: "knob", "aria-hidden": "true" }), h("span", { class: "sl" }, "Quiet mode"), h("span", { class: "faint", id: "quiet-note" })),
        h("p", { class: "sub" }, "Hides the cards in the answer window. They are still saved for the review.")),
      composerEl(s));
  }
  // Stop is the normal button. Deleting the call is a separate, quiet link at the very bottom (it keeps its own confirmation).
  if (ph !== "starting") wrap.append(h("div", { class: "stoprow" }, btn(ph === "stopping" ? "Stopping…" : "Stop call", { id: "stop", icon: "stop", cls: "", onclick: () => act(api.stop, "Stop") }), h("span", { class: "grow" }), shortcutsBtn()));
  if (ph === "stopping") { const sv = h("div", { class: "stopsteps", id: "saving" }); fillStopSteps(sv, s); wrap.append(sv); }
  if (ph !== "starting") wrap.append(h("div", { class: "deleterow" }, h("button", { type: "button", id: "stop-del", class: "linkbtn danger-link", onclick: () => act(api.stopDelete, "Delete this call") }, ico("trash"), "Delete this call…"), h("span", { class: "faint" }, "Stops it and removes everything saved from it.")));
  return wrap;
}
/** One input for the live call with two clear modes: a Note for the AI (background it keeps) or a question for Wingman (it answers in the answer window). The voice way to ask is armed by Ctrl+Opt+A or the button. */
function composerEl(s) {
  const input = h("input", { type: "text", id: "note-in", maxlength: "300", autocomplete: "off" });
  const go = h("button", { type: "button", class: "btn", id: "note-add" });
  const seg = h("div", { class: "seg composer-mode", role: "group", "aria-label": "What this box does" });
  const sync = () => {
    const c = HL.composer(H.compose);
    input.placeholder = c.placeholder; input.setAttribute("aria-label", c.label); go.textContent = c.button;
    for (const b of seg.children) b.setAttribute("aria-pressed", b.dataset.m === H.compose ? "true" : "false");
  };
  const send = async () => {
    const v = input.value.trim(); if (!v) return;
    const c = HL.composer(H.compose);
    if (await act(() => (H.compose === "ask" ? api.ask(v) : api.note(v)), c.label)) { input.value = ""; announce(c.sent); }
  };
  for (const [m, label, icon] of [["note", "Note for the AI", "pencil"], ["ask", "Ask Wingman", "help"]])
    seg.append(h("button", { type: "button", "data-m": m, "data-fk": "mode-" + m, onclick: () => { H.compose = m; sync(); input.focus(); } }, ico(icon), label));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); send(); } });
  go.addEventListener("click", send);
  sync();
  const voice = h("button", { type: "button", class: "btn sm", id: "ask-voice", onclick: () => act(api.askWingman, "Ask Wingman") }, ico("mic"), h("span", {}, "Listen for my question"));
  return h("div", { class: "composer" },
    h("div", { class: "composer-head" }, seg, h("span", { class: "grow" }), voice, tip("A note is background the AI keeps for this call (it never reads it out). A question is answered right away in a “For you” card in the answer window.", true)),
    h("div", { class: "noterow" }, input, go),
    h("div", { id: "ask-status", class: "askstatus", role: "status" }),
    h("p", { class: "sub" }, h("span", { id: "note-count" }), h("span", { class: "keyhint" }, h("kbd", {}, "Ctrl"), " ", h("kbd", {}, "Opt"), " ", h("kbd", {}, "N"), " note · ", h("kbd", {}, "Ctrl"), " ", h("kbd", {}, "Opt"), " ", h("kbd", {}, "A"), " ask by voice, from any app")));
}
/** What the stop is doing right now, and that the user can leave: the summary finishes in the background. */
function fillStopSteps(el, s) {
  const row = (x) => h("li", { class: x.state }, x.state === "done" ? ico("check") : x.state === "now" ? h("span", { class: "dot pulse" }) : h("span", { class: "tick" }), x.label);
  el.textContent = "";
  el.append(h("ul", {}, HL.stopSteps(s).map(row)),
    h("p", { class: "sub" }, "Up to 20 seconds (", h("span", { id: "stop-elapsed", class: "ltr" }, H.stopAt ? Math.round((Date.now() - H.stopAt) / 1000) + " s" : "0 s"), "). You can leave this screen: the call is saved and the summary finishes in the background."),
    h("div", { class: "actions" }, HL.canSkipSummary(s) ? btn("Skip summary", { id: "skip-summary", cls: "sm", onclick: () => act(api.skipSummary, "Skip summary") }) : null, btn("Go to Calls", { id: "stop-leave", cls: "sm", onclick: () => { loadList().then(() => viewInbox()).catch(() => showListError()); } })));
}
/** The "listening for your question" strip, with the seconds left from the real armed window (called on every state change and every second). */
function patchAsk(s) {
  const as = $("ask-status"), at = HL.askStatus(s, Date.now());
  if (as && as.textContent !== at) { as.textContent = at; as.classList.toggle("on", !!at); }
}
/** Update the live panel in place from call state: timers, quiet switch, note count, stop steps, client proposal, and the problem banner. */
function patchLive(s) {
  const ph = s.phase, now = Date.now();
  const phase = $("phase"); if (phase) phase.textContent = ph === "waiting" ? "Waiting for you to start listening" : ph === "live" ? "Listening" : ph === "stopping" ? "Stopping" : "Starting";
  const big = $("big-timer"); if (big) big.textContent = clock(now - s.liveAt);
  const wt = $("wait-timer"); if (wt) wt.textContent = clock(now - s.startedAt);
  const q = $("quiet"); if (q) { q.setAttribute("aria-checked", s.quiet ? "true" : "false"); const n = $("quiet-note"); if (n) n.textContent = s.quiet ? "On: cards are hidden" : "Off"; }
  const nc = $("note-count"); if (nc) nc.textContent = s.notes ? plural(s.notes, "note") + " added · " : "";
  patchAsk(s);
  const av = $("ask-voice"); if (av) av.disabled = !!s.askArmed;
  const st = $("stop"), sd = $("stop-del"); if (st) st.disabled = ph === "stopping"; if (sd) sd.disabled = ph === "stopping";
  if (st) st.querySelector("span").textContent = ph === "stopping" ? "Stopping…" : "Stop call";
  const sv = $("saving"); if (sv && ph === "stopping") { const k = `${s.stopPhase || ""}|${!!s.summaryOk}|${!!s.endedCleanly}|${!!s.summarySkipped}`; if (sv.dataset.k !== k) { sv.dataset.k = k; fillStopSteps(sv, s); } }
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
  // Problems ranked by impact. "Blind" faults (not hearing, mic dead, speech down, Wingman off) are one unmistakable banner; advisories stay small.
  const blind = [], adv = [];
  if (s.offReason) blind.push("Wingman turned itself off: " + s.offReason + ". It is not listening any more. The call so far is saved.");
  for (const hh of Object.values(s.health || {})) (hh.level === "red" ? blind : adv).push(hh.text);
  if (s.overlayDown) adv.push(s.overlayDown === "one-screen" ? "No answer window: only one screen is connected, so it stays closed to keep it out of screen share. Still listening; cards are saved." : "The answer window closed. Still listening; cards are saved.");
  if (s.lastError && ph !== "live") adv.push(s.lastError.slice(0, 160));
  const hk = JSON.stringify([blind, adv]);
  if (hk !== H.lastHealth) {
    H.lastHealth = hk;
    const box = $("health-box");
    if (box) {
      box.textContent = "";
      if (blind.length) box.append(h("div", { class: "blindbar", role: "alert" }, ico("warning"), h("div", {}, h("div", { class: "bb-h" }, "Problem right now"), h("ul", {}, blind.map((t) => h("li", {}, t))), h("div", { class: "bb-s" }, "Answers may be missing or wrong until this clears."))));
      if (adv.length) box.append(h("ul", { class: "healthlist adv", "aria-label": "Notices" }, adv.map((t) => h("li", { class: "warn" }, ico("warning"), h("span", {}, t)))));
    }
    if (blind.length) announce("Wingman problem: " + blind[0]);
  }
}

/* ---------- Setup (first run) ---------- */
// Names of providers whose key is missing (status from keys:status; never the key itself).
const keysMissing = () => (H.keys ? Object.entries(H.keys.providers || {}).filter(([, v]) => v && v.source === "missing").map(([k]) => ({ deepgram: "Deepgram", anthropic: "Anthropic" }[k] || k)) : []);
/** A short checklist while Wingman is not set up yet: keys missing, or no full readiness check has passed. Each button goes straight to the control. */
function setupCard() {
  if (isRunning()) return null;
  const d = doc(), miss = keysMissing(), practiced = state.calls.some((c) => c.mode !== "live" && !c.crashed);
  const fullOk = !!(d && d.ok && d.at !== H.quickAt);
  const need = miss.length > 0 || !d || (state.calls.length === 0 && !fullOk);
  if (!need) return null;
  const item = (done, title, why, action) => h("li", { class: done ? "done" : "" }, done ? ico("check") : h("span", { class: "tick" }), h("div", { class: "grow" }, h("div", { class: "st-t" }, title), h("div", { class: "faint st-w" }, why)), done ? null : action);
  const items = [
    item(!miss.length, "Add your keys", miss.length ? `Missing: ${miss.join(" and ")}. Deepgram hears the call, Anthropic writes the AI answers.` : "Both keys are saved in the Keychain.", btn("Open Settings → Keys", { id: "setup-keys", cls: "sm", icon: "settings", onclick: () => viewSettings("keys") })),
    item(fullOk, "Run the readiness check", "Tests the microphone (Wingman needs the Microphone permission), system audio, the speech service and the AI. About 20 seconds, a few cents.", btn("Run readiness check", { id: "setup-check", cls: "sm", icon: "mic", disabled: checking(), onclick: () => runCheck(false) })),
    item(practiced, "Try a practice call", "A pretend call through the real answer window. Free, offline.", btn("Practice call", { id: "setup-practice", cls: "sm", icon: "play", onclick: () => act(api.practice, "Practice call") })),
  ];
  const n = [!miss.length, fullOk, practiced].filter(Boolean).length;
  return h("section", { class: "card-big setup", "aria-labelledby": "setup-h" }, h("div", { class: "rhead" }, h("h2", { id: "setup-h" }, "Set up Wingman"), chip(`${n} of 3 done`, n === 3 ? "good" : "warn"), h("span", { class: "grow" })), h("ul", { class: "setuplist" }, items));
}

/* ---------- Plan editor ---------- */
/** The Plan editor for one prepared meeting (a new one, or H.editId). Only drawn while it is open. All plan text is set with value/textContent. */
function editorCard() {
  if (!H.editing && !H.planOpen) return null;
  const cur = H.editId ? H.plans.find((m) => m.id === H.editId) : null;
  const sec = h("section", { class: "card-big plan seq cur", "aria-labelledby": "plan-h" });
  sec.append(h("div", { class: "rhead" }, h("h2", { id: "plan-h" }, cur ? "Plan: edit prepared meeting" : "Plan: new prepared meeting"), tip("Who the call is with and what you want from it. The AI uses it for answers, tips and the summary. It is used by the call you start with it, and kept until about 6 hours after the meeting time (or 14 days if it has no time).")));
  const f = (id, label, help, el) => h("div", { class: "field" }, h("label", { for: id }, label), el, help ? h("p", { class: "help", id: id + "-h" }, help) : null);
  const b = H.draft || cur || { title: "", atInput: "", at: "", who: "", goal: "", notes: "", mustCover: "" };
  const title = h("input", { type: "text", id: "plan-title", maxlength: "80", autocomplete: "off", value: b.title || "", placeholder: "e.g. Hosting move with Dana", "aria-describedby": "plan-title-h" });
  const at = h("input", { type: "datetime-local", id: "plan-at", value: b.atInput != null ? b.atInput : b.at || "", "aria-describedby": "plan-at-h" });
  const who = h("input", { type: "text", id: "plan-who", maxlength: "120", autocomplete: "off", value: b.who, placeholder: "Who is on the call?", "aria-describedby": "plan-who-h" });
  const goal = h("input", { type: "text", id: "plan-goal", maxlength: "200", autocomplete: "off", value: b.goal, placeholder: "What do you want out of it?", "aria-describedby": "plan-goal-h" });
  const notes = h("textarea", { id: "plan-notes", maxlength: "600", rows: "2", placeholder: "One per line, e.g. they run a WooCommerce shop on old hosting", "aria-describedby": "plan-notes-h" }); notes.value = b.notes;
  const must = h("textarea", { id: "plan-must", maxlength: "600", rows: "2", placeholder: "One per line, e.g. budget, timeline", "aria-describedby": "plan-must-h" }); must.value = b.mustCover;
  const err = h("div", { class: "formerr", role: "alert", id: "plan-err" });
  const group = (t, ...kids) => h("fieldset", { class: "fgroup" }, h("legend", {}, t), ...kids);
  const form = h("form", { id: "plan-form", novalidate: true },
    group("The meeting", h("div", { class: "frow" }, f("plan-title", "Title (optional)", "A name for the list. Without one the list shows who it is with.", title), f("plan-at", "When (optional)", "Date and time, e.g. from your calendar. It shows in the list and the menu bar, and the meeting stays until about 6 hours after it.", at))),
    group("The call", h("div", { class: "frow" }, f("plan-who", "Who is on the call", "Name of the person or company.", who), f("plan-goal", "Goal", "The one outcome that makes this call a success.", goal))),
    group("For the AI", f("plan-notes", "Notes", "Background it should know. It never reads these out loud.", notes), f("plan-must", "Must cover", "You get a reminder in the answer window if one of these has not come up after 15 minutes.", must)),
    group("Background files", attachField()),
    err,
    h("div", { class: "actions stick" }, h("button", { type: "submit", class: "btn primary", id: "plan-save" }, ico("check"), h("span", {}, "Save plan")), btn("Cancel", { id: "plan-cancel", onclick: () => closeEditor(true) }), h("span", { class: "sub" }, "Saving does not start a call: pick it under Prepared meetings.")));
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); err.textContent = "";
    let r; try { r = await api.savePlan({ id: H.editId, title: title.value, at: at.value, who: who.value, goal: goal.value, notes: notes.value, mustCover: must.value }); } catch (x) { err.textContent = "Could not save: " + x.message; return; }
    if (!r.ok) { err.textContent = r.error === "preview" ? "This is a preview, nothing was saved." : r.error || "Could not save."; return; }
    const id = r.plan.id;
    H.plans = await api.plansList().catch(() => H.plans);
    api.recentPlans().then((l) => { H.recent = l; }).catch(() => {});
    closeEditor(false); updateCallPanel(true); announce("Plan saved");
    const sb = $("pm-start-" + id); if (sb) sb.focus();
  });
  sec.append(form);
  if (!H.editId && H.recent.length) sec.append(h("div", { class: "recent" }, h("div", { class: "label" }, "Start from a recent plan"),
    h("ul", {}, H.recent.slice(0, 3).map((p, i) => { const t = [p.who, p.goal].filter(Boolean).join(" · ") || p.notes.split("\n")[0] || "Plan"; return h("li", {}, h("button", { type: "button", class: "btn sm", id: "recent-" + i, title: "Fill the form with this plan", onclick: () => { captureDraft(); H.draft = { ...(H.draft || {}), ...p }; renderSide(); const w = $("plan-who"); if (w) w.focus(); } }, ico("plan"), h("span", { dir: dirOf(t), lang: langOf(t) }, t))); })),
    h("button", { type: "button", class: "linkbtn", id: "recent-forget", onclick: async () => { H.recent = await api.forgetRecentPlans().catch(() => []); renderSide(); announce("Recent plans forgotten"); } }, "Forget recent plans")));
  return sec;
}

/* ---------- Readiness check (doctor) ---------- */
const niceFix = HL.niceFix, keyRelated = HL.keyRelated;   // doctor text says Settings → Keys and Wingman, not keys.env and the terminal
/** One list style for readiness problems (card, Start warning). Only the status icon is red or amber; the words stay neutral. */
function issueList(list) {
  return h("ul", { class: "issues2" }, list.map(([lvl, x]) => h("li", { class: lvl }, ico(lvl === "bad" ? "x" : "warning"), h("div", {}, h("div", {}, niceFix(x.text)),
    x.fix ? h("div", { class: "fix" }, "Fix: " + niceFix(x.fix)) : null,
    keyRelated(x) ? h("button", { type: "button", class: "linkbtn fixlink", onclick: () => viewSettings("keys") }, "Open Settings → Keys") : null))));
}
function readinessCard() {
  const d = doc(), running = checking();
  const quick = !!d && d.at === H.quickAt;
  const sec = h("section", { class: "card-big ready " + seqCls(1), "aria-labelledby": "ready-h", id: "ready-card" });
  const verdict = running ? chip("Checking…", "warn", { dot: true }) : !d ? chip("Not checked yet", "") : d.ok ? chip(d.verdict === "READY" ? "Ready" : "Ready, with warnings", "good", { dot: true }) : chip(d.verdict === "BUSY" ? "Busy" : "Not ready", d.verdict === "BUSY" ? "warn" : "bad", { dot: true });
  sec.append(stepHead(1, "ready-h", "Readiness check", "A test of the microphone, system audio, your keys, the speech service and the AI. Run it before a call.", verdict, h("span", { class: "grow" }),
    h("button", { type: "button", class: "btn", id: "recheck", disabled: running, onclick: () => runCheck(false) }, ico("refresh"), h("span", {}, running ? "Checking…" : !d ? "Run readiness check" : quick ? "Run full check" : "Re-check"))));
  if (running) sec.append(h("p", { class: "sub" }, "Testing the microphone, system audio, the speech service and the AI. About 20 seconds, a few cents."));
  else if (!d) sec.append(h("p", { class: "sub" }, "Run this before a call. It tests the microphone, system audio, your keys, the speech service and the AI."));
  else {
    sec.append(h("p", { class: "sub" }, `Checked ${ago(d.at)}.` + (quick ? " Quick check only (free): keys and settings. It does not test the microphone, the speech service or the AI." : "") + (d.ok ? (d.warnings.length ? " You can call; fix these if you can:" : quick ? "" : " Everything needed for a call works.") : " Fix these before the call:")));
    const list = [...d.failing.map((x) => ["bad", x]), ...d.warnings.map((x) => ["warn", x])];
    if (list.length) sec.append(issueList(list));
    if (!d.ok && d.verdict !== "BUSY") sec.append(h("p", { class: "sub" }, "Keys and options are on the ", h("button", { type: "button", class: "linkbtn", id: "to-settings", onclick: () => viewSettings() }, "Settings page"), "."));
  }
  return sec;
}
/** Run the readiness check. offline = the free quick check (keys and settings only). Result lands in state.call.doctor. */
async function runCheck(offline) {
  H.doctorBusy = true; renderSide(); if (!offline) announce("Checking everything. About 20 seconds.");
  let r = null; try { r = await api.runDoctor(offline === true); } catch (e) { if (!offline) fail("The readiness check did not finish. Try again."); }
  H.doctorBusy = false;
  if (r && state.call) { state.call.doctor = r; if (offline) H.quickAt = r.at; else H.fullAt = r.at; }
  if (state.view === "home") renderSide();
  if (r && !offline) announce(r.ok ? "Ready for a call" : "Not ready: " + (r.failing[0] ? niceFix(r.failing[0].text) : r.verdict));
}
/** At launch, when no recent result exists, run the free offline check (no audio, no network, no cost). */
function autoCheck() {
  if (H.autoChecked || isRunning()) return;
  H.autoChecked = true;
  const d = doc();
  if (checking() || (d && Date.now() - d.at < 6 * 3600 * 1000)) return;
  runCheck(true);
}

/* ---------- Waiting for you ---------- */
/** Up to five saved calls with cards to rate or a summary to send. */
function waitingCard() {
  const todo = state.calls.filter((c) => !c.crashed && (pendingOf(c) > 0 || c.hasSummary)).slice(0, 5);
  const sec = h("section", { class: "card-big waiting", "aria-labelledby": "wait-h" });
  sec.append(h("div", { class: "rhead" }, h("h2", { id: "wait-h" }, ico("inbox"), "Waiting for you"), tip("Calls with cards you have not rated yet, or a summary and follow-up email ready to send."), h("span", { class: "grow" }), btn("All calls", { cls: "ghost sm", onclick: () => { loadList().then(() => viewInbox()).catch(() => showListError()); } })));
  if (!todo.length) { sec.append(h("p", { class: "sub" }, state.calls.length ? "Nothing to rate or send. You're all caught up." : "After your first call, cards to rate and follow-up emails appear here.")); return sec; }
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

/** Background files and pasted text for this prepared meeting. Added right away (not with Save); the AI reads them as background only. */
function attachField() {
  const list = h("ul", { class: "att-list", "aria-label": "Background files" });
  const meter = h("div", { class: "sub", id: "att-meter" });
  const msg = h("div", { class: "formerr", role: "status", id: "att-msg" });
  const file = h("input", { type: "file", id: "att-file", multiple: "", hidden: "", accept: ".txt,.md,text/plain,text/markdown" });
  const paste = h("textarea", { id: "att-paste", rows: "2", maxlength: "20000", placeholder: "Or paste text here: an email, an offer, notes" });
  const draw = (st) => {
    if (!st) return;
    H.attach = st;
    file.accept = st.pdf ? ".txt,.md,.pdf,text/plain,text/markdown,application/pdf" : ".txt,.md,text/plain,text/markdown";
    list.textContent = "";
    for (const a of st.files) list.append(h("li", {}, h("span", { class: "att-name", dir: dirOf(a.name), lang: langOf(a.name) }, a.name), h("span", { class: "faint att-n" }, `${a.chars.toLocaleString("en")} characters`),
      h("button", { type: "button", class: "btn ghost sm", "aria-label": "Remove " + a.name, onclick: async () => { try { draw(await api.attachRemove(H.editId, a.id)); msg.textContent = ""; announce("File removed"); } catch (x) { msg.textContent = "Could not remove: " + x.message; } } }, ico("x"), h("span", {}, "Remove"))));
    const used = st.files.reduce((n, a) => n + a.chars, 0);
    meter.textContent = `${used.toLocaleString("en")} of ${st.maxChars.toLocaleString("en")} characters used. They stay with this meeting and are dropped once a call has used it.${st.pdf ? "" : " PDF needs the pdftotext tool, which this Mac does not have: paste the text instead."}`;
  };
  const report = (r, what) => { if (!r.ok) { msg.textContent = r.error === "preview" ? "Not available in a preview." : (r.error || "Could not add that."); return; } msg.textContent = r.truncated ? `${what} was cut to fit the limit.` : ""; announce(`${what} added`); };
  file.addEventListener("change", async () => {
    for (const f of [...file.files]) {
      if (f.size > 2 * 1024 * 1024) { msg.textContent = `${f.name}: files can be 2 MB at most.`; continue; }
      try { const r = await api.attachAdd(H.editId, f.name, new Uint8Array(await f.arrayBuffer())); draw(r.state); report(r, f.name); } catch (x) { msg.textContent = "Could not add: " + x.message; }
    }
    file.value = "";
  });
  const addPaste = async () => {
    if (!paste.value.trim()) return;
    try { const r = await api.attachPaste(H.editId, paste.value); draw(r.state); report(r, "Text"); if (r.ok) paste.value = ""; } catch (x) { msg.textContent = "Could not add: " + x.message; }
  };
  if (H.attach) draw(H.attach); else api.attachList(H.editId).then(draw).catch(() => {});
  return h("div", { class: "field attach" },
    h("label", { for: "att-paste", class: "sr" }, "Pasted text"), h("p", { class: "help" }, "Notes, an offer or an email the AI should know about. It uses them only as background for answers, tips and the call summary; it never reads them out."),
    list, meter,
    h("div", { class: "att-actions" }, btn("Add file", { id: "att-add", icon: "attach", onclick: () => file.click() }), file, paste, btn("Add pasted text", { id: "att-paste-add", icon: "plus", onclick: addPaste })),
    msg);
}
/* ---------- Shortcuts and card types (one place for every key) ---------- */
// Read from tray/main.cjs (KEYS) and overlay/main.cjs (overlay.hotkeys defaults). Global keys work from any app during a call.
const SHORTCUTS = [
  ["During a call (from any app)", [
    [["Ctrl", "Opt", "A"], "Ask Wingman: your next sentence (within 10 s) is a question for it"],
    [["Ctrl", "Opt", "N"], "Add a note for the AI"],
    [["Ctrl", "Opt", "Return"], "Start listening (only if “Ask me before listening starts” is on)"],
    [["Ctrl", "Opt", "C"], "Clear the cards in the answer window"],
    [["Ctrl", "Opt", "P"], "Pause the answer window: cards are hidden, new ones keep arriving and show on resume"],
    [["Ctrl", "Opt", "R"], "Rewind: show or hide what was just said (last 30 s)"],
    [["Ctrl", "Opt", "K"], "Copy the newest phone number, email or domain"],
    [["Ctrl", "Opt", "1…3"], "Copy capture chip 1, 2 or 3 (phone, email, domain) shown in the answer window"],
    [["Ctrl", "Opt", "L"], "Show or hide the call checklist"]]],
  ["In a call's review", [
    [["Y"], "Mark the card useful"], [["N"], "Mark it not useful"], [["U"], "Clear the mark"],
    [["J", "K"], "Next or previous card"], [["1", "…", "5"], "Switch tab"], [["/"], "Search calls"], [["Esc"], "Back to Calls"], [["?"], "Show this list"]]],
];
/** Modal list of shortcuts and card types (where "types" scrolls to the card legend). Traps Tab, closes on Escape or outside click, returns focus to the opener. */
function openShortcuts(where) {
  closeShortcuts();
  const opener = document.activeElement;
  const keys = (ks) => h("span", { class: "kbs" }, ks.map((k, i) => [i ? " " : null, h("kbd", {}, k)]));
  const groups = SHORTCUTS.map(([title, rows]) => h("section", { class: "kb-g" }, h("h3", {}, title), h("dl", {}, rows.map(([ks, what]) => [h("dt", {}, keys(ks)), h("dd", {}, what)]))));
  const types = h("section", { class: "kb-g", id: "kb-types" }, h("h3", {}, "Card types"), h("ul", { class: "kb-types" }, Object.keys(BADGE).filter((k) => k !== "calc").concat("calc").map((k) => h("li", {}, badgeChip(k), h("span", {}, BADGE[k][2])))));
  const panel = h("div", { class: "sheet kb-sheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "kb-h", tabindex: "-1" },
    h("div", { class: "sheet-head" }, h("h2", { id: "kb-h" }, "Shortcuts"), h("button", { type: "button", class: "btn ghost sm icon", id: "kb-close", "aria-label": "Close", onclick: () => closeShortcuts(true) }, ico("x"))),
    ...groups, h("p", { class: "sub" }, "The answer-window keys can be changed in settings.yaml under overlay.hotkeys."), types);
  const ov = h("div", { class: "sheet-ov", id: "kb-sheet" }, panel); ov._opener = opener;
  ov.addEventListener("pointerdown", (e) => { if (e.target === ov) closeShortcuts(true); });
  ov.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closeShortcuts(true); return; }
    if (e.key === "Tab") { const els = [...panel.querySelectorAll("button")]; const first = els[0], last = els[els.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }
  });
  $("pop-slot").append(ov);
  if (where === "types") { const t = $("kb-types"); if (t) { t.scrollIntoView({ block: "center" }); t.setAttribute("tabindex", "-1"); t.focus({ preventScroll: true }); return; } }
  $("kb-close").focus();
}
function closeShortcuts(restore) {
  const s = $("kb-sheet"); if (!s) return;
  const t = s._opener; s.remove();
  if (restore && t && document.contains(t)) t.focus();
}
