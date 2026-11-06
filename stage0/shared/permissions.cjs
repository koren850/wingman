"use strict";
// Electron permission lockdown for every window's session. Wingman's windows load only local files, so no page needs a browser permission
// (camera, microphone, geolocation, notifications, clipboard-read, ...): the microphone is opened by the engine through ffmpeg, and the macOS
// microphone prompt is asked from the main process (systemPreferences), not by a renderer. Electron grants permission requests when no handler is
// set, so each session gets a handler that says no. `allow` is a list of permission names that stay allowed (none today).
// Also: <webview> attachment and redirects are refused. No electron import here: the Electron objects are passed in, so it is unit-tested with fakes.

/** Makes one session refuse every permission request and check except the ones in `allow`. */
function denyPermissions(ses, allow = []) {
  const ok = new Set(allow);
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ok.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ok.has(permission));
  if (typeof ses.setDevicePermissionHandler === "function") ses.setDevicePermissionHandler(() => false);
}

/** Locks down the session of every web contents the app ever creates (and the default session at once when the app is ready). */
function install(app, allow = []) {
  app.on("web-contents-created", (_e, wc) => {
    try { denyPermissions(wc.session, allow); } catch { /* a session that cannot be set stays as Electron has it */ }
    wc.on("will-attach-webview", (e) => e.preventDefault());
    wc.on("will-redirect", (e) => e.preventDefault());
  });
  if (app.whenReady && app.getAppPath) app.whenReady().then(() => { try { const { session } = require("electron"); denyPermissions(session.defaultSession, allow); } catch { /* not in Electron */ } });
}

module.exports = { denyPermissions, install };
