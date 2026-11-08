// Preload for the answer window: exposes window.wingman with one subscribe function per event main.cjs sends, plus copy(text) back to main.
// Only these fixed channels cross the context-isolation boundary; the page gets no Node or raw ipcRenderer (the subscribe functions return nothing, so no ipcRenderer proxy leaks).
const { contextBridge, ipcRenderer } = require("electron");

/** Events main.cjs sends to the window: [channel, exposed name, whether the event carries a payload]. */
/** @type {[string, string, boolean][]} */
const EVENTS = [
  ["config", "onConfig", true],
  ["card", "onCard", true],
  ["capture", "onCapture", true],
  ["line", "onLine", true],
  ["speaker", "onSpeaker", true],
  ["partial", "onPartial", true],
  ["rewind", "onRewind", false],
  ["copied", "onCopied", true],
  ["phase", "onPhase", true],
  ["ended", "onEnded", false],
  ["reset", "onReset", false],
  ["frame", "onFrame", true],
  ["flow", "onFlow", true],
  ["addressed", "onAddressed", true],
  ["checklist", "onChecklist", false],
  ["clear", "onClear", false],
  ["ask", "onAsk", true],
  ["pause", "onPause", false],
  ["recap", "onRecap", true], // Catch me up: no payload = open the sheet; { phase, text, recap } = the streamed recap
  ["restore", "onRestore", false], // bring back the card that left in the last 30 s
  ["note", "onNote", true], // { kind, text }: a taken hotkey or a lost screen; empty text clears it
  ["nudge", "onNudge", true], // { kind: pace | share | interrupt, value, limit }: a thin bar, not a card
  ["ctl", "onCtl", true], // a card control pressed on the keyboard: { name: more | pin | useful | notuseful | dismiss }
];

/** Card controls back to main on the "act" channel: { kind: "rate", cardId, rating } and { kind: "event", cardId, name }. Same rule as cleanAct in v2.js (a sandboxed preload cannot require it); anything else is dropped. */
const RATINGS = ["useful", "not_useful", "fewer", "none"];
const ACT_EVENTS = ["pin", "unpin", "dismiss", "recap"];
function cleanAct(kind, payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const cardId = typeof p.cardId === "string" ? p.cardId.slice(0, 200) : "";
  if (!cardId) return null;
  if (kind === "rate" && RATINGS.includes(p.rating)) return { kind, cardId, rating: p.rating };
  if (kind === "event" && ACT_EVENTS.includes(p.name)) return { kind, cardId, name: p.name };
  return null;
}

const api = {
  /** The page's content height in px (content-sized window). main.cjs clamps it to the chosen display. */
  size: (h) => {
    const n = Number(h);
    if (Number.isFinite(n) && n > 0 && n < 20000) ipcRenderer.send("size", Math.round(n));
  },
  copy: (text) => ipcRenderer.send("copy", String(text)),
  /** How many cards the page has shown in this run: main adds it to the app's life count (the key hints hide after the first few). */
  shown: (n) => {
    const k = Number(n);
    if (Number.isInteger(k) && k > 0 && k < 1e6) ipcRenderer.send("shown", k);
  },
  act: (kind, payload) => {
    const m = cleanAct(kind, payload);
    if (m) ipcRenderer.send("act", m);
  },
};
for (const [channel, name, hasPayload] of EVENTS) {
  // The block body returns nothing on purpose: returning ipcRenderer.on() would hand the page the ipcRenderer proxy.
  api[name] = (fn) => {
    ipcRenderer.on(channel, hasPayload ? (_e, payload) => fn(payload) : () => fn());
  };
}
contextBridge.exposeInMainWorld("wingman", api);
