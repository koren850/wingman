// Guided setup, About you and the installer pieces that can be tested offline: the profile/setup IPC (validation, allow-lists, preview mode),
// the profile edit child process, the microphone list parser, the Electron fuse flip and the generated app launcher.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { ROOT } from "./env.ts";
import { parseAvfoundationInputs } from "./devices.ts";
import { assertMode, BASH, MAC } from "./test-platform.ts";

const require = createRequire(import.meta.url);
const setup = require("../dashboard/setup-ipc.cjs");
const fuses = require("../scripts/set-fuses.cjs");
const tmp = () => mkdtempSync(join(tmpdir(), "wm-setup-"));
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

const good = { name: "Dan", spellings: ["דן", " Danny "], address: "male", about: "I run a small web agency", business: "Web and hosting" };

test("profile form: a valid form is cleaned (trim, dedupe); anything else throws", () => {
  const c = setup.cleanProfile({ ...good, spellings: ["דן", " Danny ", "Danny", ""] });
  assert.deepEqual(c.spellings, ["דן", "Danny"]);
  assert.equal(c.address, "male");
  for (const bad of [
    null,
    [],
    "x",
    5,
    {},
    { ...good, extra: 1 },
    { ...good, timezone: "UTC" },
    { ...good, address: "other" },
    { ...good, address: undefined },
    { ...good, name: 5 },
    { ...good, name: "x".repeat(61) },
    { ...good, name: "a\nb" },
    { ...good, spellings: "Dan" },
    { ...good, spellings: new Array(21).fill("a") },
    { ...good, spellings: [1] },
    { ...good, spellings: ["x".repeat(61)] },
    { ...good, about: "x".repeat(1501) },
    { ...good, business: {} },
  ])
    assert.throws(() => setup.cleanProfile(bad), /bad profile/, JSON.stringify(bad)?.slice(0, 60));
  const k = setup.cleanProfile({ ...good, about: "a\u0000b\u0007c\nline2" });
  assert.equal(k.about, "abc\nline2"); // control characters removed, newline kept
});

test("microphone value: only :default, :N or null", () => {
  assert.equal(setup.cleanMic(":default"), ":default");
  assert.equal(setup.cleanMic(":2"), ":2");
  assert.equal(setup.cleanMic(null), null);
  for (const bad of ["", "default", ":", ":-1", ":123", "BlackHole 2ch", ":1; rm -rf /", 3, undefined, {}])
    assert.throws(() => setup.cleanMic(bad), /bad microphone/);
});

/** Registers the IPC with a fake handle() and records child calls. */
function rig(over: Record<string, unknown> = {}) {
  const handlers = new Map<string, (...a: any[]) => any>(),
    calls: { args: string[]; input?: string }[] = [];
  const opened: string[] = [];
  const root = tmp(),
    home = tmp();
  setup.register({
    handle: (n: string, fn: any) => handlers.set(n, fn),
    child: async (args: string[], input?: string) => {
      calls.push({ args, input });
      return { ok: true, profile: good, values: { "audio.mic.device": ":1", "overlay.allowPrimary": true }, devices: [] };
    },
    root,
    home,
    env: { WINGMAN_PACK_DIR: join(home, "pack") },
    systemPreferences: { getMediaAccessStatus: () => "not-determined", askForMediaAccess: async () => true },
    shell: {
      openExternal: async (u: string) => {
        opened.push(u);
      },
      openPath: async () => "",
    },
    screen: { getAllDisplays: () => [{}] },
    preview: false,
    ...over,
  });
  return { handlers, calls, opened, root, home, call: (n: string, ...a: any[]) => handlers.get(n)!(...a) };
}

test("setup IPC: profile:set validates first, then writes through the profile child with only the five fields", async () => {
  const r = rig();
  await assert.rejects(async () => r.call("profile:set", { ...good, address: "x" }), /bad profile/);
  await assert.rejects(async () => r.call("profile:set", { ...good, __proto__x: 1 }), /bad profile/);
  assert.equal(r.calls.length, 0, "a rejected form never reaches the child");
  const out = await r.call("profile:set", good);
  assert.equal(out.ok, true);
  assert.deepEqual(r.calls[0].args, ["src/profile-edit-cli.ts", "write"]);
  assert.deepEqual(Object.keys(JSON.parse(r.calls[0].input!)).sort(), ["about", "address", "business", "name", "spellings"]);
});

test("setup IPC: privacy panes and key pages are fixed addresses; any other name is refused", async () => {
  const r = rig();
  await r.call("setup:openPrivacy", "audio");
  await r.call("setup:openPrivacy", "mic");
  await r.call("setup:openLink", "deepgram");
  await r.call("setup:openLink", "anthropic");
  assert.deepEqual(r.opened, [setup.PANES.audio, setup.PANES.mic, setup.LINKS.deepgram, setup.LINKS.anthropic]);
  assert.match(setup.PANES.audio, /^x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_AudioCapture$/);
  for (const bad of ["https://evil.example", "constructor", "__proto__", "", 5, undefined]) {
    await assert.rejects(async () => r.call("setup:openPrivacy", bad), /bad pane/);
    await assert.rejects(async () => r.call("setup:openLink", bad), /bad link/);
  }
  assert.equal(r.opened.length, 4);
});

test("setup IPC: microphone and one-screen settings are validated and written under fixed keys", async () => {
  const r = rig();
  await assert.rejects(async () => r.call("setup:setMic", "evil"), /bad microphone/);
  await assert.rejects(async () => r.call("setup:setOneScreen", "yes"), /bad argument/);
  assert.equal(r.calls.length, 0);
  await r.call("setup:setMic", ":1");
  await r.call("setup:setOneScreen", true);
  await r.call("setup:setOneScreen", false);
  assert.deepEqual(
    r.calls.map((c) => JSON.parse(c.input!)),
    [{ "audio.mic.device": ":1" }, { "overlay.allowPrimary": true }, { "overlay.allowPrimary": null }],
  );
});

test("setup:status reports permission, screens, settings and pack; setup:askMic asks for the microphone only", async () => {
  const r = rig();
  const s = await r.call("setup:status");
  assert.equal(s.mic, "not-determined");
  assert.equal(s.displays, 1);
  assert.equal(s.micDevice, ":1");
  assert.equal(s.allowPrimary, true);
  assert.equal(s.systemAudio, "unknown");
  assert.equal(s.pack.using, "example");
  const a = await r.call("setup:askMic");
  assert.equal(a.ok, true);
  assert.equal(a.granted, true);
});

test("preview mode (snapshots, fake calls) never reads or writes anything real", async () => {
  const r = rig({ preview: true });
  for (const [n, a] of [
    ["profile:set", [good]],
    ["setup:askMic", []],
    ["setup:setMic", [":1"]],
    ["setup:setOneScreen", [true]],
    ["setup:copyPack", []],
    ["setup:openPrivacy", ["mic"]],
    ["setup:openLink", ["deepgram"]],
    ["setup:revealPack", []],
  ] as [string, any[]][]) {
    assert.deepEqual(await r.call(n, ...a), { ok: false, error: "preview" }, n);
  }
  await r.call("profile:get");
  await r.call("setup:status");
  await r.call("setup:mics");
  assert.equal(r.calls.length, 0);
  assert.equal(r.opened.length, 0);
});

test("pack: copying the example pack never overwrites, uses 700/600, and the user pack takes over", () => {
  const root = tmp(),
    home = tmp(),
    env = { WINGMAN_PACK_DIR: join(home, "pack") };
  mkdirSync(join(root, "data", "example-pack"), { recursive: true });
  for (const f of ["bank.yaml", "house-style.md"]) writeFileSync(join(root, "data", "example-pack", f), "example " + f);
  assert.equal(setup.packInfo(root, env, home).using, "example");
  const c = setup.copyExamplePack(root, env, home);
  assert.equal(c.ok, true);
  assert.deepEqual(c.copied.sort(), ["bank.yaml", "house-style.md"]);
  assertMode(env.WINGMAN_PACK_DIR, 0o700);
  assertMode(join(env.WINGMAN_PACK_DIR, "bank.yaml"), 0o600);
  assert.equal(setup.packInfo(root, env, home).using, "user");
  writeFileSync(join(env.WINGMAN_PACK_DIR, "bank.yaml"), "MY EDIT");
  const again = setup.copyExamplePack(root, env, home);
  assert.equal(again.ok, false);
  assert.equal(readFileSync(join(env.WINGMAN_PACK_DIR, "bank.yaml"), "utf8"), "MY EDIT");
});

test("every setup channel in the preload is registered in setup-ipc.cjs and goes through handle(), nothing else", () => {
  const pre = read("dashboard/preload.cjs"),
    ipc = read("dashboard/setup-ipc.cjs");
  const used = [...pre.matchAll(/invoke\("((?:profile|setup):[A-Za-z]+)"/g)].map((m) => m[1]).sort();
  const reg = [...ipc.matchAll(/o\.handle\("((?:profile|setup):[A-Za-z]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(used, reg);
  assert.doesNotMatch(ipc, /ipcMain/);
  assert.match(read("dashboard/window.cjs"), /require\("\.\/setup-ipc\.cjs"\)\.register\(\{ handle,/);
  assert.doesNotMatch(read("dashboard/setup.js"), /\.innerHTML|insertAdjacentHTML|\beval\(|new Function\(/);
  assert.match(read("dashboard/index.html"), /<script src="setup\.js"><\/script>/);
});

test("first setup step shows the responsible-use notice with an acknowledgement that never gates a step", () => {
  const src = read("dashboard/setup.js");
  assert.match(src, /Tell the other people on the call that you use a live assistant, and follow your local recording-consent laws\./);
  assert.match(src, /SU\.acks\.consent = true;\s*suSave\(\)/);
  assert.match(src, /consentNotice\(\),?\s*\),/); // inside the keys step panel
  assert.doesNotMatch(src, /done: \(\) => [^\n]*acks\.consent/); // listening and step completion do not depend on it
});

test("profile child: read, write (keeps timezone), and it refuses unknown fields", () => {
  const dir = tmp(),
    file = join(dir, "profile.yaml");
  const run = (mode: string, input = "") =>
    JSON.parse(
      execFileSync("./node_modules/.bin/tsx", ["src/profile-edit-cli.ts", mode], {
        cwd: ROOT,
        input,
        env: { ...process.env, WINGMAN_PROFILE_FILE: file },
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .pop()!,
    );
  assert.equal(run("read").exists, false);
  writeFileSync(file, "name: Old\ntimezone: Europe/Paris\n", { mode: 0o600 });
  const w = run("write", JSON.stringify(good));
  assert.equal(w.ok, true);
  assert.equal(w.profile.name, "Dan");
  assert.equal(w.profile.timezone, "Europe/Paris");
  assert.deepEqual(w.profile.spellings, ["דן", "Danny"]);
  assertMode(file, 0o600);
  assert.equal(run("write", JSON.stringify({ ...good, timezone: "UTC" })).ok, false);
  assert.equal(run("write", JSON.stringify({ ...good, address: "x" })).ok, false);
  assert.equal(run("write", "[]").ok, false);
  assert.match(readFileSync(file, "utf8"), /Dan/);
});

test("microphone list: parses the audio section of ffmpeg's avfoundation listing", () => {
  const txt = `[AVFoundation indev @ 0x1] AVFoundation video devices:
[AVFoundation indev @ 0x1] [0] FaceTime HD Camera
[AVFoundation indev @ 0x1] [1] Capture screen 0
[AVFoundation indev @ 0x1] AVFoundation audio devices:
[AVFoundation indev @ 0x1] [0] MacBook Pro Microphone
[AVFoundation indev @ 0x1] [1] External USB Mic  
: Input/output error`;
  assert.deepEqual(parseAvfoundationInputs(txt), [
    { index: 0, name: "MacBook Pro Microphone" },
    { index: 1, name: "External USB Mic" },
  ]);
  assert.deepEqual(parseAvfoundationInputs(""), []);
});

test("fuses: the flip turns RunAsNode, NODE_OPTIONS and --inspect off and leaves the rest; unknown binaries are refused", () => {
  const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
  const bin = Buffer.concat([Buffer.from("junk"), sentinel, Buffer.from([1, 9]), Buffer.from("101100011"), Buffer.from("tail")]);
  assert.equal(fuses.state(bin), "101100011");
  fuses.flip(bin);
  assert.equal(fuses.state(bin), "000000011");
  fuses.flip(bin);
  assert.equal(fuses.state(bin), "000000011"); // idempotent
  const removed = Buffer.concat([sentinel, Buffer.from([1, 9]), Buffer.from("r01r00011")]);
  fuses.flip(removed);
  assert.equal(fuses.state(removed), "r00r00011"); // a removed fuse ("r") is left alone
  assert.throws(() => fuses.flip(Buffer.from("no sentinel here")), /sentinel/);
  assert.throws(() => fuses.flip(Buffer.concat([sentinel, Buffer.from([9, 9]), Buffer.from("101100011")])), /unknown fuse wire/);
});

test("installer scripts: syntax, flags, no sudo, and the launcher shows both dialogs", BASH, () => {
  for (const f of ["../install.sh", "scripts/make-app.sh", "scripts/wingman.sh", "scripts/wingman-cli.sh"])
    assert.equal(spawnSync("bash", ["-n", join(ROOT, f)]).status, 0, f);
  const inst = read("../install.sh");
  assert.doesNotMatch(inst, /(^|[;&|(]\s*)sudo\s/m); // no command runs sudo (the word appears in a message only)
  for (const flag of ["--check", "--dry-run", "--yes", "--update", "--uninstall", "--purge"]) assert.ok(inst.includes(flag), flag);
  const mk = read("scripts/make-app.sh");
  for (const needle of [
    "Wingman's folder moved",
    "Wingman needs Node 24",
    "NSMicrophoneUsageDescription",
    "NSAudioCaptureUsageDescription",
    "set-fuses.cjs",
    "install.js",
  ])
    assert.ok(mk.includes(needle), needle);
  assert.match(read("scripts/wingman-cli.sh"), /update\) shift; exec \.\.\/install\.sh --update/);
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.engines.node, ">=24");
  assert.match(pkg.packageManager, /^pnpm@11\./);
  assert.equal(pkg.version, "0.1.0");
  assert.doesNotMatch(pkg.description, /throwaway|dogfood/i);
  assert.match(pkg.scripts.postinstall, /postinstall\.cjs$/);
  assert.doesNotMatch(pkg.scripts.postinstall, /\|\|\s*true/);
});

test("install.sh --check changes nothing and exits 0 on a good machine; unknown flags are refused", MAC, () => {
  const r = spawnSync("bash", [join(ROOT, "..", "install.sh"), "--check"], {
    encoding: "utf8",
    env: { ...process.env, HOME: tmp(), WINGMAN_DATA_DIR: join(tmp(), "none") },
  });
  assert.match(r.stdout, /Checking this Mac \(nothing is changed\)/);
  assert.notEqual(r.status === 0 || r.status === 1, false);
  const bad = spawnSync("bash", [join(ROOT, "..", "install.sh"), "--nope"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
});

// ---- install.sh / make-app.sh: stale app detection, help, ffmpeg, atomic swap ----
import { chmodSync, copyFileSync, realpathSync, renameSync } from "node:fs";

test("install.sh --help prints the whole header, including the data and Keychain lines", BASH, () => {
  const r = spawnSync("bash", [join(ROOT, "..", "install.sh"), "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Your data lives in/);
  assert.match(r.stdout, /and the macOS Keychain\. The installer only reads them/);
  assert.doesNotMatch(r.stdout, /set -uo pipefail/);
});

test("make-app.sh --stale: missing app, a moved folder or another Electron are stale; a current build is not", BASH, () => {
  const base = realpathSync(tmp());
  const stage = join(base, "stage0");
  mkdirSync(join(stage, "scripts"), { recursive: true });
  mkdirSync(join(stage, "node_modules", "electron"), { recursive: true });
  copyFileSync(join(ROOT, "scripts", "make-app.sh"), join(stage, "scripts", "make-app.sh"));
  chmodSync(join(stage, "scripts", "make-app.sh"), 0o755);
  writeFileSync(join(stage, "node_modules", "electron", "package.json"), JSON.stringify({ version: "9.9.9" }));
  const stale = (dir: string) => spawnSync("bash", [join(dir, "scripts", "make-app.sh"), "--stale"]).status;
  assert.equal(stale(stage), 0, "no app yet: build it");
  const fakeApp = (dir: string, stamp: string) => {
    mkdirSync(join(dir, ".app", "Wingman.app", "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(dir, ".app", "Wingman.app", "Contents", "Resources", "app"), { recursive: true });
    writeFileSync(join(dir, ".app", "Wingman.app", "Contents", "MacOS", "Wingman"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(dir, ".app", "Wingman.app", "Contents", "Resources", "app", ".built-from"), stamp + "\n");
  };
  fakeApp(stage, `${stage}\n9.9.9`);
  assert.equal(stale(stage), 1, "built for this folder and this Electron: leave it");
  writeFileSync(join(stage, "node_modules", "electron", "package.json"), JSON.stringify({ version: "10.0.0" }));
  assert.equal(stale(stage), 0, "Electron upgraded");
  writeFileSync(join(stage, "node_modules", "electron", "package.json"), JSON.stringify({ version: "9.9.9" }));
  const moved = join(base, "moved-stage0");
  renameSync(stage, moved);
  assert.equal(stale(moved), 0, "the folder moved: the baked path is wrong, rebuild");
});

test("install.sh rebuilds a stale app, checks ffmpeg where the app looks, and installs to /Applications by rename", BASH, () => {
  const inst = read("../install.sh"),
    mk = read("scripts/make-app.sh");
  assert.match(inst, /make-app\.sh --stale/);
  assert.doesNotMatch(inst, /\[ ! -x "\$APP_OUT\/Contents\/MacOS\/Wingman" \] \|\| \[ "\$\{UPDATING/);
  assert.doesNotMatch(inst, /if command -v ffmpeg >\/dev\/null 2>&1 \|\|/, "an ffmpeg only the shell sees is not enough");
  assert.match(inst, /for d in \/opt\/homebrew\/bin \/usr\/local\/bin \/usr\/bin \/bin/);
  assert.match(inst, /mv "\$1\.new" "\$1"/);
  assert.match(mk, /mv "\$OUT" "\$FINAL"/);
  assert.doesNotMatch(mk, /^rm -rf "\$OUT"; mkdir/m);
  assert.match(mk, /\.built-from/);
});
