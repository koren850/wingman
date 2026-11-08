"use strict";
// "What Wingman knows" panel and the "So far" card (renderer). The data and the pure edit functions are in knowslib.js.
// Each line can be edited or removed. In wave 1 the lines come from a fixture or from the saved meeting context; changes are kept in the page only.
// In a live call (model.source "memory") onChange also gets an `op` ({ op: "edit"|"remove"|"add", ... }): home.js sends it to the main process, which queues a "user" edit for the engine.
// The panel shows the text the model reads (toModelText).
// All text goes in with textContent. Classic script, loaded after app.js (uses h, ico, btn, chip, T, tip, dirOf, langOf, announce).

const KN = window.WingmanKnows;

/** Where a line comes from, in words: the line of the user's text it was read from, the call it was remembered from, or the part of the app that made it. "" when unknown. */
function srcLine(x) {
  if (x.source) return T("knows.src.quote", { text: x.source });
  if (x.src === "past")
    return x.at
      ? T("knows.src.pastAt", { date: new Date(x.at).toLocaleDateString(WingmanI18n.lang === "he" ? "he-IL" : "en", { day: "numeric", month: "short" }) })
      : T("knows.src.past");
  return x.src === "brief" || x.src === "call" || x.src === "user" ? T("knows.src." + x.src) : "";
}

/** "Wingman understood: ..." under the context box. One line, from the model alone. model null: nothing is drawn. */
function understoodLine(model) {
  if (!model) return null;
  const u = KN.understood(model);
  const parts = [];
  if (u.people.length) parts.push(T("ctx.u.people", { names: u.people.join(", ") }));
  if (u.topic) parts.push(T("ctx.u.topic", { topic: u.topic }));
  if (u.agenda) parts.push(T("ctx.u.agenda", { n: u.agenda }));
  if (u.facts) parts.push(T("ctx.u.facts", { n: u.facts }));
  if (u.past) parts.push(T("ctx.u.past", { n: u.past }));
  return h(
    "p",
    { class: "ctx-understood", id: "ctx-understood", role: "status" },
    h("b", {}, T("ctx.understood") + " "),
    h("span", { dir: "auto" }, parts.length ? parts.join(" · ") + "." : T("ctx.u.nothing")),
    parts.length ? h("span", { class: "faint" }, " " + T("ctx.u.fix")) : null,
  );
}

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
    // The "Sample" badge belongs to demo mode only (a fixture model), and the live Home shows it once, on So far.
    model && !(o.view && model.source === "fixture") ? chip(T("knows.source." + model.source), model.source === "fixture" ? "warn" : "info") : null,
  );
  if (o.view) {
    // Live Home: folded by default, with Show and Edit buttons. "read" shows the lines, "edit" also shows the pencil, trash and add boxes.
    const set = (v) => () => o.onView && o.onView(v);
    if (model) head.append(chip(String(KN.count(model)), ""));
    if (o.view === "folded") head.append(btn(T("knows.view.show"), { id: id + "-show", cls: "sm ghost", onclick: set("read") }));
    if (o.view === "read") head.append(btn(T("knows.view.hide"), { id: id + "-hide", cls: "sm ghost", onclick: set("folded") }));
    head.append(
      o.view === "edit"
        ? btn(T("knows.view.done"), { id: id + "-done", cls: "sm", onclick: set("read") })
        : btn(T("knows.view.edit"), { id: id + "-edit", cls: "sm ghost", icon: "pencil", onclick: set("edit") }),
    );
    sec.classList.add("kview-" + o.view);
    if (o.view === "folded") {
      sec.append(head);
      return sec;
    }
  }
  sec.append(head);
  if (!model || (KN.count(model) === 0 && !model.topic)) {
    sec.append(h("p", { class: "sub kn-empty", id: id + "-empty" }, T(o.emptyKey || (live ? "knows.empty.live" : "knows.empty.before"))));
    if (model && model.source === "saved") sec.append(h("p", { class: "sub" }, T("knows.plainBackground")));
    return sec;
  }
  if (o.ai && o.ai !== "ok")
    sec.append(
      h("p", { class: "sub kn-paused", id: id + "-paused", role: "status" }, ico("warning"), T(o.ai === "offline" ? "knows.aiOffline" : "knows.aiPaused")),
    );
  sec.append(h("p", { class: "sub" }, T(live ? "knows.sub.live" : "knows.sub.before")));
  if (model.topic)
    sec.append(h("p", { class: "kn-topic" }, h("b", {}, T("knows.topic") + ": "), h("span", { dir: "auto", lang: langOf(model.topic) }, model.topic)));
  if (KN.kindOf(model))
    sec.append(h("p", { class: "kn-kind", id: id + "-kind" }, h("b", {}, T("knows.kind") + ": "), chip(T("kind." + KN.kindOf(model)), "info")));
  if (model.source === "saved") sec.append(h("p", { class: "sub" }, T("knows.plainBackground")));

  const change = (next, msg, focusId, op) => {
    if (o.onChange) o.onChange(next, focusId, op);
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
        const from = srcLine(x);
        li.append(
          h(
            "span",
            { class: "kn-text", dir: "auto", lang: langOf(x.text) },
            x.who ? h("b", {}, x.who + ": ") : null,
            x.text,
            x.role ? h("span", { class: "faint" }, " (" + x.role + ")") : null,
            from ? h("span", { class: "kn-src faint", dir: "auto" }, from) : null,
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
                change(KN.removeItem(model, key, x.id), T("knows.removed"), nextId, { op: "remove", id: x.id });
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
          change(r.model, T("knows.saved"), `${id}-e-${key}-${x.id}`, { op: "edit", id: x.id, text: KN.clean(inp.value) });
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
        if (r.ok) change(r.model, T("knows.added"), `${id}-a-${key}`, { op: "add", sec: key, text: KN.clean(inp.value) });
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

/** The "So far" card for the live Home (ai: "ok" | "paused" | "offline", from the engine; the last notes stay on screen when it is not ok): the topic, up to four lines, and counts of open questions and promises. model null: a calm waiting line. */
function soFarCard(model, ai) {
  const sec = h("section", { class: "card-big sofar", id: "sofar", "aria-labelledby": "sofar-h" });
  sec.append(
    h(
      "div",
      { class: "rhead" },
      h("h2", { id: "sofar-h" }, T("sofar.title")),
      KN.kindOf(model) ? chip(T("kind." + KN.kindOf(model)), "info", { title: T("knows.kindNote") }) : null,
      h("span", { class: "grow" }),
      ai && ai !== "ok" ? chip(T(ai === "offline" ? "knows.aiOffline.short" : "knows.aiPaused.short"), "warn", { dot: true }) : null,
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
  const tipped = (el, key) => {
    el.setAttribute("title", T(key)); // plain words for the short label
    return el;
  };
  if (n("decisions")) chips.push(tipped(chip(T("sofar.decided", { n: n("decisions") }), "info"), "sofar.decided.tip"));
  if (n("open")) chips.push(tipped(chip(T("sofar.open", { n: n("open") }), "warn"), "sofar.open.tip"));
  if (n("promises")) chips.push(tipped(chip(T("sofar.promises", { n: n("promises") }), "warn"), "sofar.promises.tip"));
  const left = (s.mustCover || []).filter((x) => !x.done).length;
  if (left) chips.push(tipped(chip(T("sofar.cover", { n: left }), ""), "sofar.cover.tip"));
  if (chips.length) sec.append(h("div", { class: "chips" }, chips));
  return sec;
}
