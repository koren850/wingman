"use strict";
// Errors the user can act on (renderer). The table of messages is errors.js; the words are in the string catalogs.
// errorBox(raw) draws what happened, the next step and ONE button. showError(raw) puts that box at the top of the window (#err-slot) until it is dismissed.
// Classic script, loaded after app.js (uses h, ico, btn, T, announce, viewSettings, viewHome, runCheck, viewInbox and loadList at call time).

/**
 * Does what an error button says. ctx: { retry } (what "Try again" runs), { paste } (focus the Meeting context box), { files } (focus the file list).
 * Returns true if something was done.
 */
function performErrorAction(action, ctx) {
  const c = ctx || {};
  switch (action) {
    case "keys":
      viewSettings("keys");
      return true;
    case "allow":
      // The permission step is on Home: in the first-run window when it is on screen, otherwise in the setup card.
      if (!wizGoAllow()) {
        SU.open = "allow";
        SU.force = true;
      }
      viewHome();
      return true;
    case "settings":
      viewSettings();
      return true;
    case "check":
      if (state.view !== "home") viewHome().then(() => runCheck(false));
      else runCheck(false);
      return true;
    case "retry":
      if (c.retry) {
        c.retry();
        return true;
      }
      return false;
    case "home":
      viewHome();
      return true;
    case "calls":
      loadList()
        .then(() => viewInbox())
        .catch(() => showListError());
      return true;
    case "paste": {
      const el = c.paste || $("ctx-text");
      if (el) {
        el.focus();
        return true;
      }
      return false;
    }
    case "files": {
      const el = c.files || $("ctx-choose");
      if (el) el.focus();
      return !!el;
    }
    case "dismiss":
    default:
      return true;
  }
}

/** The "Fix it" actions of health messages (errors.js FIX). Falls back to performErrorAction for the rest. */
function performFix(action, ctx) {
  switch (action) {
    case "keys":
      openKeysSheet();
      return true;
    case "pane-mic":
    case "pane-audio":
      api.setupOpenPrivacy(action === "pane-mic" ? "mic" : "audio").catch(() => {});
      announce(T("fix.opened"));
      return true;
    case "switch-mic":
      viewSettings("mic");
      return true;
    case "retry-check":
      return performErrorAction("check", ctx);
    default:
      return performErrorAction(action, ctx);
  }
}
/** The Fix it button (or the plain reason) for a health message. null for a message that is not a health message. */
function fixControl(raw, ctx) {
  const f = WingmanErrors.fixOf(raw);
  if (f.action)
    return h(
      "button",
      { type: "button", class: "btn sm fixit", "data-code": f.code, "data-fix": f.action, onclick: () => performFix(f.action, ctx || {}) },
      T(f.label),
    );
  if (f.reason) return h("p", { class: "nofix faint", "data-code": f.code }, T(f.reason));
  return null;
}

/**
 * A box for one error: what happened, the next step, one button. raw is the message from the engine or a file import (or an error code from errors.js).
 * o: { retry, paste, files, onDone } . The button runs the action and then onDone (for a box that removes itself).
 */
function errorBox(raw, o = {}) {
  const d = WingmanErrors.describe(T, raw);
  const f = WingmanErrors.fixOf(d.code);
  const useFix = !!(f.action || f.reason) && !(d.action === "retry" && o.retry); // a caller's own retry (offline while saving, ...) keeps its button
  return h(
    "div",
    { class: "eb", role: "alert", "data-code": d.code },
    ico("warning"),
    h("div", { class: "eb-text" }, h("div", { class: "eb-what" }, d.what), h("div", { class: "eb-next" }, d.next)),
    useFix
      ? f.action
        ? h(
            "button",
            {
              type: "button",
              class: "btn sm eb-btn fixit",
              "data-fix": f.action,
              onclick: () => {
                performFix(f.action, o);
                if (o.onDone) o.onDone();
              },
            },
            T(f.label),
          )
        : h("p", { class: "nofix faint" }, T(f.reason))
      : h(
          "button",
          {
            type: "button",
            class: "btn sm eb-btn",
            onclick: () => {
              performErrorAction(d.action, o);
              if (o.onDone) o.onDone();
            },
          },
          d.btn,
        ),
  );
}

/** Shows the error box at the top of the window (replacing an older one) and announces it. */
function showError(raw, o = {}) {
  const slot = $("err-slot");
  if (!slot) return;
  slot.textContent = "";
  const box = errorBox(raw, { ...o, onDone: () => (slot.textContent = "") });
  box.append(
    h(
      "button",
      { type: "button", class: "btn ghost sm icon eb-x", "aria-label": T("err.dismiss"), title: T("err.dismiss"), onclick: () => (slot.textContent = "") },
      ico("x"),
    ),
  );
  slot.append(box);
  announce(box.querySelector(".eb-what").textContent + ". " + box.querySelector(".eb-next").textContent);
}
function clearError() {
  const slot = $("err-slot");
  if (slot) slot.textContent = "";
}
