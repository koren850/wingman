"use strict";
// The first-run window: paste two keys, allow the sound, go. Three steps (keys, allow, ready) drawn in the Home column by home.js until the
// person finishes or skips. Loaded after setup.js; shares its globals ($, h, btn, chip, ico, T, api, state, H, KEYS, SU, suAct, suSave, loadSetup...).
// Pure decisions (which step, which message for which error) are in setuplib.js and unit tested. The main-process side is keys:connect
// (keys-ipc.cjs) and setup:status / setup:askMic / setup:openPrivacy / setup:openLink (setup-ipc.cjs).
//
// A key is typed into a password field and sent once. Normally the field is cleared at once. Only when the key could not be checked for a
// reason that is not about the key (no network, service down, too many tries) is it kept in WZ.pending in this page's memory, so that
// "Try again" needs no second paste. It is dropped as soon as the check succeeds or the service refuses it. It is never stored anywhere.

const WZ = {
  res: {}, // provider -> last result word ("invalid", "nocredit", "network"...), only for this run of the window
  busy: new Set(), // providers being checked now
  pending: {}, // provider -> a key that could not be checked for a network-type reason
  replace: {}, // provider -> the person chose "Use a different key"
  pick: "", // a step the person went back to
  asked: false, // the microphone prompt was shown
  started: false, // the window has been on screen in this run, so it stays through the steps even after the keys are saved
  preview: "", // snapshot aid (?focus=setup-<name>): fixed example states, never real data
};
const WZ_NAMES = { deepgram: "Deepgram", anthropic: "Anthropic" };
const WZ_PROVIDERS = ["deepgram", "anthropic"];

/** Snapshot aid. Fixed example states for the hidden screenshots. Only the main process can set the focus query, and only in snapshot mode. */
const WZ_PREVIEWS = {
  keys: {},
  "keys-invalid": { res: { deepgram: "invalid" } },
  "keys-nocredit": { pick: "keys", saved: ["deepgram", "anthropic"], res: { deepgram: "ok", anthropic: "nocredit" } },
  "keys-network": { pick: "keys", saved: ["deepgram"], res: { deepgram: "ok", anthropic: "network" } },
  "keys-checking": { pick: "keys", saved: ["deepgram"], res: { deepgram: "ok" }, busy: ["anthropic"] },
  "allow-mac": { saved: ["deepgram", "anthropic"], mic: "not-determined", platform: "darwin" },
  "allow-blocked": { saved: ["deepgram", "anthropic"], mic: "denied", platform: "darwin" },
  "allow-win": { saved: ["deepgram", "anthropic"], mic: "denied", platform: "win32" },
  "allow-mac-done": { pick: "allow", saved: ["deepgram", "anthropic"], mic: "granted", platform: "darwin", audioAck: true },
  ready: { saved: ["deepgram", "anthropic"], mic: "granted", platform: "darwin", audioAck: true },
  "ready-win": { saved: ["deepgram", "anthropic"], mic: "granted", platform: "win32", store: "dpapi" },
};
/** Called by viewHome(focus). `focus` is "setup-<name>" for a snapshot, anything else leaves the real state. */
function wizPreviewSet(focus) {
  const name = typeof focus === "string" && focus.startsWith("setup-") ? focus.slice(6) : "";
  WZ.preview = Object.prototype.hasOwnProperty.call(WZ_PREVIEWS, name) ? name : "";
}

/** Everything the window draws from, in one place: the real state, or the fixed example in a snapshot. */
function wizView() {
  const pv = WZ.preview ? WZ_PREVIEWS[WZ.preview] : null;
  const st = SU.status || {};
  const providers = (H.keys && H.keys.providers) || {};
  const saved = (p) => (pv ? !!(pv.saved && pv.saved.includes(p)) : !!(providers[p] && providers[p].source !== "missing"));
  const last4 = (p) => (pv ? (p === "deepgram" ? "a9F2" : "Q7xZ") : (providers[p] && providers[p].last4) || "");
  const res = pv ? pv.res || {} : WZ.res;
  // The state of one key: "ok", "missing", or the problem word of this run. A saved key from an earlier run counts as ok.
  const keyState = (p) => {
    const r = res[p];
    if (r && r !== "ok") return r;
    return saved(p) ? "ok" : "missing";
  };
  return {
    platform: pv && pv.platform ? pv.platform : st.platform || "darwin",
    mic: pv && pv.mic ? pv.mic : st.mic || "unknown",
    audioAck: pv ? !!pv.audioAck : !!SU.acks.audio,
    store: pv ? pv.store || "keychain" : (H.keys && H.keys.store) || "keychain",
    displays: pv ? 2 : st.displays || 1,
    busy: (p) => (pv ? !!(pv.busy && pv.busy.includes(p)) : WZ.busy.has(p)),
    saved,
    last4,
    keyState,
    keyStates: () => ({ deepgram: keyState("deepgram"), anthropic: keyState("anthropic") }),
  };
}

const wizRedraw = () => {
  if (state.view === "home") renderSide();
};

/** Is the window on screen? Keys missing (or the person is in the middle of it), and not finished, skipped or in a call. */
function wizardActive() {
  if (WZ.preview) return true;
  if (!H.keys || state.view !== "home") return false;
  return WingmanSetup.wizardVisible({
    done: SU.acks.welcomeDone,
    skipped: SU.acks.welcomeSkipped,
    running: isRunning(),
    keysMissing: keysMissing().length > 0,
    started: WZ.started,
  });
}
/** The person finished or skipped: remember it and show the normal Home. */
function wizEnd(kind) {
  SU.acks[kind === "skip" ? "welcomeSkipped" : "welcomeDone"] = true;
  suSave();
}
/** Opens the window again from Settings → Setup guide. */
function wizReopen() {
  SU.acks.welcomeDone = false;
  SU.acks.welcomeSkipped = false;
  WZ.started = true;
  WZ.pick = "";
  suSave();
}

/* ---------- keys ---------- */
/** Sends one pasted key to be checked and saved. The answer is a result word and the saved-key status, never the key. */
async function wizConnect(p, value) {
  WZ.busy.add(p);
  delete WZ.res[p];
  wizRedraw();
  let r;
  try {
    r = await api.keysConnect(p, value);
  } catch {
    r = { ok: false, result: "app" };
  }
  WZ.busy.delete(p);
  const result = (r && r.result) || (r && r.ok ? "ok" : "other");
  if (r && r.state && r.state.ok) {
    H.keys = r.state;
    KEYS.data = r.state;
  }
  // Keep the pasted key only when the reason is not the key itself, so "Try again" needs no second paste.
  if (["network", "unavailable", "limit", "store"].includes(result)) WZ.pending[p] = value;
  else delete WZ.pending[p];
  WZ.res[p] = result;
  if (r && r.saved) WZ.replace[p] = false;
  WZ.pick = "keys"; // stay on this step so the person sees the result, then presses Continue
  const name = WZ_NAMES[p];
  if (result === "ok") announce(T("wiz.ok", { name }));
  else fail(T(WingmanSetup.keyProblem(result).text, { name }));
  wizRedraw();
}
/** The saved key checked again (credit added, or an earlier problem). */
async function wizRecheck(p) {
  WZ.busy.add(p);
  wizRedraw();
  let r;
  try {
    r = await api.keysRecheck(p);
  } catch {
    r = { ok: false, result: "app" };
  }
  WZ.busy.delete(p);
  WZ.res[p] = (r && r.result) || (r && r.ok ? "ok" : "other");
  if (WZ.res[p] === "ok") announce(T("wiz.ok", { name: WZ_NAMES[p] }));
  wizRedraw();
}
/** Check and save: every field with something in it, one after the other. */
async function wizSubmit() {
  const todo = [];
  for (const p of WZ_PROVIDERS) {
    const el = $("wiz-key-" + p);
    const v = (el && el.value.trim()) || WZ.pending[p] || "";
    if (el) el.value = "";
    if (v) todo.push([p, v]);
  }
  if (!todo.length) {
    WZ.empty = true;
    announce(T("wiz.empty"));
    return wizRedraw();
  }
  WZ.empty = false;
  for (const [p, v] of todo) await wizConnect(p, v);
}
const wizOpen = (which) => api.setupOpenLink(which).catch(() => {});

function wizKeyBlock(p, v) {
  const name = WZ_NAMES[p],
    ks = v.keyState(p),
    busy = v.busy(p);
  const showInput = ks !== "ok" && ks !== "nocredit";
  const prob = ks !== "ok" && ks !== "missing" ? WingmanSetup.keyProblem(ks) : null;
  const short = p === "deepgram" ? "dg" : "an";
  const input = showInput || WZ.replace[p];
  const top = h(
    "div",
    { class: "wiz-key-top" },
    h("h3", {}, name),
    busy
      ? chip(T("wiz.checking"), "warn", { dot: true })
      : ks === "ok"
        ? chip([T("wiz.ok", { name }), " ", ltr(WingmanSetup.mask(v.last4(p)))], "good", { dot: true })
        : ks === "nocredit"
          ? chip(T("wiz.saved", { name }), "warn", { dot: true })
          : null,
  );
  const children = [top, h("p", { class: "what" }, T("wiz." + short + ".what")), h("p", { class: "cost" }, T("wiz." + short + ".cost"))];
  if (input) {
    const field = h("input", {
      type: "password",
      id: "wiz-key-" + p,
      class: "keyin",
      autocomplete: "off",
      spellcheck: "false",
      autocapitalize: "off",
      "aria-label": T("wiz.paste", { name }),
      "aria-describedby": prob ? "wiz-err-" + p : null,
      "aria-invalid": prob ? "true" : null,
      placeholder: T("wiz.paste", { name }),
      disabled: busy ? true : null,
    });
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        wizSubmit();
      }
    });
    children.push(
      h(
        "div",
        { class: "wiz-actions" },
        btn(T("wiz.get." + p), { id: "wiz-get-" + p, cls: "sm", icon: "jump", onclick: () => wizOpen(p) }),
        h("span", { class: "wiz-note" }, T("wiz.getHelp")),
      ),
      h("div", { class: "wiz-input" }, field),
    );
  }
  if (prob) {
    const fix =
      prob.fix === "get"
        ? btn(T("wiz.fix.get"), { id: "wiz-fix-" + p, cls: "sm", icon: "jump", onclick: () => wizOpen(p) })
        : prob.fix === "billing"
          ? btn(T("wiz.fix.billing"), { id: "wiz-fix-" + p, cls: "sm", icon: "jump", onclick: () => wizOpen(p + "Billing") })
          : prob.fix === "retry"
            ? btn(T("wiz.fix.retry"), {
                id: "wiz-fix-" + p,
                cls: "sm",
                icon: "refresh",
                disabled: busy,
                onclick: () => (WZ.pending[p] ? wizConnect(p, WZ.pending[p]) : wizSubmit()),
              })
            : null;
    children.push(
      h("p", { class: "wiz-err", id: "wiz-err-" + p, role: "alert" }, ico("warning"), h("span", {}, T(prob.text, { name }))),
      h(
        "div",
        { class: "wiz-actions" },
        fix,
        ks === "nocredit" ? btn(T("wiz.recheck"), { id: "wiz-recheck-" + p, cls: "sm", icon: "refresh", disabled: busy, onclick: () => wizRecheck(p) }) : null,
      ),
    );
  }
  if ((ks === "ok" || ks === "nocredit") && !WZ.replace[p])
    children.push(
      h(
        "div",
        { class: "wiz-actions" },
        btn(T("wiz.replace"), {
          id: "wiz-replace-" + p,
          cls: "sm ghost",
          onclick: () => {
            WZ.replace[p] = true;
            delete WZ.res[p];
            wizRedraw();
            const f = $("wiz-key-" + p);
            if (f) f.focus();
          },
        }),
      ),
    );
  return h("div", { class: "wiz-key" + (ks === "ok" ? " is-ok" : prob ? " is-bad" : ""), id: "wiz-" + p }, ...children);
}

function wizKeysStep(v) {
  const anyInput = WZ_PROVIDERS.some((p) => v.keyState(p) !== "ok" && v.keyState(p) !== "nocredit") || WZ_PROVIDERS.some((p) => WZ.replace[p]);
  const busy = WZ_PROVIDERS.some((p) => v.busy(p));
  const done = WingmanSetup.keysDone(v.keyStates());
  return h(
    "div",
    { class: "wiz-body" },
    h("p", { class: "wiz-note" }, T("wiz.keys.intro")),
    WZ_PROVIDERS.map((p) => wizKeyBlock(p, v)),
    WZ.empty ? h("p", { class: "wiz-err", role: "alert" }, ico("warning"), h("span", {}, T("wiz.empty"))) : null,
    h(
      "div",
      { class: "wiz-actions" },
      anyInput ? btn(busy ? T("wiz.checking") : T("wiz.check"), { id: "wiz-check", cls: "primary", icon: "check", disabled: busy, onclick: wizSubmit }) : null,
      done ? btn(T("wiz.continue"), { id: "wiz-next", cls: anyInput ? "" : "primary", onclick: () => ((WZ.pick = ""), wizRedraw()) }) : null,
    ),
    h("p", { class: "wiz-note", id: "wiz-store" }, T("wiz.store." + v.store)),
  );
}

/* ---------- allow ---------- */
function wizAllowStep(v) {
  const a = WingmanSetup.allowState({ platform: v.platform, mic: v.mic, audioAck: v.audioAck });
  const mac = v.platform === "darwin";
  const rows = [];
  // Microphone
  const micOpen = () =>
    suAct(
      "mic",
      async () => (a.mic === "ask" && mac && v.mic === "not-determined" ? api.setupAskMic() : api.setupOpenPrivacy("mic")),
      (r) => (r && r.granted ? T("wiz.mic.ok") : T(mac ? "wiz.mic.asked" : "wiz.mic.blocked.win")),
    ).then(() => loadSetup().then(wizRedraw));
  rows.push(
    h(
      "div",
      { class: "wiz-perm" + (a.mic === "blocked" ? " is-bad" : ""), id: "wiz-mic" },
      h("div", { class: "grow" }, h("div", { class: "t" }, T("wiz.mic")), h("div", { class: "w" }, T("wiz.mic.why"))),
      a.mic === "ok"
        ? chip(T("wiz.mic.ok"), "good", { dot: true })
        : btn(a.mic === "ask" && mac && v.mic === "not-determined" ? T("wiz.mic.ask") : T(mac ? "wiz.mic.openMac" : "wiz.mic.openWin"), {
            id: "wiz-mic-btn",
            cls: "primary sm",
            icon: "mic",
            onclick: micOpen,
          }),
      a.mic === "ok" ? null : btn(T("wiz.perm.check"), { id: "wiz-mic-check", cls: "sm ghost", icon: "refresh", onclick: () => loadSetup().then(wizRedraw) }),
      a.mic === "blocked"
        ? h("p", { class: "wiz-err", role: "alert" }, ico("warning"), h("span", {}, T(mac ? "wiz.mic.blocked.mac" : "wiz.mic.blocked.win")))
        : null,
    ),
  );
  // The other side of the call
  rows.push(
    h(
      "div",
      { class: "wiz-perm", id: "wiz-sys" },
      h("div", { class: "grow" }, h("div", { class: "t" }, T("wiz.sys")), h("div", { class: "w" }, T("wiz.sys.why"))),
      a.system === "none"
        ? chip(T("wiz.sys.none"), "good", { dot: true })
        : a.system === "ok"
          ? chip(T("wiz.sys.acked"), "good", { dot: true })
          : [
              btn(T("wiz.sys.open"), { id: "wiz-sys-open", cls: "primary sm", icon: "jump", onclick: () => api.setupOpenPrivacy("audio").catch(() => {}) }),
              btn(T("wiz.sys.ack"), {
                id: "wiz-sys-ack",
                cls: "sm",
                icon: "check",
                onclick: () => {
                  SU.acks.audio = true;
                  suSave();
                  wizRedraw();
                },
              }),
            ],
      a.system === "none" ? null : h("p", { class: "wiz-note" }, T("wiz.sys.restart")),
    ),
  );
  return h(
    "div",
    { class: "wiz-body" },
    h("p", { class: "wiz-note" }, T(mac ? "wiz.allow.intro.mac" : "wiz.allow.intro.win")),
    rows,
    h(
      "div",
      { class: "wiz-actions" },
      btn(T("wiz.back"), {
        id: "wiz-back",
        cls: "ghost",
        onclick: () => {
          WZ.pick = "keys";
          wizRedraw();
        },
      }),
      btn(T("wiz.continue"), {
        id: "wiz-next",
        cls: "primary",
        disabled: !a.done,
        onclick: () => {
          WZ.pick = "";
          wizRedraw();
        },
      }),
    ),
  );
}

/* ---------- ready ---------- */
function wizReadyStep(v) {
  const noCredit = WZ_PROVIDERS.some((p) => v.keyState(p) === "nocredit");
  const go = (fn) => () => {
    wizEnd("done");
    fn();
  };
  return h(
    "div",
    { class: "wiz-body wiz-ready", id: "wiz-ready" },
    h("p", { class: "wiz-note" }, T("wiz.ready.text")),
    btn(T("wiz.ready.practice"), {
      id: "wiz-practice",
      cls: "lg primary",
      icon: "play",
      onclick: go(() => act(() => api.practice({ quick: true }), T("home.practice"))),
    }),
    h(
      "div",
      { class: "wiz-actions" },
      btn(T("wiz.ready.start"), { id: "wiz-start", icon: "phone", onclick: go(() => startFlow({ noAi: false })) }),
      btn(T("wiz.ready.later"), { id: "wiz-later", cls: "ghost", onclick: go(() => viewHome()) }),
    ),
    noCredit ? h("p", { class: "wiz-err", role: "alert" }, ico("warning"), h("span", {}, T("wiz.ready.nocredit"))) : null,
    v.displays < 2 ? h("p", { class: "wiz-note" }, T("wiz.ready.oneScreen")) : null,
    h("p", { class: "wiz-note" }, T("wiz.ready.more")),
    h("p", { class: "wiz-note", id: "wiz-consent" }, T("wiz.ready.consent")),
  );
}

/* ---------- the window ---------- */
/** The first-run window, or null when it is not needed. home.js shows it instead of the usual Home cards. */
function welcomeCard() {
  if (!wizardActive()) return null;
  WZ.started = true; // kept for this run of the app only: after a restart with both keys saved, the usual Home and its setup card take over
  const v = wizView();
  const allow = WingmanSetup.allowState({ platform: v.platform, mic: v.mic, audioAck: v.audioAck });
  const pl = WingmanSetup.wizardPlan({ keys: v.keyStates(), allow, pick: WZ.preview ? WZ_PREVIEWS[WZ.preview].pick || "" : WZ.pick });
  const idx = WingmanSetup.WIZ_STEPS.indexOf(pl.step);
  const stepsDone = { keys: pl.keys, allow: pl.keys && pl.allow, ready: false };
  const steps = h(
    "ol",
    { class: "wiz-steps", "aria-label": T("wiz.progress", { n: idx + 1 }) },
    WingmanSetup.WIZ_STEPS.map((id, i) =>
      h(
        "li",
        { class: stepsDone[id] ? "done" : "", "aria-current": id === pl.step ? "step" : null },
        h("span", { class: "n" }, stepsDone[id] ? ico("check") : String(i + 1)),
        T("wiz.step." + id),
      ),
    ),
  );
  const body = pl.step === "keys" ? wizKeysStep(v) : pl.step === "allow" ? wizAllowStep(v) : wizReadyStep(v);
  return h(
    "section",
    { class: "card-big wiz", id: "wizard", "aria-labelledby": "wiz-h" },
    h(
      "div",
      { class: "wiz-head" },
      h("h2", { id: "wiz-h" }, pl.step === "ready" ? T("wiz.ready.title") : T("wiz.title")),
      h("span", { class: "grow" }),
      pl.step === "ready"
        ? null
        : btn(T("wiz.skip"), {
            id: "wiz-skip",
            cls: "sm ghost",
            onclick: () => {
              wizEnd("skip");
              wizRedraw();
            },
          }),
    ),
    pl.step === "keys" ? h("p", { class: "wiz-lead" }, T("wiz.lead")) : null,
    languageRow(),
    steps,
    body,
  );
}
// When the person comes back from System Settings, look at the microphone again.
if (typeof window !== "undefined")
  window.addEventListener("focus", () => {
    if (!WZ.preview && state.view === "home" && wizardActive()) loadSetup().then(wizRedraw);
  });
// A unit test loads this file with require() and stub globals (src/setup-wizard.test.ts); the page itself loads it as a classic script.
if (typeof module !== "undefined" && module.exports)
  module.exports = { welcomeCard, wizPreviewSet, wizSubmit, wizConnect, wizRecheck, wizEnd, wizReopen, WZ, WZ_PREVIEWS };
