"use strict";
// electron-builder afterPack hook: turns off the Electron fuses the security notes rely on (RunAsNode, NODE_OPTIONS, --inspect), then,
// for an unsigned build, signs the app ad hoc. The fuses change the Electron binary, so this runs BEFORE any signature (ours or electron-builder's).
const path = require("node:path");
const { execFileSync } = require("node:child_process");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const out = execFileSync(process.execPath, [path.join(__dirname, "set-fuses.cjs"), app], { encoding: "utf8" });
  process.stdout.write(`  • ${out.trim()}\n`);
  if (process.env.WINGMAN_SIGN === "1") return; // electron-builder signs next, with the Developer ID certificate
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  process.stdout.write("  • ad hoc signed (unsigned build: macOS asks to confirm the first start)\n");
};
