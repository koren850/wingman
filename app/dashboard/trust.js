"use strict";
// Card trust (renderer): "Show the line", "What this card saw", the "Held back" list and "What Wingman learned" of the call review. The data side is trustlib.js (pure).
//   trustButtons(card, o)    two buttons for a card: Show the line (o.onLine) and What this card saw (opens the panel under the buttons)
//   trustSawPanel(card)      memory version, tokens by part, trimmed parts and background pieces; a card from before the record says so
//   reviewHeld(d)            the Held back block of the Review tab: skipped and dropped moments with the reason, the line before it, and a rating
//   reviewLearning()         the learned counts and a reset button
// Classic script, loaded after review.js (uses h, T, btn, chip, ico, announce, state, api, WingmanTrust, WingmanReview, textEl).

/** The label of a prompt part or a trimmed step in the window language (the catalog has the known ones; an unknown one shows as it is). */
function trustWord(prefix, name) {
  const k = "trust." + prefix + "." + name;
  const t = T(k);
  return t !== k ? t : String(name).replace(/[-_:]+/g, " ");
}

/** What the model saw for this card. Built with textContent only; a legacy row (no record) gets one honest line. */
function trustSawPanel(card) {
  const s = WingmanTrust.cardSaw(card);
  const box = h("div", { class: "trust-saw", id: "saw-" + card.id, role: "group", "aria-label": T("trust.saw") });
  if (s.legacy) {
    box.append(h("p", { class: "faint" }, T("trust.legacy")));
    return box;
  }
  const dl = h("dl", { class: "rev-stats" });
  dl.append(h("dt", {}, T("trust.memory")), h("dd", { "data-stat": "memv" }, s.memV == null ? T("trust.unknown") : T("trust.memoryV", { n: s.memV })));
  dl.append(h("dt", {}, T("trust.tokens")), h("dd", { "data-stat": "tokens" }, ltr(String(s.tokens))));
  if (s.parts.length)
    dl.append(
      h("dt", {}, T("trust.parts")),
      h(
        "dd",
        { "data-stat": "parts" },
        s.parts.filter((p) => p.tokens > 0).map((p) => h("span", { class: "trust-part" }, trustWord("part", p.name) + " ", ltr(String(p.tokens)))),
      ),
    );
  dl.append(
    h("dt", {}, T("trust.trimmed")),
    h(
      "dd",
      { "data-stat": "trimmed" },
      s.trimmed.length ? s.trimmed.map((x) => h("span", { class: "trust-part" }, trustWord("step", WingmanTrust.stepKey(x)))) : T("trust.nothingTrimmed"),
    ),
  );
  dl.append(
    h("dt", {}, T("trust.chunks")),
    h(
      "dd",
      { "data-stat": "chunks" },
      s.chunks.length
        ? s.chunks.map((c) => h("span", { class: "trust-part", dir: "auto" }, c.source ? c.source : T("trust.chunkNoSource", { id: c.id })))
        : T("trust.noChunks"),
    ),
  );
  box.append(dl);
  return box;
}

/**
 * The two buttons of a card. o: { onLine(): the page jumps to the line (null when the card has no line to show) }.
 * The panel opens under the buttons and the button says whether it is open (aria-expanded).
 */
function trustButtons(card, o) {
  const wrap = h("div", { class: "trust" });
  const saw = btn(T("trust.saw"), { cls: "sm ghost", id: "saw-btn-" + card.id, aria: T("trust.saw") });
  saw.setAttribute("aria-expanded", "false");
  saw.setAttribute("aria-controls", "saw-" + card.id);
  let panel = null;
  saw.addEventListener("click", () => {
    if (panel) {
      panel.remove();
      panel = null;
      saw.setAttribute("aria-expanded", "false");
      return;
    }
    panel = trustSawPanel(card);
    wrap.append(panel);
    saw.setAttribute("aria-expanded", "true");
  });
  const kids = [];
  if (o && o.onLine) kids.push(btn(T("trust.line"), { cls: "sm ghost", id: "line-btn-" + card.id, icon: "jump", onclick: o.onLine }));
  kids.push(saw);
  wrap.prepend(h("div", { class: "trust-btns" }, kids));
  return wrap;
}

/** Goes to the transcript line a card answers (Review: the Transcript tab, scrolled to it and highlighted). */
function trustJump(card) {
  const d = state.detail;
  const i = WingmanTrust.sourceLine(d.transcript, card);
  if (i < 0) return announce(T("trust.noLine"));
  setTab("transcript", { line: i }, true);
}

/** The Held back block: skipped and dropped moments of this call. A rating "I wanted this" goes to learning (once per moment). */
function reviewHeld(d) {
  const items = WingmanTrust.heldBack(d.events, d.transcript, d.held);
  const sec = h("section", { class: "rev-block", id: "rev-held", "aria-labelledby": "rev-held-h" });
  sec.append(h("h2", { id: "rev-held-h" }, T("held.title")));
  if (!items.length) {
    sec.append(h("p", { class: "sub", id: "rev-held-none" }, T("held.none")));
    return sec;
  }
  sec.append(h("p", { class: "faint" }, T("held.note")));
  const ul = h("ul", { class: "held-list", id: "held-list" });
  const t0 = typeof t0Of === "function" ? t0Of(d) : 0;
  for (const it of items) {
    const li = h("li", { class: "held-item", "data-key": it.key, "data-group": it.group });
    const why = h(
      "div",
      { class: "held-why" },
      chip(T("rev.g." + it.group), it.group === "dropped" ? "warn" : ""),
      " ",
      h("span", { dir: "auto" }, reviewReason(it.reason)),
    );
    if (it.t != null && t0) why.append(" ", h("span", { class: "faint" }, mmss(it.t - t0)));
    li.append(why);
    if (it.line)
      li.append(h("div", { class: "held-line faint", dir: "auto", lang: langOf(it.line) }, T("held.after"), " ", h("span", { dir: "auto" }, it.line)));
    const rate = h("div", { class: "held-rate", role: "group", "aria-label": T("held.rate") });
    for (const v of ["wanted", "fine"]) {
      const b = h("button", { type: "button", class: "btn sm ghost", "data-v": v, "aria-pressed": it.rating === v ? "true" : "false" }, T("held." + v));
      b.addEventListener("click", async () => {
        const next = b.getAttribute("aria-pressed") === "true" ? null : v;
        b.disabled = true;
        let r = null;
        try {
          r = await api.rateHeld(state.id, it.key, next);
        } catch {
          r = null;
        }
        b.disabled = false;
        if (!r || !r.ok) return announce(T(r && r.error === "preview" ? "rev.export.preview" : "held.failed"));
        for (const x of rate.querySelectorAll("button")) x.setAttribute("aria-pressed", r.ratings[it.key] === x.dataset.v ? "true" : "false");
        if (d.held) d.held[it.key] = r.ratings[it.key];
        announce(T("held.saved"));
      });
      rate.append(b);
    }
    li.append(rate);
    ul.append(li);
  }
  sec.append(ul);
  return sec;
}

/** A kind of card (ANS, NOTE, CHECK...) in plain words. */
const learnTagWord = (k) => {
  const key = "tag." + String(k);
  const t = T(key);
  return t !== key ? t : String(k);
};

/** What Wingman learned from the user's ratings (counts only) and the reset button. */
function reviewLearning() {
  const sec = h("section", { class: "rev-block", id: "rev-learn", "aria-labelledby": "rev-learn-h" });
  sec.append(h("h2", { id: "rev-learn-h" }, T("learn.title")));
  const body = h("div", { id: "rev-learn-body" }, h("p", { class: "faint" }, "…"));
  sec.append(body);
  const draw = (r) => {
    body.replaceChildren();
    if (!r || !r.ok) return body.append(h("p", { class: "sub" }, T("learn.unavailable")));
    const raised = Array.isArray(r.raised) ? r.raised : [],
      watching = r.watching && typeof r.watching === "object" ? Object.entries(r.watching) : [];
    body.append(h("p", { class: "sub", id: "learn-sum" }, T("learn.calls", { n: Number(r.calls) || 0 })));
    if (raised.length) body.append(h("p", { class: "sub", id: "learn-raised" }, T("learn.raised", { kinds: raised.map(learnTagWord).join(", ") })));
    if (watching.length)
      body.append(
        h(
          "p",
          { class: "faint", id: "learn-watch" },
          T("learn.watching", { list: watching.map(([k, v]) => `${learnTagWord(k)}: ${Number(v.neg) || 0}`).join(", ") }),
        ),
      );
    if (!raised.length && !watching.length) body.append(h("p", { class: "faint", id: "learn-none" }, T("learn.none")));
    const reset = btn(T("learn.reset"), { id: "learn-reset", cls: "sm" });
    reset.addEventListener("click", async () => {
      reset.disabled = true;
      let x = null;
      try {
        x = await api.learnReset();
      } catch {
        x = null;
      }
      reset.disabled = false;
      if (!x || !x.ok) return announce(T(x && x.error === "preview" ? "rev.export.preview" : "learn.failed"));
      announce(T("learn.done"));
      draw({ ok: true, calls: 0, raised: [], watching: {} });
    });
    body.append(h("div", { class: "actions" }, reset), h("p", { class: "faint" }, T("learn.note")));
  };
  Promise.resolve(api.learnSummary ? api.learnSummary() : null)
    .then(draw)
    .catch(() => draw(null));
  return sec;
}
