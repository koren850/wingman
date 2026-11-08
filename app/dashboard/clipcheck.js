// Page script for WINGMAN_DASHBOARD_EVAL (dashboard/snapshot.sh): looks for clipped or overflowing content in the window.
// Returns { ok, problems[], lang, dir }. A problem is: the page scrolls sideways, or an element is wider than its parent without scrolling on purpose,
// or a one-line text is cut by overflow:hidden without an ellipsis. Elements that are hidden or inside a scrollable box are ignored.
(() => {
  const problems = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth + 1) problems.push(`page scrolls sideways (${doc.scrollWidth} > ${doc.clientWidth})`);
  const name = (el) =>
    (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "") ||
    el.tagName;
  const scrolls = (el) => /(auto|scroll)/.test(getComputedStyle(el).overflowX);
  for (const el of document.querySelectorAll("main *, header *")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || el.closest("[hidden]")) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const p = el.parentElement;
    if (p && !scrolls(p) && p !== document.body) {
      const pr = p.getBoundingClientRect();
      const pcs = getComputedStyle(p);
      if (
        pcs.display !== "none" &&
        (r.right > pr.right + 2 || r.left < pr.left - 2) &&
        cs.position !== "absolute" &&
        cs.position !== "fixed" &&
        !el.closest("svg, pre")
      )
        problems.push(
          `${name(el)} sticks out of ${name(p)} (${Math.round(r.left)}..${Math.round(r.right)} vs ${Math.round(pr.left)}..${Math.round(pr.right)})`,
        );
    }
    if (
      el.scrollWidth > el.clientWidth + 1 &&
      /(hidden|clip)/.test(cs.overflowX) &&
      cs.textOverflow !== "ellipsis" &&
      el.children.length === 0 &&
      el.textContent.trim()
    )
      problems.push(`${name(el)} cuts its text without an ellipsis`);
  }
  return { ok: problems.length === 0, problems: problems.slice(0, 40), lang: doc.lang, dir: doc.dir, buttons: document.querySelectorAll("button").length };
})();
