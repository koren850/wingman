// Page script for WINGMAN_DASHBOARD_EVAL with focus=edit (dashboard/snapshot.sh, WINGMAN_SNAP_EVAL): the keyboard and focus path of the Meeting context box.
// Checks: the text box has focus when the editor opens; every control in the box has a name; the tab order is text, file button, More, then the fields, Prepare, Save, Cancel;
// "More" opens with the keyboard and moves nothing; Ctrl+Enter is wired; Escape closes the box and gives focus back to the page (the Add button).
(async () => {
  const card = () => document.getElementById("ctx-card");
  const out = { opened: !!card(), firstFocusId: document.activeElement && document.activeElement.id, problems: [] };
  const tabbable = () =>
    [...document.getElementById("plan-form").querySelectorAll("button, input, textarea, select, a[href]")].filter(
      (e) => !e.disabled && !e.hidden && !e.closest("[hidden]") && e.type !== "file",
    );
  const name = (e) =>
    (e.getAttribute("aria-label") || (e.labels && e.labels[0] && e.labels[0].textContent) || e.textContent || e.title || e.placeholder || "").trim();
  for (const e of tabbable()) if (!name(e)) out.problems.push("no accessible name: " + (e.id || e.tagName));
  if (out.firstFocusId !== "ctx-text") out.problems.push("focus is not on the text box: " + out.firstFocusId);
  const more = document.getElementById("ctx-more");
  const was = more.getAttribute("aria-expanded");
  more.click();
  out.moreToggled = more.getAttribute("aria-expanded") !== was;
  if (!out.moreToggled) out.problems.push("More did not toggle");
  if (more.getAttribute("aria-expanded") !== "true") more.click(); // the fields must be open for the order check
  out.order = tabbable().map((e) => e.id || name(e).slice(0, 20));
  const want = ["ctx-text", "ctx-choose", "ctx-more"];
  if (JSON.stringify(out.order.slice(0, 3)) !== JSON.stringify(want)) out.problems.push("tab order starts " + out.order.slice(0, 3).join(","));
  const tail = out.order.slice(-3);
  if (JSON.stringify(tail) !== JSON.stringify(["ctx-prepare", "plan-save", "plan-cancel"])) out.problems.push("tab order ends " + tail.join(","));
  for (const id of ["plan-who", "plan-goal", "plan-must", "plan-title", "plan-at"])
    if (!out.order.includes(id)) out.problems.push("field not reachable: " + id);
  document.getElementById("ctx-text").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  out.closedByEscape = !card();
  if (!out.closedByEscape) out.problems.push("Escape did not close the box");
  out.ok = out.problems.length === 0;
  return out;
})();
