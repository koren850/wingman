"use strict";
// Where the two API keys are kept, on every platform, with one interface: get(provider), set(provider, value), remove(provider).
//   macOS    the Keychain (src/keychain.cjs, /usr/bin/security)
//   Windows  Windows data protection (DPAPI) through the PowerShell that ships with Windows. The key is encrypted for the signed-in user
//            and the encrypted text is stored in <data folder>/secrets/<NAME>.dpapi. Nothing to install.
//   other    a file in <data folder>/secrets/<NAME>.key that only the owner can read (folder 700, file 600). There is no OS keyring in v0.0.1.
// CommonJS, so the Electron main process and the tsx tools share one copy. Every backend takes an injectable runner or folder, so tests
// never reach a real Keychain or a real PowerShell: the real runner refuses to run under the node test runner.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const kc = require("./keychain.cjs");

const WIN_ENTROPY = "wingman-v1"; // not a secret: it only ties the encrypted text to this app
/** The two fixed PowerShell scripts. The key goes in on stdin and never on the command line. Windows PowerShell 5.1 is part of every supported Windows. */
const PS_HEAD =
  "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$e=[Text.Encoding]::UTF8.GetBytes('" +
  WIN_ENTROPY +
  "');$in=[Console]::In.ReadToEnd().Trim();";
const PS_SCRIPTS = Object.freeze({
  protect: PS_HEAD + "$b=[Text.Encoding]::UTF8.GetBytes($in);[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$e,'CurrentUser'))",
  unprotect:
    PS_HEAD + "$b=[Convert]::FromBase64String($in);[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$e,'CurrentUser'))",
});

/** The real PowerShell runner: run("protect" | "unprotect", stdin) -> { status, stdout, stderr }. Refuses to run under the test runner. */
function realPowerShell(which, input) {
  if (process.env.NODE_TEST_CONTEXT) return { status: 126, stdout: "", stderr: "real PowerShell is disabled under the test runner" };
  const script = PS_SCRIPTS[which];
  if (!script) return { status: 2, stdout: "", stderr: "unknown script" };
  const sys = process.env.SystemRoot || "C:\\Windows";
  const exe = path.win32.join(sys, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const r = spawnSync(
    exe,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    {
      input,
      encoding: "utf8",
      timeout: 20000,
      maxBuffer: 1 << 20,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    },
  );
  return { status: r.status === null ? 1 : r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

/** <data folder>/secrets, made with owner-only rights. */
function secretsDir(dataDir) {
  const d = path.join(dataDir, "secrets");
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}
/** Writes a small file so that only the owner can read it, and replaces any older copy in one step. */
function writeOwnerOnly(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows has no mode bits */
  }
}
function readIfThere(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
function removeIfThere(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}
const account = (p) => {
  if (!kc.PROVIDERS.includes(p)) throw new kc.KeychainError("Unknown provider.");
  return kc.ACCOUNTS[p];
};

/** Windows: DPAPI through PowerShell. `run` is injectable. A decrypted value is remembered per process (PowerShell takes about half a second to start). */
/** @param {{ dataDir: string, run?: (which: string, input: string) => { status: number, stdout: string, stderr: string } }} o */
function createWindowsStore({ dataDir, run = realPowerShell }) {
  const file = (p) => path.join(secretsDir(dataDir), account(p) + ".dpapi");
  const cache = new Map(); // blob -> value
  function get(provider) {
    const blob = readIfThere(file(provider)).trim();
    if (!blob) return null;
    if (cache.has(blob)) return cache.get(blob);
    const r = run("unprotect", blob);
    const v = r.status === 0 ? String(r.stdout).replace(/\r?\n$/, "") : "";
    if (!v) return null;
    cache.set(blob, v);
    return v;
  }
  function set(provider, value) {
    const f = file(provider);
    kc.assertSafeSecret(value);
    const r = run("protect", value);
    const blob = String(r.stdout).trim();
    if (r.status !== 0 || !/^[A-Za-z0-9+/=]{20,}$/.test(blob)) throw new kc.KeychainError("Windows could not protect the key.");
    writeOwnerOnly(f, blob + "\n");
    if (get(provider) !== value) {
      removeIfThere(f);
      throw new kc.KeychainError("Windows did not return what was saved. The key was not kept.");
    }
    return true;
  }
  function remove(provider) {
    return removeIfThere(file(provider));
  }
  return { get, set, remove, kind: "dpapi" };
}

/** Other systems: an owner-only file. Weaker than an OS store, and the app says so. */
/** @param {{ dataDir: string }} o */
function createFileStore({ dataDir }) {
  const file = (p) => path.join(secretsDir(dataDir), account(p) + ".key");
  function get(provider) {
    return readIfThere(file(provider)).trim() || null;
  }
  function set(provider, value) {
    kc.assertSafeSecret(value);
    writeOwnerOnly(file(provider), value + "\n");
    if (get(provider) !== value) throw new kc.KeychainError("The key file did not return what was saved.");
    return true;
  }
  function remove(provider) {
    return removeIfThere(file(provider));
  }
  return { get, set, remove, kind: "file" };
}

/** The store for this platform. o: { platform?, dataDir?, macRun? (the /usr/bin/security runner), winRun? (the PowerShell runner) }. */
function createSecureStore(o = {}) {
  const platform = o.platform || process.platform;
  const dataDir = o.dataDir || require("../shared/paths.cjs").dataDir();
  if (platform === "darwin") return Object.assign(kc.createKeychain(o.macRun || kc.realRunner), { kind: "keychain" });
  if (platform === "win32") return createWindowsStore({ dataDir, run: o.winRun });
  return createFileStore({ dataDir });
}
/** Plain words for where the keys are kept (the setup window and the guide use these). */
const STORE_KINDS = Object.freeze(["keychain", "dpapi", "file"]);

module.exports = { createSecureStore, createWindowsStore, createFileStore, realPowerShell, PS_SCRIPTS, STORE_KINDS };
