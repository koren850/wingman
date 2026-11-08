"use strict";
// Home: start or plan a call, run the live call, and see what is waiting. Shares helpers with app.js (classic scripts: $, h, state, api).
// Main sends call state through api.onCallState (boot.js -> onCallState below); this file never keeps its own copy of the call, only state.call.
// The page only asks the main process for fixed commands (start, start listening, quiet, client, note, stop). All call text goes in via textContent.

const HL = window.WingmanHome;
// Home view state. panelKey/sideKey are "what was drawn last": a re-render happens only when they change, so typing is never wiped.
// (H.timer and H.fullAt are not read anywhere.)
const H = {
  attach: null,
  panelKey: "",
  timer: null,
  plans: [],
  editId: "",
  editing: false,
  planOpen: false,
  draft: null,
  dismissed: "",
  doctorBusy: false,
  tickBound: false,
  lastHealth: "",
  showConv: false,
  keys: null,
  ai: null,
  recent: [],
  moreOpen: false,
  prepared: null,
  prepNote: "",
  knows: undefined, // the live "What Wingman knows" model: undefined = not asked yet, null = nothing to show
  kai: "ok", // the engine's AI state for the notes: ok | paused | offline
  knowsView: "folded", // the live knowledge panel: folded | read | edit
  kPending: null, // a newer model that arrived while a line was being edited (shown when the edit ends)
  compose: "note",
  autoChecked: false,
  quickAt: 0,
  fullAt: 0,
  stopAt: 0,
};
const isRunning = () => !!(state.call && state.call.running);
const phaseOf = () => (state.call ? state.call.phase : "idle");
const clock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
};
const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? T("time.justNow") : m < 60 ? T("time.minAgo", { n: m }) : T("time.hAgo", { n: Math.round(m / 60) });
};
const hrs = (ms) => {
  const m = Math.max(1, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`;
};

/** Run a controller command; say plainly when it did not happen. */
async function act(fn, what) {
  let r;
  try {
    r = await fn();
  } catch (e) {
    showError(String((e && e.message) || what));
    return false;
  }
  if (r && r.cancelled) return false;
  if (r && r.ok === false) {
    showError(r.error === "preview" ? "preview" : `${what} did not work right now.`);
    return false;
  }
  return true;
}

/* ---------- header: call chip + live state ---------- */
/** Handler for every controller state push (from boot.js). Redraws the header chip and, on Home, patches or rebuilds the panels. */
function onCallState(s) {
  const was = state.call && state.call.running;
  state.call = s;
  if (!!was !== !!s.running) {
    H.showConv = false; // the live conversation is hidden again at the start of every call
    H.knows = undefined; // and what Wingman knows is asked for again
    H.kai = "ok";
    H.kPending = null;
    H.knowsView = "folded";
  }
  H.stopAt = s.running && s.phase === "stopping" ? H.stopAt || Date.now() : 0;
  if (was && !s.running)
    loadList().then(() => {
      if (state.view === "home") renderSide();
    });
  renderCallSlot();
  if (state.view === "home") {
    updateCallPanel();
    const k = `${!!s.doctorRunning}|${s.doctor ? s.doctor.at : 0}|${s.plansKey || ""}|${!!s.running}`;
    if (k !== H.sideKey) {
      const first = H.sideKey === undefined;
      H.sideKey = k;
      // The prepared meetings changed (saved here, by the CLI, used by a call or expired): read them again, then redraw (not while a form field has focus).
      if (!first && !document.querySelector("#main form :focus"))
        api
          .plansList()
          .then((l) => {
            H.plans = l;
            if (state.view === "home") renderSide();
          })
          .catch(() => renderSide());
    }
  }
}
/** Header chip while a call runs (clock, colour by health). Click goes to Home. */
function renderCallSlot() {
  const slot = $("call-slot");
  slot.textContent = "";
  if (!isRunning()) return;
  const s = state.call,
    ph = s.phase;
  const label = ph === "live" ? chipClock(s) : ph === "waiting" ? T("call.waiting") : ph === "stopping" ? T("call.saving") : T("call.starting");
  const bad = Object.values(s.health || {}).some((x) => x.level === "red");
  slot.append(
    h(
      "button",
      {
        type: "button",
        id: "call-chip",
        class: "chip go " + (ph === "live" ? (bad ? "bad" : "good") : "warn"),
        onclick: () => {
          if (state.view !== "home") viewHome();
          else window.scrollTo({ top: 0 });
        },
        "aria-label": T("call.chipAria", { label }),
        title: T("call.chipTitle"),
      },
      h("span", { class: "dot pulse" }),
      h("span", { class: "ctr" }, label),
      ico("chevron"),
    ),
  );
}
const chipClock = (s) => T(s.practice ? "call.practiceClock" : "call.clock", { time: clock(Date.now() - s.liveAt) });
/** One 1 s interval for the whole page (set up once): clocks, the ask countdown and the stop timer. Updates text in place, no re-render. */
function ensureTick() {
  if (H.tickBound) return;
  H.tickBound = true;
  setInterval(() => {
    if (!isRunning()) return;
    const c = $("call-chip");
    if (c) {
      const t = c.querySelector(".ctr"),
        s = state.call;
      if (t && s.phase === "live") t.textContent = chipClock(s);
    }
    const big = $("big-timer");
    if (big && state.call.phase === "live") big.textContent = clock(Date.now() - state.call.liveAt);
    const w = $("wait-timer");
    if (w) w.textContent = clock(Date.now() - state.call.startedAt);
    if (state.call.askArmed) patchAsk(state.call);
    const se = $("stop-elapsed");
    if (se && H.stopAt) se.textContent = Math.round((Date.now() - H.stopAt) / 1000) + " s";
  }, 1000);
}

/* ---------- Home view ---------- */
/** Draw Home. focus "plan" opens the plan form. Loads brief, files, keys, settings and recent plans first; drops out if the user navigated away meanwhile. */
async function viewHome(focus) {
  closePopover(false);
  state.view = "home";
  state.gen++;
  setNav();
  busy();
  const main = $("main");
  main.textContent = "";
  const leftCol = h("div", { class: "hcol" }, h("div", { id: "call-col", class: "hcol" }), h("div", { id: "ready-slot" }));
  const sideCol = h("div", { id: "side-col", class: "hcol" });
  main.append(
    h("div", { class: "page-head" }, h("h1", {}, T("home.title")), h("span", { class: "grow" }), shortcutsBtn()),
    h("div", { class: "home" }, leftCol, sideCol),
  );
  H.panelKey = "";
  H.sideKey = undefined;
  ensureTick();
  if (!state.call) {
    try {
      state.call = await api.callState();
    } catch {
      state.call = null;
    }
  }
  H.plans = await api.plansList().catch(() => []);
  H.attach = null;
  H.editId = "";
  H.keys = await api
    .keysStatus()
    .then((r) => (r && r.ok ? r : null))
    .catch(() => null);
  loadAiMode();
  loadSetup()
    .then(() => {
      if (state.view === "home" && !isRunning()) renderSide();
    })
    .catch(() => {});
  H.recent = await api.recentPlans().catch(() => []);
  H.editing = false;
  H.planOpen = false;
  H.draft = null;
  if (state.view !== "home") return;
  renderCallSlot();
  updateCallPanel(true);
  renderSide();
  ready();
  if (focus === "plan") {
    H.planOpen = true;
    H.editId = "";
    renderSide();
    const f = $("ctx-text") || $("plan-edit");
    if (f) {
      f.scrollIntoView({ block: "center" });
      f.focus({ preventScroll: true });
    }
  } else if (focus === "review" && H.plans.length) {
    startFlow({ planId: H.plans[0].id }); // screenshot aid: the review step of the first meeting
  } else if (focus === "keys") {
    openKeysSheet(); // screenshot aid and the "Add keys" link from the tray
  } else if (focus === "edit" && H.plans.length)
    openEditor(H.plans[0].id); // screenshot aid: the first meeting's editor
  else focusTop();
  autoCheck();
}

/** Redraw the right column (and the setup/plan/readiness/start cards): the live conversation during a call, otherwise the setup steps and the waiting list. Keeps focus and unsaved plan text. */
function renderSide() {
  const side = $("side-col"),
    slot = $("ready-slot");
  if (!side) return;
  captureDraft();
  keepFocus(() => {
    side.textContent = "";
    slot.textContent = "";
    const homeEl = document.querySelector(".home");
    if (homeEl) homeEl.classList.toggle("idle", !isRunning());
    if (isRunning()) {
      const onKnows = (m, focusId, op) => {
        H.knows = m;
        if (op && m && m.source === "memory") sendKnowsEdit(op); // a real call: the engine learns the change (a preview or a saved model only changes the page)
        renderSide();
        const f = (focusId && document.getElementById(focusId)) || document.getElementById("knows-live-h");
        if (f) {
          if (f.tagName === "H2") f.setAttribute("tabindex", "-1");
          f.focus();
        }
      };
      // Glanceable order: the newest card, "So far", then What Wingman knows (folded; Show or Edit opens it), then the conversation.
      const onView = (v) => {
        H.knowsView = v;
        renderSide();
        const f = $("knows-live-" + (v === "folded" ? "show" : v === "edit" ? "done" : "edit"));
        if (f) f.focus();
      };
      side.append(
        latestCardPanel(),
        soFarCard(H.knows, H.kai),
        knowsPanel(H.knows, { id: "knows-live", onChange: onKnows, ai: H.kai, view: H.knowsView, onView }),
        liveFeedPanel(),
      );
      if (H.knows === undefined) loadKnows();
      return;
    }
    // Before a call, Home reads as a sequence: 1 Readiness check, 2 Start (a quick call, or one of the prepared meetings). The Plan editor opens above when it is in use.
    // Idle Home is one calm column: set up (only until it is done), Start (the one primary button), the readiness line, then what is waiting.
    const sc = setupCard();
    const d0 = doc();
    const problems = !!d0 && !d0.ok && !checking(); // a failed readiness check goes first: its Fix it buttons are what the user needs
    slot.append(
      h(
        "div",
        { class: "hcol seqcol" },
        ...(problems ? [readinessCard()] : []),
        editorCard(),
        idleCard(),
        sc,
        ...(problems ? [] : [readinessCard()]),
        waitingCard(),
      ),
    );
  });
}
/** Asks the main process for the live "What Wingman knows" model (the call memory; a fixture in previews). Later changes arrive by themselves with the live feed (knowsPush). */
function loadKnows() {
  H.knows = null; // set at once, so one request is made
  api
    .knowsGet("live", WingmanI18n.lang)
    .then((r) => {
      H.knows = r && r.ok ? r.model : null;
      sendReviewOps(H.knows);
      H.kai = r && r.ai ? r.ai : "ok";
      if (state.view === "home" && isRunning()) renderSide();
    })
    .catch(() => {
      H.knows = null;
    });
}
/** A new memory from the live feed ({ model, ver, ai }). Not drawn while the user is typing in the panel: it waits until the edit ends. */
function knowsPush(m) {
  if (!m || typeof m !== "object") return;
  if (m.ai) H.kai = m.ai === "paused" || m.ai === "offline" ? m.ai : "ok";
  if (m.model !== undefined && m.model !== null) {
    sendReviewOps(m.model);
    const editing =
      document.activeElement && document.activeElement.closest && document.activeElement.closest("#knows-live") && document.activeElement.tagName === "INPUT";
    if (editing) H.kPending = m.model;
    else {
      H.knows = m.model;
      H.kPending = null;
    }
  }
  if (state.view === "home" && isRunning() && !H.kPending) renderSide();
}
/** The edit ends (focus leaves the notes): show the newest memory that waited. */
document.addEventListener("focusout", () => {
  if (!H.kPending) return;
  setTimeout(() => {
    const a = document.activeElement;
    if (H.kPending && !(a && a.closest && a.closest("#knows-live") && a.tagName === "INPUT")) {
      H.knows = H.kPending;
      H.kPending = null;
      if (state.view === "home" && isRunning()) renderSide();
    }
  }, 0);
});
/** Sends one edit of the notes to the main process. A refusal is shown with a button, and the notes are asked for again so the page shows what the engine has. */
function sendKnowsEdit(op) {
  const edit = KN.toEdit(op);
  if (!edit) return;
  api
    .knowsEdit(edit)
    .then((r) => {
      if (r && r.ok) return;
      showError(r && r.error === "too many changes" ? "too many memory edits" : "memory edit failed", { retry: () => loadKnows() });
      loadKnows();
    })
    .catch(() => {
      showError("memory edit failed", { retry: () => loadKnows() });
      loadKnows();
    });
}
/** The effective AI mode for the Start card, read from the current settings (the same read the Settings page uses). */
function loadAiMode() {
  api
    .getSettings()
    .then((r) => {
      H.ai = r && r.ok ? HL.aiMode(r.items, T) : null;
      if (state.view === "home" && !isRunning()) renderSide();
    })
    .catch(() => {
      H.ai = null;
    });
}

/* call column: rebuilt when the phase changes, patched in place while it stays the same (so a note being typed is never lost) */
/** Left column. Rebuilt only when the phase key changes; otherwise patchLive updates it in place. */
function updateCallPanel(force) {
  const col = $("call-col");
  if (!col) return;
  const s = state.call || { phase: "idle", health: {} };
  const running = isRunning();
  const after = !running && s.callId && s.callId !== H.dismissed ? (s.deleted ? "deleted" : "after") : "";
  const key = (running ? s.phase : "idle") + "|" + after + "|" + !!s.practice;
  if (force || key !== H.panelKey) {
    const wasRunning = H.panelKey && /^(starting|waiting|live|stopping)/.test(H.panelKey);
    H.panelKey = key;
    H.lastHealth = "";
    keepFocus(() => {
      col.textContent = "";
      if (running) col.append(livePanel(s));
      else {
        if (after) col.append(afterCard(s, after));
      } // Home draws the Start card as step 3 in renderSide
    });
    if (!force && wasRunning !== running) renderSide();
  }
  if (running) patchLive(s);
}

/* ---- idle: the Start card is step 3 ---- */
/** Shortcut keys: symbols on macOS (control, option), words elsewhere. The word stays as the tooltip. */
const IS_MAC = /Mac/i.test((typeof navigator !== "undefined" && (navigator.platform || navigator.userAgent)) || "");
const kbdCombo = (key) =>
  h(
    "span",
    { class: "kbs" },
    ["Ctrl", "Opt", key].map((k, i) => [i ? " " : null, h("kbd", { title: HL.keyName(k) }, HL.keySym(k, IS_MAC))]),
  );
const shortcutsBtn = () =>
  h(
    "button",
    { type: "button", class: "btn ghost sm", id: "kb-open", title: T("home.shortcutsTitle"), onclick: () => openShortcuts() },
    ico("keyboard"),
    h("span", {}, T("home.shortcuts")),
  );
const doc = () => (state.call && state.call.doctor) || null;
const checking = () => !!(state.call && state.call.doctorRunning) || H.doctorBusy;
/** 1 Readiness check, 2 Start: which one needs the user now. */
function curStep() {
  const d = doc();
  return !d || !d.ok || checking() ? 1 : 2;
}
const seqCls = (n) => "seq" + (curStep() === n ? " cur" : "");
const stepHead = (n, id, title, why, ...rest) =>
  h(
    "div",
    { class: "rhead" },
    n ? h("span", { class: "stepn", "aria-hidden": "true" }, String(n)) : null,
    h("h2", { id }, title),
    why ? tip(why) : null,
    n && curStep() === n ? chip(T("step.next"), "warn") : null,
    ...rest,
  );

/** Can the person press Start now? Keys and the last readiness check decide (homelib startState). Checking never blocks. */
const startNow = () => HL.startState(checking() ? null : doc(), keysMissing());
/** The line under Start when it is disabled: the reason in plain words, the Fix it button, and (for a failed check only) a way to start anyway. */
function startWhy(ss, t) {
  if (!ss.disabled) return null;
  const code = ss.code || WingmanErrors.classify(ss.rawSource || ss.raw).code;
  const text = ss.raw ? T("start.why.check", { why: ss.raw }) : T(ss.why);
  return h(
    "div",
    { class: "startwhy", id: "start-why", role: "status" },
    ico("warning"),
    h("span", { class: "grow" }, text),
    fixControl(ss.code ? ss.code : code, {}) || btn(T("gate.check"), { id: "gate-check", icon: "refresh", cls: "sm", onclick: () => runCheck(false) }),
    ss.raw ? h("button", { type: "button", class: "linkbtn", id: "gate-anyway", onclick: () => startFlow(t, true) }, T("gate.anyway")) : null,
  );
}

/** True once the person has at least one saved call. Until then the practice call sits next to Start. */
const firstCallDone = () => state.calls.length > 0;

/** The Start card: one primary button (Start a call), the keys line when keys are missing, the prepared meetings, and the other ways to start folded below. */
function idleCard() {
  const now = Date.now(),
    paths = HL.startPaths(H.plans, now, T, WingmanI18n.lang);
  const ss = startNow();
  const quick = h(
    "button",
    {
      type: "button",
      class: "btn lg primary",
      id: "start-call",
      disabled: ss.disabled,
      "aria-describedby": ss.disabled ? "start-why" : null,
      onclick: () => startFlow({ noAi: false }),
    },
    ico("phone"),
    h("span", {}, T("home.quickCall")),
  );
  const noAi = btn(T("home.quickNoAi"), {
    icon: "play",
    cls: "",
    id: "start-noai",
    disabled: ss.disabled && ss.code !== "key-anthropic", // without the Anthropic key a call can still run without AI
    onclick: () => startFlow({ noAi: true }),
  });
  const target = HL.practiceTarget(H.plans, now);
  const prac = btn(HL.practiceLabel(target, T), {
    icon: "play",
    cls: "",
    id: "practice",
    onclick: () => act(() => api.practice(target ? { planId: target.id } : { quick: true }), T("home.practice")),
  });
  const nm = (r) => ({ dir: dirOf(r.name), lang: langOf(r.name) });
  const row = (r) =>
    h(
      "li",
      { class: "pm" + (r.isNext ? " next" : ""), "data-id": r.id, id: r.isNext ? "next-meeting" : null },
      h(
        "div",
        { class: "pm-main" },
        h("b", { class: "pm-t", ...nm(r) }, r.name),
        r.isNext ? chip(T("home.nextTag"), "warn") : null,
        r.sub ? h("span", { class: "faint pm-s", dir: dirOf(r.sub), lang: langOf(r.sub) }, r.sub) : null,
      ),
      h(
        "div",
        { class: "pm-meta" },
        r.time ? chip(r.time, r.isNext ? "warn" : "info") : chip(T("home.noTime"), ""),
        KN.KINDS.includes(r.kind) ? chip(T("kind." + r.kind), "", { title: T("knows.kindNote") }) : null,
        r.must ? chip(WingmanI18n.plural(WingmanI18n.lang, "home.mustChip", r.must), "") : null,
        r.files ? chip(WingmanI18n.plural(WingmanI18n.lang, "home.fileChip", r.files), "") : null,
        r.uses ? chip(WingmanI18n.plural(WingmanI18n.lang, "home.usedChip", r.uses), "") : null,
        r.pending ? chip(T("home.pendingChip"), "warn") : null,
      ),
      h(
        "div",
        { class: "pm-act" },
        btn(T("home.start"), { id: "pm-start-" + r.id, cls: "sm", aria: r.startLabel, disabled: ss.disabled, onclick: () => startFlow({ planId: r.id }) }),
        btn("", {
          id: "pm-edit-" + r.id,
          icon: "pencil",
          cls: "ghost sm icon",
          aria: T("home.editNamed", { name: r.name }),
          title: T("home.edit"),
          onclick: () => openEditor(r.id),
        }),
        btn("", {
          id: "pm-del-" + r.id,
          icon: "trash",
          cls: "ghost sm icon",
          aria: T("home.deleteNamed", { name: r.name }),
          title: T("home.delete"),
          onclick: () => deletePlan(r.id, r.name),
        }),
      ),
    );
  const missing = keysMissing();
  return h(
    "section",
    { class: "card-big startcard", "aria-labelledby": "start-h" },
    h("div", { class: "rhead" }, h("h2", { id: "start-h" }, T("home.start")), tip(T("home.startTip"))),
    h("p", { class: "briefnote faint" }, T("home.quickNote")),
    h("div", { class: "startrow" }, quick, firstCallDone() ? null : prac),
    // One readiness area: why Start is off (with Fix it), or the one-line AI status.
    h(
      "div",
      { id: "start-gate" },
      startWhy(ss, {}),
      !ss.disabled && missing.length
        ? h("div", { class: "keysline", id: "keys-line" }, btn(T("keys.add"), { id: "add-keys", icon: "key", onclick: () => openKeysSheet() }))
        : null,
    ),
    !ss.disabled && H.ai
      ? h(
          "p",
          { class: "aimode" + (H.ai.on ? "" : " off"), id: "ai-mode" },
          ico(H.ai.on ? "check" : "warning"),
          h("span", {}, H.ai.text, " "),
          h("button", { type: "button", class: "linkbtn", id: "ai-change", onclick: () => viewSettings() }, T("home.changeAi")),
        )
      : null,
    h(
      "div",
      { class: "path prepared", role: "group", "aria-labelledby": "pm-h" },
      h(
        "div",
        { class: "rhead" },
        h("h3", { id: "pm-h" }, T("home.meetings")),
        paths.rows.length ? chip(String(paths.rows.length), "") : null,
        tip(T("home.meetingsTip")),
        h("span", { class: "grow" }),
        btn(T("home.addContext"), { id: "plan-open", icon: "plan", onclick: () => openEditor("") }),
      ),
      paths.rows.length
        ? h("ul", { class: "pmlist", "aria-labelledby": "pm-h" }, paths.rows.map(row))
        : h("p", { class: "briefnote faint", id: "pm-empty" }, T("home.noMeetings")),
    ),
    h(
      "details",
      { class: "moreways", id: "more-ways" },
      h("summary", {}, T("home.moreWays")),
      h(
        "div",
        { class: "startmore" },
        h("div", { class: "opt" }, noAi, h("p", {}, T("home.noAiNote"))),
        firstCallDone() ? h("div", { class: "opt" }, prac, h("p", {}, target ? T("home.practiceNoteWith") : T("home.practiceNote"))) : null,
      ),
      h("p", { class: "briefnote faint" }, T("home.listenHint1"), kbdCombo("A"), T("home.listenHint2")),
    ),
  );
}

async function deletePlan(id, name) {
  let r;
  try {
    r = await api.deletePlan(id);
  } catch (e) {
    showError(String((e && e.message) || "delete"));
    return;
  }
  if (r && r.cancelled) return;
  if (!r || !r.ok) {
    showError(r && r.error === "preview" ? "preview" : "could not be deleted");
    return;
  }
  H.plans = await api.plansList().catch(() => H.plans.filter((m) => m.id !== id));
  if (H.editId === id) closeEditor(false);
  else renderSide();
  announce(T("home.deleted", { name }));
  const o = $("plan-open");
  if (o) o.focus();
}
/** Starting the meeting whose editor is open saves its unsaved edits first. True means go on; false means saving failed (error shown in the form) and the call must not start. */
async function savePlanFirst(planId) {
  const f = $("plan-form");
  if (!f || !planId || H.editId !== planId) return true;
  const plan = await saveFromForm(false);
  if (!plan) {
    const w = $("ctx-text");
    if (w) w.focus();
    fail(T("ctx.notSavedNoStart"));
    return false;
  }
  closeEditor(false);
  announce(T("ctx.savedFirst"));
  return true;
}
const blockedBy = () => HL.blockedBy(doc());
const setStartBusy = (on) => {
  const ss = startNow(); // a blocked Start stays off when the busy state ends
  for (const b of document.querySelectorAll("#start-call, #start-noai, #next-start, .pm-act .primary"))
    b.disabled = on || (ss.disabled && !(b.id === "start-noai" && ss.code === "key-anthropic"));
};
/** Start. t: { planId?, noAi? }: no planId is a quick call (no Plan). Warns when the last readiness check failed (Start anyway is always there). Practice never goes through here. */
async function startFlow(t, anyway) {
  H.reviewOps = null; // edits from an earlier, unfinished start must not reach this call
  const g = $("start-gate");
  if (g) g.textContent = "";
  setStartBusy(true);
  try {
    if (!(await savePlanFirst(t.planId))) return;
    const d = anyway ? null : blockedBy();
    if (d) {
      showStartGate(d, t);
      return;
    }
    if (t.planId && !t.reviewed) {
      const rv = await reviewBeforeStart(t.planId);
      if (!rv.go) return;
      H.reviewOps = rv.ops;
    }
    const m = t.planId ? H.plans.find((x) => x.id === t.planId) : null;
    const what = t.planId ? T("home.startNamed", { name: m ? m.title || m.who || "" : "" }) : t.noAi ? T("home.quickNoAi") : T("home.quickCall");
    await act(() => (t.noAi ? api.startNoAi(t.planId) : api.start(t.planId)), what);
  } finally {
    setStartBusy(false);
  }
}
/**
 * The review step: what Wingman knows about this meeting, before the call. Opens only when there is context (a prepared digest or saved text);
 * no context, or any problem reading it, goes straight to Start. Resolves to { go, ops }.
 */
async function reviewBeforeStart(planId) {
  let model = null;
  try {
    const r = await api.knowsGet("before", WingmanI18n.lang, planId);
    model = r && r.ok ? r.model : null;
  } catch {
    model = null;
  }
  if (!KN.hasContext(model)) return { go: true, ops: [] };
  return prestartReview(model);
}
/** The edits made in the review step go to the call as soon as its notes exist (the ids are the ones the notes will get). A refusal is ignored: the line simply stays as the engine has it. */
function sendReviewOps(m) {
  if (!H.reviewOps || !H.reviewOps.length || !m || m.source !== "memory") return;
  const ops = H.reviewOps;
  H.reviewOps = null;
  // ids come from the digest; if the live line with that id has other text, the ids drifted: leave that line alone rather than change the wrong one
  const live = {};
  for (const list of Object.values(m.sections || {})) for (const x of list) live[x.id] = x.text;
  for (const o of ops) {
    if (o.was && live[o.id] != null && live[o.id] !== o.was) continue;
    const edit = KN.toEdit(o);
    if (edit) api.knowsEdit(edit).catch(() => {});
  }
}
/** Warning under Start when the last readiness check failed: run it again, or start anyway. */
function showStartGate(d, t) {
  const slot = $("start-gate") || $("main");
  slot.textContent = "";
  slot.append(
    h(
      "div",
      { class: "startgate", role: "alert" },
      h("div", { class: "sg-h" }, ico("warning"), h("b", {}, T("gate.title"))),
      h("p", { class: "sub" }, T("gate.sub")),
      issueList(d.failing.map((x) => ["bad", x])),
      h(
        "div",
        { class: "actions" },
        btn(T("gate.check"), { id: "gate-check", icon: "refresh", cls: "primary", onclick: () => runCheck(false) }),
        btn(T("gate.anyway"), { id: "gate-anyway", cls: "danger", onclick: () => startFlow(t, true) }),
        btn(T("gate.cancel"), {
          cls: "ghost",
          onclick: () => {
            slot.textContent = "";
          },
        }),
      ),
    ),
  );
  const c = $("gate-check");
  if (c) c.focus();
}

/** Banner after a call ended (saved / summary ready / problem) or was deleted. Dismiss is remembered by call id. */
function afterCard(s, kind) {
  const dismiss = btn("", {
    icon: "x",
    cls: "ghost sm icon",
    aria: T("after.dismiss"),
    title: T("after.dismiss"),
    onclick: () => {
      H.dismissed = s.callId;
      updateCallPanel(true);
    },
  });
  if (kind === "deleted")
    return h(
      "section",
      { class: "afterbar", role: "status" },
      ico("trash"),
      h("div", { class: "grow" }, h("b", {}, T("after.deleted")), T("after.deletedNote")),
      dismiss,
    );
  const known = state.calls.some((c) => c.id === s.callId);
  const go = (tab) => async () => {
    await loadList();
    openCall(s.callId, { tab });
  };
  return h(
    "section",
    { class: "afterbar good", role: "status" },
    ico("check"),
    h(
      "div",
      { class: "grow" },
      h("b", {}, s.summaryOk ? T("after.followReady") : s.endedCleanly ? T("after.saved") : T("after.problem")),
      " ",
      s.summaryOk
        ? T("after.followNote")
        : s.summarySkipped
          ? T("after.skipped")
          : s.endedCleanly
            ? T("after.noSummary")
            : s.lastError
              ? s.lastError.slice(0, 120)
              : T("after.check"),
    ),
    s.summaryOk
      ? btn(T("after.openSummary"), { id: "open-summary", cls: "positive", icon: "follow", onclick: go("followup") })
      : btn(known || s.endedCleanly ? T("after.openCall") : T("after.openCalls"), { id: "open-call", cls: "positive", onclick: go(undefined) }),
    dismiss,
  );
}

/* ---- live ---- */
/** The call card by phase (starting, waiting for consent, live, stopping). Built once per phase; patchLive fills in the changing parts by id. */
function livePanel(s) {
  const ph = s.phase;
  const wrap = h("section", { class: "card-big livecard", "aria-labelledby": "live-h", id: "livecard" });
  const head = h(
    "div",
    { class: "livehead" },
    h("div", {}, h("div", { class: "label", id: "live-h" }, s.practice ? T("live.practiceCall") : T("live.call")), h("div", { class: "phase", id: "phase" })),
    ph === "live"
      ? h(
          "div",
          { class: "timerbox" },
          h("span", { class: "hdot good", id: "health-dot", role: "img", "aria-label": T("live.statusGood"), title: T("live.statusGood") }),
          h("div", { class: "bigtime", id: "big-timer", "aria-label": T("live.callTime") }),
        )
      : chip(ph === "waiting" ? T("live.nothingSent") : ph === "stopping" ? T("call.saving") : T("call.starting"), ph === "waiting" ? "good" : "warn", {
          dot: true,
        }),
  );
  wrap.append(head, h("div", { id: "off-banner" }), h("div", { id: "health-box" }));
  if (ph === "starting") wrap.append(h("p", { class: "sub" }, T("live.startingNote")));
  if (ph === "waiting") {
    wrap.append(
      h(
        "div",
        { class: "waitbox" },
        h("p", {}, T("live.waitingNote")),
        h(
          "button",
          {
            type: "button",
            id: "consent",
            class: "btn lg primary",
            onclick: (e) => {
              const b = e.currentTarget;
              b.disabled = true;
              act(api.consent, T("live.startListening")).then((ok) => {
                if (!ok) b.disabled = false;
              });
            },
          },
          ico("check"),
          h("span", {}, T("live.startListening")),
        ),
        h("p", { class: "sub" }, kbdCombo("Return"), T("live.sameFromAnyApp"), h("span", { class: "ltr", id: "wait-timer" }, "00:00"), "."),
      ),
    );
  }
  if (ph === "live" || ph === "waiting") wrap.append(h("div", { id: "client-box" }));
  if (ph === "live") {
    wrap.append(
      h(
        "div",
        { class: "liverow" },
        h(
          "button",
          {
            type: "button",
            id: "quiet",
            class: "switch",
            role: "switch",
            "aria-checked": "false",
            onclick: (e) => {
              const on = e.currentTarget.getAttribute("aria-checked") !== "true";
              act(() => api.quiet(on), T("live.quiet"));
            },
          },
          h("span", { class: "knob", "aria-hidden": "true" }),
          h("span", { class: "sl" }, T("live.quiet")),
          h("span", { class: "faint", id: "quiet-note" }),
        ),
        h("p", { class: "sub" }, T("live.quietNote")),
      ),
      composerEl(s),
    );
  }
  // Stop is the only button here. A call is deleted afterwards, from Calls (it keeps its own confirmation).
  if (ph !== "starting")
    wrap.append(
      h(
        "div",
        { class: "stoprow" },
        btn(ph === "stopping" ? T("live.stopping") : T("live.stop"), { id: "stop", icon: "stop", cls: "", onclick: () => act(api.stop, T("live.stop")) }),
        h("span", { class: "grow" }),
        shortcutsBtn(),
      ),
    );
  if (ph === "stopping") {
    const sv = h("div", { class: "stopsteps", id: "saving" });
    fillStopSteps(sv, s);
    wrap.append(sv);
  }
  return wrap;
}
/** One input for the live call with two clear modes: a Note for the AI (background it keeps) or a question for Wingman (it answers in the answer window). The voice way to ask is armed by Ctrl+Opt+A or the button. */
function composerEl(s) {
  const input = h("input", { type: "text", id: "note-in", maxlength: "300", autocomplete: "off" });
  const go = h("button", { type: "button", class: "btn", id: "note-add" });
  const seg = h("div", { class: "seg composer-mode", role: "group", "aria-label": T("compose.mode") });
  const sync = () => {
    const c = HL.composer(H.compose, T);
    input.placeholder = c.placeholder;
    input.setAttribute("aria-label", c.label);
    go.textContent = c.button;
    for (const b of seg.children) b.setAttribute("aria-pressed", b.dataset.m === H.compose ? "true" : "false");
  };
  const send = async () => {
    const v = input.value.trim();
    if (!v) return;
    const c = HL.composer(H.compose, T);
    if (await act(() => (H.compose === "ask" ? api.ask(v) : api.note(v)), c.label)) {
      input.value = "";
      announce(c.sent);
    }
  };
  for (const [m, label, icon] of [
    ["note", T("compose.note.label"), "pencil"],
    ["ask", T("compose.ask.label"), "help"],
  ])
    seg.append(
      h(
        "button",
        {
          type: "button",
          "data-m": m,
          "data-fk": "mode-" + m,
          onclick: () => {
            H.compose = m;
            sync();
            input.focus();
          },
        },
        ico(icon),
        label,
      ),
    );
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      send();
    }
  });
  go.addEventListener("click", send);
  sync();
  const voice = h(
    "button",
    { type: "button", class: "btn sm", id: "ask-voice", onclick: () => act(api.askWingman, T("compose.ask.label")) },
    ico("mic"),
    h("span", {}, T("compose.voice")),
  );
  return h(
    "div",
    { class: "composer" },
    h("div", { class: "composer-head" }, seg, h("span", { class: "grow" }), h("span", { class: "composer-tools" }, voice, tip(T("compose.tip"), true))),
    h("div", { class: "noterow" }, input, go),
    h("div", { id: "ask-status", class: "askstatus", role: "status" }),
    h(
      "p",
      { class: "sub" },
      h("span", { id: "note-count" }),
      h(
        "span",
        { class: "keyhint" },
        h("span", { class: "kh" }, kbdCombo("N"), h("span", {}, T("compose.keyNote"))),
        h("span", { class: "kh" }, kbdCombo("A"), h("span", {}, T("compose.keyAsk"))),
      ),
    ),
  );
}
/** What the stop is doing right now, and that the user can leave: the summary finishes in the background. */
function fillStopSteps(el, s) {
  const row = (x) =>
    h(
      "li",
      { class: x.state },
      x.state === "done" ? ico("check") : x.state === "now" ? h("span", { class: "dot pulse" }) : h("span", { class: "tick" }),
      x.label,
    );
  el.textContent = "";
  el.append(
    h("ul", {}, HL.stopSteps(s, T).map(row)),
    h(
      "p",
      { class: "sub" },
      T("stop.upTo"),
      h("span", { id: "stop-elapsed", class: "ltr" }, H.stopAt ? Math.round((Date.now() - H.stopAt) / 1000) + " s" : "0 s"),
      T("stop.leave"),
    ),
    h(
      "div",
      { class: "actions" },
      HL.canSkipSummary(s) ? btn(T("stop.skipSummary"), { id: "skip-summary", cls: "sm", onclick: () => act(api.skipSummary, T("stop.skipSummary")) }) : null,
      btn(T("stop.goCalls"), {
        id: "stop-leave",
        cls: "sm",
        onclick: () => {
          loadList()
            .then(() => viewInbox())
            .catch(() => showListError());
        },
      }),
    ),
  );
}
/** The "listening for your question" strip, with the seconds left from the real armed window (called on every state change and every second). */
function patchAsk(s) {
  const as = $("ask-status"),
    at = HL.askStatus(s, Date.now(), T);
  if (as && as.textContent !== at) {
    as.textContent = at;
    as.classList.toggle("on", !!at);
  }
}
/** Update the live panel in place from call state: timers, quiet switch, note count, stop steps, client proposal, and the problem banner. */
function patchLive(s) {
  const ph = s.phase,
    now = Date.now();
  const phase = $("phase");
  if (phase) phase.textContent = T("live.phase." + (ph === "waiting" || ph === "live" || ph === "stopping" ? ph : "starting"));
  const big = $("big-timer");
  if (big) big.textContent = clock(now - s.liveAt);
  const wt = $("wait-timer");
  if (wt) wt.textContent = clock(now - s.startedAt);
  const q = $("quiet");
  if (q) {
    q.setAttribute("aria-checked", s.quiet ? "true" : "false");
    const n = $("quiet-note");
    if (n) n.textContent = s.quiet ? T("live.quietOn") : T("live.quietOff");
  }
  const nc = $("note-count");
  if (nc) nc.textContent = s.notes ? WingmanI18n.plural(WingmanI18n.lang, "live.notes", s.notes) : "";
  patchAsk(s);
  const av = $("ask-voice");
  if (av) av.disabled = !!s.askArmed;
  const st = $("stop");
  if (st) st.disabled = ph === "stopping";
  if (st) st.querySelector("span").textContent = ph === "stopping" ? T("live.stopping") : T("live.stop");
  const sv = $("saving");
  if (sv && ph === "stopping") {
    const k = `${s.stopPhase || ""}|${!!s.summaryOk}|${!!s.endedCleanly}|${!!s.summarySkipped}`;
    if (sv.dataset.k !== k) {
      sv.dataset.k = k;
      fillStopSteps(sv, s);
    }
  }
  // client proposal
  const cb = $("client-box");
  if (cb) {
    const k = s.client ? "c:" + s.client : s.proposed ? "p:" + s.proposed : "";
    if (cb.dataset.k !== k) {
      cb.dataset.k = k;
      cb.textContent = "";
      if (s.client)
        cb.append(
          h("div", { class: "clientrow" }, chip(T("live.who"), "info"), h("b", {}, s.client), h("span", { class: "faint" }, T("live.clientConfirmed"))),
        );
      else if (s.proposed)
        cb.append(
          h(
            "div",
            { class: "clientrow ask" },
            ico("help"),
            h("div", { class: "grow" }, T("live.looksLike"), h("b", { dir: dirOf(s.proposed), lang: langOf(s.proposed) }, s.proposed), T("live.isThisWho")),
            btn(T("live.confirmClient"), { cls: "primary", id: "confirm-client", onclick: () => act(api.confirmClient, T("live.confirmClient")) }),
          ),
        );
    }
  }
  // Problems ranked by impact. "Blind" faults (not hearing, mic dead, speech down, Wingman off) are one unmistakable banner; advisories stay small.
  const blind = [],
    adv = [];
  if (s.offReason) blind.push(T("live.offSelf", { why: s.offReason }));
  for (const hh of Object.values(s.health || {})) (hh.level === "red" ? blind : adv).push(hh.text);
  if (s.overlayDown) adv.push(s.overlayDown === "one-screen" ? T("live.oneScreen") : T("live.overlayClosed"));
  if (s.lastError && ph !== "live") adv.push(s.lastError.slice(0, 160));
  // The small status dot next to the timer: red = a blind fault, amber = a notice, green = all good.
  const dot = $("health-dot");
  if (dot) {
    const lv = blind.length ? "bad" : adv.length ? "warn" : "good",
      tx = { bad: T("live.statusBad"), warn: T("live.statusWarn"), good: T("live.statusGood") }[lv];
    dot.className = "hdot " + lv;
    dot.title = tx;
    dot.setAttribute("aria-label", tx);
  }
  const hk = JSON.stringify([blind, adv]);
  if (hk !== H.lastHealth) {
    H.lastHealth = hk;
    const box = $("health-box");
    if (box) {
      box.textContent = "";
      if (blind.length)
        box.append(
          h(
            "div",
            { class: "blindbar", role: "alert" },
            ico("warning"),
            h(
              "div",
              {},
              h("div", { class: "bb-h" }, T("live.problemNow")),
              h(
                "ul",
                {},
                blind.map((t) => h("li", {}, t)),
              ),
              h("div", { class: "bb-s" }, T("live.problemNote")),
            ),
          ),
        );
      if (adv.length)
        box.append(
          h(
            "ul",
            { class: "healthlist adv", "aria-label": T("live.notices") },
            adv.map((t) => h("li", { class: "warn" }, ico("warning"), h("span", {}, t))),
          ),
        );
    }
    if (blind.length) announce(T("live.announceProblem", { why: blind[0] }));
  }
}

/* ---------- Setup (first run) ---------- */
// Names of providers whose key is missing (status from keys:status; never the key itself).
const keysMissing = () =>
  H.keys
    ? Object.entries(H.keys.providers || {})
        .filter(([, v]) => v && v.source === "missing")
        .map(([k]) => ({ deepgram: "Deepgram", anthropic: "Anthropic" })[k] || k)
    : [];
// setupCard() (the guided setup) is in setup.js.

/* ---------- Readiness check (doctor) ---------- */
const niceFix = HL.niceFix,
  keyRelated = HL.keyRelated; // doctor text says Settings → Keys and Wingman, not keys.env and the terminal
/** One list style for readiness problems (card, Start warning). Only the status icon is red or amber; the words stay neutral. */
/** The one button under a readiness problem: from the errors table (keys, permissions, ...), or the Keys link for a key problem. */
function issueButton(x) {
  const raw = String(x.text || "") + " " + String(x.fix || "");
  let code = WingmanErrors.classify(raw).code;
  if (code === "generic" && keyRelated(x)) code = "key-deepgram"; // a key problem the table has no pattern for
  const f = WingmanErrors.fixOf(code);
  if (!f.action && !f.reason) return null;
  return h("div", { class: "fixrow" }, fixControl(code, {}));
}
function issueList(list) {
  return h(
    "ul",
    { class: "issues2" },
    list.map(([lvl, x]) =>
      h(
        "li",
        { class: lvl },
        ico(lvl === "bad" ? "x" : "warning"),
        h("div", {}, h("div", {}, niceFix(x.text)), x.fix ? h("div", { class: "fix" }, T("ready.fix", { text: niceFix(x.fix) })) : null, issueButton(x)),
      ),
    ),
  );
}
function readinessCard() {
  const d = doc(),
    running = checking();
  const quick = !!d && d.at === H.quickAt;
  const sec = h("section", { class: "card-big ready", "aria-labelledby": "ready-h", id: "ready-card" });
  if (d && d.ok && !d.warnings.length && !running) {
    // Everything works: one quiet line with a re-check button instead of a card.
    sec.classList.add("ready-small");
    sec.append(
      h(
        "div",
        { class: "ready-ok" },
        h("h2", { id: "ready-h", class: "sr" }, T("ready.title")),
        chip(T("ready.ready"), "good", { dot: true }),
        h("p", { class: "sub" }, T("ready.okLine", { when: ago(d.at) })),
        h("span", { class: "grow" }),
        h(
          "button",
          { type: "button", class: "btn sm ghost", id: "recheck", onclick: () => runCheck(false) },
          ico("refresh"),
          h("span", {}, quick ? T("ready.full") : T("ready.recheck")),
        ),
      ),
    );
    return sec;
  }
  const verdict = running
    ? chip(T("ready.checking"), "warn", { dot: true })
    : !d
      ? chip(T("ready.notChecked"), "")
      : d.ok
        ? chip(d.verdict === "READY" ? T("ready.ready") : T("ready.readyWarn"), "good", { dot: true })
        : chip(d.verdict === "BUSY" ? T("ready.busy") : T("ready.notReady"), d.verdict === "BUSY" ? "warn" : "bad", { dot: true });
  sec.append(
    stepHead(
      0,
      "ready-h",
      T("ready.title"),
      T("ready.tip"),
      verdict,
      h("span", { class: "grow" }),
      h(
        "button",
        { type: "button", class: "btn", id: "recheck", disabled: running, onclick: () => runCheck(false) },
        ico("refresh"),
        h("span", {}, running ? T("ready.checking") : !d ? T("ready.run") : quick ? T("ready.full") : T("ready.recheck")),
      ),
    ),
  );
  if (running) sec.append(h("p", { class: "sub" }, T("ready.testing")));
  else if (!d) sec.append(h("p", { class: "sub" }, T("ready.runHint")));
  else {
    sec.append(
      h(
        "p",
        { class: "sub" },
        T("ready.checked", { when: ago(d.at) }) +
          (quick ? T("ready.quickOnly") : "") +
          (d.ok ? (d.warnings.length ? T("ready.canCall") : quick ? "" : T("ready.allWorks")) : T("ready.fixFirst")),
      ),
    );
    const list = [...d.failing.map((x) => ["bad", x]), ...d.warnings.map((x) => ["warn", x])];
    if (list.length) sec.append(issueList(list));
    if (!d.ok && d.verdict !== "BUSY")
      sec.append(
        h(
          "p",
          { class: "sub" },
          T("ready.keysOn"),
          h("button", { type: "button", class: "linkbtn", id: "to-settings", onclick: () => viewSettings() }, T("ready.settingsPage")),
          ".",
        ),
      );
  }
  return sec;
}
/** Run the readiness check. offline = the free quick check (keys and settings only). Result lands in state.call.doctor. */
async function runCheck(offline) {
  H.doctorBusy = true;
  renderSide();
  if (!offline) announce(T("ready.announceChecking"));
  let r = null;
  try {
    r = await api.runDoctor(offline === true);
  } catch (e) {
    if (!offline) showError(T("ready.didNotFinish"), { retry: () => runCheck(false) });
  }
  H.doctorBusy = false;
  if (r && state.call) {
    state.call.doctor = r;
    if (offline) H.quickAt = r.at;
    else H.fullAt = r.at;
  }
  if (state.view === "home") renderSide();
  if (r && !offline) announce(r.ok ? T("ready.announceReady") : T("ready.announceNot", { why: r.failing[0] ? niceFix(r.failing[0].text) : r.verdict }));
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
  const todo = HL.waitingCalls(state.calls, Date.now(), pendingOf);
  const sec = h("section", { class: "card-big waiting", "aria-labelledby": "wait-h", id: "waiting" });
  sec.append(
    h(
      "div",
      { class: "rhead" },
      h("h2", { id: "wait-h" }, ico("inbox"), T("wait.title")),
      tip(T("wait.tip")),
      h("span", { class: "grow" }),
      btn(T("wait.all"), {
        cls: "ghost sm",
        onclick: () => {
          loadList()
            .then(() => viewInbox())
            .catch(() => showListError());
        },
      }),
    ),
  );
  if (!todo.rows.length) {
    sec.append(h("p", { class: "sub" }, state.calls.length ? T("wait.caughtUp") : T("wait.first")));
    return sec;
  }
  if (todo.rows.some((c) => pendingOf(c) > 0)) sec.append(h("p", { class: "sub rate-benefit", id: "rate-benefit" }, T("wait.benefit")));
  sec.append(
    h(
      "ul",
      { class: "waitlist" },
      todo.rows.map((c) => {
        const p = pendingOf(c),
          go = (o) => openCall(c.id, o);
        const tab = c.mode === "live" && p ? "rate" : c.hasSummary ? "followup" : "rate";
        return h(
          "li",
          {
            class: "wl go",
            onclick: (e) => {
              if (!e.target.closest("button")) go({ tab, filter: tab === "rate" ? "unrated" : undefined });
            },
          },
          h(
            "button",
            { type: "button", class: "rowlink", onclick: () => go({ tab, filter: tab === "rate" ? "unrated" : undefined }) },
            dayLabel(c.startedAt),
            h("span", { class: "tm" }, tm(c.startedAt)),
            h("span", { class: "tm" }, mins(c.durationMs)),
          ),
          h(
            "span",
            { class: "wait" },
            p
              ? linkChip(
                  [h("span", { class: "ctr" }, p), T("wait.toRate")],
                  "warn",
                  () => go({ tab: "rate", filter: "unrated" }),
                  T("wait.toRateAria", { n: p }),
                )
              : null,
            c.hasSummary ? linkChip(T("wait.followReady"), "info", () => go({ tab: "followup" }), T("wait.followAria")) : null,
          ),
        );
      }),
    ),
  );
  if (todo.more > 0) sec.append(h("p", { class: "sub" }, T("wait.more", { n: todo.more })));
  return sec;
}

/* ---------- Shortcuts and card types (one place for every key) ---------- */
// Read from tray/main.cjs (KEYS) and overlay/main.cjs (overlay.hotkeys defaults). Global keys work from any app during a call.
const shortcuts = () => [
  [
    T("kb.g.call"),
    [
      [["Ctrl", "Opt", "A"], T("kb.ask")],
      [["Ctrl", "Opt", "N"], T("kb.note")],
      [["Ctrl", "Opt", "Return"], T("kb.consent")],
      [["Ctrl", "Opt", "C"], T("kb.clear")],
      [["Ctrl", "Opt", "P"], T("kb.pause")],
      [["Ctrl", "Opt", "R"], T("kb.rewind")],
      [["Ctrl", "Opt", "K"], T("kb.copy")],
      [["Ctrl", "Opt", "1…3"], T("kb.copyN")],
      [["Ctrl", "Opt", "L"], T("kb.checklist")],
    ],
  ],
  [
    T("kb.g.review"),
    [
      [["Y"], T("kb.useful")],
      [["N"], T("kb.notUseful")],
      [["U"], T("kb.clearMark")],
      [["J", "K"], T("kb.nextPrev")],
      [["1", "…", "5"], T("kb.tab")],
      [["/"], T("kb.search")],
      [["Esc"], T("kb.back")],
      [["?"], T("kb.list")],
    ],
  ],
];
function openShortcuts(where) {
  closeShortcuts();
  const opener = document.activeElement;
  const keys = (ks) =>
    h(
      "span",
      { class: "kbs" },
      ks.map((k, i) => [i ? " " : null, h("kbd", { title: HL.keyName(k) }, HL.keySym(k, IS_MAC))]),
    );
  const groups = shortcuts().map(([title, rows]) =>
    h(
      "section",
      { class: "kb-g" },
      h("h3", {}, title),
      h(
        "dl",
        {},
        rows.map(([ks, what]) => [h("dt", {}, keys(ks)), h("dd", {}, what)]),
      ),
    ),
  );
  const types = h(
    "section",
    { class: "kb-g", id: "kb-types" },
    h("h3", {}, T("kb.cardTypes")),
    h(
      "ul",
      { class: "kb-types" },
      Object.keys(BADGE)
        .filter((k) => k !== "calc")
        .concat("calc")
        .map((k) => h("li", {}, badgeChip(k), h("span", {}, BADGE[k][2]))),
    ),
  );
  const panel = h(
    "div",
    { class: "sheet kb-sheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "kb-h", tabindex: "-1" },
    h(
      "div",
      { class: "sheet-head" },
      h("h2", { id: "kb-h" }, T("home.shortcuts")),
      h("button", { type: "button", class: "btn ghost sm icon", id: "kb-close", "aria-label": T("kb.close"), onclick: () => closeShortcuts(true) }, ico("x")),
    ),
    ...groups,
    h("p", { class: "sub" }, T("kb.changeKeys")),
    types,
  );
  const ov = h("div", { class: "sheet-ov", id: "kb-sheet" }, panel);
  ov._opener = opener;
  ov.addEventListener("pointerdown", (e) => {
    if (e.target === ov) closeShortcuts(true);
  });
  ov.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeShortcuts(true);
      return;
    }
    if (e.key === "Tab") {
      const els = [...panel.querySelectorAll("button")];
      const first = els[0],
        last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
  $("pop-slot").append(ov);
  if (where === "types") {
    const t = $("kb-types");
    if (t) {
      t.scrollIntoView({ block: "center" });
      t.setAttribute("tabindex", "-1");
      t.focus({ preventScroll: true });
      return;
    }
  }
  $("kb-close").focus();
}
function closeShortcuts(restore) {
  const s = $("kb-sheet");
  if (!s) return;
  const t = s._opener;
  s.remove();
  if (restore && t && document.contains(t)) t.focus();
}
