"use strict";
// electron-builder config for the packaged Wingman.app and .dmg. Run it with `pnpm dist` (scripts/package-app.cjs stages the files first).
//
// Unsigned by default: no Apple Developer account is needed to build. The app is only ad hoc signed (scripts/after-pack.cjs), so macOS asks
// the user to confirm the first start (see docs/DEVELOPMENT.md, "Building the app").
//
// Signing and notarizing are prepared but OFF. To switch them on, set WINGMAN_SIGN=1 and give electron-builder the usual variables:
//   CSC_LINK, CSC_KEY_PASSWORD      the "Developer ID Application" certificate (.p12, or a base64 string) and its password
//   CSC_NAME                        (instead of CSC_LINK) the certificate name, when it is already in the keychain
//   APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID     notarization with an Apple ID
//   or APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER     notarization with an App Store Connect API key
// WINGMAN_NOTARIZE=0 signs without notarizing. Signed builds use the hardened runtime and build/entitlements.mac.plist.
const fs = require("node:fs");
const path = require("node:path");

const sign = process.env.WINGMAN_SIGN === "1";
const notarize = sign && process.env.WINGMAN_NOTARIZE !== "0";
const electronDir = path.join(__dirname, "node_modules", "electron");

/** Same Electron as the dev setup (the version in node_modules), and its downloaded files when they are there (no second download). */
const electron = {
  electronVersion: process.env.WINGMAN_ELECTRON_VERSION || JSON.parse(fs.readFileSync(path.join(electronDir, "package.json"), "utf8")).version,
};
if (fs.existsSync(path.join(electronDir, "dist", "Electron.app"))) electron.electronDist = path.join(electronDir, "dist");

module.exports = {
  ...electron,
  appId: "com.wingman.app",
  productName: "Wingman",
  copyright: "MIT License",
  artifactName: "Wingman-${version}-${arch}.${ext}",
  // scripts/package-app.cjs fills .stage with the code, the bundled engine and the shipped data; the app folder is that stage.
  directories: { app: ".stage", output: "dist", buildResources: "build" },
  // No asar: the engine runs child processes with the app folder as cwd and starts the audiotee binary from it.
  electronLanguages: ["en", "he"], // the app has English and Hebrew windows; drops the other Chromium language packs
  asar: false,
  // The engine is bundled (src/*.mjs); the only package the app loads at run time is yaml. electron-builder would add the dev checkout's whole dependency tree.
  files: ["**/*", "!node_modules/**", "node_modules/yaml/**"],
  npmRebuild: false,
  buildDependenciesFromSource: false,
  afterPack: path.join(__dirname, "scripts", "after-pack.cjs"),
  // The window and the tray read their icons from ../brand/png (next to the app folder).
  extraResources: [{ from: "../brand/png", to: "brand/png", filter: ["icon-512.png", "trayTemplate.png", "trayTemplate@2x.png"] }],
  mac: {
    target: [{ target: "dmg", arch: ["arm64"] }],
    category: "public.app-category.productivity",
    icon: path.join(__dirname, "..", "brand", "Wingman.icns"),
    minimumSystemVersion: "14.2", // audiotee (system audio) needs macOS 14.2
    identity: sign ? undefined : null, // null = electron-builder does not sign; after-pack.cjs ad hoc signs
    hardenedRuntime: sign,
    gatekeeperAssess: false,
    entitlements: sign ? path.join(__dirname, "build", "entitlements.mac.plist") : undefined,
    entitlementsInherit: sign ? path.join(__dirname, "build", "entitlements.mac.plist") : undefined,
    notarize,
    extendInfo: {
      // Menu-bar app: no Dock icon until the window opens (the code calls app.dock.show() then).
      LSUIElement: true,
      NSMicrophoneUsageDescription: "Wingman listens to your microphone during a call to follow what you say. Audio is not stored.",
      NSAudioCaptureUsageDescription: "Wingman listens to the other side of your call (system audio) to follow the conversation. Audio is not stored.",
    },
  },
  dmg: { title: "Wingman ${version}", icon: path.join(__dirname, "..", "brand", "Wingman.icns") },
};
