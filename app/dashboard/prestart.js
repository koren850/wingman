"use strict";
// The review step before Start: "What Wingman knows" for a prepared meeting, shown once, before the call.
// It lists the people, the call type (read only), what it read from the person's text with the line each fact came from, and warns when two facts may disagree.
// Each line can be unticked or edited. "Start" keeps those changes (sent to the call as edits once its notes exist); "Start without review" starts at once with nothing changed.
// No context is a normal state: the caller does not open this at all (WingmanKnows.hasContext). All text goes in with textContent.
// Classic script, loaded after knows.js (uses h, ico, btn, chip, T, dirOf, langOf, announce, $, srcLine).

/** The sections the review lists, in reading order (the same order as the model text). */
const PRESTART_SECTIONS = ["roster", "past", "agenda", "facts", "mustCover"];

/**
 * Opens the review sheet for a "before the call" model. Resolves to { go: false } (closed, nothing started) or { go: true, ops } (start; ops = the edits to send to the call).
 */
function prestartReview(model, o = {}) {
  return new Promise((resolve) => {
    const KNW = window.WingmanKnows;
    const st = { off: {}, text: {} };
    const opener = document.activeElement;
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      const ov = $("prestart-sheet");
      if (ov) ov.remove();
      if (!r.go && opener && document.contains(opener)) opener.focus();
      resolve(r);
    };
    const offer = recapOffer(o.recap);
    const body = h("div", { class: "ps-body", id: "ps-body" });
    const draw = () => {
      body.textContent = "";
      const cur = KNW.applyReview(model, st).model;
      const kind = KNW.kindOf(model);
      if (kind)
        body.append(
          h(
            "p",
            { class: "ps-kind", id: "ps-kind" },
            h("b", {}, T("knows.kind") + ": "),
            chip(T("kind." + kind), "info"),
            h("span", { class: "faint" }, " " + T("knows.kindNote")),
          ),
        );
      if (model.topic)
        body.append(h("p", { class: "kn-topic" }, h("b", {}, T("knows.topic") + ": "), h("span", { dir: "auto", lang: langOf(model.topic) }, model.topic)));
      const bad = KNW.conflicts(cur);
      if (bad.length)
        body.append(
          h(
            "div",
            { class: "ps-warn", id: "ps-warn", role: "alert" },
            h("div", { class: "sg-h" }, ico("warning"), h("b", {}, T("review.conflict.title"))),
            h("p", { class: "sub" }, T("review.conflict.sub")),
            h(
              "ul",
              {},
              bad.map((c) =>
                h(
                  "li",
                  { "data-kind": c.kind },
                  h("b", {}, T(c.kind === "number" ? "review.conflict.number" : "review.conflict.negation") + " "),
                  h("span", { dir: "auto", lang: langOf(c.a.text) }, "“" + c.a.text + "”"),
                  " / ",
                  h("span", { dir: "auto", lang: langOf(c.b.text) }, "“" + c.b.text + "”"),
                ),
              ),
            ),
          ),
        );
      if (offer) body.append(offer.el);
      for (const key of PRESTART_SECTIONS) {
        const list = (model.sections && model.sections[key]) || [];
        if (!list.length) continue;
        const hid = "ps-h-" + key;
        body.append(
          h("h3", { id: hid }, T("knows.sec." + key), h("span", { class: "faint kn-n" }, ` ${list.length}`)),
          h(
            "ul",
            { class: "kn-list ps-list", "aria-labelledby": hid },
            list.map((x) => line(key, x)),
          ),
        );
      }
    };
    const line = (key, x) => {
      const on = !st.off[x.id];
      const text = st.text[x.id] != null ? st.text[x.id] : x.text;
      const cb = h("input", { type: "checkbox", id: "ps-c-" + x.id, checked: on ? true : null, "aria-describedby": "ps-t-" + x.id });
      cb.addEventListener("change", () => {
        st.off[x.id] = !cb.checked;
        draw();
        const again = $("ps-c-" + x.id);
        if (again) again.focus();
      });
      const from = srcLine(x);
      const edit = () => {
        const inp = h("input", {
          type: "text",
          id: "ps-i-" + x.id,
          value: text,
          maxlength: String(KNW.MAX_TEXT),
          "aria-label": T("knows.editShort"),
          dir: "auto",
        });
        const save = () => {
          const r = KNW.editItem({ sections: { [key]: [{ id: x.id, text: x.text }] } }, key, x.id, inp.value);
          if (r.ok) st.text[x.id] = r.model.sections[key][0].text;
          draw();
          const f = $("ps-e-" + x.id);
          if (f) f.focus();
        };
        inp.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            draw();
            const f = $("ps-e-" + x.id);
            if (f) f.focus();
          }
        });
        li.textContent = "";
        li.append(inp, btn(T("knows.save"), { id: "ps-s-" + x.id, cls: "sm", onclick: save }));
        inp.focus();
      };
      const li = h(
        "li",
        { class: "kn-item ps-item" + (on ? "" : " off"), "data-id": x.id },
        cb,
        h(
          "label",
          { class: "kn-text", for: "ps-c-" + x.id, id: "ps-t-" + x.id, dir: "auto", lang: langOf(text) },
          text,
          x.role ? h("span", { class: "faint" }, " (" + x.role + ")") : null,
          from ? h("span", { class: "kn-src faint", dir: "auto" }, from) : null,
        ),
        btn("", { id: "ps-e-" + x.id, cls: "ghost sm icon", icon: "pencil", aria: T("knows.edit", { text }), title: T("knows.editShort"), onclick: edit }),
      );
      return li;
    };
    draw();
    const panel = h(
      "div",
      { class: "sheet ps-sheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "ps-h", tabindex: "-1" },
      h("div", { class: "sheet-head" }, h("h2", { id: "ps-h" }, T("knows.title"))),
      h("p", { class: "sub" }, T("review.sub")),
      body,
      h(
        "div",
        { class: "actions ps-actions" },
        btn(T("review.start"), {
          id: "ps-start",
          icon: "phone",
          cls: "primary",
          onclick: () => finish({ go: true, ops: [...KNW.applyReview(model, st).ops, ...(offer ? offer.ops() : [])] }),
        }),
        btn(T("review.skip"), { id: "ps-skip", onclick: () => finish({ go: true, ops: [] }) }),
        btn(T("review.cancel"), { id: "ps-cancel", cls: "ghost", onclick: () => finish({ go: false }) }),
      ),
    );
    const ov = h("div", { class: "sheet-ov", id: "prestart-sheet" }, panel);
    ov.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        finish({ go: false });
        return;
      }
      if (e.key === "Tab") {
        const els = [...panel.querySelectorAll("button, input")].filter((x) => !x.disabled);
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
    $("ps-start").focus();
    ready();
    announce(T("review.opened"));
  });
}
