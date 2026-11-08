"use strict";
// Smoke mode of the packaged app: `Wingman --wingman-smoke` checks that the install is complete and that the parts that differ per
// platform really work, prints one line "WINGMAN-SMOKE {json}" and exits 0 (all good) or 1. It opens no window and uses no network, no
// microphone and no API key. CI runs it on the built Windows installer and on the .dmg build. The checks are plain functions with
// injected dependencies, so they are unit-tested on any machine.
const nodeFs = require("node:fs");
const nodeOs = require("node:os");
const nodePath = require("node:path");
const { PACKED_TOOLS } = require("./bin.cjs");
const { trayIcon } = require("./platform.cjs");

/** Files a complete packaged app must have, relative to the app folder (`root`) and to the folder next to it (`resources`). */
function expectedFiles(platform = process.platform) {
  const p = platform === "win32" ? nodePath.win32 : nodePath.posix;
  const inRoot = [
    "packaged.json",
    "package.json",
    "tray/main.cjs",
    "tray/app-entry.cjs",
    "dashboard/window.cjs",
    "overlay/main.cjs",
    "shared/entry-guard.cjs",
    "src/keychain.cjs",
    "node_modules/yaml/package.json",
    "data/example-pack/bank.yaml",
    "data/demo/demo-call.json",
    "profiles/demo-en.yaml",
    ...PACKED_TOOLS.map((t) => `src/${t}.mjs`),
  ];
  if (platform === "darwin") inRoot.push("bin/audiotee");
  const icon = trayIcon("brand", platform).file;
  return { inRoot, inResources: [icon, "brand/png/icon-512.png"].map((f) => f.split(p.sep).join("/")) };
}

/** The names of missing files (empty = complete). */
function missingFiles({ root, resources, platform = process.platform, fs = nodeFs, path: p = platform === "win32" ? nodePath.win32 : nodePath.posix }) {
  const want = expectedFiles(platform);
  return [...want.inRoot.map((f) => p.join(root, ...f.split("/"))), ...want.inResources.map((f) => p.join(resources, ...f.split("/")))].filter(
    (f) => !fs.existsSync(f),
  );
}

/** Saves, reads and deletes a made-up key in a scratch file with the real key store. Returns "" when it works, else a short reason. */
const SMOKE_KEY = "smoke-test-key-0123456789abcdef";
function keystoreProblem({ keychain }) {
  const fake = SMOKE_KEY;
  try {
    keychain.set("deepgram", fake);
    if (keychain.get("deepgram") !== fake) return "the key store returned another value";
    keychain.remove("deepgram");
    return keychain.get("deepgram") === null ? "" : "the key was not removed";
  } catch (e) {
    return String((e && e.message) || e).slice(0, 200);
  }
}

/**
 * Runs one bundled tool the way the tray does (a child of this process with the per-run token), so the parent check of
 * shared/entry-guard.cjs is exercised too. Resolves "" when the tool printed what it should and exited 0, else a short reason.
 * @param {{ execFile: any, execPath: string, env: any, tool?: string, expect?: RegExp, expectKey?: RegExp }} o
 */
function toolProblem({ execFile, execPath, env, tool = "settings-cli", expect = /Effective Wingman settings/, expectKey = undefined }) {
  return new Promise((resolve) => {
    execFile(
      execPath,
      ["--wingman-tool", tool, "--"],
      { env, timeout: 60_000, windowsHide: true, maxBuffer: 1 << 20, encoding: "utf8" },
      (err, out, errOut) => {
        if (err)
          return resolve(
            `${tool} failed: ${String(errOut || err.message)
              .trim()
              .slice(0, 200)}`,
          );
        if (!expect.test(String(out))) return resolve(`${tool} printed something unexpected`);
        // A key saved by this process must be readable in the tool process too. A per-process key store (such as Electron safeStorage) keeps its master key in the Electron
        // user-data folder, and every helper process has a folder of its own (tray/app-entry.cjs backgroundProcess), so this can really fail.
        if (expectKey && !expectKey.test(String(out)))
          return resolve(`${tool} could not read a key saved by the app (the key store differs between Wingman processes)`);
        resolve("");
      },
    );
  });
}

/**
 * The whole smoke run. Returns { ok, problems, platform, version }.
 * d: { root, resources, platform, fs, os, version, makeKeychain(scratchDir), execFile, execPath, env, newToken }
 */
async function runSmoke(d) {
  const platform = d.platform || process.platform;
  const fs = d.fs || nodeFs;
  const problems = [];
  const missing = missingFiles({ root: d.root, resources: d.resources, platform, fs });
  if (missing.length) problems.push(`missing files: ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ", ..." : ""}`);
  const scratch = fs.mkdtempSync(nodePath.join((d.os || nodeOs).tmpdir(), "wingman-smoke-"));
  try {
    // The key store is tried in a scratch file, never with the user's own keys. null = this platform has nothing to try (macOS: the real Keychain).
    const keychain = d.makeKeychain(scratch);
    const ks = keychain ? keystoreProblem({ keychain }) : "";
    if (ks) problems.push(`key store: ${ks}`);
    // Leave a made-up key in the scratch store while the tool runs: settings-cli reports whether it can read it.
    let seeded = false;
    if (keychain && !ks) {
      try {
        keychain.set("deepgram", SMOKE_KEY);
        seeded = true;
      } catch (e) {
        problems.push(`key store: ${String((e && e.message) || e).slice(0, 200)}`);
      }
    }
    const env = {
      ...d.env,
      DEEPGRAM_API_KEY: "", // a key of the machine must not make the check pass
      ANTHROPIC_API_KEY: "",
      WINGMAN_DATA_DIR: scratch,
      HOME: scratch,
      USERPROFILE: scratch,
      NO_COLOR: "1",
      WINGMAN_TOOL_TOKEN: d.newToken(),
      WINGMAN_PARENT_PID: String(d.pid || process.pid),
    };
    const t = await toolProblem({ execFile: d.execFile, execPath: d.execPath, env, expectKey: seeded ? /DEEPGRAM_API_KEY\s+present/ : undefined });
    if (t) problems.push(`tool: ${t}`);
  } finally {
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* the temp folder is cleaned by the system */
    }
  }
  return { ok: problems.length === 0, problems, platform, version: d.version };
}

/**
 * Writes the report where CI can read it. A Windows GUI program started from PowerShell has no console, so printing is not enough:
 * WINGMAN_SMOKE_OUT names a file that gets the same JSON.
 */
function writeReport(result, env = process.env, fs = nodeFs) {
  if (!env.WINGMAN_SMOKE_OUT) return;
  try {
    fs.writeFileSync(env.WINGMAN_SMOKE_OUT, JSON.stringify(result) + "\n");
  } catch {
    /* the exit code still tells */
  }
}

module.exports = { writeReport, expectedFiles, missingFiles, keystoreProblem, toolProblem, runSmoke };
