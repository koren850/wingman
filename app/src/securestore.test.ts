// The key store of each platform: Windows data protection (with a fake PowerShell), the owner-only file, and the platform picker.
// No real Keychain and no real PowerShell is ever started: the runners are fakes and the real ones refuse to run under the test runner.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POSIX, assertMode } from "./test-platform.ts";

const require = createRequire(import.meta.url);
const ss = require("./securestore.cjs");
const KEY = "sk-ant-TESTONLY0123456789abcdefghijkl9F2a";
const DG = "dgTESTONLY0123456789abcdefABCDEF1234Zz";
const dir = () => mkdtempSync(join(tmpdir(), "wingman-secure-"));
const everything = (d: string) => readdirSync(d, { recursive: true, encoding: "utf8" }).map((f) => join(d, f));

/** A fake PowerShell: "protect" reverses and base64-encodes the stdin, "unprotect" undoes it. */
function fakePs() {
  const calls: { which: string; input: string }[] = [];
  const run = (which: string, input: string) => {
    calls.push({ which, input });
    if (which === "protect")
      return { status: 0, stdout: Buffer.from([...input].reverse().join("") + "-padding-padding").toString("base64") + "\r\n", stderr: "" };
    if (which === "unprotect") {
      const t = Buffer.from(input.trim(), "base64").toString().replace("-padding-padding", "");
      return { status: 0, stdout: [...t].reverse().join("") + "\r\n", stderr: "" };
    }
    return { status: 2, stdout: "", stderr: "" };
  };
  return { run, calls };
}

test("Windows store: the key is encrypted on disk, never in the file as text, and comes back after a restart", () => {
  const d = dir(),
    ps = fakePs();
  const a = ss.createWindowsStore({ dataDir: d, run: ps.run });
  assert.equal(a.kind, "dpapi");
  assert.equal(a.get("anthropic"), null);
  assert.equal(a.set("anthropic", KEY), true);
  for (const f of everything(d).filter((x) => /\.dpapi$/.test(x))) assert.ok(!readFileSync(f, "utf8").includes(KEY), "plain text on disk");
  assert.ok(existsSync(join(d, "secrets", "ANTHROPIC_API_KEY.dpapi")));
  const b = ss.createWindowsStore({ dataDir: d, run: ps.run }); // a new process: no memory of the key
  assert.equal(b.get("anthropic"), KEY);
  assert.equal(b.get("deepgram"), null);
  assert.equal(b.remove("anthropic"), true);
  assert.equal(b.get("anthropic"), null);
  assert.equal(b.remove("anthropic"), false);
});

test("Windows store: PowerShell gets the key on stdin only and runs once per key per process", () => {
  const d = dir(),
    ps = fakePs();
  const s = ss.createWindowsStore({ dataDir: d, run: ps.run });
  s.set("deepgram", DG);
  const fresh = ss.createWindowsStore({ dataDir: d, run: ps.run });
  const before = ps.calls.length;
  fresh.get("deepgram");
  fresh.get("deepgram");
  fresh.get("deepgram");
  assert.equal(ps.calls.length - before, 1, "the same value is not decrypted again");
  for (const script of Object.values(ss.PS_SCRIPTS) as string[]) assert.ok(!script.includes("sk-ant") && !script.includes(DG));
  assert.match(ss.PS_SCRIPTS.protect, /ProtectedData\]::Protect/);
  assert.match(ss.PS_SCRIPTS.unprotect, /ProtectedData\]::Unprotect/);
});

test("Windows store: a failing PowerShell, a bad answer or a value that does not come back is an error that keeps nothing", () => {
  const d = dir();
  const fail = ss.createWindowsStore({ dataDir: d, run: () => ({ status: 1, stdout: "", stderr: `boom ${KEY}` }) });
  assert.throws(
    () => fail.set("anthropic", KEY),
    (e: Error) => !e.message.includes(KEY) && /could not protect/.test(e.message),
  );
  const wrong = ss.createWindowsStore({
    dataDir: d,
    run: (w: string) => ({ status: 0, stdout: w === "protect" ? "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=" : "something else", stderr: "" }),
  });
  assert.throws(() => wrong.set("anthropic", KEY), /did not return/);
  assert.ok(!existsSync(join(d, "secrets", "ANTHROPIC_API_KEY.dpapi")), "a key that did not verify is not kept");
  const broken = ss.createWindowsStore({ dataDir: d, run: () => ({ status: 1, stdout: "", stderr: "" }) });
  writeFileSync(join(d, "secrets", "DEEPGRAM_API_KEY.dpapi"), "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=\n");
  assert.equal(broken.get("deepgram"), null, "a blob that cannot be decrypted (another user, another PC) counts as missing");
});

test("Windows store: refuses keys that are not one plain token, and unknown providers", () => {
  const s = ss.createWindowsStore({ dataDir: dir(), run: fakePs().run });
  assert.throws(() => s.set("anthropic", "bad key with spaces " + "x".repeat(20)));
  assert.throws(() => s.set("openai", KEY), /Unknown provider/);
});

test("the real PowerShell runner refuses to run under the test runner", () => {
  const r = ss.realPowerShell("unprotect", "x");
  assert.equal(r.status, 126);
});

test("File store: owner-only folder and file, read back, removed", { ...POSIX }, () => {
  const d = dir();
  const s = ss.createFileStore({ dataDir: d });
  assert.equal(s.kind, "file");
  s.set("deepgram", DG);
  assert.equal(s.get("deepgram"), DG);
  assertMode(join(d, "secrets"), 0o700);
  assertMode(join(d, "secrets", "DEEPGRAM_API_KEY.key"), 0o600);
  assert.equal(s.remove("deepgram"), true);
  assert.equal(s.get("deepgram"), null);
});

test("File store works anywhere (mode bits are only checked on POSIX)", () => {
  const s = ss.createFileStore({ dataDir: dir() });
  s.set("anthropic", KEY);
  assert.equal(s.get("anthropic"), KEY);
  s.set("anthropic", DG);
  assert.equal(s.get("anthropic"), DG, "a new value replaces the old one");
});

test("the picker chooses by platform: macOS Keychain, Windows DPAPI, anything else a file", () => {
  const d = dir();
  const mac = ss.createSecureStore({ platform: "darwin", dataDir: d, macRun: () => ({ status: 44, stdout: "", stderr: "" }) });
  assert.equal(mac.kind, "keychain");
  assert.equal(mac.get("anthropic"), null);
  assert.equal(ss.createSecureStore({ platform: "win32", dataDir: d, winRun: fakePs().run }).kind, "dpapi");
  assert.equal(ss.createSecureStore({ platform: "linux", dataDir: d }).kind, "file");
});

test("Windows store: a failing PowerShell on set keeps nothing; a corrupt file reads as no key and a new set repairs it", () => {
  const d = dir(),
    ps = fakePs();
  const bad = ss.createWindowsStore({ dataDir: d, run: () => ({ status: 1, stdout: "", stderr: "x" }) });
  assert.throws(() => bad.set("anthropic", KEY), /could not protect/);
  assert.equal(bad.get("anthropic"), null);
  assert.deepEqual(
    everything(d).filter((f) => f.endsWith(".dpapi")),
    [],
  );
  const s = ss.createWindowsStore({ dataDir: d, run: ps.run });
  s.set("anthropic", KEY);
  const f = everything(d).find((x) => x.endsWith(".dpapi"))!;
  writeFileSync(f, "not-base64!!\n");
  const broken = ss.createWindowsStore({ dataDir: d, run: () => ({ status: 1, stdout: "", stderr: "bad data" }) });
  assert.equal(broken.get("anthropic"), null);
  s.set("anthropic", DG);
  assert.equal(ss.createWindowsStore({ dataDir: d, run: ps.run }).get("anthropic"), DG);
});

test("Windows store: a key is never on the PowerShell command line (only the runner input), and an unknown provider throws", () => {
  const d = dir(),
    ps = fakePs();
  const s = ss.createWindowsStore({ dataDir: d, run: ps.run });
  s.set("deepgram", DG);
  assert.ok(ps.calls.every((c) => c.which === "protect" || c.which === "unprotect"));
  assert.ok(Object.values(ss.PS_SCRIPTS).every((t) => !String(t).includes(DG)));
  assert.throws(() => s.get("openai"));
  assert.throws(() => s.set("anthropic", "bad key with spaces"));
});
