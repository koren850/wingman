"use strict";
// Layout and contrast checks for the answer window (snapshot tool and tests). Not loaded by the real page.
// Browser: the snapshot tool injects this file and calls WingmanQa.run(). Node: require() gives contrastRatio and friends for unit tests.
// run() returns { issues: [{ type, sel, detail }], metrics }. Issue types:
//   wider      an element sticks out of its parent or out of the window
//   clipped    a box hides part of its text without an ellipsis or a line clamp
//   contrast   text is below 4.5:1 against what is behind it
//   min-font   visible text below 12px
//   dir        text in a v2 zone has no dir attribute of its own (dir=auto, ltr or rtl)
//   rows       more than two rows of chips (the rail row and the pills row)
//   midword    a chip label, the headline or the Because line is cut (a label never is; the other two may not lose text)
//   covers     the Catch me up sheet covers the live caption
(function (root) {
  /** "rgb(1, 2, 3)" | "rgba(1, 2, 3, 0.5)" -> [r, g, b, a] or null. */
  function parseColor(s) {
    const m = /^rgba?\(([^)]+)\)$/.exec(String(s || "").trim());
    if (!m) return null;
    const p = m[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    if (p.length < 3 || p.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
    return [p[0], p[1], p[2], p.length > 3 && Number.isFinite(p[3]) ? p[3] : 1];
  }
  /** Source-over: fg [r,g,b,a] on an opaque bg [r,g,b]. */
  const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
  const lin = (c) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  /** WCAG contrast ratio of two opaque colours [r,g,b]. */
  function contrastRatio(a, b) {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }
  const ZONES = ["hero", "watch", "recap", "idle", "note"];

  function run(win) {
    const w = win || window;
    const doc = w.document;
    const issues = [];
    const add = (type, el, detail) => issues.push({ type, sel: describe(el), detail });
    const cs = (el) => w.getComputedStyle(el);
    function describe(el) {
      const id = el.id ? "#" + el.id : "";
      const cls = typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).join(".") : "";
      return (el.tagName || "").toLowerCase() + id + cls;
    }
    function visible(el) {
      if (el.closest(".sr")) return false;
      for (let e = el; e && e !== doc.documentElement; e = e.parentElement) {
        const s = cs(e);
        if (s.display === "none" || s.visibility === "hidden") return false;
      }
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    function opacityOf(el) {
      let o = 1;
      for (let e = el; e && e !== doc.documentElement; e = e.parentElement) o *= Number(cs(e).opacity);
      return o;
    }
    function backdrop(el) {
      const stack = [];
      for (let e = el; e; e = e.parentElement) {
        const c = parseColor(cs(e).backgroundColor);
        if (c && c[3] > 0) stack.push(c);
        if (c && c[3] >= 1) break;
      }
      let bg = [255, 255, 255];
      const base = parseColor(cs(doc.body).backgroundColor);
      if (base && base[3] >= 1) bg = base.slice(0, 3);
      for (let i = stack.length - 1; i >= 0; i--) bg = over(stack[i], bg);
      return bg;
    }
    const hasOwnText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
    const all = [...doc.querySelectorAll("#wrap *")].filter((el) => !["SCRIPT", "STYLE", "BR"].includes(el.tagName) && !el.closest("svg") && visible(el));
    const vw = w.innerWidth,
      vh = w.innerHeight;
    const metrics = { elements: all.length, textElements: 0, minFont: 99, minContrast: 99, heroPct: 0, ellipsized: 0 };
    for (const el of all) {
      const s = cs(el);
      const r = el.getBoundingClientRect();
      const p = el.parentElement;
      // wider than the parent or the window
      if (s.position !== "absolute" && s.position !== "fixed") {
        if (r.right > vw + 1 || r.left < -1) add("wider", el, `x ${Math.round(r.left)}..${Math.round(r.right)} in a ${vw}px window`);
        else if (p && p.id !== "wrap" && cs(p).overflowX === "visible") {
          const pr = p.getBoundingClientRect();
          if (pr.width > 0 && (r.right > pr.right + 1 || r.left < pr.left - 1))
            add("wider", el, `child ${Math.round(r.width)}px in a ${Math.round(pr.width)}px parent`);
        }
      }
      // clipped text (an ellipsis or a line clamp is a deliberate cut and is counted, not reported)
      const clamp = s.webkitLineClamp && s.webkitLineClamp !== "none";
      const clipsX = s.overflowX !== "visible" && el.scrollWidth > el.clientWidth + 1;
      const clipsY = s.overflowY !== "visible" && el.scrollHeight > el.clientHeight + 1;
      if (hasOwnText(el) || el.children.length) {
        if (clipsX && s.overflowX !== "auto" && s.overflowX !== "scroll") {
          if (s.textOverflow === "ellipsis") metrics.ellipsized++;
          else add("clipped", el, `content ${el.scrollWidth}px in a ${el.clientWidth}px box`);
        }
        if (clipsY && s.overflowY !== "auto" && s.overflowY !== "scroll") {
          if (clamp) metrics.ellipsized++;
          else if (!["stage", "main", "cards", "wrap", "keys"].includes(el.id) || el.id === "keys")
            add("clipped", el, `content ${el.scrollHeight}px in a ${el.clientHeight}px box`);
        }
      }
      if (hasOwnText(el)) {
        metrics.textElements++;
        const fs = parseFloat(s.fontSize);
        metrics.minFont = Math.min(metrics.minFont, fs);
        if (fs < 12 - 0.01) add("min-font", el, `${fs}px`);
        const fg = parseColor(s.color);
        if (fg) {
          const bg = backdrop(el);
          const o = opacityOf(el);
          const eff = over([fg[0], fg[1], fg[2], fg[3] * o], bg);
          const ratio = contrastRatio(eff, bg);
          metrics.minContrast = Math.min(metrics.minContrast, ratio);
          if (ratio < 4.5) add("contrast", el, `${ratio.toFixed(2)}:1 (${s.color} on rgb(${bg.map(Math.round).join(",")}))`);
        }
        const zone = ZONES.find((z) => el.closest("#" + z));
        if (zone) {
          const d = el.closest("[dir]");
          if (!d || d === doc.documentElement) add("dir", el, "no dir on the text or its box");
        }
      }
    }
    // chips: at most two rows (rail + pills); a label or the headline is never cut inside a word
    const chips = [...doc.querySelectorAll("#chips .chip")].filter(visible);
    const tops = [];
    for (const c of chips) {
      const t = c.getBoundingClientRect().top;
      if (!tops.some((x) => Math.abs(x - t) < 6)) tops.push(t);
    }
    metrics.chipRows = tops.length;
    if (tops.length > 2) add("rows", chips[0], `${tops.length} rows of chips`);
    for (const el of doc.querySelectorAll("#chips .ct, #hero .hsay, #hero .hwhy")) {
      if (!visible(el)) continue;
      const cut = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
      // a clamped headline is deliberate only when the card offers More (the whole line is one press away)
      if (cut && el.classList.contains("hsay") && el.closest(".hcard") && el.closest(".hcard").querySelector(".b.more")) continue;
      if (cut) add("midword", el, `text is cut: ${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight}`);
    }
    const recap = doc.getElementById("recap"),
      cap = doc.getElementById("last");
    if (recap && cap && visible(recap) && visible(cap) && recap.getBoundingClientRect().top < cap.getBoundingClientRect().bottom - 1)
      add("covers", recap, "the sheet covers the live caption");
    const hero = doc.querySelector("#hero .hcard");
    if (hero) metrics.heroPct = Math.round((hero.getBoundingClientRect().height / vh) * 1000) / 10;
    return { issues, metrics };
  }

  const api = { parseColor, contrastRatio, run };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WingmanQa = api;
})(typeof window !== "undefined" ? window : globalThis);
