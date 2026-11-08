"use strict";
// Which platform scripts/package-app.cjs builds for, and what that changes. Pure functions, unit-tested on any machine.
//   pnpm dist            the platform you are on (macOS: the .dmg, Windows: the NSIS installer)
//   pnpm dist --win      stage and build for Windows        pnpm dist --mac   for macOS
// electron-builder can only build a Windows installer on Windows without extra tools (it needs Wine on other systems), so the build
// step refuses a foreign platform; `--stage-only` works for either one (to look at the stage, and for tests).

/** "darwin" or "win32". Throws for anything else (Linux has no packaged app yet). */
function targetPlatform(argv, host = process.platform) {
  const win = argv.includes("--win"),
    mac = argv.includes("--mac");
  if (win && mac) throw new Error("use only one of --win and --mac");
  const t = win ? "win32" : mac ? "darwin" : host;
  if (t !== "darwin" && t !== "win32")
    throw new Error(`there is no packaged app for ${host} yet: use --win or --mac with --stage-only, or run from source (install.sh)`);
  return t;
}

/** Everything that differs per platform. */
function planFor(platform, argv = [], host = process.platform) {
  const dirOnly = argv.includes("--dir");
  const stageOnly = argv.includes("--stage-only");
  if (!stageOnly && platform !== host)
    throw new Error(
      `a ${platform === "win32" ? "Windows" : "macOS"} app is built on ${platform === "win32" ? "Windows" : "macOS"} (this is ${host}); use --stage-only to only fill the stage`,
    );
  return {
    platform,
    stageOnly,
    dirOnly,
    audiotee: platform === "darwin", // the macOS system-audio helper; Windows has none
    // The electron-builder command line (before --config / --projectDir).
    // --publish never: electron-builder must not upload on a tag build; the release workflow attaches the files itself.
    builderArgs:
      platform === "win32"
        ? ["--win", dirOnly ? "dir" : "nsis", "--x64", "--publish", "never"]
        : ["--mac", dirOnly ? "dir" : "dmg", "--arm64", "--publish", "never"],
    // Where the finished app folder and installer land, relative to app/dist (the documentation and the CI scripts use these).
    unpackedDir: platform === "win32" ? "win-unpacked" : "mac-arm64",
    installerGlob: platform === "win32" ? "Wingman-Setup-*-x64.exe" : "Wingman-*-arm64.dmg",
  };
}

module.exports = { targetPlatform, planFor };
