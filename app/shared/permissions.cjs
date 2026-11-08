"use strict";
// Electron permission lockdown for every window's session. Wingman's windows load only local files, so no page needs a browser permission
// (camera, microphone, geolocation, notifications, clipboard-read, ...): the microphone is opened by the engine through ffmpeg, and the macOS
// microphone prompt is asked from the main process (systemPreferences), not by a renderer. The one exception is the hidden capture window, which
// records the microphone itself (grantSession). Electron grants permission requests when no handler is
// set, so each session gets a handler that says no. `allow` is a list of permission names that stay allowed (none today).
// Also: <webview> attachment and redirects are refused. No electron import here: the Electron objects are passed in, so it is unit-tested with fakes.

// Sessions that may use named permissions, set with grantSession(). Only the hidden capture window (tray/capture-host.cjs) has one:
// it runs a local page that records the microphone ("media") and, on Windows, system audio ("display-capture").
const granted = new WeakMap();

/** Lets one session (not the default one) keep the named permissions. Call it before the window loads. */
function grantSession(ses, permissions) {
  granted.set(ses, new Set(permissions));
}

/** Makes one session refuse every permission request and check except the ones in `allow` (and those given to it with grantSession). */
function denyPermissions(ses, allow = []) {
  const ok = new Set(allow);
  const yes = (permission) => ok.has(permission) || !!granted.get(ses)?.has(permission);
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(yes(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => yes(permission));
  if (typeof ses.setDevicePermissionHandler === "function") ses.setDevicePermissionHandler(() => false);
}

/** Locks down the session of every web contents the app ever creates (and the default session at once when the app is ready). */
function install(app, allow = []) {
  app.on("web-contents-created", (_e, wc) => {
    try {
      denyPermissions(wc.session, allow);
    } catch {
      /* a session that cannot be set stays as Electron has it */
    }
    wc.on("will-attach-webview", (e) => e.preventDefault());
    wc.on("will-redirect", (e) => e.preventDefault());
  });
  if (app.whenReady && app.getAppPath)
    app.whenReady().then(() => {
      try {
        const { session } = require("electron");
        denyPermissions(session.defaultSession, allow);
      } catch {
        /* not in Electron */
      }
    });
}

module.exports = { denyPermissions, grantSession, install };
