"use strict";
// The hidden capture window: records audio inside the app so users need no ffmpeg.
//   microphone   getUserMedia in the window (macOS and Windows)
//   system audio Electron loopback audio through getDisplayMedia (Windows only; macOS keeps the bundled AudioTee in the engine)
// The window page is tray/capture/capture.js. This file owns the window, the microphone permission, the loopback request handler and the
// command/reply bookkeeping. It offers a small object (start, stop, devices, onPcm, onEnded) that tray/capture-bridge.cjs serves to the engine.
// Electron objects are passed in (o), so the logic is unit-tested with fakes in src/capture-host.test.ts.

const START_TIMEOUT_MS = 20_000;
const COMMAND_TIMEOUT_MS = 10_000;

/** An Error with a short machine code: "permission" | "no-device" | "busy" | "unsupported" | "failed". */
function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * o: { BrowserWindow, session, ipcMain, desktopCapturer, systemPreferences, grantSession, dir, platform?, setTimeout?, clearTimeout? }
 * dir = the folder with capture.html (tray/capture). The window is created on the first command and again after a crash.
 */
function createCaptureHost(o) {
  const platform = o.platform || process.platform;
  const setT = o.setTimeout || setTimeout,
    clearT = o.clearTimeout || clearTimeout;
  const path = require("node:path");
  const pcmListeners = new Set(),
    endListeners = new Set();
  const pending = new Map(); // command id -> { resolve, reject, timer }
  const running = new Set(); // channels the page is recording now
  let win,
    ready,
    nextId = 1,
    ses,
    wired = false;

  function sessionOnce() {
    if (ses) return ses;
    ses = o.session.fromPartition("wingman-capture"); // its own session: the permission for "media" is granted here and nowhere else
    o.grantSession(ses, ["media", "display-capture"]);
    if (platform === "win32")
      ses.setDisplayMediaRequestHandler(
        (_request, callback) => {
          // Electron needs a video source with the loopback audio; the page stops the video track at once.
          o.desktopCapturer
            .getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } })
            .then((sources) => (sources.length ? callback({ video: sources[0], audio: "loopback" }) : callback({})))
            .catch(() => callback({}));
        },
        { useSystemPicker: false },
      );
    return ses;
  }

  function wireIpc() {
    if (wired) return;
    wired = true;
    const mine = (e) => !!win && !win.isDestroyed() && e.sender === win.webContents; // only the capture window may call these
    o.ipcMain.on("capture:reply", (e, msg) => {
      if (!mine(e) || !msg || typeof msg.id !== "number") return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearT(p.timer);
      if (msg.ok) p.resolve(msg);
      else p.reject(codedError(typeof msg.code === "string" ? msg.code : "failed", String(msg.message || "capture failed").slice(0, 300)));
    });
    o.ipcMain.on("capture:pcm", (e, ch, bytes) => {
      if (!mine(e) || (ch !== "mic" && ch !== "system") || !running.has(ch)) return;
      const buf = Buffer.from(bytes);
      if (buf.length < 2) return;
      const whole = buf.length % 2 ? buf.subarray(0, buf.length - 1) : buf;
      for (const cb of pcmListeners) cb(ch, whole);
    });
    o.ipcMain.on("capture:ended", (e, ch, reason) => {
      if (!mine(e) || (ch !== "mic" && ch !== "system") || !running.delete(ch)) return;
      for (const cb of endListeners) cb(ch, String(reason || "the audio device stopped"));
    });
  }

  function failAll(reason) {
    for (const [id, p] of pending) {
      clearT(p.timer);
      p.reject(codedError("failed", reason));
      pending.delete(id);
    }
    for (const ch of [...running]) {
      running.delete(ch);
      for (const cb of endListeners) cb(ch, reason);
    }
  }

  /** The window, created and loaded. A second caller waits for the same load. */
  function window() {
    if (win && !win.isDestroyed() && ready) return ready;
    wireIpc();
    const s = sessionOnce();
    const w = new o.BrowserWindow({
      show: false,
      width: 200,
      height: 100,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(o.dir, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        session: s,
        backgroundThrottling: false, // a hidden window must not slow its audio thread
        autoplayPolicy: "no-user-gesture-required",
      },
    });
    win = w;
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    w.webContents.on("will-navigate", (e) => e.preventDefault());
    w.webContents.on("render-process-gone", (_e, d) => {
      // A crashed page is dropped, so the next command opens a fresh window.
      if (win === w) {
        win = undefined;
        ready = undefined;
      }
      failAll(`the capture window stopped (${(d && d.reason) || "gone"})`);
      if (!w.isDestroyed()) w.destroy();
    });
    w.on("closed", () => {
      if (win === w) {
        win = undefined;
        ready = undefined;
        failAll("the capture window was closed");
      }
    });
    ready = Promise.resolve(w.loadFile(path.join(o.dir, "capture.html"))).then(
      () => w,
      (e) => {
        if (win === w) {
          win = undefined;
          ready = undefined;
        }
        throw codedError("failed", `capture window did not load: ${e && e.message}`);
      },
    );
    return ready;
  }

  /** Sends one command to the page and waits for its reply. */
  async function command(cmd, timeoutMs = COMMAND_TIMEOUT_MS) {
    const w = await window();
    // Chromium lets getDisplayMedia run only right after a user gesture. This script counts as one for a few seconds, so the page may call it.
    if (cmd.op === "start" && cmd.ch === "system" && typeof w.webContents.executeJavaScript === "function")
      await Promise.resolve(w.webContents.executeJavaScript("0", true)).catch(() => {});
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setT(() => {
        pending.delete(id);
        reject(codedError("failed", `the capture window did not answer ${cmd.op} in ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      if (timer && timer.unref) timer.unref();
      pending.set(id, { resolve, reject, timer });
      try {
        w.webContents.send("capture:cmd", { id, ...cmd });
      } catch (e) {
        pending.delete(id);
        clearT(timer);
        reject(codedError("failed", String(e && e.message)));
      }
    });
  }

  /** macOS asks once; a denied answer is final until the user changes System Settings. Windows only reports "denied" when the privacy switch is off. */
  async function micPermission() {
    const sp = o.systemPreferences;
    if (!sp || typeof sp.getMediaAccessStatus !== "function") return;
    let status = "unknown";
    try {
      status = sp.getMediaAccessStatus("microphone");
    } catch {
      return;
    }
    if (status === "not-determined" && platform === "darwin" && typeof sp.askForMediaAccess === "function") {
      let granted = false;
      try {
        granted = await sp.askForMediaAccess("microphone");
      } catch {
        granted = false;
      }
      if (!granted) throw codedError("permission", "microphone access was not granted");
    } else if (status === "denied" || status === "restricted") throw codedError("permission", `microphone access is ${status}`);
  }

  return {
    /** Starts recording a channel. Resolves { fellBack } once the page has the stream; rejects with a coded Error. */
    async start(ch, opts = {}) {
      if (ch === "system" && platform !== "win32") throw codedError("unsupported", "system audio capture in the app is Windows only");
      if (ch === "mic") await micPermission();
      running.add(ch); // before the reply: the first chunk can be sent right behind it
      try {
        const r = await command({ op: "start", ch, name: typeof opts.name === "string" ? opts.name.slice(0, 120) : "" }, START_TIMEOUT_MS);
        return { fellBack: !!r.fellBack };
      } catch (e) {
        running.delete(ch);
        throw e;
      }
    },
    async stop(ch) {
      running.delete(ch);
      if (!win || win.isDestroyed()) return;
      await command({ op: "stop", ch }).catch(() => {});
    },
    /** The input devices the page can see: { devices: [{index, name}], defaultName }. */
    async devices() {
      if (platform === "darwin" || platform === "win32") await micPermission();
      const r = await command({ op: "devices" });
      return { devices: Array.isArray(r.devices) ? r.devices : [], defaultName: String(r.defaultName || "") };
    },
    onPcm(cb) {
      pcmListeners.add(cb);
      return () => pcmListeners.delete(cb);
    },
    onEnded(cb) {
      endListeners.add(cb);
      return () => endListeners.delete(cb);
    },
    /** Closes the window (app quit). */
    destroy() {
      running.clear();
      const w = win;
      win = undefined;
      ready = undefined;
      for (const [id, p] of pending) {
        clearT(p.timer);
        p.reject(codedError("failed", "the app is closing"));
        pending.delete(id);
      }
      if (w && !w.isDestroyed()) w.destroy();
    },
    isRunning: (ch) => running.has(ch),
  };
}

module.exports = { createCaptureHost, codedError, START_TIMEOUT_MS };
