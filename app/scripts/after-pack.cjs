"use strict";
// electron-builder afterPack hook: turns off the Electron fuses the security notes rely on (RunAsNode, NODE_OPTIONS, --inspect), then,
// for an unsigned macOS build, signs the app ad hoc. The fuses change the Electron binary, so this runs BEFORE any signature (ours or electron-builder's).
// Windows: only the fuses (the .exe is not signed). Linux has no packaged app.
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/** What to do for an electron-builder platform name: the file to flip fuses in and whether to sign ad hoc. Pure, so it is unit-tested. */
function planFor(platformName, appOutDir, productFilename, env = process.env, join = path.join) {
  if (platformName === "darwin") return { target: join(appOutDir, `${productFilename}.app`), adHoc: env.WINGMAN_SIGN !== "1" };
  if (platformName === "windows" || platformName === "win32") return { target: join(appOutDir, `${productFilename}.exe`), adHoc: false };
  return null;
}

exports.planFor = planFor;
exports.default = async function afterPack(context) {
  const plan = planFor(context.electronPlatformName, context.appOutDir, context.packager.appInfo.productFilename);
  if (!plan) return;
  const out = execFileSync(process.execPath, [path.join(__dirname, "set-fuses.cjs"), plan.target], { encoding: "utf8" });
  process.stdout.write(`  • ${out.trim()}\n`);
  if (!plan.adHoc) return; // Windows: nothing to sign. macOS with WINGMAN_SIGN=1: electron-builder signs next, with the Developer ID certificate
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", plan.target], { stdio: "inherit" });
  process.stdout.write("  • ad hoc signed (unsigned build: macOS asks to confirm the first start)\n");
};
