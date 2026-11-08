"use strict";
// "What Wingman knows" panel and the "So far" card (renderer). The data and the pure edit functions are in knowslib.js.
// Each line can be edited or removed. In wave 1 the lines come from a fixture or from the saved meeting context; changes are kept in the page only.
// Wave 2 gives onChange a real handler that writes a "user" patch to the call memory. The panel shows the text the model reads (toModelText).
// All text goes in with textContent. Classic script, loaded after app.js (uses h, ico, btn, chip, T, tip, dirOf, langOf, announce).

const KN = window.WingmanKnows;

/**
 * The panel. model: a knowslib model (or null for "nothing yet"). o: { id, onChange(model), emptyKey, sourceKey }.
 * Keyboard: every edit and remove button is a real button in the tab order; Enter saves an edit, Escape cancels it.
 */
function knowsPanel(model, o = {}) {
  const id = o.id || "knows";
  const sec = h("section", { class: "card-big knows", id, "aria-labelledby": id + "-h" });
  const live = !!model && model.mode === "live";
  const head = h(
    "div",
    { class: "rhead" },
    h("h2", { id: id + "-h" }, T("knows.title")),
    tip(T("knows.tip")),
    h("span", { class: "grow" }),
    model ? chip(T("knows.source." + model.source), model.source === "fixture" ? "warn" : "info") : null,
  );
  sec.append(head);
  if (!model || (KN.count(model) === 0 && !model.topic)) {
    sec.append(h("p", { class: "sub kn-empty", id: id + "-empty" }, T(o.emptyKey || (live ? "knows.empty.live" : "knows.empty.before"))));
    if (model && model.source === "saved") sec.append(h("p", { class: "sub" }, T("knows.plainBackground")));
    return sec;
  }
  sec.append(h("p", { class: "sub" }, T(live ? "knows.sub.live" : "knows.sub.before")));
  if (model.topic)
    sec.append(h("p", { class: "kn-topic" }, h("b", {}, T("knows.topic") + ": "), h("span", { dir: "auto", lang: langOf(model.topic) }, model.topic)));
  if (model.source === "saved") sec.append(h("p", { class: "sub" }, T("knows.plainBackground")));

  const change = (next, msg, focusId) => {
    if (o.onChange) o.onChange(next, focusId);
    else {
      const fresh = knowsPanel(next, o);
      sec.replaceWith(fresh);
      if (focusId) {
        const f = document.getElementById(focusId) || fresh.querySelector("h2");
        if (f) {
          if (!f.hasAttribute("tabindex") && f.tagName === "H2") f.setAttribute("tabindex", "-1");
          f.focus();
        }
      }
    }
    if (msg) announce(msg);
  };

  for (const key of KN.order(model)) {
    const list = (model.sections && model.sections[key]) || [];
    const block = h("div", { class: "kn-sec", "data-sec": key });
    const hid = `${id}-${key}-h`;
    block.append(h("h3", { id: hid }, T("knows.sec." + key), list.length ? h("span", { class: "faint kn-n" }, ` ${list.length}`) : null));
    const ul = h("ul", { class: "kn-list", "aria-labelledby": hid });
    if (!list.length) ul.append(h("li", { class: "faint kn-none" }, T("knows.none")));
    list.forEach((x, i) => {
      const li = h("li", { class: "kn-item", "data-id": x.id });
      const label = (x.who ? x.who + ": " : "") + x.text;
      const show = () => {
        li.textContent = "";
        li.append(
          h(
            "span",
            { class: "kn-text", dir: "auto", lang: langOf(x.text) },
            x.who ? h("b", {}, x.who + ": ") : null,
            x.text,
            x.role ? h("span", { class: "faint" }, " (" + x.role + ")") : null,
          ),
          h(
            "span",
            { class: "kn-act" },
            btn("", {
              cls: "ghost sm icon",
              icon: "pencil",
              id: `${id}-e-${key}-${x.id}`,
              aria: T("knows.edit", { text: label }),
              title: T("knows.editShort"),
              onclick: edit,
            }),
            btn("", {
              cls: "ghost sm icon",
              icon: "trash",
              id: `${id}-r-${key}-${x.id}`,
              aria: T("knows.remove", { text: label }),
              title: T("knows.removeShort"),
              onclick: () => {
                const nextId = list[i + 1] ? `${id}-r-${key}-${list[i + 1].id}` : list[i - 1] ? `${id}-r-${key}-${list[i - 1].id}` : hid;
                change(KN.removeItem(model, key, x.id), T("knows.removed"), nextId);
              },
            }),
          ),
        );
      };
      const edit = () => {
        li.textContent = "";
        const inp = h("input", {
          type: "text",
          class: "kn-input",
          maxlength: String(KN.MAX_TEXT),
          value: x.text,
          "aria-label": T("knows.editShort"),
          dir: "auto",
        });
        const save = () => {
          const r = KN.editItem(model, key, x.id, inp.value);
          if (!r.ok) {
            inp.setAttribute("aria-invalid", "true");
            announce(T("knows.cantEmpty"));
            inp.focus();
            return;
          }
          change(r.model, T("knows.saved"), `${id}-e-${key}-${x.id}`);
        };
        inp.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            show();
            const b = document.getElementById(`${id}-e-${key}-${x.id}`);
            if (b) b.focus();
          }
        });
        li.append(
          inp,
          btn(T("knows.save"), { cls: "sm primary", onclick: save }),
          btn(T("knows.cancel"), {
            cls: "sm ghost",
            onclick: () => {
              show();
              const b = document.getElementById(`${id}-e-${key}-${x.id}`);
              if (b) b.focus();
            },
          }),
        );
        inp.focus();
        inp.select();
      };
      show();
      ul.append(li);
    });
    block.append(ul);
    // Add a line (a fact the user knows and the AI should know too).
    if (key !== "roster" || !live) {
      const add = h("form", { class: "kn-add", onsubmit: (e) => e.preventDefault() });
      const inp = h("input", {
        type: "text",
        class: "kn-input",
        maxlength: String(KN.MAX_TEXT),
        placeholder: T("knows.addPlaceholder"),
        "aria-label": T("knows.addLabel", { section: T("knows.sec." + key) }),
        dir: "auto",
        id: `${id}-a-${key}`,
      });
      const go = () => {
        const r = KN.addItem(model, key, inp.value);
        if (r.ok) change(r.model, T("knows.added"), `${id}-a-${key}`);
      };
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          go();
        }
      });
      add.append(inp, btn(T("knows.add"), { cls: "sm", onclick: go }));
      block.append(add);
    }
    sec.append(block);
  }
  sec.append(
    h(
      "details",
      { class: "kn-model" },
      h("summary", {}, T("knows.seeModel")),
      h("p", { class: "sub" }, T("knows.seeModelHelp")),
      h("pre", { class: "kn-pre", dir: "ltr", id: id + "-pre" }, KN.toModelText(model)),
    ),
  );
  return sec;
}

/** The "So far" card for the live Home: the topic, up to four lines, and counts of open questions and promises. model null: a calm waiting line. */
function soFarCard(model) {
  const sec = h("section", { class: "card-big sofar", id: "sofar", "aria-labelledby": "sofar-h" });
  sec.append(
    h(
      "div",
      { class: "rhead" },
      h("h2", { id: "sofar-h" }, T("sofar.title")),
      h("span", { class: "grow" }),
      model && model.source === "fixture" ? chip(T("knows.source.fixture"), "warn") : null,
    ),
  );
  const s = model && model.sections ? model.sections : {};
  const lines = (s.soFar || []).slice(-4);
  if (!model || (!model.topic && !lines.length)) {
    sec.append(h("p", { class: "sub", id: "sofar-empty" }, T("sofar.empty")));
    return sec;
  }
  if (model.topic)
    sec.append(h("p", { class: "kn-topic" }, h("b", {}, T("knows.topic") + ": "), h("span", { dir: "auto", lang: langOf(model.topic) }, model.topic)));
  if (lines.length)
    sec.append(
      h(
        "ul",
        { class: "sofar-list" },
        lines.map((x) => h("li", { dir: "auto", lang: langOf(x.text) }, x.text)),
      ),
    );
  const chips = [];
  const n = (k) => (s[k] || []).length;
  if (n("decisions")) chips.push(chip(T("sofar.decided", { n: n("decisions") }), "info"));
  if (n("open")) chips.push(chip(T("sofar.open", { n: n("open") }), "warn"));
  if (n("promises")) chips.push(chip(T("sofar.promises", { n: n("promises") }), "warn"));
  const left = (s.mustCover || []).filter((x) => !x.done).length;
  if (left) chips.push(chip(T("sofar.cover", { n: left }), ""));
  if (chips.length) sec.append(h("div", { class: "chips" }, chips));
  return sec;
}
