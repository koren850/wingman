"use strict";
// After the call: what is still open, and a follow-up draft, both from the notes Wingman kept during the call (the call memory).
// d.memory comes from the main process (dashboard/memlib.cjs afterCall): { ver, loops: { questions, promises, theirs, cover }, decisions, empty } or null.
// The draft is plain text built from those lines (shared/memview.js draftText). It is not written by AI and never sent anywhere. All text goes in with textContent.
// Classic script, loaded after knows.js (uses h, T, chip, copyBtn, dirOf, langOf, WingmanMemView).

/** The words of the follow-up note, in the window's language. */
const afterDraftLabels = () => ({
  hello: T("after.draft.hello"),
  decided: T("after.draft.decided"),
  weOwe: T("after.draft.weOwe"),
  youOwe: T("after.draft.youOwe"),
  open: T("after.draft.open"),
  bye: T("after.draft.bye"),
});

/** The section for the Follow-up tab. Returns null when the call has no notes (an older call, or notes were off). */
function afterMemory(d) {
  const m = d && d.memory;
  if (!m || !m.loops) return null;
  const L = m.loops;
  const sec = h("section", { class: "after-loops", id: "after-loops", "aria-labelledby": "after-loops-h" });
  sec.append(h("h2", { id: "after-loops-h" }, T("after.loops.title")), h("p", { class: "sub" }, T("after.loops.sub")));
  const groups = [
    ["promises", L.promises, "me"],
    ["theirs", L.theirs, "info"],
    ["questions", L.questions, "warn"],
    ["cover", L.cover, ""],
  ];
  let any = false;
  for (const [key, list, tone] of groups) {
    if (!list || !list.length) continue;
    any = true;
    const hid = "after-loops-" + key;
    sec.append(
      h("h3", { id: hid, class: "al-h" }, chip(T("after.loops." + key), tone), h("span", { class: "faint kn-n" }, ` ${list.length}`)),
      h(
        "ul",
        { class: "bul al-list", "aria-labelledby": hid },
        list.map((x) =>
          h(
            "li",
            { dir: "auto", lang: langOf(x.text) },
            x.who && key !== "questions" && key !== "cover" ? h("b", {}, x.who + ": ") : null,
            x.text,
            x.due ? h("span", { class: "faint" }, " (" + x.due + ")") : null,
          ),
        ),
      ),
    );
  }
  if (!any) sec.append(h("p", { class: "muted", id: "after-loops-none" }, T("after.loops.none")));
  const draft = WingmanMemView.draftText({ decisions: m.decisions || [], loops: L }, afterDraftLabels());
  const box = h("div", { class: "emailbox after-draft", "aria-labelledby": "after-draft-h" });
  box.append(h("div", { class: "eh" }, h("h3", { id: "after-draft-h" }, T("after.draft.title"))));
  if (draft.empty) box.append(h("p", { class: "muted" }, T("after.draft.empty")));
  else
    box.append(
      h("pre", { class: "email after-draft-text", id: "after-draft-text", dir: "auto", lang: langOf(draft.text) }, draft.text),
      h("div", { class: "foot" }, T("after.draft.note")),
      copyBtn(T("after.draft.copy"), () => draft.text, { cls: "primary", what: T("tab.followup") }),
    );
  sec.append(box);
  return sec;
}
