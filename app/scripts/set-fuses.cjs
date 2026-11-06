// Flips Electron fuses in a built Wingman.app, with no dependency (@electron/fuses is not installed): the fuse wire is a sentinel
// string followed by [version, count, one ASCII byte per fuse: "1" on, "0" off, "r" removed] inside the Electron Framework binary.
// Turned OFF: RunAsNode (ELECTRON_RUN_AS_NODE turns the app into a free node), EnableNodeOptionsEnvironmentVariable (NODE_OPTIONS),
// EnableNodeCliInspectArguments (--inspect). Must run BEFORE the ad hoc codesign. Usage: node set-fuses.cjs <path to .app> [--check]
const fs = require("node:fs");
const path = require("node:path");
const SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
const FUSES = { RunAsNode: 0, EnableCookieEncryption: 1, EnableNodeOptionsEnvironmentVariable: 2, EnableNodeCliInspectArguments: 3 };
const OFF = ["RunAsNode", "EnableNodeOptionsEnvironmentVariable", "EnableNodeCliInspectArguments"];

/** Reads or sets the fuses in a framework binary buffer. Returns { index, wire } (wire = the fuse bytes as a string). */
function locate(buf) {
  const i = buf.indexOf(SENTINEL);
  if (i < 0) throw new Error("fuse sentinel not found (a different Electron build?)");
  const version = buf[i + SENTINEL.length],
    n = buf[i + SENTINEL.length + 1];
  if (version !== 1 || n < 4 || n > 32) throw new Error(`unknown fuse wire (version ${version}, ${n} fuses)`);
  return { at: i + SENTINEL.length + 2, n };
}
function flip(buf) {
  const { at } = locate(buf);
  for (const name of OFF) if (buf[at + FUSES[name]] !== 0x72 /* r */) buf[at + FUSES[name]] = 0x30;
  return buf;
}
function state(buf) {
  const { at, n } = locate(buf);
  return buf.subarray(at, at + n).toString("latin1");
}
const frameworkOf = (app) => path.join(app, "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Electron Framework");

module.exports = { flip, state, frameworkOf, OFF, FUSES };

if (require.main === module) {
  const app = process.argv[2],
    check = process.argv.includes("--check");
  if (!app) {
    console.error("usage: set-fuses.cjs <Wingman.app> [--check]");
    process.exit(2);
  }
  const f = frameworkOf(app);
  try {
    const buf = fs.readFileSync(f);
    if (!check) {
      flip(buf);
      fs.writeFileSync(f, buf);
    }
    const s = state(fs.readFileSync(f));
    const ok = OFF.every((n) => s[FUSES[n]] === "0");
    console.log(`fuses ${s} (${ok ? "RunAsNode, NODE_OPTIONS and --inspect are off" : "NOT off"})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error("set-fuses: " + e.message);
    process.exit(1);
  }
}
