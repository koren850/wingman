const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("wingman", {
  onConfig: (fn) => ipcRenderer.on("config", (_e, c) => fn(c)),
  onCard: (fn) => ipcRenderer.on("card", (_e, c) => fn(c)),
  onCapture: (fn) => ipcRenderer.on("capture", (_e, c) => fn(c)),
  onLine: (fn) => ipcRenderer.on("line", (_e, l) => fn(l)),
  onRewind: (fn) => ipcRenderer.on("rewind", () => fn()),
  onCopied: (fn) => ipcRenderer.on("copied", (_e, t) => fn(t)),
  onReset: (fn) => ipcRenderer.on("reset", () => fn()),
  onFrame: (fn) => ipcRenderer.on("frame", (_e, f) => fn(f)),
  onChecklist: (fn) => ipcRenderer.on("checklist", () => fn()),
  onClear: (fn) => ipcRenderer.on("clear", () => fn()),
  onAsk: (fn) => ipcRenderer.on("ask", (_e, a) => fn(a)),
  onPause: (fn) => ipcRenderer.on("pause", () => fn()),
  copy: (text) => ipcRenderer.send("copy", String(text)),
});
