"use strict";
// Developer check of the real capture page (tray/capture/capture.js) inside Electron, without the Wingman app and without a microphone:
// Chromium's fake audio device plays a beep, the page records it, and this script checks the PCM that comes out.
//   ./node_modules/.bin/electron scripts/capture-selftest.cjs        (exit 0 = ok; prints one line per check)
// It opens one hidden window, no Dock icon, no permission prompt (fake UI flag) and does not touch keys, settings or the network.
const { app, BrowserWindow, ipcMain, session, desktopCapturer } = require("electron");
const path = require("node:path");

app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
if (process.platform === "darwin") app.dock.hide();
require("../shared/permissions.cjs").install(app);
const { createCaptureHost } = require("../tray/capture-host.cjs");

const fails = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) fails.push(what);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const host = createCaptureHost({
    BrowserWindow,
    session,
    ipcMain,
    desktopCapturer,
    systemPreferences: undefined, // no macOS prompt in this check
    grantSession: require("../shared/permissions.cjs").grantSession,
    dir: path.join(__dirname, "..", "tray", "capture"),
  });
  try {
    const list = await host.devices();
    check(list.devices.length >= 1, `devices listed: ${JSON.stringify(list.devices.map((d) => d.name))}`);
    const chunks = [];
    host.onPcm((ch, b) => chunks.push([ch, b]));
    const r = await host.start("mic", { name: "no such microphone" });
    check(r.fellBack === true, "an unknown saved name falls back to the default device");
    await sleep(2000);
    const n = chunks.length;
    check(n >= 12 && n <= 25, `about 10 chunks per second (got ${n} in 2 s)`);
    check(
      chunks.every(([ch, b]) => ch === "mic" && b.length === 3200),
      "every chunk is 100 ms of 16 kHz mono s16le (3200 bytes)",
    );
    let peak = 0;
    for (const [, b] of chunks) for (let i = 0; i + 1 < b.length; i += 2) peak = Math.max(peak, Math.abs(b.readInt16LE(i)));
    check(peak > 1000, `the fake device's beep is in the audio (peak ${peak} of 32767)`);
    const r2 = await host.start("mic", { name: list.devices[0].name });
    check(r2.fellBack === false, "a listed device name is found");
    await sleep(500);
    await host.stop("mic");
    const after = chunks.length;
    await sleep(500);
    check(chunks.length === after, "no audio after stop");
  } catch (e) {
    check(false, `error: ${e && e.code} ${e && e.message}`);
  }
  host.destroy();
  app.exit(fails.length ? 1 : 0);
});
setTimeout(() => {
  console.log("FAIL timed out");
  app.exit(1);
}, 40_000).unref();
