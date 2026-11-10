// How local tools are started inside the packaged app: the app's own executable runs the bundled engine (no Node, no node_modules).
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import bin from "../shared/bin.cjs";
import { MAC } from "./test-platform.ts";

const EXE = "/Applications/Wingman.app/Contents/MacOS/Wingman";

test("packaged: a tsx tool becomes --wingman-tool <name> and keeps its arguments after --", () => {
  const c = bin.binCommand("tsx", ["/x/src/run.ts", "--profile", "demo-en", "--file", "a.wav"], "/x", { packaged: true, execPath: EXE });
  assert.deepEqual(c, { cmd: EXE, args: ["--wingman-tool", "run", "--", "--profile", "demo-en", "--file", "a.wav"] });
  assert.deepEqual(bin.binCommand("tsx", ["src/settings-edit-cli.ts", "read"], "/x", { packaged: true, execPath: EXE }).args, [
    "--wingman-tool",
    "settings-edit-cli",
    "--",
    "read",
  ]);
});

test("packaged: the dashboard's Export and features tools ship (window.cjs starts them)", () => {
  for (const t of ["export-cli", "features-cli"]) assert.equal(bin.binCommand("tsx", [`src/${t}.ts`], "/x", { packaged: true, execPath: EXE }).args[1], t);
});

test("packaged: the answer window is the same executable with --wingman-overlay", () => {
  const c = bin.binCommand("electron", ["/x/overlay/main.cjs"], "/x", { packaged: true, execPath: EXE });
  assert.deepEqual(c, { cmd: EXE, args: ["--wingman-overlay", "--"] });
});

test("packaged: only the bundled tools can be started", () => {
  assert.throws(() => bin.binCommand("tsx", ["src/gate.ts"], "/x", { packaged: true, execPath: EXE }), /not part of the packaged app/);
  assert.throws(() => bin.binCommand("tsx", ["../../etc/evil.ts"], "/x", { packaged: true, execPath: EXE }), /not part of the packaged app/);
  assert.throws(() => bin.binCommand("vite", ["x"], "/x", { packaged: true, execPath: EXE }), /not part of the packaged app/);
});

test("packaged: detected by packaged.json in the app folder, never in a checkout", () => {
  const dir = mkdtempSync(join(tmpdir(), "wingman-packed-"));
  try {
    assert.equal(bin.isPackaged(dir), false);
    assert.equal(bin.binCommand("tsx", ["src/call.ts"], dir, { platform: "darwin" }).cmd, posix.join(dir, "node_modules", ".bin", "tsx")); // a macOS path keeps forward slashes on any host
    writeFileSync(join(dir, "packaged.json"), "{}");
    assert.equal(bin.isPackaged(dir), true);
    assert.equal(bin.binCommand("tsx", ["src/call.ts"], dir, { execPath: EXE }).args[0], "--wingman-tool");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real checkout is not packaged", () => {
  assert.equal(bin.isPackaged(join(import.meta.dirname, "..")), false);
});

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const guard = require("../shared/entry-guard.cjs");
const setupIpc = require("../dashboard/setup-ipc.cjs");
const OK_ENV = { WINGMAN_TOOL_TOKEN: "a".repeat(48) };

test("entry guard: debugging and code-loading switches are refused", () => {
  for (const a of [
    "--remote-debugging-port=9222",
    "--remote-debugging-pipe",
    "-remote-debugging-port=1",
    "--remote-allow-origins=*",
    "--inspect=9229",
    "--inspect-brk",
    "--js-flags=--expose-gc",
    "--load-extension=/x",
    "--disable-web-security",
    "--no-sandbox",
    "--proxy-server=localhost:1",
    "--host-rules=MAP * 127.0.0.1",
    "--ignore-certificate-errors",
    "--renderer-cmd-prefix=/bin/sh",
  ])
    assert.ok(guard.refusedSwitch(["--wingman-tool", "call", "--", a]), a);
  assert.equal(guard.refusedSwitch(["--wingman-tool", "run", "--", "--profile", "demo", "--file", "x.wav", "--open-window"]), null);
  assert.equal(guard.refusedSwitch([]), null);
});

test("entry guard: tools need the run token and a Wingman parent", () => {
  const exe = (p: number) => (p === 100 ? "/Apps/Wingman.app/Contents/MacOS/Wingman" : "/sbin/launchd");
  const ok = { env: OK_ENV, ppid: 100, execPath: "/Apps/Wingman.app/Contents/MacOS/Wingman", exe, platform: "darwin" }; // the paths are macOS paths, whatever system runs the test
  assert.equal(guard.callerProblem(ok), null);
  assert.match(String(guard.callerProblem({ ...ok, env: {} })), /only be started by the Wingman app/); // open -a Wingman --args ...
  assert.match(String(guard.callerProblem({ ...ok, env: { WINGMAN_TOOL_TOKEN: "short" } })), /only be started/);
  assert.match(String(guard.callerProblem({ ...ok, ppid: 1 })), /not started by the Wingman app/); // right token, parent is launchd
  assert.match(String(guard.callerProblem({ ...ok, exe: () => "" })), /not started/);
  // the background summary may outlive its parent
  const late = { ...ok, ppid: 1, tool: "summary", env: { ...OK_ENV, WINGMAN_PARENT_PID: "100" } };
  assert.equal(guard.callerProblem({ ...late, exe: (p: number) => (p === 100 ? ok.execPath : "/sbin/launchd") }), null);
  assert.equal(guard.callerProblem({ ...late, exe: () => "" }), null); // spawner already gone
  assert.match(String(guard.callerProblem({ ...late, tool: "call" })), /not started/); // only the summary gets this
  assert.match(String(guard.callerProblem({ ...late, env: OK_ENV })), /not started/);
  assert.match(String(guard.callerProblem({ ...late, exe: () => "/bin/zsh" })), /not started/);
  assert.notEqual(guard.newToken(), guard.newToken());
  assert.match(guard.newToken(), /^[0-9a-f]{48}$/);
});

test("starter answers: copying nothing is an error", () => {
  const root = mkdtempSync(join(tmpdir(), "wm-starter-"));
  const home = join(root, "home");
  mkdirSync(home);
  const r = setupIpc.copyExamplePack(root, { WINGMAN_PACK_DIR: join(root, "pack") }, home, "sales");
  assert.equal(r.ok, false);
  assert.match(r.error, /not part of this install/);
  rmSync(root, { recursive: true, force: true });
});

test("package-app stage carries every starter pack", { timeout: 120_000, ...MAC }, () => {
  const app = fileURLToPath(new URL("..", import.meta.url));
  const r = spawnSync(process.execPath, [join(app, "scripts", "package-app.cjs"), "--stage-only"], { cwd: app, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  for (const p of ["sales", "support", "interview", "empty"]) assert.ok(existsSync(join(app, ".stage", "data", "starter-packs", p, "bank.yaml")), p);
  assert.ok(existsSync(join(app, ".stage", "shared", "entry-guard.cjs")));
});
