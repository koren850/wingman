"use strict";
// Preload of the hidden capture window (tray/capture-host.cjs). Exposes four calls to capture.js and nothing else.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("wingmanCapture", {
  /** cb(cmd): a command from the app: { id, op: "start"|"stop"|"devices", ch, name }. */
  onCommand: (cb) => ipcRenderer.on("capture:cmd", (_e, cmd) => cb(cmd)),
  /** The answer to a command: { id, ok, code?, message?, ... }. */
  reply: (msg) => ipcRenderer.send("capture:reply", msg),
  /** One chunk of 16 kHz mono s16le audio for "mic" or "system". */
  pcm: (ch, bytes) => ipcRenderer.send("capture:pcm", ch, bytes),
  /** A running channel ended by itself (device unplugged, stream stopped). */
  ended: (ch, reason) => ipcRenderer.send("capture:ended", ch, String(reason || "")),
});
