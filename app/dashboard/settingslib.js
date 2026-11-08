"use strict";
// Pure helpers for the Settings page (renderer classic script, require() in tests): which entries are advanced, and the search box.
// An entry is advanced when the catalog marks it `advanced: true` (set by the moments work), or when it is one of the keys listed below
// (the engine switch must never sit on the normal page, even before the catalog flag exists).
(function (root) {
  const MAIN_ORDER = [
    "stt.language",
    "privacy.requireConsentAck",
    "cards.quiet",
    "run.noAi",
    "summary.enabled",
    "budget.maxUsdPerCall",
    "@mic",
    "overlay.display",
    "ui.language",
  ];
  const ALWAYS_ADVANCED = ["moments.engine"];
  /** True when the entry belongs only under Advanced. */
  const isAdvanced = (i) => !!i && (i.advanced === true || ALWAYS_ADVANCED.includes(i.key));
  /** The keys of `order` (the normal page) that are allowed there: advanced entries and the "@mic" pseudo row handling stay with the caller. */
  const normalKeys = (items, order) => order.filter((k) => k.startsWith("@") || !isAdvanced((items || []).find((x) => x.key === k)));
  const fold = (s) =>
    String(s == null ? "" : s)
      .toLowerCase()
      .replace(/[֑-ׇ]/g, "") // Hebrew points
      .replace(/\s+/g, " ")
      .trim();
  /**
   * Entries that match a search text, in the catalog order. Every word of the query must appear in the label, the help text or the key
   * (labelOf(item) and helpOf(item) give the text in the window language). An empty query matches nothing.
   */
  function search(items, query, labelOf, helpOf) {
    const words = fold(query).split(" ").filter(Boolean);
    if (!words.length) return [];
    return (items || []).filter((i) => {
      const hay = fold([labelOf ? labelOf(i) : i.label, helpOf ? helpOf(i) : i.help, i.label, i.key].join(" "));
      return words.every((w) => hay.includes(w));
    });
  }
  const api = { MAIN_ORDER, ALWAYS_ADVANCED, isAdvanced, normalKeys, search, fold };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WingmanSettings = api;
})(typeof window !== "undefined" ? window : globalThis);
