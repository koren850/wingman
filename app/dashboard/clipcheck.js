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
  // Contrast: the text of every visible leaf element against the colour behind it (WCAG: 4.5, or 3 for large text). Disabled controls are exempt.
  const rgba = (c) => {
    const m = String(c).match(/-?[\d.]+%?/g);
    if (!m) return null;
    const n = (v, i) => (/%$/.test(v) ? parseFloat(v) * 2.55 : parseFloat(v) * (/^color\(/.test(c) ? 255 : 1));
    if (m.length < 3) return null;
    return { r: n(m[0]), g: n(m[1]), b: n(m[2]), a: m.length > 3 ? (/%$/.test(m[3]) ? parseFloat(m[3]) / 100 : parseFloat(m[3])) : 1 };
  };
  const over = (top, under) => ({
    r: top.r * top.a + under.r * (1 - top.a),
    g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a),
    a: 1,
  });
  const bgBehind = (el) => {
    const stack = [];
    for (let e = el; e; e = e.parentElement) {
      const c = rgba(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0) stack.push(c);
      if (c && c.a >= 1) break;
    }
    let acc = { r: 255, g: 255, b: 255, a: 1 };
    const page = rgba(getComputedStyle(document.body).backgroundColor);
    if (page && page.a > 0) acc = over(page, acc);
    for (const c of stack.reverse()) acc = over(c, acc);
    return acc;
  };
  const lum = (c) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const lowContrast = [];
  for (const el of document.querySelectorAll("main *, header *, .sheet *")) {
    if (el.children.length && ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || el.closest("[hidden], .sr, :disabled, [disabled]")) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const fg = rgba(cs.color);
    if (!fg) continue;
    const bg = bgBehind(el);
    let op = 1;
    for (let e = el; e && e !== document.body; e = e.parentElement) op *= parseFloat(getComputedStyle(e).opacity);
    const c = ratio(over({ ...fg, a: fg.a * op }, bg), bg);
    const size = parseFloat(cs.fontSize),
      bold = parseInt(cs.fontWeight, 10) >= 700;
    const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
    if (c < need) lowContrast.push(`${name(el)} ${c.toFixed(2)} < ${need} "${el.textContent.trim().slice(0, 24)}"`);
  }
  const visible = (sel) => [...document.querySelectorAll(sel)].some((b) => b.offsetParent !== null);
  const shown = (id) => {
    const e = document.getElementById(id);
    return !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden"; // a fixed sheet has no offsetParent
  };
  const textOfMain = (document.querySelector("main") || document.body).innerText || "";
  // A catalog key on screen instead of its text means T() did not find it.
  const prefixes = new Set(Object.keys((window.WingmanCatalogs && window.WingmanCatalogs.en) || {}).map((k) => k.split(".")[0]));
  const rawKeys = [...document.querySelectorAll("main *, header *, .sheet *")]
    .filter(
      (e) =>
        e.children.length === 0 &&
        e.offsetParent !== null &&
        /^[a-z][a-zA-Z0-9]*(\.[A-Za-z0-9_-]+)+$/.test(e.textContent.trim()) &&
        prefixes.has(e.textContent.trim().split(".")[0]),
    )
    .map((e) => e.textContent.trim())
    .slice(0, 10);
  const envNames = (textOfMain.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|keys\.env/g) || []).length;
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
    // What the plain-words, Start, live, ended, settings and review rules look at
    lowContrast: lowContrast.slice(0, 20),
    envNames,
    rawKeys,
    pendingPill: !!document.getElementById("pending-slot") || [...document.querySelectorAll("header .chip")].some((c) => /to rate|לדירוג/.test(c.textContent)),
    liveDelete:
      shown("stop-del") ||
      [...document.querySelectorAll("#livecard button, #livecard .linkbtn")].some((b) => /delete this call|מחק את השיחה/i.test(b.textContent)),
    startDisabled: !!document.getElementById("start-call") && document.getElementById("start-call").disabled,
    startWhy: shown("start-why"),
    practiceBesideStart: !!document.querySelector(".startrow #start-call") && !!document.querySelector(".startrow #practice"),
    fixIt: visible("#start-why .fixit, #start-why #gate-check"),
    // The first-run window (setupwizard.js)
    wizard: shown("wizard"),
    wizInputs: document.querySelectorAll("#wizard input[type=password]").length,
    wizCheck: shown("wiz-check"),
    wizSteps: document.querySelectorAll("#wizard .wiz-steps li").length,
    openSummary: shown("open-summary"),
    settingsTabs: [...document.querySelectorAll("#set-body [role=tab]")].filter((b) => b.offsetParent !== null).length,
    classicNew: [...document.querySelectorAll("#set-body .setrow, #set-body .setlist > *")].some(
      (r) => r.offsetParent !== null && !r.closest("#adv") && /moments\.engine|Classic|New engine|המנוע הקלאסי/.test(r.textContent),
    ),
    reviewStep: shown("prestart-sheet"),
    reviewRows: document.querySelectorAll("#prestart-sheet .ps-item").length,
    reviewKind: shown("ps-kind"),
    reviewSources: document.querySelectorAll("#prestart-sheet .kn-src").length,
    reviewWarn: shown("ps-warn"),
    reviewSkip: shown("ps-skip"),
    // Mode picker, card trust, held back, learning, earlier calls
    modeRows: document.querySelectorAll("#main .pm .mode-sel").length,
    modeCustom: [...document.querySelectorAll("#main .mode-sel option")].some((o) => o.value === "standup"),
    modeLive: shown("mode-live"),
    modeLiveNote: (document.getElementById("mode-live-note") || {}).textContent || "",
    trustBtns: document.querySelectorAll("#cardlist .trust-btns").length,
    trustSaw: shown("saw-" + ((document.querySelector("#cardlist .card") || {}).dataset || {}).id),
    heldList: shown("rev-held"),
    heldItems: document.querySelectorAll("#held-list .held-item").length,
    heldRate: document.querySelectorAll("#held-list .held-rate button").length,
    learnReset: shown("learn-reset"),
    pastCard: shown("past-card"),
    pastPeople: document.querySelectorAll("#past-list .past-person").length,
    kindChip: shown("sofar") && !!document.querySelector("#sofar .chip.info"),
    problems: problems.slice(0, 40),
    lang: doc.lang,
    dir: doc.dir,
    buttons: document.querySelectorAll("button").length,
  };
})();
