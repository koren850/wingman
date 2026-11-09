// preinstall: stops early, with a clear message, on a machine Wingman cannot run on. Plain Node, no dependencies.
const { spawnSync } = require("node:child_process");
const bad = [];
const major = Number(process.versions.node.split(".")[0]);
if (major < 24)
  bad.push(
    `Node ${process.versions.node} is too old: Wingman needs Node 24 or newer.\n    Fix: brew install node@24 && brew link --overwrite node@24   (or: nvm install 24), then run install.sh again.`,
  );
if (process.platform === "darwin") {
  const v = spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).stdout?.trim() || "";
  const [a, b] = v.split(".").map(Number);
  if (a && (a < 14 || (a === 14 && (b || 0) < 2))) bad.push(`macOS ${v} is too old: Wingman needs macOS 14.2 or newer (system audio capture).`);
} else if (!process.env.WINGMAN_SKIP_APP) {
  console.warn("Note: Wingman's menu-bar app and audio capture are macOS-only; installing the engine and tests only.");
}
if (bad.length) {
  console.error("\nWingman cannot be installed here:\n  - " + bad.join("\n  - ") + "\n");
  process.exit(1);
}
