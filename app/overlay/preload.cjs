// Preload for the answer window: exposes window.wingman with one subscribe function per event main.cjs sends, plus copy(text) back to main.
// Only these fixed channels cross the context-isolation boundary; the page gets no Node or raw ipcRenderer (the subscribe functions return nothing, so no ipcRenderer proxy leaks).
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("wingman", {
  onConfig: (fn) => {
    ipcRenderer.on("config", (_e, c) => fn(c));
  },
  onCard: (fn) => {
    ipcRenderer.on("card", (_e, c) => fn(c));
  },
  onCapture: (fn) => {
    ipcRenderer.on("capture", (_e, c) => fn(c));
  },
  onLine: (fn) => {
    ipcRenderer.on("line", (_e, l) => fn(l));
  },
  onSpeaker: (fn) => {
    ipcRenderer.on("speaker", (_e, s) => fn(s));
  },
  onPartial: (fn) => {
    ipcRenderer.on("partial", (_e, l) => fn(l));
  },
  onRewind: (fn) => {
    ipcRenderer.on("rewind", () => fn());
  },
  onCopied: (fn) => {
    ipcRenderer.on("copied", (_e, t) => fn(t));
  },
  onPhase: (fn) => {
    ipcRenderer.on("phase", (_e, p) => fn(p));
  },
  onEnded: (fn) => {
    ipcRenderer.on("ended", () => fn());
  },
  onReset: (fn) => {
    ipcRenderer.on("reset", () => fn());
  },
  onFrame: (fn) => {
    ipcRenderer.on("frame", (_e, f) => fn(f));
  },
  onFlow: (fn) => {
    ipcRenderer.on("flow", (_e, f) => fn(f));
  },
  onAddressed: (fn) => {
    ipcRenderer.on("addressed", (_e, a) => fn(a));
  },
  onChecklist: (fn) => {
    ipcRenderer.on("checklist", () => fn());
  },
  onClear: (fn) => {
    ipcRenderer.on("clear", () => fn());
  },
  onAsk: (fn) => {
    ipcRenderer.on("ask", (_e, a) => fn(a));
  },
  onPause: (fn) => {
    ipcRenderer.on("pause", () => fn());
  },
  copy: (text) => ipcRenderer.send("copy", String(text)),
});
