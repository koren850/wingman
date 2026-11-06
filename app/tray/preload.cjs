// Preload for the note prompt window (prompt.html). Exposes one call, window.wingman.submit(kind, data), which main.cjs checks by sender.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("wingman", { submit: (kind, data) => ipcRenderer.invoke("prompt:submit", kind, data) });
