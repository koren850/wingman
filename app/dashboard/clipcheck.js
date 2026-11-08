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
    if (el.closest(".sr")) continue; // visually hidden on purpose (screen reader text): its box is clipped by design
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
  // One-line controls must stay on one line: the tab pills of the live composer, the segmented tabs of a call, each key hint, every chip.
  const linesOf = (el) => {
    // Lines of text: the distinct vertical positions of the text nodes' boxes (a fixed-height pill does not count as two lines)
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3;
    const tops = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!n.textContent.trim()) continue;
      const r = document.createRange();
      r.selectNodeContents(n);
      for (const q of r.getClientRects()) if (q.width > 0) tops.push(q.top);
    }
    tops.sort((x, y) => x - y);
    let count = 0,
      last = -1e9;
    for (const t of tops)
      if (t - last > lh * 0.6) {
        count++;
        last = t;
      }
    return Math.max(1, count);
  };
  for (const el of document.querySelectorAll(".seg button, .tabs [role=tab], .keyhint .kh, .chip, .navbtn")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || el.closest("[hidden]") || el.closest(".sr")) continue;
    const box = el.getBoundingClientRect();
    if (!box.width) continue;
    // a text line is at most ~1.8 line-heights tall; two lines of text inside a pill means it wrapped
    if (el.matches(".kh") ? linesOf(el) > 1 : linesOf(el) > 1) problems.push(`${name(el)} wraps to ${linesOf(el)} lines`);
    else if (el.scrollWidth > el.clientWidth + 1 && !/(visible)/.test(cs.overflowX)) problems.push(`${name(el)} overflows its pill`);
  }
  const primaries = [...document.querySelectorAll("main .btn.primary")].filter((b) => b.offsetParent !== null).length;
  const sample = [...document.querySelectorAll("main .chip")].filter((c) => c.offsetParent !== null && c.textContent.trim() === "Sample").length;
  const pills = [...document.querySelectorAll(".seg button, .tabs [role=tab]")].filter((b) => b.offsetParent !== null).length;
  const rowTexts = [...document.querySelectorAll(".waitlist li")].map((li) => li.textContent.replace(/\s+/g, " ").trim());
  const dupWait = rowTexts.length - new Set(rowTexts).size;
  return {
    ok: problems.length === 0,
    primaries,
    sample,
    pills,
    waitRows: rowTexts.length,
    dupWait,
    sheet: !!document.getElementById("keys-sheet"),
    // the one-box context editor: the "Wingman understood" line, the web page and calendar controls, and the Review part of a call
    understood: !!document.getElementById("ctx-understood") && document.getElementById("ctx-understood").offsetParent !== null,
    sources: !!document.getElementById("ctx-url") && !!document.getElementById("ctx-cal-use"),
    review: !!document.getElementById("rev-moments") && !!document.getElementById("rev-coaching") && !!document.getElementById("rev-export"),
    reviewCounts: (document.getElementById("rev-moments-sum") || {}).textContent || "",
    problems: problems.slice(0, 40),
    lang: doc.lang,
    dir: doc.dir,
    buttons: document.querySelectorAll("button").length,
  };
})();
