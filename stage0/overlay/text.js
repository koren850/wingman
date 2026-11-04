"use strict";
// Pure text helpers for the answer window page (classic script in the page, require() in tests).
// RTL/bidi: Hebrew text with Latin or number "islands" (brand names, dates) is split into segments so the page can isolate each island and keep its order.
(function (root) {
  const bidi = typeof module !== "undefined" && module.exports ? require("../dashboard/bidi.js") : root.WingmanBidi;
  const SHORT = /^[A-Za-z0-9]{1,2}$/;

  /** Shared bidi tokenizer plus the overlay rule: a short number or word next to an island ("8 Nov", "Node 18", "Facebook Ads") joins it, so word order never flips. */
  function segments(text) {
    const out = [];
    for (const seg of bidi.splitBidi(text)) out.push({ ...seg });
    // pull a short Latin/number token (e.g. "8 ") from the neutral text into the island next to it
    for (let i = 0; i < out.length; i++) {
      const s = out[i];
      if (s.ltr) continue;
      const before = out[i - 1], after = out[i + 1];
      if (after && after.ltr) { const m = /(?:^|[\s(])([A-Za-z0-9]{1,2}) $/.exec(s.text); if (m) { const cut = s.text.length - m[1].length - 1; after.text = m[1] + " " + after.text; s.text = s.text.slice(0, cut); } }
      if (before && before.ltr) { const m = /^ ([A-Za-z0-9]{1,2})(?=$|[\s).,:;!?])/.exec(s.text); if (m) { before.text += " " + m[1]; s.text = s.text.slice(m[0].length); } }
    }
    // two islands separated by a single space are one island
    const merged = [];
    for (let i = 0; i < out.length; i++) {
      const s = out[i];
      if (s.text === "") continue;
      const last = merged[merged.length - 1];
      if (last && last.ltr && s.ltr) { last.text += s.text; continue; }
      if (s.ltr === false && s.text === " " && last && last.ltr && out[i + 1] && out[i + 1].ltr) { last.text += " " + out[i + 1].text; i++; continue; }
      merged.push(s);
    }
    return merged;
  }

  /** True for a line with Latin letters and no Hebrew: it is shown left to right as a whole (an English interview card). */
  function isLatin(text) { const t = String(text ?? ""); return /[A-Za-z]/.test(t) && !/[\u0590-\u05FF]/.test(t); }

  const WHO = { "stt-me": "המיקרופון שלך", "stt-them": "הצד השני" };
  /** Fault / advisory text for the window: Hebrew only, with a next step when the engine text has none. */
  function healthText(id, text, askKey) {
    const raw = String(text ?? "");
    if (id === "health-only-you") return "שומע רק אותך. לתשובות לצד השני, הצטרף לשיחה או הפעל את השמע שלה." + (askKey ? ` לשאול אותי: ${askKey}` : "");
    const key = String(id).replace(/^health-/, "");
    const m = /^[A-Z][A-Za-z0-9 ()_.,\/]*?\s[–-]\s(.+)$/.exec(raw);   // "NOT HEARING THE OTHER SIDE – ...", "STT (them) – ...": drop the English tag
    let t = m ? m[1] : raw;
    if (WHO[key] && m) t = `${WHO[key]}: ${t}`;
    if (/^stt-(me|them)$/.test(key) && !/בדוק|מנסה/.test(t)) t += ". בדוק את חיבור האינטרנט";
    else if (/^stt-(me|them)$/.test(key) && /מנסה/.test(t) && !/בדוק/.test(t)) t += ". אם זה נמשך, בדוק אינטרנט";
    return t;
  }

  const api = { segments, healthText, isLatin };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.WingmanText = api;
})(typeof window !== "undefined" ? window : globalThis);
