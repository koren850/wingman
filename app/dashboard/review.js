"use strict";
// Call review (renderer): the "Review" part of a call's Details tab. Three small blocks, all from files that are already on disk:
//   Moments    how many moments did not become a card, and why (the moment.* rows of events.jsonl; reviewlib.js counts them)
//   Coaching   talk share, longest time without a break, questions asked, pace, interruptions (summary.json `coaching`, numbers only, no score)
//   Export     Markdown or JSON of the call, saved where the user chooses (the main process asks for the place and writes the file)
// All text goes in with textContent. Classic script, loaded after after.js (uses h, T, btn, chip, ico, announce, state, api, WingmanReview).

/** Words for one reason, in the window's language when the catalog has them. */
function reviewReason(reason) {
  const k = "rev.r." + reason;
  const t = T(k);
  return t !== k ? t : WingmanReview.reasonLabel(reason);
}

function reviewMoments(d) {
  const R = WingmanReview.momentReport(d.events);
  const sec = h("section", { class: "rev-block", id: "rev-moments", "aria-labelledby": "rev-moments-h" });
  sec.append(h("h2", { id: "rev-moments-h" }, T("rev.moments.title")));
  if (!R.total) {
    sec.append(h("p", { class: "sub", id: "rev-moments-none" }, T("rev.moments.none")), h("p", { class: "faint" }, T("rev.moments.noneNote")));
    if (R.invalid) sec.append(h("p", { class: "sub" }, T("rev.invalid", { n: R.invalid })));
    return sec;
  }
  sec.append(
    h("p", { class: "sub", id: "rev-moments-sum" }, T("rev.moments.sum", { n: R.total, skipped: R.skipped.n, dropped: R.dropped.n, chipped: R.chipped.n })),
  );
  for (const g of ["skipped", "dropped", "chipped"]) {
    const grp = R[g];
    if (!grp.n) continue;
    const ul = h("ul", { class: "rev-reasons", "aria-labelledby": `rev-${g}-h` });
    for (const r of grp.reasons)
      ul.append(h("li", { "data-reason": r.reason }, h("span", { dir: "auto" }, reviewReason(r.reason)), h("span", { class: "faint rev-n" }, " " + r.n)));
    sec.append(
      h(
        "div",
        { class: "rev-group", "data-group": g },
        h("h3", { id: `rev-${g}-h` }, T("rev.g." + g), h("span", { class: "faint rev-n" }, " " + grp.n)),
        h("p", { class: "faint" }, T("rev.g." + g + ".what")),
        ul,
      ),
    );
  }
  if (R.invalid) sec.append(h("p", { class: "sub" }, T("rev.invalid", { n: R.invalid })));
  return sec;
}

function reviewCoaching(d) {
  const c = d.summary && d.summary.coaching ? d.summary.coaching : d.callSummary && d.callSummary.coaching;
  const sec = h("section", { class: "rev-block", id: "rev-coaching", "aria-labelledby": "rev-coaching-h" });
  sec.append(h("h2", { id: "rev-coaching-h" }, T("rev.coach.title")));
  const rows = WingmanReview.coachingRows(c || null);
  if (!rows.length) {
    sec.append(h("p", { class: "sub", id: "rev-coaching-none" }, T("rev.coach.none")));
    return sec;
  }
  const v = {
    talk: () => T("rev.coach.talk.v", { n: c.talkSharePct }),
    mono: () => `${Math.floor(c.longestMonologueSec / 60)}:${String(c.longestMonologueSec % 60).padStart(2, "0")}`,
    q: () => String(c.questionsAsked),
    pace: () =>
      [c.paceWpm.me != null ? T("rev.coach.pace.me", { n: c.paceWpm.me }) : "", c.paceWpm.them != null ? T("rev.coach.pace.them", { n: c.paceWpm.them }) : ""]
        .filter(Boolean)
        .join(", "),
    int: () => String(c.interruptions),
  };
  const dl = h("dl", { class: "rev-stats" });
  for (const r of rows) dl.append(h("dt", {}, T("rev.coach." + r.key)), h("dd", { "data-stat": r.key }, ltr(v[r.key](r))));
  sec.append(dl, h("p", { class: "faint" }, T("rev.coach.note")));
  return sec;
}

function reviewExport() {
  const sec = h("section", { class: "rev-block", id: "rev-export", "aria-labelledby": "rev-export-h" });
  sec.append(h("h2", { id: "rev-export-h" }, T("rev.export.title")));
  const note = h("p", { class: "sub", id: "rev-export-note", role: "status" });
  const go = async (fmt, b) => {
    b.disabled = true;
    note.textContent = T("rev.export.working");
    let r;
    try {
      r = await api.exportCall(state.id, fmt);
    } catch (x) {
      r = { ok: false, error: "failed" };
    }
    b.disabled = false;
    note.textContent =
      r && r.ok
        ? T("rev.export.saved", { name: r.path })
        : T("rev.export." + (r && ["unavailable", "cancelled", "preview"].includes(r.error) ? r.error : "failed"));
    announce(note.textContent);
  };
  const mk = (fmt) => {
    const b = btn(T("rev.export." + fmt), { id: "rev-export-" + fmt });
    b.addEventListener("click", () => go(fmt, b));
    return b;
  };
  sec.append(h("div", { class: "actions" }, mk("md"), mk("json")), note);
  return sec;
}

/** The Review part of the Details tab. */
function subReview(out, d) {
  out.append(h("div", { class: "review", id: "review" }, reviewMoments(d), reviewCoaching(d), reviewExport()));
}
