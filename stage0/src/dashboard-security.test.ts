// Static guards for the Wingman window: no HTML injection paths, strict CSP, every IPC handler checks its sender,
// snapshot mode can never start a call, and only fixed commands can reach a call's stdin.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./env.ts";

const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

test("renderer scripts never inject HTML or evaluate strings", () => {
  for (const f of ["dashboard/app.js", "dashboard/home.js", "dashboard/settings.js", "dashboard/setup.js", "dashboard/boot.js", "dashboard/bidi.js"]) {
    const t = read(f);
    for (const bad of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function\(/, /setTimeout\(\s*["'`]/]) assert.doesNotMatch(t, bad, `${f} uses ${bad}`);
  }
});

test("CSP is strict and the page loads only its own files", () => {
  const html = read("dashboard/index.html");
  assert.match(html, /default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(read("dashboard/app.css"), /https?:\/\/|@import/);
});

test("every ipcMain handler in the window host goes through the sender check", () => {
  const t = read("dashboard/window.cjs");
  const direct = t.match(/ipcMain\.handle\(/g) || [];
  assert.equal(direct.length, 1, "only the handle() wrapper may call ipcMain.handle");
  assert.match(t, /const handle = \(name, fn\) => ipcMain\.handle\(name, \(e, \.\.\.a\) => \{ if \(!mine\(e\)\) throw new Error\("denied"\)/);
  assert.match(read("tray/main.cjs"), /ipcMain\.handle\("prompt:submit", \(e, kind, data\) => \{\s*if \(!promptWin \|\| e\.sender !== promptWin\.webContents\) throw/);
});

test("window security flags stay on", () => {
  const t = read("dashboard/window.cjs");
  assert.match(t, /contextIsolation: true, nodeIntegration: false, sandbox: true/);
  assert.match(t, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/); assert.match(t, /will-navigate/);
  assert.match(t, /setContentProtection\(on\)/);   // on during a call (see protect() in window.cjs)
  assert.match(t, /s.phase !== "idle"/);
});

test("snapshot mode: no Tray, no global shortcuts, no spawn, no single-instance lock", () => {
  const t = read("tray/main.cjs");
  assert.match(t, /spawn: SNAPSHOT \? \(\) => \{ throw new Error\("snapshot mode never spawns a process"\); \} : spawn/);
  assert.match(t, /if \(!SNAPSHOT\) \{\s*const img[\s\S]*?new Tray\([\s\S]*?registerKeys\(\);/);
  assert.match(t, /if \(!SNAPSHOT\) \{\s*app\.dock && app\.dock\.hide\(\);[^\n]*\n\s*gotLock = app\.requestSingleInstanceLock/);
  assert.match(read("dashboard/window.cjs"), /if \(fake \|\| SNAP\) return \{ ok: false, error: "preview" \}/);
});

test("the window cannot send arbitrary stdin: preload exposes named commands only, and the controller whitelists", () => {
  const p = read("dashboard/preload.cjs");
  assert.doesNotMatch(p, /ipcRenderer\.send\(|ipcRenderer\.on\("(?!call:state|nav|live:update)/);
  assert.doesNotMatch(p, /writeStdin|\.write\(/);
  assert.match(read("tray/controller.cjs"), /if \(!COMMANDS\.includes\(cmd\) && !\/\^\(note\|ask\) \[\^\\n\\r\]\{1,300\}\$\/\.test\(cmd\) && !\/\^speaker [^\n]*\.test\(cmd\)\) return false;/);
});

test("speaker rename: fixed command, strict regex in the controller, argument checked again in the sender-guarded handler", () => {
  assert.match(read("tray/controller.cjs"), /!\/\^speaker \(\?:\[1-9\]\|1\[0-9\]\|20\)\(\?: \[\^\\n\\r\]\{1,40\}\)\?\$\/\.test\(cmd\)/);
  assert.match(read("dashboard/window.cjs"), /case "speaker": \{ if \(!arg \|\| typeof arg !== "object" \|\| !Number\.isInteger\(arg\.spk\)/);
  assert.match(read("dashboard/preload.cjs"), /speaker: \(spk, name\) => ipcRenderer\.invoke\("call:cmd", "speaker"/);
  assert.doesNotMatch(read("dashboard/live.js"), /innerHTML|outerHTML|insertAdjacentHTML/);
});

test("live conversation: guarded channel, call text only via textContent, never on the status lines or in tray.log", () => {
  const w = read("dashboard/window.cjs"), r = read("dashboard/live.js"), tail = read("dashboard/livetail.cjs"), tray = read("tray/main.cjs") + read("tray/controller.cjs") + read("tray/lib.cjs");
  assert.match(w, /handle\("live:get", \(id\) => \{\s*if \(typeof id !== "string"/);       // handle() = sender-checked
  assert.doesNotMatch(r, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(tail, /console\.|logLine|require\("node:(http|https|net|dgram)"\)|fetch\(/);
  assert.doesNotMatch(tray, /livetail|livefeed|transcript\.jsonl/);                         // the tray and status stream never touch call content
  assert.match(read("dashboard/index.html"), /script-src 'self'/);
});
