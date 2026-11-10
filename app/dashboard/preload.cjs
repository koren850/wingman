// Preload for the main window (set in window.cjs). Exposes window.wingman (called `api` in the renderer scripts).
// Each method maps to one ipcMain handler in window.cjs / keys-ipc.cjs; arguments are coerced to plain types here and checked again in main.
/* global document -- the preload runs in the page world of the window; the page language is the window language (boot.js sets it) */
const { contextBridge, ipcRenderer } = require("electron");
// Fixed, narrow surface. The page can ask for named commands; it cannot send arbitrary IPC or stdin.
// Keys: keysSet is the only way a secret goes main-ward; nothing here ever returns one (status gives last 4 characters).
contextBridge.exposeInMainWorld("wingman", {
  listCalls: () => ipcRenderer.invoke("calls:list"),
  exportCall: (id, fmt) => ipcRenderer.invoke("calls:export", String(id), String(fmt)),
  getCall: (id) => ipcRenderer.invoke("calls:get", String(id)),
  searchCalls: (q) => ipcRenderer.invoke("calls:search", String(q)),
  setTag: (id, cardId, useful) => ipcRenderer.invoke("calls:setTag", String(id), String(cardId), useful === null ? null : String(useful)),
  deleteCall: (id) => ipcRenderer.invoke("calls:delete", String(id)),
  copyText: (text) => ipcRenderer.invoke("clipboard:write", String(text)),
  settingsText: () => ipcRenderer.invoke("tools:settings"),
  callState: () => ipcRenderer.invoke("call:state"),
  // Push channels (main -> page). Only the callback gets the payload; the raw ipcRenderer event is not passed to the page.
  onCallState: (cb) => {
    ipcRenderer.on("call:state", (_e, s) => cb(s));
  },
  onNav: (cb) => {
    ipcRenderer.on("nav", (_e, o) => cb(o));
  },
  liveGet: (id) => ipcRenderer.invoke("live:get", String(id)),
  onLive: (cb) => {
    ipcRenderer.on("live:update", (_e, p) => cb(p));
  },
  // start / startNoAi: no argument = a quick call (no Plan); a meeting id = that prepared meeting. practice: { planId } | { quick: true } | nothing (the next meeting).
  start: (planId) => ipcRenderer.invoke("call:cmd", "start", planId ? String(planId) : ""),
  startNoAi: (planId) => ipcRenderer.invoke("call:cmd", "startNoAi", planId ? String(planId) : ""),
  practice: (o) =>
    ipcRenderer.invoke("call:cmd", "practice", { quick: !!(o && o.quick), planId: o && o.planId ? String(o.planId) : "", lang: document.documentElement.lang }),
  consent: () => ipcRenderer.invoke("call:cmd", "consent"),
  quiet: (on) => ipcRenderer.invoke("call:cmd", "quiet", !!on),
  confirmClient: () => ipcRenderer.invoke("call:cmd", "client"),
  note: (text) => ipcRenderer.invoke("call:cmd", "note", String(text)),
  speaker: (spk, name) => ipcRenderer.invoke("call:cmd", "speaker", { spk: Number(spk), name: String(name) }),
  ask: (text) => ipcRenderer.invoke("call:cmd", "ask", String(text)),
  askWingman: () => ipcRenderer.invoke("call:cmd", "askWingman"),
  stop: () => ipcRenderer.invoke("call:cmd", "stop"),
  skipSummary: () => ipcRenderer.invoke("call:cmd", "skipSummary"),
  writeSummary: (id) => ipcRenderer.invoke("calls:writeSummary", String(id)),
  stopDelete: () => ipcRenderer.invoke("call:cmd", "stopDelete"),
  // the call mode: "auto" | a kind | a custom mode id. The running call gets it through the control socket; a prepared meeting stores it.
  setMode: (kind) => ipcRenderer.invoke("call:cmd", "mode", String(kind)),
  setPlanKind: (id, kind) => ipcRenderer.invoke("plans:setKind", String(id || ""), String(kind)),
  modesList: () => ipcRenderer.invoke("modes:list"),
  // card trust and learning (call review)
  rateHeld: (id, key, rating) => ipcRenderer.invoke("held:rate", String(id), String(key), rating === null ? null : String(rating)),
  learnSummary: () => ipcRenderer.invoke("learn:summary"),
  learnReset: () => ipcRenderer.invoke("learn:reset"),
  // earlier calls
  pastSearch: (q) => ipcRenderer.invoke("past:search", String(q)),
  pastList: () => ipcRenderer.invoke("past:list"),
  pastForget: (key, callId) => ipcRenderer.invoke("past:forget", String(key), callId ? String(callId) : ""),
  pastRecap: (m) =>
    ipcRenderer.invoke("past:recap", { title: String(m && m.title), who: String(m && m.who), topic: String(m && m.topic), goal: String((m && m.goal) || "") }),
  lookup: (term) => ipcRenderer.invoke("lookup:run", String(term)),
  plansList: () => ipcRenderer.invoke("plans:list"),
  // Only the keys the page gives are sent (a missing key leaves that field as it is). `context` is the pasted Meeting context text.
  savePlan: (d) => {
    const o = { id: String(d.id || "") };
    for (const k of ["title", "who", "goal", "notes", "mustCover", "at", "context"]) if (d[k] !== undefined) o[k] = String(d[k]);
    return ipcRenderer.invoke("plans:save", o);
  },
  planContext: (id) => ipcRenderer.invoke("plans:context", String(id || "")),
  preparePlan: (id, lang) => ipcRenderer.invoke("plans:prepare", String(id || ""), String(lang || "en")),
  knowsGet: (mode, lang, planId) => ipcRenderer.invoke("knows:get", String(mode), String(lang || "en"), String(planId || "")),
  // One edit of what Wingman knows: { op: "edit", id, text } | { op: "remove", id } | { op: "add", list, text }. Checked again in main and by the engine.
  knowsEdit: (e) => ipcRenderer.invoke("knows:edit", e && typeof e === "object" ? { ...e } : null),
  deletePlan: (id) => ipcRenderer.invoke("plans:delete", String(id)),
  discardDraft: () => ipcRenderer.invoke("plans:discardDraft"),
  recentPlans: () => ipcRenderer.invoke("brief:recent"),
  forgetRecentPlans: () => ipcRenderer.invoke("brief:forgetRecent"),
  attachList: (id) => ipcRenderer.invoke("attach:list", String(id || "")),
  attachAdd: (id, name, bytes) => ipcRenderer.invoke("attach:add", String(id || ""), String(name), bytes instanceof Uint8Array ? bytes : new Uint8Array(0)),
  attachPaste: (id, text) => ipcRenderer.invoke("attach:paste", String(id || ""), String(text)),
  attachRemove: (id, fileId) => ipcRenderer.invoke("attach:remove", String(id || ""), String(fileId)),
  ctxUrl: (id, url) => ipcRenderer.invoke("ctx:url", String(id || ""), String(url)),
  ctxCalPreview: () => ipcRenderer.invoke("ctx:calPreview"),
  ctxCalUse: (id) => ipcRenderer.invoke("ctx:calUse", String(id || "")),
  ctxCalSave: (url) => ipcRenderer.invoke("ctx:calSave", String(url)),
  runDoctor: (offline) => ipcRenderer.invoke("doctor:run", offline === true),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSetting: (key, value) => ipcRenderer.invoke("settings:set", String(key), value),
  resetSetting: (key) => ipcRenderer.invoke("settings:set", String(key), null),
  keysStatus: () => ipcRenderer.invoke("keys:status"),
  keysSet: (provider, value) => ipcRenderer.invoke("keys:set", String(provider), String(value)),
  keysConnect: (provider, value) => ipcRenderer.invoke("keys:connect", String(provider), String(value)),
  keysRecheck: (provider) => ipcRenderer.invoke("keys:recheck", String(provider)),
  keysTest: (provider) => ipcRenderer.invoke("keys:test", String(provider)),
  keysRemove: (provider) => ipcRenderer.invoke("keys:remove", String(provider)),
  keysMigrate: () => ipcRenderer.invoke("keys:migrate"),
  profileGet: () => ipcRenderer.invoke("profile:get"),
  profileSet: (d) =>
    ipcRenderer.invoke("profile:set", {
      name: String(d.name),
      spellings: Array.isArray(d.spellings) ? d.spellings.map(String) : [],
      address: String(d.address),
      about: String(d.about),
      business: String(d.business),
    }),
  setupStatus: () => ipcRenderer.invoke("setup:status"),
  setupAskMic: () => ipcRenderer.invoke("setup:askMic"),
  setupOpenPrivacy: (which) => ipcRenderer.invoke("setup:openPrivacy", String(which)),
  setupOpenLink: (which) => ipcRenderer.invoke("setup:openLink", String(which)),
  setupMics: () => ipcRenderer.invoke("setup:mics"),
  setupSetMic: (v) => ipcRenderer.invoke("setup:setMic", v === null ? null : String(v)),
  setupSetOneScreen: (on) => ipcRenderer.invoke("setup:setOneScreen", !!on),
  setupCopyPack: (pick) => ipcRenderer.invoke("setup:copyPack", pick),
  setupRevealPack: () => ipcRenderer.invoke("setup:revealPack"),
  reveal: (what) => ipcRenderer.invoke("settings:reveal", String(what)),
});
