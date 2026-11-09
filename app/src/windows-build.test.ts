// The Windows build: which platform is built, the electron-builder config, the after-pack hook, the stage and the smoke mode.
// Nothing here needs Windows: paths are the win32 flavour where it matters, and the real Windows run is the CI job (see the build-windows report).
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = require("../scripts/build-target.cjs");
const afterPack = require("../scripts/after-pack.cjs");
const fuses = require("../scripts/set-fuses.cjs");
const smoke = require("../shared/smoke.cjs");
const bin = require("../shared/bin.cjs");

test("build target: the host platform by default, --win and --mac override, Linux is refused", () => {
  assert.equal(target.targetPlatform([], "darwin"), "darwin");
  assert.equal(target.targetPlatform([], "win32"), "win32");
  assert.equal(target.targetPlatform(["--win"], "darwin"), "win32");
  assert.equal(target.targetPlatform(["--mac"], "win32"), "darwin");
  assert.throws(() => target.targetPlatform(["--win", "--mac"], "darwin"), /only one/);
  assert.throws(() => target.targetPlatform([], "linux"), /no packaged app for linux/);
  assert.equal(target.targetPlatform(["--win"], "linux"), "win32"); // staging for Windows works anywhere
});

test("build plan: NSIS x64 on Windows, dmg arm64 on macOS, no foreign builds, audiotee on macOS only", () => {
  const w = target.planFor("win32", [], "win32");
  assert.deepEqual(w.builderArgs, ["--win", "nsis", "--x64", "--publish", "never"]);
  assert.equal(w.audiotee, false);
  assert.equal(w.installerGlob, "Wingman-Setup-*-x64.exe");
  assert.equal(w.unpackedDir, "win-unpacked");
  const m = target.planFor("darwin", ["--dir"], "darwin");
  assert.deepEqual(m.builderArgs, ["--mac", "dir", "--arm64", "--publish", "never"]);
  assert.equal(m.audiotee, true);
  assert.deepEqual(target.planFor("win32", ["--dir"], "win32").builderArgs, ["--win", "dir", "--x64", "--publish", "never"]);
  assert.throws(() => target.planFor("win32", [], "darwin"), /built on Windows/);
  assert.throws(() => target.planFor("darwin", [], "win32"), /built on macOS/);
  assert.equal(target.planFor("win32", ["--stage-only"], "darwin").stageOnly, true);
});

test("electron-builder config: per-user one-click NSIS installer for x64, unsigned, icon set", () => {
  const c = require("../electron-builder.cjs");
  assert.deepEqual(c.win.target, [{ target: "nsis", arch: ["x64"] }]);
  assert.match(c.win.artifactName, /^Wingman-Setup-\$\{version\}-\$\{arch\}\.\$\{ext\}$/);
  assert.ok(c.win.icon.endsWith("wingman.ico") && existsSync(c.win.icon));
  assert.equal(c.nsis.perMachine, false);
  assert.equal(c.nsis.oneClick, true);
  assert.equal(c.nsis.allowElevation, false);
  assert.equal(c.nsis.deleteAppDataOnUninstall, false);
  assert.equal(c.asar, false);
  assert.ok(c.extraResources.some((r: { filter: string[] }) => r.filter.includes("wingman.ico")));
  assert.deepEqual(c.mac.target, [{ target: "dmg", arch: ["arm64"] }]); // macOS is unchanged
  assert.equal(c.mac.identity, null);
});

test("release workflows: the installer name in the workflow matches the build plan", () => {
  const wf = readFileSync(join(APP, "..", ".github", "workflows", "release.yml"), "utf8");
  assert.ok(wf.includes(target.planFor("win32", ["--stage-only"], "win32").installerGlob));
  assert.ok(wf.includes(target.planFor("darwin", ["--stage-only"], "darwin").installerGlob));
  assert.match(wf, /windows-latest/);
  assert.match(wf, /macos-latest/);
});

test("after-pack: fuses for both platforms, ad hoc signing only for an unsigned macOS build", () => {
  const j = (...p: string[]) => p.join("/");
  assert.deepEqual(afterPack.planFor("darwin", "/o/mac-arm64", "Wingman", {}, j), { target: "/o/mac-arm64/Wingman.app", adHoc: true });
  assert.deepEqual(afterPack.planFor("darwin", "/o/mac-arm64", "Wingman", { WINGMAN_SIGN: "1" }, j), { target: "/o/mac-arm64/Wingman.app", adHoc: false });
  assert.deepEqual(afterPack.planFor("win32", "/o/win-unpacked", "Wingman", {}, j), { target: "/o/win-unpacked/Wingman.exe", adHoc: false });
  assert.equal(afterPack.planFor("linux", "/o/linux-unpacked", "Wingman", {}, j), null);
});

test(
  "after-pack: camera and Bluetooth usage texts are removed from the app and its helpers, the microphone text stays",
  { skip: process.platform !== "darwin" && "plutil is macOS only" },
  () => {
    const j = (...p: string[]) => p.join("/");
    assert.deepEqual(afterPack.plistPaths("/o/Wingman.app", [""], j), [
      "/o/Wingman.app/Contents/Info.plist",
      "/o/Wingman.app/Contents/Frameworks/Wingman Helper.app/Contents/Info.plist",
    ]);
    const dir = mkdtempSync(join(tmpdir(), "wingman-plist-"));
    try {
      const app = join(dir, "Wingman.app");
      const files = afterPack.plistPaths(app);
      for (const f of files) {
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(
          f,
          `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>NSCameraUsageDescription</key><string>c</string><key>NSBluetoothAlwaysUsageDescription</key><string>b</string><key>NSMicrophoneUsageDescription</key><string>m</string></dict></plist>`,
        );
      }
      afterPack.stripUnusedPlistKeys(app);
      for (const f of files) {
        const t = readFileSync(f, "utf8");
        assert.ok(!/Camera|Bluetooth/.test(t), f);
        assert.ok(t.includes("NSMicrophoneUsageDescription"), f);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("set-fuses: the binary is found for a .app, an .exe and an unpacked folder, and the fuses flip in an exe-like buffer", () => {
  assert.match(fuses.binaryOf("/x/Wingman.app"), /Electron Framework$/);
  assert.equal(fuses.binaryOf("/x/Wingman.exe"), "/x/Wingman.exe");
  assert.equal(fuses.binaryOf("/x/Wingman.EXE"), "/x/Wingman.EXE");
  assert.match(fuses.binaryOf(join("x", "win-unpacked")), /win-unpacked[\\/]Wingman\.exe$/);
  // make-app.sh builds into a temp folder whose name does not end in .app: the framework inside makes it a macOS bundle
  const tmpApp = "/x/.Wingman.app.build.123";
  assert.match(
    fuses.binaryOf(tmpApp, (p: string) => p === join(tmpApp, "Contents", "Frameworks", "Electron Framework.framework")),
    /Electron Framework$/,
  );
  assert.match(
    fuses.binaryOf(tmpApp, () => false),
    /Wingman\.exe$/,
  );
  // MZ header, some bytes, the sentinel, version 1, 9 fuses: RunAsNode on, cookie encryption on, NODE_OPTIONS on, inspect on, the rest left alone
  const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
  const buf = Buffer.concat([Buffer.from("MZ\0\0pad"), sentinel, Buffer.from([1, 9]), Buffer.from("111100001")]);
  assert.equal(fuses.state(fuses.flip(buf)), "011000001"[0] + "1" + "0" + "0" + "0000" + "1");
});

test("packaged tools: a Windows path with backslashes names the tool", () => {
  const exe = "C:\\Users\\sam\\AppData\\Local\\Programs\\Wingman\\Wingman.exe";
  const c = bin.binCommand("tsx", ["C:\\app\\src\\run.ts", "--profile", "demo"], "C:\\app", { packaged: true, execPath: exe, platform: "win32" });
  assert.deepEqual(c, { cmd: exe, args: ["--wingman-tool", "run", "--", "--profile", "demo"] });
  assert.throws(() => bin.binCommand("tsx", ["C:\\app\\src\\gate.ts"], "C:\\app", { packaged: true, execPath: exe }), /not part of the packaged app/);
});

test("stage for Windows: complete, no audiotee, the smoke check finds nothing missing", { timeout: 120_000 }, () => {
  const r = spawnSync(process.execPath, [join(APP, "scripts", "package-app.cjs"), "--win", "--stage-only"], { cwd: APP, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const stage = join(APP, ".stage");
  assert.equal(existsSync(join(stage, "bin")), false);
  assert.ok(
    existsSync(join(stage, "src", "keychain.cjs")) && existsSync(join(stage, "shared", "platform.cjs")) && existsSync(join(stage, "shared", "smoke.cjs")),
  );
  assert.equal(JSON.parse(readFileSync(join(stage, "package.json"), "utf8")).main, "tray/app-entry.cjs");
  // Lay the resources folder out like electron-builder does (brand next to the app) and run the file check the way the packaged app does.
  const res = mkdtempSync(join(tmpdir(), "wm-res-"));
  try {
    mkdirSync(join(res, "brand", "png"), { recursive: true });
    writeFileSync(join(res, "brand", "wingman.ico"), "ico");
    writeFileSync(join(res, "brand", "png", "icon-512.png"), "png");
    assert.deepEqual(smoke.missingFiles({ root: stage, resources: res, platform: "win32", path }), []);
    rmSync(join(res, "brand", "wingman.ico"));
    assert.equal(smoke.missingFiles({ root: stage, resources: res, platform: "win32", path }).length, 1);
  } finally {
    rmSync(res, { recursive: true, force: true });
  }
});

test("smoke mode: a key saved by the app must be readable by the tool process", async () => {
  const fsOk = { existsSync: () => true, mkdtempSync: () => "/scratch", rmSync: () => undefined };
  const store = new Map<string, string>();
  const keychain = { set: (p: string, v: string) => store.set(p, v), get: (p: string) => store.get(p) ?? null, remove: (p: string) => store.delete(p) };
  const run = (toolSees: boolean) =>
    smoke.runSmoke({
      root: "/app",
      resources: "/res",
      platform: "win32",
      fs: fsOk,
      version: "0.0.1",
      makeKeychain: () => keychain,
      execFile: (_e: string, _a: string[], o: { env: Record<string, string> }, cb: (e: null, out: string, err: string) => void) => {
        assert.equal(o.env.DEEPGRAM_API_KEY, ""); // a key of this machine cannot make the check pass
        const present = toolSees && store.get("deepgram") ? "present" : "missing";
        cb(null, `Effective Wingman settings\n  DEEPGRAM_API_KEY   ${present}\n`, "");
      },
      execPath: "C:\\Wingman.exe",
      env: { DEEPGRAM_API_KEY: "real-machine-key" },
      newToken: () => "a".repeat(48),
    });
  assert.equal((await run(true)).ok, true);
  const r = await run(false);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /could not read a key saved by the app/);
});

test("smoke mode: reports every problem, tries the key store in a scratch folder, runs a bundled tool", async () => {
  const fsOk = { existsSync: () => true, mkdtempSync: () => "/scratch", rmSync: () => undefined };
  const mk = (over = {}) => ({
    root: "/app",
    resources: "/res",
    platform: "win32",
    fs: fsOk,
    version: "0.0.1",
    makeKeychain: (_dir: string) => null,
    execFile: (_exe: string, args: string[], o: { env: Record<string, string> }, cb: (e: Error | null, out: string, err: string) => void) => {
      assert.deepEqual(args, ["--wingman-tool", "settings-cli", "--"]);
      assert.match(o.env.WINGMAN_TOOL_TOKEN, /^[0-9a-f]{48}$/);
      assert.equal(o.env.WINGMAN_DATA_DIR, "/scratch"); // never the user's own folder
      cb(null, "Effective Wingman settings (layers: ...)", "");
    },
    execPath: "C:\\Wingman.exe",
    env: { PATH: "x" },
    newToken: () => "a".repeat(48),
    ...over,
  });
  assert.deepEqual(await smoke.runSmoke(mk()), { ok: true, problems: [], platform: "win32", version: "0.0.1" });
  const bad = await smoke.runSmoke(
    mk({
      fs: { ...fsOk, existsSync: (f: string) => !/yaml.package\.json$/.test(f) },
      makeKeychain: () => ({
        set: () => {
          throw new Error("no encryption");
        },
      }),
      execFile: (_e: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) =>
        cb(new Error("exit 2"), "", "wingman: not allowed"),
    }),
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.problems.length, 3);
  assert.match(bad.problems[0], /missing files: .*yaml/);
  assert.match(bad.problems[1], /key store: no encryption/);
  assert.match(bad.problems[2], /tool: settings-cli failed \(exit \?, \d+ s\): stderr "wingman: not allowed"/);
  // a store that returns another value, and a tool that prints the wrong thing
  const store = new Map<string, string>();
  const liar = { set: (p: string, v: string) => store.set(p, v + "!"), get: (p: string) => store.get(p) ?? null, remove: (p: string) => store.delete(p) };
  assert.match(smoke.keystoreProblem({ keychain: liar }), /another value/);
  assert.match(
    await smoke.toolProblem({
      execFile: (_e: string, _a: string[], _o: unknown, cb: (e: null, out: string, err: string) => void) => cb(null, "hello", ""),
      execPath: "x",
      env: {},
    }),
    /unexpected/,
  );
});
