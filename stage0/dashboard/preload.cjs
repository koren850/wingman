const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("wingman", {
  listCalls: () => ipcRenderer.invoke("calls:list"),
  getCall: (id) => ipcRenderer.invoke("calls:get", String(id)),
  searchCalls: (q) => ipcRenderer.invoke("calls:search", String(q)),
  setTag: (id, cardId, useful) => ipcRenderer.invoke("calls:setTag", String(id), String(cardId), useful === null ? null : String(useful)),
  deleteCall: (id) => ipcRenderer.invoke("calls:delete", String(id)),
  copyText: (text) => ipcRenderer.invoke("clipboard:write", String(text)),
  settingsText: () => ipcRenderer.invoke("tools:settings"),
  doctorOffline: () => ipcRenderer.invoke("tools:doctor"),
});
