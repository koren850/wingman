"use strict";
// Call mode picker, data side (pure functions, no DOM). The mode is the kind of call: client, support, vendor, team, consult, personal, interview, other, or a custom mode of the user.
//   pickerState(view, custom)   what the picker shows: { value: "auto" | id, shown: id, locked, guess }
//   options(custom)             [{ id, builtin }] in the order of the list: auto, the eight kinds, then the custom modes (at most 6)
//   cleanModes(raw)             custom modes from the main process: [{ id, label }], plain text, at most 6
//   labelOf(id, T, custom)      words for a mode id in the window language (a custom mode keeps its own label)
// `view` is a MemoryView or a knows model: { kind, kindLocked }. Auto = the model's guess (kindLocked false). Locked = the user chose it (or a prepared meeting did).
(function (root) {
  const KINDS = ["client", "support", "vendor", "team", "consult", "personal", "interview", "other"];
  const ID = /^[A-Za-z0-9_-]{1,20}$/;
  const clip = (s, n) =>
    String(s == null ? "" : s)
      .replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, n);

  function cleanModes(raw) {
    const out = [];
    for (const m of Array.isArray(raw) ? raw : []) {
      const id = m && typeof m.id === "string" && ID.test(m.id) && !KINDS.includes(m.id) && m.id !== "auto" ? m.id : "";
      if (!id || out.some((x) => x.id === id)) continue;
      out.push({ id, label: clip(m.label, 40) || id });
      if (out.length >= 6) break;
    }
    return out;
  }
  const isKnown = (id, custom) => KINDS.includes(id) || cleanModes(custom).some((m) => m.id === id);

  function pickerState(view, custom) {
    const v = view && typeof view === "object" ? view : {};
    const k = typeof v.kind === "string" && isKnown(v.kind, custom) ? v.kind : "";
    const locked = !!k && v.kindLocked === true;
    return { shown: k, locked, guess: !!k && !locked, value: locked ? k : "auto" };
  }

  function options(custom) {
    return [{ id: "auto", builtin: true }, ...KINDS.map((id) => ({ id, builtin: true })), ...cleanModes(custom).map((m) => ({ id: m.id, builtin: false }))];
  }

  function labelOf(id, T, custom) {
    if (id === "auto") return T("mode.auto");
    if (KINDS.includes(id)) return T("kind." + id);
    const c = cleanModes(custom).find((m) => m.id === id);
    return c ? c.label : clip(id, 20);
  }

  const api = { KINDS, pickerState, options, cleanModes, labelOf, isKnown };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WingmanMode = api;
})(typeof window !== "undefined" ? window : globalThis);
