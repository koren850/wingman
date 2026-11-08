"use strict";
// The ONLY module that talks to the macOS Keychain (via /usr/bin/security) and the only one that moves keys out of
// keys.env. CommonJS so both the Electron main process (dashboard/window.cjs) and the tsx/ESM tools (src/keychain.ts) use the same code.
//
// Storage: generic passwords, service "wingman", account = the env var name (DEEPGRAM_API_KEY / ANTHROPIC_API_KEY).
// Every call goes through an injectable `run(args, input)` (sync, returns {status, stdout, stderr}); tests pass a mock, so
// nothing here ever has to touch a real Keychain in a test. The real runner uses execFile semantics (spawnSync with an
// absolute path and no shell).
//
// WRITE and why `security -i`: `security add-generic-password ... -w <key>` would put the key in argv, which any user
// process can read with `ps`. Instead we start `security -i` (interactive mode, man security: "-i ... the user will be able
// to type commands on stdin until an EOF") and write the command line to its STDIN. The man page does not document the
// quoting rules; the interactive parser (security_tool's readline loop) splits a line on whitespace and honours double quotes and
// backslash escapes. So we never rely on quoting: assertSafeSecret() rejects quotes, backslashes, whitespace, control
// characters and anything outside [A-Za-z0-9_.-], and a secret starting with "-" (it could be read as an option). A secret
// that passes is one bare token that every parsing rule leaves intact. `security -i` exits 0 even when a command fails, so every
// write is verified by reading the value back and comparing in memory.
const fs = require("node:fs");
const os = require("node:os");
const nodePath = require("node:path");
// eslint-disable-next-line no-redeclare -- CommonJS module scope; deliberately shadows the global `crypto` with the node: module
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const SECURITY = "/usr/bin/security";
const SERVICE = "wingman";
/** provider id -> Keychain account (and env var name). Only these two live in the Keychain. */
const ACCOUNTS = Object.freeze({ deepgram: "DEEPGRAM_API_KEY", anthropic: "ANTHROPIC_API_KEY" });
const PROVIDERS = Object.freeze(Object.keys(ACCOUNTS));
/** Every env var that holds a provider key (children that do not need keys never get these). */
const KEY_ENV_VARS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "DEEPGRAM_API_KEY",
  "SONIOX_API_KEY",
  "GLADIA_API_KEY",
]);

/** Environment for a child that does not need API keys (overlay, ffmpeg, caffeinate...). */
function childEnv(env = process.env) {
  const out = { ...env };
  for (const v of KEY_ENV_VARS) delete out[v];
  return out;
}

/** The real runner. Refuses to run inside the node test runner so a test can never reach a real Keychain by accident. */
function realRunner(args, input) {
  if (process.env.NODE_TEST_CONTEXT) return { status: 126, stdout: "", stderr: "real Keychain is disabled under the test runner" };
  const r = spawnSync(SECURITY, args, {
    input,
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 1 << 20,
    env: { HOME: os.homedir(), PATH: "/usr/bin:/bin" },
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  return { status: r.status === null ? 1 : r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

/** Generic message only: never includes the value. Returns null when the format is acceptable. */
function checkKeyFormat(provider, value) {
  if (!PROVIDERS.includes(provider)) return "Unknown provider.";
  if (typeof value !== "string") return "That does not look like an API key.";
  if (value.length < 20 || value.length > 300 || !/^[A-Za-z0-9_.-]+$/.test(value) || value.startsWith("-"))
    return "That does not look like an API key (20 to 300 letters, digits, - _ . only).";
  // Anthropic keys start with sk-ant-. Deepgram's docs give no format or prefix for their keys, so only the generic check applies.
  if (provider === "anthropic" && !value.startsWith("sk-ant-")) return "An Anthropic key starts with sk-ant-.";
  return null;
}
/** Throws unless the value is one bare token that `security -i` parses unchanged (see the WRITE note above). */
function assertSafeSecret(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,300}$/.test(value) || value.startsWith("-"))
    throw new KeychainError("The key has characters that cannot be stored safely.");
}

class KeychainError extends Error {
  constructor(m) {
    super(m);
    this.name = "KeychainError";
  }
}

/** Remove every occurrence of the given secrets from a string. */
function scrub(text, secrets = []) {
  let s = String(text == null ? "" : text);
  for (const x of secrets) if (typeof x === "string" && x.length >= 6) s = s.split(x).join("[key]");
  return s;
}
const last4 = (v) => (typeof v === "string" && v.length >= 8 ? v.slice(-4) : "");

/** Keychain access over an injectable runner. set() verifies by reading back; get() returns null when absent. */
function createKeychain(run = realRunner) {
  const acct = (p) => {
    if (!PROVIDERS.includes(p)) throw new KeychainError("Unknown provider.");
    return ACCOUNTS[p];
  };
  function get(provider) {
    const r = run(["find-generic-password", "-s", SERVICE, "-a", acct(provider), "-w"]);
    if (r.status !== 0) return null;
    const v = String(r.stdout).replace(/\r?\n$/, "");
    return v || null;
  }
  function set(provider, value) {
    const account = acct(provider);
    assertSafeSecret(value);
    // The command line (with the secret) goes to stdin only.
    const r = run(["-i"], `add-generic-password -U -s ${SERVICE} -a ${account} -w ${value}\n`);
    if (r.status !== 0) throw new KeychainError("The Keychain refused to save the key.");
    if (get(provider) !== value) throw new KeychainError("The Keychain did not return what was saved. Nothing was changed in keys.env.");
    return true;
  }
  function remove(provider) {
    const r = run(["delete-generic-password", "-s", SERVICE, "-a", acct(provider)]);
    return r.status === 0;
  }
  return { get, set, remove };
}

// ---- Windows: Electron safeStorage (DPAPI) ----
/** Name of the file with the encrypted keys, inside the data folder. Same two keys as the Keychain; each value is base64 of the encrypted bytes. */
const SECURE_KEYS_FILE = "keys.enc.json";

/**
 * Same get / set / remove as createKeychain, for Windows, where there is no `security`. Electron's safeStorage encrypts with the Windows
 * user account (DPAPI), so a copied file is useless on another account or machine. The encrypted values sit in one small JSON file.
 * `safeStorage` and `fs` are injectable. Without Electron (plain node, a dev checkout) `safeStorage` is null: get() finds nothing and
 * set() fails, so the key lookup falls back to the environment and keys.env, as on Linux.
 * @param {{ safeStorage: any, file: string, fs?: any }} o
 */
function createSecureFileKeychain({ safeStorage, file, fs: fsImpl = fs }) {
  const acct = (p) => {
    if (!PROVIDERS.includes(p)) throw new KeychainError("Unknown provider.");
    return ACCOUNTS[p];
  };
  const usable = () => {
    try {
      return !!safeStorage && safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  };
  const readAll = () => {
    try {
      const o = JSON.parse(fsImpl.readFileSync(file, "utf8"));
      return o && typeof o === "object" && !Array.isArray(o) ? o : {};
    } catch {
      return {};
    }
  };
  const writeAll = (o) => {
    fsImpl.mkdirSync(pathOf(file).dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
    try {
      fsImpl.writeFileSync(tmp, JSON.stringify(o), { mode: 0o600, flag: "wx" });
      fsImpl.renameSync(tmp, file);
    } catch (e) {
      try {
        fsImpl.unlinkSync(tmp);
      } catch {
        /* nothing to clean */
      }
      throw e;
    }
  };
  function get(provider) {
    const account = acct(provider);
    if (!usable()) return null;
    const b64 = readAll()[account];
    if (typeof b64 !== "string" || !b64) return null;
    try {
      return safeStorage.decryptString(Buffer.from(b64, "base64")) || null;
    } catch {
      return null; // another Windows account, or a damaged file: counts as "not there"
    }
  }
  function set(provider, value) {
    const account = acct(provider);
    assertSafeSecret(value);
    if (!usable()) throw new KeychainError("Windows could not encrypt the key. Nothing was saved.");
    try {
      writeAll({ ...readAll(), [account]: safeStorage.encryptString(value).toString("base64") });
    } catch {
      throw new KeychainError("The key could not be saved.");
    }
    if (get(provider) !== value) throw new KeychainError("The saved key did not read back. Nothing was changed in keys.env.");
    return true;
  }
  function remove(provider) {
    const account = acct(provider);
    const all = readAll();
    if (!(account in all)) return false;
    delete all[account];
    try {
      writeAll(all);
      return true;
    } catch {
      return false;
    }
  }
  return { get, set, remove };
}
/** The path module that fits a file name (a Windows path with a drive letter or backslashes is handled by path.win32 on any host). */
const pathOf = (file) => (/^[A-Za-z]:|\\/.test(file) ? nodePath.win32 : nodePath);

/** Electron's safeStorage when this code runs inside Electron's main process, else null (plain node: `require("electron")` is a path string). */
function electronSafeStorage() {
  try {
    const e = require("electron");
    return e && typeof e === "object" && e.safeStorage ? e.safeStorage : null;
  } catch {
    return null;
  }
}

/**
 * The key store of this platform: macOS Keychain through `security`; Windows safeStorage in the data folder; other systems use the
 * macOS runner, which finds nothing (keys then come from the environment or keys.env). A `run` (tests) always selects the runner store.
 * @param {{ platform?: string, run?: any, safeStorage?: any, file?: string, fs?: any }} [o]
 */
function platformKeychain({ platform = process.platform, run, safeStorage, file, fs: fsImpl } = {}) {
  if (platform === "win32" && !run)
    return createSecureFileKeychain({
      safeStorage: safeStorage === undefined ? electronSafeStorage() : safeStorage,
      file: file || nodePath.win32.join(require("../shared/paths.cjs").dataDir(), SECURE_KEYS_FILE),
      fs: fsImpl,
    });
  return createKeychain(run || realRunner);
}

// ---- keys.env helpers (legacy file) ----
/** Parses KEY=value lines (optional quotes) of the legacy keys.env. Lines with an empty value are ignored. */
function parseKeysFile(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2])
      out[m[1]] = m[2]
        .trim()
        .replace(/^["']|["']$/g, "")
        .trim();
  }
  return out;
}
function readKeysFile(file) {
  try {
    return parseKeysFile(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/**
 * The one lookup order for an API key, used by the engine (env.ts) and by Settings (keyStatus), so both always agree:
 * the platform key store first (macOS Keychain, Windows safeStorage; it is where Settings saves, so a saved key always wins), then the process environment, then the legacy keys.env.
 * `provider` is set only for the two providers that can live in the Keychain; `account` is the env var / keys.env name.
 * Returns the value and where it came from; a missing key is { value: null, source: "missing" }. A Keychain error counts as "not there".
 */
/** @param {{ provider?: string | null, account: string, keychain?: any, env?: any, fromFile?: any }} o */
function resolveKey({ provider = null, account, keychain = null, env = process.env, fromFile = {} }) {
  const kc = provider && keychain ? safe(() => keychain.get(provider)) : null;
  if (kc) return { value: kc, source: "keychain" };
  const e = env[account] && String(env[account]).trim();
  if (e) return { value: e, source: "env" };
  if (fromFile[account]) return { value: fromFile[account], source: "file" };
  return { value: null, source: "missing" };
}

/** Where each key comes from. Values never leave this function except as the last 4 characters. */
/** @param {{ keychain: any, file: string, env?: any }} o */
function keyStatus({ keychain, file, env = process.env }) {
  const fromFile = readKeysFile(file);
  const out = {};
  for (const p of PROVIDERS) {
    const a = ACCOUNTS[p];
    const r = resolveKey({ provider: p, account: a, keychain, env, fromFile });
    out[p] = { source: r.source, last4: last4(r.value), inFile: !!fromFile[a], inKeychain: r.source === "keychain" || !!safe(() => keychain.get(p)) };
  }
  return out;
}
function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

/**
 * Idempotent. For each key that is in keys.env but not in the Keychain: write it, verify it (read-back), then drop that line from keys.env.
 * NO plaintext backup is made: a copy would be one more place the key lives, and the line is only removed after the Keychain returned the
 * identical value, so there is nothing a backup could restore that the Keychain does not already hold. If anything fails before the rewrite,
 * keys.env is untouched.
 * keys.env is rewritten atomically: a fresh temp file created with O_EXCL (so a pre-placed file or symlink at that name is never followed),
 * mode 600, fsync, rename. A keys.env that is itself a symlink or not a regular file is refused. The file is re-read right before the rewrite,
 * and a line is only dropped if it still holds the value that was moved (a concurrent edit is never overwritten).
 * Returns only provider ids and counts, never values. The caller (Settings button / `pnpm keys migrate`) is the only trigger.
 * @param {{ keychain: any, file: string }} o
 */
function migrateKeysToKeychain({ keychain, file }) {
  /** @type {{ moved: string[], alreadyInKeychain: string[], failed: { provider: string, reason: string }[], backup: null }} */
  const result = { moved: [], alreadyInKeychain: [], failed: [], backup: null };
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return result;
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new KeychainError("keys.env is a link or not a regular file. Nothing was changed.");
  const parsed = parseKeysFile(fs.readFileSync(file, "utf8"));
  /** @type {string[]} */
  const todo = [];
  for (const p of PROVIDERS) {
    const a = ACCOUNTS[p];
    if (!parsed[a]) continue;
    if (safe(() => keychain.get(p))) {
      result.alreadyInKeychain.push(p);
      continue;
    } // never overwrite a Keychain value with the file's
    todo.push(p);
  }
  if (!todo.length) return result;
  const moved = {};
  for (const p of todo) {
    try {
      keychain.set(p, parsed[ACCOUNTS[p]]);
      moved[ACCOUNTS[p]] = parsed[ACCOUNTS[p]];
      result.moved.push(p);
    } catch (e) {
      result.failed.push({ provider: p, reason: scrub(e.message, [parsed[ACCOUNTS[p]]]) });
    }
  }
  if (Object.keys(moved).length) {
    const cur = fs.readFileSync(file, "utf8"),
      now = parseKeysFile(cur);
    const drop = new Set(Object.keys(moved).filter((a) => now[a] === moved[a]));
    if (drop.size) {
      const kept = cur
        .split("\n")
        .filter((line) => {
          const m = line.match(/^\s*([A-Z_]+)\s*=/);
          return !(m && drop.has(m[1]));
        })
        .join("\n");
      const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
      let fd;
      try {
        fd = fs.openSync(tmp, "wx", 0o600);
        fs.writeSync(fd, kept);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(tmp, file);
      } catch {
        if (fd !== undefined)
          try {
            fs.closeSync(fd);
          } catch {
            /* */
          }
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* */
        }
        throw new KeychainError("The keys were saved in the Keychain but keys.env could not be rewritten. Delete the key lines there by hand.");
      }
    }
  }
  return result;
}

// ---- IPC-side policy (used by dashboard/keys-ipc.cjs): rate limit, key test requests ----
/** Sliding-window limiter: the returned function is true while under `max` calls per `windowMs`, and records the call. */
function createRateLimiter(max = 5, windowMs = 60000, now = () => Date.now()) {
  const hits = [];
  return () => {
    const t = now();
    while (hits.length && t - hits[0] > windowMs) hits.shift();
    if (hits.length >= max) return false;
    hits.push(t);
    return true;
  };
}

/** The smallest authenticated request per provider. Resolves "ok" | "invalid" | "network". Never throws, never includes the key in the result. */
async function testKey(provider, key, fetchFn = globalThis.fetch) {
  if (!PROVIDERS.includes(provider) || !key || !/^[\x21-\x7e]+$/.test(key)) return "invalid"; // printable ASCII only: no header injection from a hand-edited keys.env
  /** @type {[string, RequestInit]} */
  const req =
    provider === "deepgram"
      ? ["https://api.deepgram.com/v1/projects", { headers: { Authorization: `Token ${key}` } }]
      : ["https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } }];
  try {
    const res = await fetchFn(req[0], { method: "GET", ...req[1], redirect: "error", signal: AbortSignal.timeout(10000) });
    if (res.status >= 200 && res.status < 300) return "ok";
    if (res.status === 401 || res.status === 403) return "invalid";
    return "network";
  } catch {
    return "network";
  }
}

module.exports = {
  SERVICE,
  ACCOUNTS,
  PROVIDERS,
  KEY_ENV_VARS,
  childEnv,
  realRunner,
  createKeychain,
  createSecureFileKeychain,
  platformKeychain,
  SECURE_KEYS_FILE,
  checkKeyFormat,
  assertSafeSecret,
  KeychainError,
  scrub,
  last4,
  parseKeysFile,
  keyStatus,
  resolveKey,
  migrateKeysToKeychain,
  createRateLimiter,
  testKey,
};
