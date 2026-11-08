"use strict";
// Small platform differences of the packaged app, in one place so they are unit-tested on any machine (`platform` is a parameter).
const nodePath = require("node:path");

/**
 * PATH for the packaged app and its children. macOS: Finder gives apps only /usr/bin:/bin, but ffmpeg (microphone) and pdftotext (optional)
 * are looked up on the PATH, so add the usual places. Windows: the PATH of the user is already complete; it is left as it is.
 */
function appPath(current, platform = process.platform) {
  if (platform === "win32") return current || "";
  const have = (current || "").split(":");
  return [...new Set([...have, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean))].join(":");
}

/**
 * The menu-bar (tray) icon file. macOS wants a black "template" image that the system tints. Windows has no template images: it needs a
 * coloured icon that shows on both a light and a dark taskbar, and the multi-size .ico lets Windows pick 16, 24 or 32 pixels.
 * `brand` is the folder with png/ and wingman.ico (resources/brand in the packaged app).
 */
function trayIcon(brand, platform = process.platform) {
  const p = platform === "win32" ? nodePath.win32 : nodePath.posix;
  return platform === "win32" ? { file: p.join(brand, "wingman.ico"), template: false } : { file: p.join(brand, "png", "trayTemplate.png"), template: true };
}

module.exports = { appPath, trayIcon };
