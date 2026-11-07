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
];

const api = {
  copy: (text) => ipcRenderer.send("copy", String(text)),
};
for (const [channel, name, hasPayload] of EVENTS) {
  // The block body returns nothing on purpose: returning ipcRenderer.on() would hand the page the ipcRenderer proxy.
  api[name] = (fn) => {
    ipcRenderer.on(channel, hasPayload ? (_e, payload) => fn(payload) : () => fn());
  };
}
contextBridge.exposeInMainWorld("wingman", api);
