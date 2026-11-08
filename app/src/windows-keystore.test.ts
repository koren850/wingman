// The Windows key store (safeStorage + one JSON file), the entry guard on Windows and the platform helpers.
// Everything uses a fake safeStorage and an in-memory file system and runs on any host: no real DPAPI, no real keys.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { migrateKeysToKeychain, resolveKey } from "./keychain.ts";

const require = createRequire(import.meta.url);
const kc = require("./keychain.cjs");
const guard = require("../shared/entry-guard.cjs");
const platform = require("../shared/platform.cjs");

const FILE = "C:\\Users\\sam\\AppData\\Roaming\\Wingman\\keys.enc.json";
const KEY = "sk-ant-TESTONLY0123456789abcdefghijkl9F2a";
const DG = "dgTESTONLY0123456789abcdefABCDEF1234Zz";

/** A safeStorage that "encrypts" by reversing the bytes and adding a marker, so a plain value never appears in the file. */
function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s: string) => Buffer.from("ENC:" + [...s].reverse().join("")),
    decryptString: (b: Buffer) => {
      const t = b.toString();
      if (!t.startsWith("ENC:")) throw new Error("bad data");
      return [...t.slice(4)].reverse().join("");
    },
  };
}
/** A tiny in-memory fs with the calls the key store makes. */
function memFs() {
  const files = new Map<string, string>();
  const dirs: string[] = [];
  return {
    files,
    dirs,
    readFileSync: (f: string) => {
      if (!files.has(f)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files.get(f)!;
    },
    writeFileSync: (f: string, d: string, o?: { flag?: string }) => {
      if (o?.flag === "wx" && files.has(f)) throw new Error("EEXIST");
      files.set(f, String(d));
    },
    renameSync: (a: string, b: string) => {
      files.set(b, files.get(a)!);
      files.delete(a);
    },
    unlinkSync: (f: string) => void files.delete(f),
    mkdirSync: (d: string) => void dirs.push(d),
  };
}

test("windows key store: set, get, remove; the file never holds the plain key", () => {
  const fs = memFs();
  const k = kc.createSecureFileKeychain({ safeStorage: fakeSafeStorage(), file: FILE, fs });
  assert.equal(k.get("anthropic"), null);
  assert.equal(k.set("anthropic", KEY), true);
  assert.equal(k.set("deepgram", DG), true);
  assert.equal(k.get("anthropic"), KEY);
  assert.equal(k.get("deepgram"), DG);
  const text = fs.files.get(FILE)!;
  assert.ok(!text.includes(KEY) && !text.includes(DG), "plain key in the file");
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["ANTHROPIC_API_KEY", "DEEPGRAM_API_KEY"]);
  assert.deepEqual(fs.dirs, [`C:\\Users\\sam\\AppData\\Roaming\\Wingman`, `C:\\Users\\sam\\AppData\\Roaming\\Wingman`]); // the folder is made with the win32 path rules
  assert.equal(k.remove("anthropic"), true);
  assert.equal(k.get("anthropic"), null);
  assert.equal(k.get("deepgram"), DG);
  assert.equal(k.remove("anthropic"), false);
  assert.ok(![...fs.files.keys()].some((f) => f.includes(".tmp-")), "temp file left behind");
});

test("windows key store: nothing works without safeStorage, and bad data counts as missing", () => {
  const fs = memFs();
  const off = kc.createSecureFileKeychain({ safeStorage: fakeSafeStorage(false), file: FILE, fs });
  assert.equal(off.get("anthropic"), null);
  assert.throws(() => off.set("anthropic", KEY), /could not encrypt/);
  const none = kc.createSecureFileKeychain({ safeStorage: null, file: FILE, fs });
  assert.equal(none.get("deepgram"), null);
  assert.throws(() => none.set("deepgram", DG), /could not encrypt/);
  fs.files.set(FILE, "not json");
  const k = kc.createSecureFileKeychain({ safeStorage: fakeSafeStorage(), file: FILE, fs });
  assert.equal(k.get("anthropic"), null);
  assert.equal(k.set("anthropic", KEY), true); // a damaged file is replaced
  fs.files.set(FILE, JSON.stringify({ ANTHROPIC_API_KEY: Buffer.from("other account").toString("base64") }));
  assert.equal(k.get("anthropic"), null); // cannot be decrypted by this account
  assert.throws(() => k.get("nobody"), /Unknown provider/);
  assert.throws(() => k.set("anthropic", "has space in it"), /cannot be stored safely/);
});

test("windows key store: a failed write is reported without the key", () => {
  const fs = memFs();
  fs.writeFileSync = () => {
    throw new Error("disk full " + KEY);
  };
  const k = kc.createSecureFileKeychain({ safeStorage: fakeSafeStorage(), file: FILE, fs });
  assert.throws(
    () => k.set("anthropic", KEY),
    (e: Error) => !e.message.includes(KEY) && /could not be saved/.test(e.message),
  );
});

test("platform key store: Windows uses safeStorage, a test runner or macOS uses the security runner", () => {
  const fs = memFs();
  const win = kc.platformKeychain({ platform: "win32", safeStorage: fakeSafeStorage(), file: FILE, fs });
  win.set("anthropic", KEY);
  assert.ok(fs.files.has(FILE));
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    return { status: 44, stdout: "", stderr: "" };
  };
  assert.equal(kc.platformKeychain({ platform: "darwin", run }).get("anthropic"), null);
  assert.equal(kc.platformKeychain({ platform: "win32", run }).get("anthropic"), null); // an injected runner always wins
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "find-generic-password");
  // plain node on Windows (a dev checkout): no Electron, so no store, and the lookup falls through to the environment
  const dev = kc.platformKeychain({ platform: "win32", file: FILE, fs: memFs() });
  assert.equal(dev.get("anthropic"), null);
  assert.deepEqual(resolveKey({ provider: "anthropic", account: "ANTHROPIC_API_KEY", keychain: dev, env: { ANTHROPIC_API_KEY: KEY } }), {
    value: KEY,
    source: "env",
  });
  assert.deepEqual(resolveKey({ provider: "anthropic", account: "ANTHROPIC_API_KEY", keychain: win, env: { ANTHROPIC_API_KEY: "other" } }), {
    value: KEY,
    source: "keychain",
  });
});

test("windows key store: keys.env moves into it like into the Keychain", async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "wm-winkeys-"));
  const file = join(dir, "keys.env");
  writeFileSync(file, `ANTHROPIC_API_KEY=${KEY}\nDEEPGRAM_API_KEY=${DG}\nOTHER=1\n`);
  const k = kc.createSecureFileKeychain({ safeStorage: fakeSafeStorage(), file: FILE, fs: memFs() });
  const r = migrateKeysToKeychain({ keychain: k, file });
  assert.deepEqual([...r.moved].sort(), ["anthropic", "deepgram"]);
  assert.equal(k.get("anthropic"), KEY);
  assert.equal(readFileSync(file, "utf8"), "OTHER=1\n");
});

test("entry guard on Windows: the parent is found by image name (tasklist)", () => {
  const out = (pid: number, name: string) => `"${name}","${pid}","Console","1","90,000 K"\r\n`;
  const run = (_cmd: string, args: string[]) => {
    assert.match(_cmd, /tasklist\.exe$/);
    const pid = Number(args[1].replace("PID eq ", ""));
    return pid === 4242 ? out(4242, "Wingman.exe") : pid === 99 ? out(99, "cmd.exe") : "INFO: No tasks are running which match the specified criteria.\r\n";
  };
  assert.equal(guard.exeOf(4242, "win32", run), "Wingman.exe");
  assert.equal(guard.exeOf(7, "win32", run), "");
  assert.equal(
    guard.exeOf(4242, "win32", () => {
      throw new Error("no tasklist");
    }),
    "",
  );
  const execPath = "C:\\Users\\sam\\AppData\\Local\\Programs\\Wingman\\Wingman.exe";
  const env = { WINGMAN_TOOL_TOKEN: "a".repeat(48) };
  const exe = (p: number) => guard.exeOf(p, "win32", run);
  assert.equal(guard.callerProblem({ env, ppid: 4242, execPath, exe, platform: "win32" }), null); // case and folder do not matter
  assert.equal(guard.callerProblem({ env, ppid: 4242, execPath: execPath.toUpperCase(), exe, platform: "win32" }), null);
  assert.match(String(guard.callerProblem({ env, ppid: 99, execPath, exe, platform: "win32" })), /not started/); // a command prompt
  assert.match(String(guard.callerProblem({ env: {}, ppid: 4242, execPath, exe, platform: "win32" })), /only be started/);
  // the background summary outlives its parent: Windows keeps the old pid, which no process has any more
  const late = { env: { ...env, WINGMAN_PARENT_PID: "4242" }, ppid: 555, execPath, tool: "summary", platform: "win32" };
  assert.equal(guard.callerProblem({ ...late, exe }), null);
  assert.equal(guard.callerProblem({ ...late, exe: (p: number) => (p === 555 ? "" : "") }), null);
  assert.match(String(guard.callerProblem({ ...late, tool: "call", exe })), /not started/);
  assert.match(String(guard.callerProblem({ ...late, ppid: 99, exe })), /not started/); // parent still alive and not Wingman
  assert.match(String(guard.callerProblem({ ...late, env, exe })), /not started/); // no spawner pid
  assert.match(String(guard.callerProblem({ ...late, exe: (p: number) => (p === 555 ? "" : "cmd.exe") })), /not started/);
});

test("platform helpers: PATH is extended only on macOS, the tray icon fits the platform", () => {
  assert.equal(platform.appPath("/usr/bin:/bin", "darwin"), "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin");
  assert.equal(platform.appPath(undefined, "darwin"), "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
  assert.equal(platform.appPath("C:\\Windows\\System32;C:\\Tools", "win32"), "C:\\Windows\\System32;C:\\Tools");
  assert.deepEqual(platform.trayIcon("C:\\app\\resources\\brand", "win32"), { file: "C:\\app\\resources\\brand\\wingman.ico", template: false });
  assert.deepEqual(platform.trayIcon("/app/brand", "darwin"), { file: "/app/brand/png/trayTemplate.png", template: true });
});
