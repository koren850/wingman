"use strict";
// Call mode picker (renderer). A small select with the current mode: "Auto" (Wingman decides and may change it as the call goes) or a locked kind (your choice stays).
// Custom modes from the pack are listed after the built-in ones. The page only sends the id; main checks it again (featureslib.modeArg).
// Classic script, loaded after knows.js (uses h, T, chip, announce, api, WingmanMode).
const MODE = { custom: [], loaded: false };
/** Loads the custom modes once (a failing or missing list is just empty). */
function modeLoad(then) {
  if (MODE.loaded) return then && then();
  MODE.loaded = true;
  Promise.resolve(api.modesList ? api.modesList() : null)
    .then((r) => {
      MODE.custom = WingmanMode.cleanModes(r && r.ok ? r.modes : []);
    })
    .catch(() => {})
    .then(() => then && then());
}
/**
 * The picker element. o: { view: { kind, kindLocked }, id, label (aria), onPick(id) -> Promise<{ok}> }.
 * Under the select, one plain line says what it means now: "Auto: Support (Wingman's guess)" or "Locked: Support".
 */
function modePicker(o) {
  const st = WingmanMode.pickerState(o.view, MODE.custom);
  const sel = h("select", { class: "mode-sel", id: o.id, "aria-label": o.label || T("mode.label"), "data-locked": st.locked ? "1" : "0" });
  for (const opt of WingmanMode.options(MODE.custom)) {
    const label = WingmanMode.labelOf(opt.id, T, MODE.custom);
    const el = h("option", { value: opt.id, dir: "auto" }, label);
    if (opt.id === st.value) el.selected = true;
    sel.append(el);
  }
  const note = h("span", { class: "faint mode-note" + (o.compact ? " sr" : ""), id: o.id + "-note", role: "status" }, modeNote(st));
  if (o.compact) sel.title = modeNote(st);
  sel.addEventListener("change", async () => {
    sel.disabled = true;
    let r = null;
    try {
      r = await o.onPick(sel.value);
    } catch {
      r = null;
    }
    sel.disabled = false;
    if (!r || !r.ok) {
      sel.value = st.value; // the change did not happen: the select goes back
      note.textContent = T("mode.failed." + (r && r.error === "no-call" ? "nocall" : "other"));
      announce(note.textContent);
      return;
    }
    note.textContent = modeNote(WingmanMode.pickerState({ kind: sel.value === "auto" ? st.shown : sel.value, kindLocked: sel.value !== "auto" }, MODE.custom));
    announce(note.textContent);
  });
  return h("span", { class: "mode-picker" }, sel, note);
}
function modeNote(st) {
  if (st.locked) return T("mode.locked", { kind: WingmanMode.labelOf(st.shown, T, MODE.custom) });
  if (st.guess) return T("mode.guess", { kind: WingmanMode.labelOf(st.shown, T, MODE.custom) });
  return T("mode.autoNone");
}
