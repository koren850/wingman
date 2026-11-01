const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("wingman", {
  onConfig: (fn) => ipcRenderer.on("config", (_e, c) => fn(c)),
  onCard: (fn) => ipcRenderer.on("card", (_e, c) => fn(c)),
  onReset: (fn) => ipcRenderer.on("reset", () => fn()),
  onClear: (fn) => ipcRenderer.on("clear", () => fn()),
  onPause: (fn) => ipcRenderer.on("pause", () => fn()),
});
