const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("wingman", { submit: (kind, data) => ipcRenderer.invoke("prompt:submit", kind, data) });
