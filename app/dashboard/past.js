"use strict";
// Earlier calls (renderer): the search of finished calls with an offline answer, the opt-in lookup, the list of stored "Last time" facts (Settings), and the recap offer for a recurring meeting.
//   pastPanel(o)         input + Search (+ Look up when the lookup is switched on). Results show the saved line, the call date and where it came from.
//   pastFactsBlock()     Settings, Privacy: what is stored per person, with a Forget button per person and per call
//   recapOffer(recap)    the block in the review step: "You met before", with Add this recap / No thanks
// All text from files, from the web and from calls goes in with textContent. Classic script, loaded after trust.js (uses h, T, btn, chip, announce, api, fullDay, openCall, dirOf, langOf).

/** The answer of a past search: the label that says no AI wrote it, then the best lines with date and source, each with a way to open the call. */
function pastResults(r) {
  const box = h("div", { class: "past-results", id: "past-results" });
  if (!r || !r.ok) {
    box.append(h("p", { class: "sub" }, T("past.failed")));
    return box;
  }
  if (!r.found || !r.hits.length) {
    box.append(h("p", { class: "sub", id: "past-none" }, T("past.none")));
    return box;
  }
  box.append(h("p", { class: "faint", id: "past-label" }, r.offline ? T("past.offline") : T("past.fromNotes")));
  const ul = h("ul", { class: "past-hits" });
  for (const x of r.hits) {
    const src = ["summary", "decision", "promise", "fact", "topic"].includes(x.source) ? x.source : "fact";
    ul.append(
      h(
        "li",
        { class: "past-hit", "data-call": x.callId },
        h("span", { class: "past-text", dir: "auto", lang: langOf(x.text) }, x.text),
        h(
          "span",
          { class: "faint past-meta" },
          " ",
          T("past.cite", { date: fullDay(x.at), source: T("past.src." + src) }),
          " ",
          btn(T("past.open"), { cls: "sm ghost", aria: T("past.openNamed", { date: fullDay(x.at) }), onclick: () => openCall(x.callId) }),
        ),
      ),
    );
  }
  box.append(ul);
  return box;
}

/** The result of a lookup: one line, the web address it came from (as text) and the exact sentence of the page. A failure says why in plain words. */
function lookupResult(r) {
  const box = h("div", { class: "lookup-result", id: "lookup-result" });
  if (!r || !r.ok) {
    const code = r && r.reason ? String(r.reason) : "failed";
    const k = "lookup.fail." + code;
    const t = T(k);
    box.append(h("p", { class: "sub", id: "lookup-fail" }, t !== k ? t : T("lookup.fail.failed")));
    return box;
  }
  box.append(
    h("p", { class: "lookup-line", id: "lookup-line", dir: "auto", lang: langOf(r.line) }, r.line),
    h("p", { class: "faint" }, T("lookup.source"), " ", h("span", { class: "ltr", id: "lookup-url", dir: "ltr" }, r.url)),
    h("p", { class: "faint" }, T("lookup.sentence"), " ", h("q", { id: "lookup-sentence", dir: "auto", lang: langOf(r.sentence) }, r.sentence)),
  );
  return box;
}

/**
 * Search of finished calls, and (when switched on) a lookup of one term on a public web page. o: { id }.
 * The lookup switch is the setting lookup.enabled: it is off until the user turns it on here or in Settings, and the main process checks it again.
 */
function pastPanel(o) {
  const id = (o && o.id) || "past";
  const input = h("input", {
    type: "text",
    id: id + "-in",
    maxlength: "300",
    autocomplete: "off",
    placeholder: T("past.placeholder"),
    "aria-label": T("past.label"),
  });
  const out = h("div", { id: id + "-out", role: "region", "aria-live": "polite" });
  const search = btn(T("past.search"), { id: id + "-go" });
  const look = btn(T("lookup.go"), { id: id + "-lookup", icon: "jump" });
  look.hidden = true;
  const sw = h("button", { type: "button", class: "btn sm ghost", id: id + "-lookup-on", "aria-pressed": "false" }, T("lookup.toggle"));
  const syncSwitch = (on) => {
    sw.setAttribute("aria-pressed", on ? "true" : "false");
    look.hidden = !on;
  };
  Promise.resolve(api.getSettings ? api.getSettings() : null)
    .then((r) => {
      const it = r && r.ok && Array.isArray(r.items) ? r.items.find((x) => x.key === "lookup.enabled") : null;
      if (it) syncSwitch(it.value === true);
    })
    .catch(() => {});
  sw.addEventListener("click", async () => {
    const next = sw.getAttribute("aria-pressed") !== "true";
    sw.disabled = true;
    let r = null;
    try {
      r = await api.setSetting("lookup.enabled", next);
    } catch {
      r = null;
    }
    sw.disabled = false;
    if (!r || r.ok === false) return announce(T("lookup.switchFailed"));
    syncSwitch(next);
    announce(T(next ? "lookup.on" : "lookup.off"));
  });
  const run = async (fn, draw, busyText) => {
    const q = input.value.trim();
    if (!q) return;
    out.replaceChildren(h("p", { class: "faint" }, busyText));
    let r = null;
    try {
      r = await fn(q);
    } catch {
      r = null;
    }
    out.replaceChildren(draw(r));
  };
  search.addEventListener("click", () => run(api.pastSearch, pastResults, T("past.searching")));
  look.addEventListener("click", () => run(api.lookup, lookupResult, T("lookup.searching")));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      search.click();
    }
  });
  return h(
    "div",
    { class: "past-panel", id },
    h("div", { class: "noterow" }, input, search, look),
    h("div", { class: "past-tools" }, sw, h("span", { class: "faint" }, T("lookup.note"))),
    out,
  );
}

/** Settings, Privacy: the stored "Last time" facts per person, with Forget buttons. Forgetting does not delete the saved calls. */
function pastFactsBlock() {
  const sec = h(
    "section",
    { class: "setgroup", id: "g-past", "aria-labelledby": "g-past-h" },
    h("h2", { id: "g-past-h", class: "label", tabindex: "-1" }, T("past.list.title")),
  );
  const body = h("div", { id: "past-list" }, h("p", { class: "faint" }, "…"));
  sec.append(h("p", { class: "help" }, T("past.list.note")), body);
  const draw = (r) => {
    body.replaceChildren();
    const people = r && r.ok && Array.isArray(r.people) ? r.people : null;
    if (!people) return body.append(h("p", { class: "sub" }, T("past.list.failed")));
    if (!people.length) return body.append(h("p", { class: "sub", id: "past-list-none" }, T("past.list.none")));
    const forget = async (key, callId, label) => {
      let x = null;
      try {
        x = await api.pastForget(key, callId || "");
      } catch {
        x = null;
      }
      if (!x || !x.ok) return announce(T(x && x.error === "preview" ? "rev.export.preview" : "past.list.failedForget"));
      announce(T("past.list.forgotten", { name: label }));
      draw(await api.pastList());
    };
    const ul = h("ul", { class: "past-people" });
    for (const p of people) {
      const li = h("li", { class: "past-person", "data-key": p.key });
      li.append(
        h(
          "div",
          { class: "past-phead" },
          h("b", { dir: "auto", lang: langOf(p.name) }, p.name),
          btn(T("past.list.forget"), {
            id: "forget-" + p.key.replace(/[^a-z0-9]+/gi, "-"),
            cls: "sm",
            aria: T("past.list.forgetNamed", { name: p.name }),
            onclick: () => forget(p.key, "", p.name),
          }),
        ),
      );
      const calls = h("ul", { class: "past-calls" });
      for (const c of p.calls || []) {
        calls.append(
          h(
            "li",
            { "data-call": c.id },
            h("span", { class: "faint" }, fullDay(c.at) + " "),
            h("span", { dir: "auto", lang: langOf(c.topic) }, c.topic || T("past.list.noTopic")),
            (c.promises || []).map((x) => h("div", { class: "faint", dir: "auto" }, `${x.who}: ${x.text}`)),
            " ",
            btn(T("past.list.forgetCall"), {
              cls: "sm ghost",
              aria: T("past.list.forgetCallNamed", { date: fullDay(c.at) }),
              onclick: () => forget(p.key, c.id, p.name),
            }),
          ),
        );
      }
      li.append(calls);
      ul.append(li);
    }
    body.append(ul);
  };
  Promise.resolve(api.pastList ? api.pastList() : null)
    .then(draw)
    .catch(() => draw(null));
  return sec;
}

/**
 * The offer in the review step for a recurring meeting. recap: { by: "name" | "topic" | "none", person?, facts: [{ text, at }] }. Returns { el, chosen() } or null.
 * Nothing is added unless the user presses Add this recap. For "name" matches the review step already lists the Last time facts, so no offer is made.
 */
function recapOffer(recap) {
  if (!recap || recap.by !== "topic" || !Array.isArray(recap.facts) || !recap.facts.length) return null;
  let chosen = null;
  const at = recap.facts[0].at;
  const box = h("div", { class: "ps-recap", id: "ps-recap", role: "group", "aria-labelledby": "ps-recap-h" });
  const draw = () => {
    box.replaceChildren(
      h("div", { class: "sg-h" }, h("b", { id: "ps-recap-h" }, T("recap.title"))),
      h("p", { class: "sub" }, T("recap.sub", { name: recap.person || "", date: at ? fullDay(at) : "" })),
      h(
        "ul",
        { class: "kn-list" },
        recap.facts.slice(0, 5).map((f) => h("li", { dir: "auto", lang: langOf(f.text) }, f.text)),
      ),
      chosen === null
        ? h(
            "div",
            { class: "actions" },
            btn(T("recap.add"), { id: "ps-recap-add", cls: "sm", onclick: () => ((chosen = true), draw(), $("ps-recap-undo") && $("ps-recap-undo").focus()) }),
            btn(T("recap.no"), { id: "ps-recap-no", cls: "sm ghost", onclick: () => ((chosen = false), draw()) }),
          )
        : h(
            "div",
            { class: "actions" },
            h("span", { class: "faint", role: "status" }, T(chosen ? "recap.added" : "recap.skipped")),
            btn(T("recap.undo"), {
              id: "ps-recap-undo",
              cls: "sm ghost",
              onclick: () => ((chosen = null), draw(), $("ps-recap-add") && $("ps-recap-add").focus()),
            }),
          ),
    );
  };
  draw();
  return {
    el: box,
    /** The notes lines to add when the user said yes (else none). */
    ops: () => (chosen === true ? recap.facts.slice(0, 5).map((f) => ({ op: "add", sec: "past", text: f.text })) : []),
  };
}
