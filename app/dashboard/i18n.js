"use strict";
// Language support for the main window. One string catalog per language (strings.en.js, strings.he.js), same pattern as overlay/strings.js.
// Classic script in the page (window.WingmanI18n), require() in tests. The page calls T("key", { name: "x" }); {name} placeholders are filled from vars.
// A missing key in the chosen language falls back to English, then to the key itself (so a gap shows as English, never as a blank).
// The choice is "auto" (the system language: Hebrew if it starts with "he", else English), "en" or "he". It is kept in the page's own storage.
(function (root) {
  const catalogs = () => {
    if (typeof module !== "undefined" && module.exports) return { en: require("./strings.en.js"), he: require("./strings.he.js") };
    return root.WingmanCatalogs || {};
  };
  const LANGS = ["en", "he"];
  const CHOICES = ["auto", "en", "he"];
  const normLang = (l) => (l === "he" ? "he" : "en");
  const dirOf = (lang) => (normLang(lang) === "he" ? "rtl" : "ltr");
  /** The language for a saved choice and a system locale ("he-IL", "en-US", ...). */
  function resolve(choice, locale) {
    if (choice === "he" || choice === "en") return choice;
    return /^he\b/i.test(String(locale || "")) || /^iw\b/i.test(String(locale || "")) ? "he" : "en";
  }
  /** Fills {name} placeholders. A placeholder with no value stays as written. */
  const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);
  /** The text for a key in a language; English if the key is missing there; the key itself if it is nowhere. */
  function t(lang, key, vars) {
    const c = catalogs();
    const l = normLang(lang);
    const s = (c[l] && c[l][key]) ?? (c.en && c.en[key]);
    return s === undefined ? key : fill(s, vars);
  }
  /** "1 file" / "3 files": picks the key `${base}.one` or `${base}.other` (Hebrew uses the same two forms here). */
  const plural = (lang, base, n, vars) => t(lang, n === 1 ? base + ".one" : base + ".other", { n, ...(vars || {}) });

  let current = "en";
  const api = {
    LANGS,
    CHOICES,
    normLang,
    dirOf,
    resolve,
    t,
    plural,
    catalogs,
    get lang() {
      return current;
    },
    setLang(l) {
      current = normLang(l);
      return current;
    },
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WingmanI18n = api;
})(typeof window !== "undefined" ? window : globalThis);
