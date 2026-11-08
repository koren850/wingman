"use strict";
// The Meeting context box (renderer): one optional box on Home where the user pastes text or drops a file, with a few small fields behind "More".
// Pasted text is saved with the meeting (tray/plans.cjs, setContext) and is plain background for the call. "Prepare" asks the main process to digest it;
// until the digest exists (wave 2) it shows what is saved, so the box and the panel below work without any model.
// Files: .txt, .md, .pdf (only with pdftotext), .ics (calendar invite). Long files are cut into parts of about 500 tokens when they are added (tray/attachments.cjs).
// Classic script, loaded after home.js (uses H, h, ico, btn, chip, tip, T, api, $, state, announce, errorBox, knowsPanel, KN, WingmanPlans).

const CTX_MAX = 30000; // characters in the text box (the files share the 40,000 character limit)
const FORM_IDS = { context: "ctx-text", title: "plan-title", at: "plan-at", who: "plan-who", goal: "plan-goal", mustCover: "plan-must" };

/** The values in the form now ("" for a field that is not drawn). */
function readForm() {
  const g = (id) => {
    const e = $(id);
    return e ? e.value : "";
  };
  const o = {};
  for (const [k, id] of Object.entries(FORM_IDS)) o[k] = g(id);
  return o;
}
/** Plan edits that were typed but not saved. Kept while the page redraws, never dropped. */
function captureDraft() {
  if (!$("plan-form")) return;
  H.draft = readForm();
  const more = $("ctx-more");
  if (more) H.moreOpen = more.getAttribute("aria-expanded") === "true";
}

/** Draws the file list, meter and message from the store state. */
function drawContextFiles(st, list, meter) {
  if (!st) return;
  H.attach = st;
  list.textContent = "";
  for (const a of st.files) {
    list.append(
      h(
        "li",
        {},
        ico("attach"),
        h("span", { class: "att-name", dir: "auto", lang: langOf(a.name) }, a.name),
        h(
          "span",
          { class: "faint att-n" },
          a.chunks > 1
            ? T("ctx.fileParts", { n: a.chars.toLocaleString(UI_LOCALE()), parts: a.chunks })
            : T("ctx.fileChars", { n: a.chars.toLocaleString(UI_LOCALE()) }),
        ),
        h(
          "button",
          {
            type: "button",
            class: "btn ghost sm",
            "aria-label": T("ctx.removeFile", { name: a.name }),
            onclick: async () => {
              try {
                drawContextFiles(await api.attachRemove(H.editId, a.id), list, meter);
                announce(T("ctx.removed"));
                $("ctx-text") && $("ctx-text").focus();
              } catch (x) {
                showError(String(x.message || x));
              }
            },
          },
          ico("x"),
          h("span", {}, T("ctx.remove")),
        ),
      ),
    );
  }
  const used = st.files.reduce((n, a) => n + a.chars, 0);
  meter.textContent = st.files.length ? T("ctx.meter", { used: used.toLocaleString(UI_LOCALE()), max: st.maxChars.toLocaleString(UI_LOCALE()) }) : "";
}
const UI_LOCALE = () => (WingmanI18n.lang === "he" ? "he-IL" : "en");

/** Opens the editor for plan `id` ("" = a new one). Loads its files and its pasted text first. */
async function openEditor(id) {
  H.editId = id;
  H.editing = true;
  H.planOpen = true;
  H.draft = null;
  H.attach = null;
  H.prepared = null;
  H.prepNote = "";
  const cur = id ? H.plans.find((m) => m.id === id) : null;
  H.attach = await api.attachList(id).catch(() => null);
  const ctx = id ? await api.planContext(id).catch(() => "") : "";
  if (cur) H.draft = { context: ctx, title: cur.title, at: cur.atInput || "", who: cur.who, goal: cur.goal, mustCover: cur.mustCover };
  H.moreOpen = !!(cur && (cur.title || cur.who || cur.goal || cur.mustCover || cur.at));
  renderSide();
  const f = $("ctx-text");
  if (f) {
    f.scrollIntoView({ block: "center" });
    f.focus({ preventScroll: true });
  }
}
/** Closes the editor. discard: an unsaved new meeting's background files are thrown away. */
function closeEditor(discard) {
  if (discard && !H.editId) api.discardDraft().catch(() => {});
  H.editing = false;
  H.planOpen = false;
  H.draft = null;
  H.editId = "";
  H.attach = null;
  H.prepared = null;
  renderSide();
}

/**
 * Saves the form. Returns the saved plan, or null (the error is shown in the form). stay: keep the editor open (Prepare); a new plan then gets its id.
 * Nothing is sent for a field the form does not have.
 */
async function saveFromForm(stay) {
  const err = $("plan-err");
  if (err) err.textContent = "";
  const v = readForm();
  let r;
  try {
    r = await api.savePlan({ id: H.editId, ...v });
  } catch (x) {
    r = { ok: false, error: String((x && x.message) || x) };
  }
  if (!r || !r.ok) {
    if (err) {
      err.textContent = "";
      err.append(errorBox(r && r.error ? r.error : "could not save", { paste: $("ctx-text") }));
    }
    return null;
  }
  H.plans = await api.plansList().catch(() => H.plans);
  api
    .recentPlans()
    .then((l) => {
      H.recent = l;
    })
    .catch(() => {});
  if (r.warning && err) err.append(errorBox(r.warning, { paste: $("ctx-text") }));
  if (stay) {
    H.editId = r.plan.id;
    H.draft = { ...v };
  }
  updateCallPanel(true);
  return r.plan;
}

/** Prepare: save, ask the main process to digest (wave 2), and show what Wingman knows. With no digest the saved text is plain background and the panel shows the saved details. */
async function prepareContext() {
  const btnEl = $("ctx-prepare");
  if (btnEl) btnEl.disabled = true;
  const note = $("ctx-prep-note");
  if (note) note.textContent = T("ctx.preparing");
  try {
    const plan = await saveFromForm(true);
    if (!plan) {
      if (note) note.textContent = "";
      return;
    }
    let r = null;
    try {
      r = await api.preparePlan(plan.id, WingmanI18n.lang);
    } catch {
      r = null;
    }
    const model = r && r.digest && r.model ? r.model : KN.fromSaved(plan);
    H.prepared = model;
    const why = r && !r.digest ? r.reason : "";
    H.prepNote = r && r.digest ? T("ctx.prepared") : why && T("ctx.prep." + why) !== "ctx.prep." + why ? T("ctx.prep." + why) : T("ctx.preparedNoDigest");
    const failed = !r || why === "failed" || why === "timeout"; // a real failure gets a box with a button; "no digest yet" is only a note
    const slot = $("ctx-prepared");
    if (slot) {
      slot.textContent = "";
      slot.append(h("p", { class: "sub", id: "ctx-prep-done", role: "status" }, H.prepNote), knowsPanel(model, { id: "knows-before" }));
      if (failed) slot.prepend(errorBox("digest failed", { retry: () => prepareContext() }));
    }
    announce(H.prepNote);
    const f = $("knows-before-h");
    if (f) {
      f.setAttribute("tabindex", "-1");
      f.focus();
    }
  } finally {
    if (btnEl) btnEl.disabled = false;
    if (note && $("ctx-prep-done")) note.textContent = "";
  }
}

/** The Meeting context box. Only drawn while the editor is open. */
function editorCard() {
  if (!H.editing && !H.planOpen) return null;
  const cur = H.editId ? H.plans.find((m) => m.id === H.editId) : null;
  const b = H.draft || { context: "", title: "", at: "", who: "", goal: "", mustCover: "" };
  const sec = h("section", { class: "card-big plan seq cur", "aria-labelledby": "plan-h", id: "ctx-card" });
  sec.append(h("div", { class: "rhead" }, h("h2", { id: "plan-h" }, T("ctx.title")), chip(T("ctx.optional"), ""), tip(T("ctx.tip"))));
  sec.append(h("p", { class: "help", id: "ctx-help" }, T("ctx.help")));

  const ta = h("textarea", {
    id: "ctx-text",
    rows: "7",
    maxlength: String(CTX_MAX),
    dir: "auto",
    placeholder: T("ctx.placeholder"),
    "aria-describedby": "ctx-help ctx-count",
  });
  ta.value = b.context || "";
  const count = h("p", { class: "faint ctx-count", id: "ctx-count" });
  const upd = () => {
    count.textContent = ta.value.length ? T("ctx.count", { n: ta.value.length.toLocaleString(UI_LOCALE()), max: CTX_MAX.toLocaleString(UI_LOCALE()) }) : "";
  };
  ta.addEventListener("input", upd);
  upd();

  // files
  const list = h("ul", { class: "att-list", "aria-label": T("ctx.files") });
  const meter = h("div", { class: "sub", id: "att-meter" });
  const msg = h("div", { class: "ctx-msg", role: "status", id: "att-msg" });
  const file = h("input", { type: "file", id: "att-file", multiple: "", hidden: "", accept: ".txt,.md,.ics,text/plain,text/markdown,text/calendar" });
  const setAccept = (st) => {
    file.accept =
      st && st.pdf ? ".txt,.md,.ics,.pdf,text/plain,text/markdown,text/calendar,application/pdf" : ".txt,.md,.ics,text/plain,text/markdown,text/calendar";
  };
  const redraw = (st) => {
    setAccept(st);
    drawContextFiles(st, list, meter);
  };
  const showMsg = (raw, o) => {
    msg.textContent = "";
    if (raw) msg.append(errorBox(raw, { paste: ta, files: $("ctx-choose"), ...(o || {}) }));
  };
  const prefill = (f) => {
    // A calendar invite fills the small fields that are still empty.
    if (!f) return;
    const set = (id, val) => {
      const e = $(id);
      if (e && val && !e.value.trim()) {
        e.value = val;
        return true;
      }
      return false;
    };
    const did = [set("plan-title", f.title), set("plan-who", f.who), f.at ? set("plan-at", WingmanPlans.toInputValue(f.at)) : false].some(Boolean);
    if (did) {
      openMore(true);
      announce(T("ctx.icsFilled"));
    }
  };
  const addFiles = async (files) => {
    msg.textContent = "";
    for (const f of files) {
      if (f.size > 2 * 1024 * 1024) {
        showMsg("2 MB");
        continue;
      }
      try {
        const r = await api.attachAdd(H.editId, f.name, new Uint8Array(await f.arrayBuffer()));
        redraw(r.state);
        if (!r.ok) {
          showMsg(r.error === "preview" ? "preview" : r.error || "bad file");
          continue;
        }
        prefill(r.fields);
        msg.textContent = r.truncated
          ? T("ctx.cut", { name: f.name })
          : r.chunks > 1
            ? T("ctx.addedParts", { name: f.name, parts: r.chunks })
            : T("ctx.added", { name: f.name });
        announce(msg.textContent);
      } catch (x) {
        showMsg(String((x && x.message) || x));
      }
    }
    file.value = "";
  };
  file.addEventListener("change", () => addFiles([...file.files]));
  const choose = btn(T("ctx.choose"), { id: "ctx-choose", icon: "attach", onclick: () => file.click() });
  const drop = h(
    "div",
    { class: "ctx-drop", id: "ctx-drop", role: "group", "aria-label": T("ctx.dropLabel") },
    ico("plus"),
    h("span", { class: "ctx-drop-t" }, T("ctx.drop")),
    choose,
    file,
  );
  const over = (on) => drop.classList.toggle("over", on);
  for (const el of [drop, sec]) {
    el.addEventListener("dragover", (e) => {
      if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) {
        e.preventDefault();
        over(true);
      }
    });
    el.addEventListener("dragleave", (e) => {
      if (e.target === drop || e.target === sec) over(false);
    });
    el.addEventListener("drop", (e) => {
      over(false);
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        e.preventDefault();
        addFiles([...e.dataTransfer.files]);
      }
    });
  }
  if (H.attach) redraw(H.attach);
  else
    api
      .attachList(H.editId)
      .then(redraw)
      .catch(() => {});

  // "More": the small fields
  const f = (id, label, help, el) =>
    h("div", { class: "field" }, h("label", { for: id }, label), el, help ? h("p", { class: "help", id: id + "-h" }, help) : null);
  const inp = (id, max, val, ph, extra) =>
    h("input", {
      type: "text",
      id,
      maxlength: String(max),
      autocomplete: "off",
      dir: "auto",
      value: val || "",
      placeholder: ph,
      "aria-describedby": id + "-h",
      ...(extra || {}),
    });
  const title = inp("plan-title", 80, b.title, T("ctx.f.title.ph"));
  const at = h("input", { type: "datetime-local", id: "plan-at", value: b.at || "", "aria-describedby": "plan-at-h" });
  const who = inp("plan-who", 120, b.who, T("ctx.f.who.ph"));
  const goal = inp("plan-goal", 200, b.goal, T("ctx.f.goal.ph"));
  const must = h("textarea", { id: "plan-must", maxlength: "600", rows: "2", dir: "auto", placeholder: T("ctx.f.must.ph"), "aria-describedby": "plan-must-h" });
  must.value = b.mustCover || "";
  const moreBox = h(
    "div",
    { id: "ctx-more-box", class: "ctx-more", role: "group", "aria-label": T("ctx.more") },
    h("div", { class: "frow" }, f("plan-who", T("ctx.f.who"), T("ctx.f.who.help"), who), f("plan-goal", T("ctx.f.goal"), T("ctx.f.goal.help"), goal)),
    f("plan-must", T("ctx.f.must"), T("ctx.f.must.help"), must),
    h("div", { class: "frow" }, f("plan-title", T("ctx.f.title"), T("ctx.f.title.help"), title), f("plan-at", T("ctx.f.at"), T("ctx.f.at.help"), at)),
  );
  const moreBtn = h("button", { type: "button", class: "linkbtn ctx-morebtn", id: "ctx-more", "aria-expanded": "false", "aria-controls": "ctx-more-box" });
  function openMore(on) {
    moreBtn.setAttribute("aria-expanded", on ? "true" : "false");
    moreBox.hidden = !on;
    moreBtn.textContent = on ? T("ctx.less") : T("ctx.more");
  }
  openMore(!!H.moreOpen);
  moreBtn.addEventListener("click", () => openMore(moreBtn.getAttribute("aria-expanded") !== "true"));

  const err = h("div", { class: "formerr", id: "plan-err" });
  const prepared = h("div", { id: "ctx-prepared", class: "ctx-prepared", "aria-live": "polite" });
  const model = H.prepared || (cur ? KN.fromSaved(cur) : null);
  if (H.prepared)
    prepared.append(h("p", { class: "sub", id: "ctx-prep-done", role: "status" }, H.prepNote || ""), knowsPanel(H.prepared, { id: "knows-before" }));
  else if (cur && model && KN.count(model)) prepared.append(knowsPanel(model, { id: "knows-before" }));
  // A digest saved by an earlier Prepare is shown too (not only the one made in this window session).
  if (cur && !H.prepared)
    api
      .knowsGet("before", WingmanI18n.lang, cur.id)
      .then((r) => {
        if (r && r.ok && r.model && r.model.source === "digest" && !H.prepared && prepared.isConnected) {
          prepared.textContent = "";
          prepared.append(knowsPanel(r.model, { id: "knows-before" }));
        }
      })
      .catch(() => {});

  const form = h(
    "form",
    { id: "plan-form", novalidate: true },
    h("div", { class: "field" }, h("label", { for: "ctx-text", class: "ctx-label" }, T("ctx.label")), ta, count),
    drop,
    list,
    meter,
    msg,
    moreBtn,
    moreBox,
    err,
    h(
      "div",
      { class: "actions stick" },
      h("button", { type: "button", class: "btn", id: "ctx-prepare", onclick: prepareContext }, ico("refresh"), h("span", {}, T("ctx.prepare"))),
      h("button", { type: "submit", class: "btn primary", id: "plan-save" }, ico("check"), h("span", {}, T("ctx.save"))),
      btn(T("ctx.cancel"), { id: "plan-cancel", onclick: () => closeEditor(true) }),
      h("span", { class: "sub", id: "ctx-prep-note" }),
    ),
    h("p", { class: "sub" }, T("ctx.saveNote")),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const plan = await saveFromForm(false);
    if (!plan) return;
    closeEditor(false);
    announce(T("ctx.saved"));
    const sb = $("pm-start-" + plan.id);
    if (sb) sb.focus();
  });
  // Keyboard: Escape closes the box (the line editor of the panel keeps its own Escape); Ctrl or Cmd + Enter saves.
  sec.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.defaultPrevented && !(e.target.classList && e.target.classList.contains("kn-input"))) {
      e.preventDefault();
      closeEditor(true);
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  sec.append(form, prepared);

  if (!H.editId && H.recent.length)
    sec.append(
      h(
        "div",
        { class: "recent" },
        h("div", { class: "label" }, T("ctx.recent")),
        h(
          "ul",
          {},
          H.recent.slice(0, 3).map((p, i) => {
            const t = [p.who, p.goal].filter(Boolean).join(" · ") || (p.notes || "").split("\n")[0] || T("ctx.recent.untitled");
            return h(
              "li",
              {},
              h(
                "button",
                {
                  type: "button",
                  class: "btn sm",
                  id: "recent-" + i,
                  title: T("ctx.recent.fill"),
                  onclick: () => {
                    captureDraft();
                    H.draft = { ...(H.draft || {}), title: p.title || "", at: p.at || "", who: p.who || "", goal: p.goal || "", mustCover: p.mustCover || "" };
                    H.moreOpen = true;
                    renderSide();
                    const w = $("ctx-text");
                    if (w) w.focus();
                  },
                },
                ico("plan"),
                h("span", { dir: "auto", lang: langOf(t) }, t),
              ),
            );
          }),
        ),
        h(
          "button",
          {
            type: "button",
            class: "linkbtn",
            id: "recent-forget",
            onclick: async () => {
              H.recent = await api.forgetRecentPlans().catch(() => []);
              renderSide();
              announce(T("ctx.recent.forgotten"));
            },
          },
          T("ctx.recent.forget"),
        ),
      ),
    );
  return sec;
}
