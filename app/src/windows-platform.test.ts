// The entry guard on Windows and the platform helpers. Everything runs on any host with fakes. (The Windows key store has its own tests in keychain-securestore.)
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const guard = require("../shared/entry-guard.cjs");
const platform = require("../shared/platform.cjs");

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
