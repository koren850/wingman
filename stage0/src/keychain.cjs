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
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const SECURITY = "/usr/bin/security";
const SERVICE = "wingman";
/** provider id -> Keychain account (and env var name). Only these two live in the Keychain. */
const ACCOUNTS = Object.freeze({ deepgram: "DEEPGRAM_API_KEY", anthropic: "ANTHROPIC_API_KEY" });
const PROVIDERS = Object.freeze(Object.keys(ACCOUNTS));
/** Every env var that holds a provider key (children that do not need keys never get these). */
const KEY_ENV_VARS = Object.freeze(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "MISTRAL_API_KEY", "GROQ_API_KEY", "DEEPGRAM_API_KEY", "SONIOX_API_KEY", "GLADIA_API_KEY"]);

/** Environment for a child that does not need API keys (overlay, ffmpeg, caffeinate...). */
function childEnv(env = process.env) {
  const out = { ...env };
  for (const v of KEY_ENV_VARS) delete out[v];
  return out;
}

/** The real runner. Refuses to run inside the node test runner so a test can never reach a real Keychain by accident. */
function realRunner(args, input) {
  if (process.env.NODE_TEST_CONTEXT) return { status: 126, stdout: "", stderr: "real Keychain is disabled under the test runner" };
  const r = spawnSync(SECURITY, args, { input, encoding: "utf8", timeout: 15000, maxBuffer: 1 << 20, env: { HOME: os.homedir(), PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"], shell: false });
  return { status: r.status === null ? 1 : r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

/** Generic message only: never includes the value. Returns null when the format is acceptable. */
function checkKeyFormat(provider, value) {
  if (!PROVIDERS.includes(provider)) return "Unknown provider.";
  if (typeof value !== "string") return "That does not look like an API key.";
  if (value.length < 20 || value.length > 300 || !/^[A-Za-z0-9_.-]+$/.test(value) || value.startsWith("-")) return "That does not look like an API key (20 to 300 letters, digits, - _ . only).";
  // Anthropic keys start with sk-ant-. Deepgram's docs give no format or prefix for their keys, so only the generic check applies.
  if (provider === "anthropic" && !value.startsWith("sk-ant-")) return "An Anthropic key starts with sk-ant-.";
  return null;
}
/** Throws unless the value is one bare token that `security -i` parses unchanged (see the WRITE note above). */
function assertSafeSecret(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,300}$/.test(value) || value.startsWith("-")) throw new KeychainError("The key has characters that cannot be stored safely.");
}

class KeychainError extends Error { constructor(m) { super(m); this.name = "KeychainError"; } }

/** Remove every occurrence of the given secrets from a string. */
function scrub(text, secrets = []) {
  let s = String(text == null ? "" : text);
  for (const x of secrets) if (typeof x === "string" && x.length >= 6) s = s.split(x).join("[key]");
  return s;
}
const last4 = (v) => (typeof v === "string" && v.length >= 8 ? v.slice(-4) : "");

/** Keychain access over an injectable runner. set() verifies by reading back; get() returns null when absent. */
function createKeychain(run = realRunner) {
  const acct = (p) => { if (!PROVIDERS.includes(p)) throw new KeychainError("Unknown provider."); return ACCOUNTS[p]; };
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

// ---- keys.env helpers (legacy file) ----
/** Parses KEY=value lines (optional quotes) of the legacy keys.env. Lines with an empty value are ignored. */
function parseKeysFile(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2]) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "").trim();
  }
  return out;
}
function readKeysFile(file) { try { return parseKeysFile(fs.readFileSync(file, "utf8")); } catch { return {}; } }

/** Where each key comes from. Values never leave this function except as the last 4 characters. */
function keyStatus({ keychain, file, env = process.env }) {
  const fromFile = readKeysFile(file);
  const out = {};
  for (const p of PROVIDERS) {
    const a = ACCOUNTS[p];
    let v = null, source = "missing";
    const kc = safe(() => keychain.get(p));
    if (kc) { v = kc; source = "keychain"; }
    else if (env[a] && String(env[a]).trim()) { v = String(env[a]).trim(); source = "env"; }
    else if (fromFile[a]) { v = fromFile[a]; source = "file"; }
    out[p] = { source, last4: last4(v), inFile: !!fromFile[a], inKeychain: !!kc };
  }
  return out;
}
function safe(fn) { try { return fn(); } catch { return null; } }

/**
 * Idempotent. For each key that is in keys.env but not in the Keychain: write it, verify it (read-back), then drop that line from keys.env.
 * NO plaintext backup is made: a copy would be one more place the key lives, and the line is only removed after the Keychain returned the
 * identical value, so there is nothing a backup could restore that the Keychain does not already hold. If anything fails before the rewrite,
 * keys.env is untouched.
 * keys.env is rewritten atomically: a fresh temp file created with O_EXCL (so a pre-placed file or symlink at that name is never followed),
 * mode 600, fsync, rename. A keys.env that is itself a symlink or not a regular file is refused. The file is re-read right before the rewrite,
 * and a line is only dropped if it still holds the value that was moved (a concurrent edit is never overwritten).
 * Returns only provider ids and counts, never values. The caller (Settings button / `pnpm keys migrate`) is the only trigger.
 */
function migrateKeysToKeychain({ keychain, file }) {
  const result = { moved: [], alreadyInKeychain: [], failed: [], backup: null };
  let st; try { st = fs.lstatSync(file); } catch { return result; }
  if (st.isSymbolicLink() || !st.isFile()) throw new KeychainError("keys.env is a link or not a regular file. Nothing was changed.");
  const parsed = parseKeysFile(fs.readFileSync(file, "utf8"));
  const todo = [];
  for (const p of PROVIDERS) {
    const a = ACCOUNTS[p];
    if (!parsed[a]) continue;
    if (safe(() => keychain.get(p))) { result.alreadyInKeychain.push(p); continue; }   // never overwrite a Keychain value with the file's
    todo.push(p);
  }
  if (!todo.length) return result;
  const moved = {};
  for (const p of todo) {
    try { keychain.set(p, parsed[ACCOUNTS[p]]); moved[ACCOUNTS[p]] = parsed[ACCOUNTS[p]]; result.moved.push(p); }
    catch (e) { result.failed.push({ provider: p, reason: scrub(e.message, [parsed[ACCOUNTS[p]]]) }); }
  }
  if (Object.keys(moved).length) {
    const cur = fs.readFileSync(file, "utf8"), now = parseKeysFile(cur);
    const drop = new Set(Object.keys(moved).filter((a) => now[a] === moved[a]));
    if (drop.size) {
      const kept = cur.split("\n").filter((line) => { const m = line.match(/^\s*([A-Z_]+)\s*=/); return !(m && drop.has(m[1])); }).join("\n");
      const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
      let fd;
      try { fd = fs.openSync(tmp, "wx", 0o600); fs.writeSync(fd, kept); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(tmp, file); }
      catch { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* */ } try { fs.unlinkSync(tmp); } catch { /* */ } throw new KeychainError("The keys were saved in the Keychain but keys.env could not be rewritten. Delete the key lines there by hand."); }
    }
  }
  return result;
}

// ---- IPC-side policy (used by dashboard/keys-ipc.cjs): rate limit, key test requests ----
/** Sliding-window limiter: the returned function is true while under `max` calls per `windowMs`, and records the call. */
function createRateLimiter(max = 5, windowMs = 60000, now = () => Date.now()) {
  const hits = [];
  return () => { const t = now(); while (hits.length && t - hits[0] > windowMs) hits.shift(); if (hits.length >= max) return false; hits.push(t); return true; };
}

/** The smallest authenticated request per provider. Resolves "ok" | "invalid" | "network". Never throws, never includes the key in the result. */
async function testKey(provider, key, fetchFn = globalThis.fetch) {
  if (!PROVIDERS.includes(provider) || !key || !/^[\x21-\x7e]+$/.test(key)) return "invalid";   // printable ASCII only: no header injection from a hand-edited keys.env
  const req = provider === "deepgram"
    ? ["https://api.deepgram.com/v1/projects", { headers: { Authorization: `Token ${key}` } }]
    : ["https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } }];
  try {
    const res = await fetchFn(req[0], { method: "GET", ...req[1], redirect: "error", signal: AbortSignal.timeout(10000) });
    if (res.status >= 200 && res.status < 300) return "ok";
    if (res.status === 401 || res.status === 403) return "invalid";
    return "network";
  } catch { return "network"; }
}

module.exports = { SERVICE, ACCOUNTS, PROVIDERS, KEY_ENV_VARS, childEnv, realRunner, createKeychain, checkKeyFormat, assertSafeSecret, KeychainError, scrub, last4, parseKeysFile, keyStatus, migrateKeysToKeychain, createRateLimiter, testKey };
