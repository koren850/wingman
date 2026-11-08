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
  /**
   * The tabs of the Settings page, in order. `keys` are the catalog entries each tab shows ("@mic" is the microphone row); the page adds its own blocks
   * (window language, About you and the setup guide in Basics; the keys form in Keys; the privacy note in Privacy; the fold with every other setting in Advanced).
   * The engine switch (Classic or New) is not in any tab but Advanced: isAdvanced() keeps it out of the lists below.
   */
  const TABS = [
    { id: "basics", keys: ["stt.language", "@mic", "overlay.display", "ui.language"] },
    { id: "keys", keys: [] },
    { id: "engine", keys: ["run.noAi", "cards.quiet", "summary.enabled", "budget.maxUsdPerCall"] },
    { id: "privacy", keys: ["privacy.requireConsentAck"] },
    { id: "advanced", keys: [] },
  ];
  const TAB_IDS = TABS.map((t) => t.id);
  /** The tab that shows a catalog entry (by key). Entries no tab lists, and every advanced entry, belong to Advanced. */
  function tabOf(key, item) {
    if (isAdvanced(item || { key })) return "advanced";
    const t = TABS.find((x) => x.keys.includes(key));
    if (t) return t.id;
    return /^privacy\./.test(key) ? "privacy" : "advanced";
  }
  /** The entry keys a tab shows normally, with advanced entries taken out. items = the catalog rows. */
  const tabKeys = (id, items) => {
    const t = TABS.find((x) => x.id === id);
    return t ? t.keys.filter((k) => k.startsWith("@") || !isAdvanced((items || []).find((x) => x.key === k) || { key: k })) : [];
  };
  /** Which tab a focus name from outside opens: "advanced", "keys", "mic" or "tab-<id>". Unknown: Basics. */
  const tabFromFocus = (f) => {
    const x = String(f || "").replace(/^tab-/, "");
    if (x === "mic") return "basics";
    return TAB_IDS.includes(x) ? x : "basics";
  };
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
  const api = { MAIN_ORDER, ALWAYS_ADVANCED, TABS, TAB_IDS, tabOf, tabKeys, tabFromFocus, isAdvanced, normalKeys, search, fold };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WingmanSettings = api;
})(typeof window !== "undefined" ? window : globalThis);
