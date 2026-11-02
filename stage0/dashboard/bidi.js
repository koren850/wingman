"use strict";
// Pure bidi tokenizer shared by the renderer (classic script) and the unit test (require).
// An LTR island starts and ends with a letter/digit (a leading "+" before a digit is allowed for phone numbers),
// so Hebrew prefix letters + "-" (ו-webhooks, ל-CRM) and trailing punctuation stay outside the island.
(function (root) {
  const TOKEN = /(\+?[A-Za-z0-9](?:[A-Za-z0-9@+._:/#?&=%~-]|,(?=\d))*(?<=[A-Za-z0-9/]))/;
  /** Split text into [{ text, ltr }] segments; ltr segments are Latin/number/email/URL/phone tokens (3+ chars). */
  function splitBidi(text) {
    const parts = String(text).split(TOKEN);
    const out = [];
    parts.forEach((p, i) => {
      if (p === "") return;
      const ltr = i % 2 === 1 && p.length >= 3;
      const last = out[out.length - 1];
      if (last && last.ltr === ltr) last.text += p; else out.push({ text: p, ltr });
    });
    return out;
  }
  const api = { splitBidi };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.WingmanBidi = api;
})(typeof window !== "undefined" ? window : globalThis);
