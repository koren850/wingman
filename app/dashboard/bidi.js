"use strict";
// Pure bidi tokenizer shared by the main window, the answer window (classic scripts) and the unit tests (require).
// An LTR island starts and ends with a letter/digit (a leading "+" before a digit is allowed for phone numbers),
// so Hebrew prefix letters + "-" (ו-webhooks, ל-CRM) and trailing punctuation stay outside the island.
(function (root) {
  // split() with one capture group puts the matched tokens at odd indexes (used below). The lookbehind enforces the "ends with letter/digit/slash" rule.
  const TOKEN = /(\+?[A-Za-z0-9](?:[A-Za-z0-9@+._:/#?&=%~-]|,(?=\d))*(?<=[A-Za-z0-9/]))/;
  /**
   * Split text into [{ text, ltr }] segments; ltr segments are Latin/number/email/URL/phone tokens (3+ chars).
   * A short number or word next to an island ("8 Nov", "Node 18", "PHP 8.2", "Google Cloud Platform") joins it, so the word order never flips in a Hebrew line.
   */
  function splitBidi(text) {
    const parts = String(text).split(TOKEN);
    const out = [];
    parts.forEach((p, i) => {
      if (p === "") return;
      const ltr = i % 2 === 1 && p.length >= 3;
      const last = out[out.length - 1];
      if (last && last.ltr === ltr) last.text += p;
      else out.push({ text: p, ltr });
    });
    // pull a short Latin/number token (e.g. "8 ") from the neutral text into the island next to it
    for (let i = 0; i < out.length; i++) {
      const s = out[i];
      if (s.ltr) continue;
      const before = out[i - 1],
        after = out[i + 1];
      if (after && after.ltr) {
        const m = /(?:^|[\s(])([A-Za-z0-9]{1,2}) $/.exec(s.text);
        if (m) {
          const cut = s.text.length - m[1].length - 1;
          after.text = m[1] + " " + after.text;
          s.text = s.text.slice(0, cut);
        }
      }
      if (before && before.ltr) {
        const m = /^ ([A-Za-z0-9]{1,2})(?=$|[\s).,:;!?])/.exec(s.text);
        if (m) {
          before.text += " " + m[1];
          s.text = s.text.slice(m[0].length);
        }
      }
    }
    // two islands separated by a single space are one island
    const merged = [];
    for (let i = 0; i < out.length; i++) {
      const s = out[i];
      if (s.text === "") continue;
      const last = merged[merged.length - 1];
      if (last && last.ltr && s.ltr) {
        last.text += s.text;
        continue;
      }
      if (s.ltr === false && s.text === " " && last && last.ltr && out[i + 1] && out[i + 1].ltr) {
        last.text += " " + out[i + 1].text;
        i++;
        continue;
      }
      merged.push(s);
    }
    return merged;
  }
  const api = { splitBidi };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WingmanBidi = api;
})(typeof window !== "undefined" ? window : globalThis);
