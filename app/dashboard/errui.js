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
      // The permission step of the guided setup is on Home; open it there.
      SU.open = "allow";
      SU.force = true;
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

/**
 * A box for one error: what happened, the next step, one button. raw is the message from the engine or a file import (or an error code from errors.js).
 * o: { retry, paste, files, onDone } . The button runs the action and then onDone (for a box that removes itself).
 */
function errorBox(raw, o = {}) {
  const d = WingmanErrors.describe(T, raw);
  return h(
    "div",
    { class: "eb", role: "alert", "data-code": d.code },
    ico("warning"),
    h("div", { class: "eb-text" }, h("div", { class: "eb-what" }, d.what), h("div", { class: "eb-next" }, d.next)),
    h(
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
