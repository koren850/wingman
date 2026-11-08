// Static invariants: checks that read the source text of the repo on purpose.
//
// Most tests in this repo call code and assert on what it does. The ones here cannot, for one of three reasons, and each test says which:
//  - the property is "this never appears" (a key in a log call), so no run can prove it. Pure "never use X" rules (innerHTML, eval, a hand-built .bin path, glossary words) are ESLint rules in eslint.config.mjs;
//  - the code is an Electron main process, a shell installer or a browser page, none of which a unit test can start;
//  - the code is an engine singleton (boot.ts and the modules that import it load settings and keys on import).
// They are kept few and labelled, in the way a lint rule is. Anything that can be tested by calling a function lives in a behavioural test instead.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./env.ts";
import { BASH } from "./test-platform.ts";

const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

// Why static: Every window must keep its CSP, sender checks and fixed command lists. A regression here is silent at runtime (the page just becomes less safe), so the check reads the source.
test("CSP is strict and the page loads only its own files", () => {
  const html = read("dashboard/index.html");
  assert.match(html, /default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(read("dashboard/app.css"), /https?:\/\/|@import/);
});

// Why static: Every window must keep its CSP, sender checks and fixed command lists. A regression here is silent at runtime (the page just becomes less safe), so the check reads the source.
test("every ipcMain handler in the window host goes through the sender check", () => {
  const t = read("dashboard/window.cjs");
  const direct = t.match(/ipcMain\.handle\(/g) || [];
  assert.equal(direct.length, 1, "only the handle() wrapper may call ipcMain.handle");
  assert.match(t, /const handle = \(name, fn\) =>\s*ipcMain\.handle\(name, \(e, \.\.\.a\) => \{\s*if \(!mine\(e\)\) throw new Error\("denied"\)/);
  assert.match(
    read("tray/main.cjs"),
    /ipcMain\.handle\("prompt:submit", \(e, kind, data\) => \{\s*if \(!promptWin \|\| e\.sender !== promptWin\.webContents\) throw/,
  );
});

// Why static: Every window must keep its CSP, sender checks and fixed command lists. A regression here is silent at runtime (the page just becomes less safe), so the check reads the source.
test("window security flags stay on", () => {
  const t = read("dashboard/window.cjs");
  assert.match(t, /contextIsolation: true, nodeIntegration: false, sandbox: true/);
  assert.match(t, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(t, /will-navigate/);
  assert.match(t, /setContentProtection\(on\)/); // on during a call (see protect() in window.cjs)
  assert.match(t, /s.phase !== "idle"/);
});

// Why static: Every window must keep its CSP, sender checks and fixed command lists. A regression here is silent at runtime (the page just becomes less safe), so the check reads the source.
test("snapshot mode: no Tray, no global shortcuts, no spawn, no single-instance lock", () => {
  const t = read("tray/main.cjs");
  assert.match(t, /spawn: SNAPSHOT\s*\?\s*\(\) => \{\s*throw new Error\("snapshot mode never spawns a process"\);\s*\}\s*: spawn/);
  assert.match(t, /if \(!SNAPSHOT\) \{\s*const img[\s\S]*?new Tray\([\s\S]*?registerKeys\(\);/);
  assert.match(t, /if \(!SNAPSHOT\) \{\s*app\.dock && app\.dock\.hide\(\);[^\n]*\n\s*gotLock = app\.requestSingleInstanceLock/);
  assert.match(read("dashboard/window.cjs"), /if \(fake \|\| SNAP\) return \{ ok: false, error: "preview" \}/);
});

// Why static: Every window must keep its CSP, sender checks and fixed command lists. A regression here is silent at runtime (the page just becomes less safe), so the check reads the source.
test("the window cannot send arbitrary stdin: preload exposes named commands only, and the controller whitelists", () => {
  const p = read("dashboard/preload.cjs");
  assert.doesNotMatch(p, /ipcRenderer\.send\(|ipcRenderer\.on\("(?!call:state|nav|live:update)/);
  assert.doesNotMatch(p, /writeStdin|\.write\(/);
  assert.match(
    read("tray/controller.cjs"),
    /if \(!COMMANDS\.includes\(cmd\) && !\/\^\(note\|ask\) \[\^\\n\\r\]\{1,300\}\$\/\.test\(cmd\) && !\/\^speaker [^\n]*\.test\(cmd\)\) return false;/,
  );
});

// Why static: Every window must keep its CSP, sender checks and fixed command lists. A regression here is silent at runtime (the page just becomes less safe), so the check reads the source.
test("speaker rename: fixed command, strict regex in the controller, argument checked again in the sender-guarded handler", () => {
  assert.match(read("tray/controller.cjs"), /!\/\^speaker \(\?:\[1-9\]\|1\[0-9\]\|20\)\(\?: \[\^\\n\\r\]\{1,40\}\)\?\$\/\.test\(cmd\)/);
  assert.match(read("dashboard/window.cjs"), /case "speaker": \{\s*if \(\s*!arg \|\|\s*typeof arg !== "object" \|\|\s*!Number\.isInteger\(arg\.spk\)/);
  assert.match(read("dashboard/preload.cjs"), /speaker: \(spk, name\) => ipcRenderer\.invoke\("call:cmd", "speaker"/);
  assert.doesNotMatch(read("dashboard/live.js"), /innerHTML|outerHTML|insertAdjacentHTML/);
});

// Why static: Every window must keep its CSP, sender checks and fixed command lists. A regression here is silent at runtime (the page just becomes less safe), so the check reads the source.
test("live conversation: guarded channel, call text only via textContent, never on the status lines or in tray.log", () => {
  const w = read("dashboard/window.cjs"),
    r = read("dashboard/live.js"),
    tail = read("dashboard/livetail.cjs"),
    tray = read("tray/main.cjs") + read("tray/controller.cjs") + read("tray/lib.cjs");
  assert.match(w, /handle\("live:get", \(id\) => \{\s*if \(typeof id !== "string"/); // handle() = sender-checked
  assert.doesNotMatch(r, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(tail, /console\.|logLine|require\("node:(http|https|net|dgram)"\)|fetch\(/);
  assert.doesNotMatch(tray, /livetail|livefeed|transcript\.jsonl/); // the tray and status stream never touch call content
  assert.match(read("dashboard/index.html"), /script-src 'self'/);
});

// Why static: The overlay window must have a strict CSP and blocked navigation; Electron cannot run in a unit test.
test("overlay: preload bridge functions return nothing; page script is external; CSP allows no inline script; window open and navigation are blocked", () => {
  // Run the real preload against a fake electron and drive every exposed subscribe function.
  const registered: Record<string, (...a: unknown[]) => void> = {};
  let api: Record<string, (...a: unknown[]) => unknown> = {};
  const fake = {
    contextBridge: { exposeInMainWorld: (_n: string, a: typeof api) => (api = a) },
    ipcRenderer: { on: (ch: string, h: () => void) => (registered[ch] = h), send: () => undefined },
  };
  const Mod = createRequire(import.meta.url)("node:module") as { _load: (...a: unknown[]) => unknown };
  const orig = Mod._load;
  Mod._load = (req: unknown, ...rest: unknown[]) => (req === "electron" ? fake : orig.call(Mod, req, ...rest));
  try {
    createRequire(import.meta.url)(join(ROOT, "overlay/preload.cjs"));
  } finally {
    Mod._load = orig;
  }
  const subs = Object.keys(api).filter((k) => k.startsWith("on"));
  assert.equal(subs.length, 22); // r2-overlay-ux added onRestore and onNote
  assert.deepEqual(
    Object.keys(api).filter((k) => !k.startsWith("on")),
    ["size", "copy", "act"],
  );
  for (const name of subs) {
    const got: unknown[] = [];
    assert.equal(
      api[name]!((...a: unknown[]) => got.push(a)),
      undefined,
      "a bridge function must not return the ipcRenderer proxy",
    );
  }
  assert.equal(Object.keys(registered).length, 22);
  const seen: unknown[][] = [];
  const expectSeen = (want: unknown[][], why: string) => assert.deepEqual(seen as unknown[], want as unknown[], why);
  api.onCard!((...a: unknown[]) => seen.push(a));
  registered.card!({}, { id: "c1" });
  expectSeen([[{ id: "c1" }]], "payload events pass the payload only");
  seen.length = 0;
  api.onPause!((...a: unknown[]) => seen.push(a));
  registered.pause!({}, "ignored");
  expectSeen([[]], "payload-less events call the handler with no argument");
  const html = read("overlay/index.html");
  const csp = /Content-Security-Policy"\s+content="([^"]*)"/.exec(html)![1];
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.doesNotMatch(csp.match(/script-src[^;]*/)![0], /unsafe-inline|unsafe-eval/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, "no inline script");
  assert.match(html, /<script src="app\.js"><\/script>/);
  const main = read("overlay/main.cjs");
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(main, /will-navigate/);
});

// Why static: Shell scripts, the setup page and the IPC table are wired by text (no Electron or macOS in a unit test); the check keeps the wiring and the no-sudo rule from drifting.
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

// Why static: Shell scripts, the setup page and the IPC table are wired by text (no Electron or macOS in a unit test); the check keeps the wiring and the no-sudo rule from drifting.
test("first setup step shows the responsible-use notice with an acknowledgement that never gates a step", () => {
  const src = read("dashboard/setup.js");
  assert.match(src, /Tell the other people on the call that you use a live assistant, and follow your local recording-consent laws\./);
  assert.match(src, /SU\.acks\.consent = true;\s*suSave\(\)/);
  assert.match(src, /consentNotice\(\),?\s*\),/); // inside the keys step panel
  assert.doesNotMatch(src, /done: \(\) => [^\n]*acks\.consent/); // listening and step completion do not depend on it
});

// Why static: Shell scripts, the setup page and the IPC table are wired by text (no Electron or macOS in a unit test); the check keeps the wiring and the no-sudo rule from drifting.
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
  assert.equal(pkg.version, "0.0.1");
  assert.doesNotMatch(pkg.description, /throwaway|dogfood/i);
  assert.match(pkg.scripts.postinstall, /postinstall\.cjs$/);
  assert.doesNotMatch(pkg.scripts.postinstall, /\|\|\s*true/);
});

// Why static: Shell scripts, the setup page and the IPC table are wired by text (no Electron or macOS in a unit test); the check keeps the wiring and the no-sudo rule from drifting.
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

// Why static: The dashboard pages are plain browser scripts loaded by Electron; wiring, one badge palette and main-process-only plan files are checked in the source.
test("the live Ask/Note input goes through validated, fixed commands only", () => {
  const w = read("dashboard/window.cjs"),
    p = read("dashboard/preload.cjs");
  assert.match(
    w,
    /case "ask":\s*if \(typeof arg !== "string" \|\| !arg\.trim\(\) \|\| arg\.length > 2000\) throw new Error\("bad argument"\);\s*return \{ ok: controller\.ask\(arg\) \}/,
  );
  assert.match(w, /case "askWingman":\s*return \{ ok: controller\.askWingman\(\) \}/);
  assert.match(p, /ask: \(text\) => ipcRenderer\.invoke\("call:cmd", "ask", String\(text\)\)/);
  assert.match(p, /askWingman: \(\) => ipcRenderer\.invoke\("call:cmd", "askWingman"\)/);
});

// Why static: The dashboard pages are plain browser scripts loaded by Electron; wiring, one badge palette and main-process-only plan files are checked in the source.
test("the snapshot doctor fixtures never mention keys.env or a terminal (the app stores keys in the Keychain)", () => {
  const w = read("dashboard/window.cjs");
  const fx = w.slice(w.indexOf("const FAKE_DOCTOR"), w.indexOf("/** The sender must be"));
  assert.ok(fx.length > 100);
  assert.doesNotMatch(fx, /keys\.env|terminal/i);
});

// Why static: The dashboard pages are plain browser scripts loaded by Electron; wiring, one badge palette and main-process-only plan files are checked in the source.
test("one badge legend: both windows get the card hues from shared/tokens.css, none of their own", () => {
  const tok = read("shared/tokens.css"),
    css = read("dashboard/app.css"),
    ov = read("overlay/index.html"),
    ovCss = read("overlay/overlay.css"),
    dh = read("dashboard/index.html");
  // one definition: dark and light hues for every card type live in the shared file
  for (const k of ["prep", "ai", "stall", "tip", "me", "fact", "fix", "careful"])
    assert.match(tok, new RegExp(`--t-${k}:\\s*#[0-9a-f]{6}`, "i"), `--t-${k} missing in tokens.css`);
  for (const [n, f] of [
    ["dashboard", css],
    ["answer window", ovCss],
  ] as const)
    assert.ok(!/--t-(prep|ai|stall|tip|me|fact):\s*#/i.test(f), `${n} redefines a card hue`);
  // both pages load it, and the answer window's CSP lets the stylesheet in and stays dark
  assert.match(dh, /<link rel="stylesheet" href="\.\.\/shared\/tokens\.css"\s*\/?>/);
  assert.match(ov, /<link rel="stylesheet" href="\.\.\/shared\/tokens\.css"\s*\/?>/);
  assert.match(ov, /<link rel="stylesheet" href="overlay\.css"\s*\/?>/);
  const ovCsp = /Content-Security-Policy"\s+content="([^"]*)"/.exec(ov)![1];
  assert.match(ovCsp, /style-src file:(;|$)/);
  assert.doesNotMatch(ovCsp, /unsafe-inline|unsafe-eval/, "no inline style or script");
  assert.doesNotMatch(ov, /<style[\s>]|\sstyle=/, "no inline style block or style attribute");
  assert.match(ov, /<html[^>]*data-theme="dark"/);
  // the answer window's own hex values are neutrals, tints and its two brighter alert tones only
  const root = /:root \{([^}]*)\}/.exec(ovCss)![1];
  const names = [...root.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]);
  for (const n of names)
    assert.ok(
      [
        "--bg",
        "--card",
        "--card2",
        "--raised",
        "--line",
        "--text",
        "--soft",
        "--muted",
        "--t-prep-bg",
        "--t-me-bg",
        "--t-ai-bg",
        "--t-stall-bg",
        "--red-bg",
        "--fault",
        "--advisory",
        "--say-pt",
        "--live-pt",
        "--t-fix-bg",
        "--t-careful-bg",
      ].includes(n),
      `answer window defines ${n}: put shared colours in tokens.css`,
    );
});

// Why static: The dashboard pages are plain browser scripts loaded by Electron; wiring, one badge palette and main-process-only plan files are checked in the source.
test("recent plans are read and written only by the main process, in the private plan folder, owner-only", () => {
  const w = read("dashboard/window.cjs");
  assert.match(w, /handle\("brief:recent"/); // recent plans are a convenience kept beside the prepared meetings assert.match(w, /handle\("brief:forgetRecent"/);
  assert.match(w, /const RECENT = path\.join\(BRIEFS, "recent\.json"\)/);
  assert.match(w, /writeFileSync\(RECENT, JSON\.stringify\(list\), \{ mode: 0o600 \}\)/);
});

// Why static: Key values must never reach logging or persistence: an allow-list of modules that may touch them.
test("static: key values can only reach memory; no logging or persistence path touches them", () => {
  const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
  // 1. Modules that load or handle keys: an explicit allow-list. Anything else importing them is a new leak path to review.
  const users = [
    "src/env.ts",
    "src/keychain.ts",
    "src/keys-cli.ts",
    "src/doctor.ts",
    "src/call.ts",
    "src/engine/boot.ts",
    "src/gate.ts",
    "src/summary.ts",
    "src/settings-cli.ts",
    "src/providers/llm.ts",
    "src/providers/catalog.ts", // env var names only, no values
    "src/keys.test.ts",
    "src/stt.ts",
    "src/providers/stt/channel.ts",
    "src/overlay.ts",
    "src/audio.ts",
    "src/cli/status.ts",
    "src/cli/pack-cmd.ts",
    "src/cli/digest-cmd.ts",
  ]; // cli/digest-cmd.ts: same as pack-cmd, hands the keys to the model registry; cli/status.ts: `wingman keys status`, present/missing only (asserted in cli.test.ts); cli/pack-cmd.ts: hands the keys to the model registry, nothing else
  const walk = (d: string): string[] =>
    readdirSync(join(ROOT, d), { withFileTypes: true }).flatMap(
      (e) => (e.isDirectory() ? (e.name === "node_modules" ? [] : walk(join(d, e.name))) : [join(d, e.name).replace(/\\/g, "/")]), // forward slashes: the lists below use them
    );
  const files = ["src", "tray", "dashboard", "overlay", "qa"].flatMap(walk).filter((f) => /\.(ts|cjs|js)$/.test(f));
  for (const f of files) {
    const t = read(f);
    if (
      /(?:require|from)\s*\(?\s*["'][^"']*keychain|loadKeys|requireKeys|KEY_VARS/.test(t) &&
      !users.includes(f) &&
      !/^src\/(.*\.test\.ts|settings-edit-cli\.ts)$/.test(f) &&
      !/^dashboard\/(keys-ipc|window)\.cjs$|^src\/keychain\.cjs$/.test(f)
    )
      assert.fail(`${f} touches keys and is not on the reviewed list`);
  }
  // 2. The key modules never log or persist anything themselves, and the window host never logs IPC args.
  for (const f of ["src/keychain.cjs", "dashboard/keys-ipc.cjs"])
    assert.doesNotMatch(read(f), /console\.|logLine|appendFile|process\.stdout|process\.stderr|JSON\.stringify\(\s*(value|key)\b/, f);
  assert.doesNotMatch(read("dashboard/window.cjs"), /console\./);
  // 3. Writers of calls/, tray.log, events, settings YAML and snapshots do not know about keys at all.
  for (const f of [
    "src/log.ts",
    "src/settings-edit.ts",
    "tray/controller.cjs",
    "tray/lib.cjs",
    "dashboard/livetail.cjs",
    "dashboard/lib.cjs",
    "src/notes.ts",
    "src/summary.ts",
  ])
    assert.doesNotMatch(read(f).replace(/requireKeys\([^)]*\)|import[^\n]*env\.ts[^\n]*/g, ""), /keychain|\bkeys\.(deepgram|anthropic)\b|API_KEY/i, f);
  // 4. Snapshot hook never reaches the Keychain; set/test are rate limited; only the sender-checked handle() registers handlers.
  assert.match(read("dashboard/window.cjs"), /fake: process\.env\.WINGMAN_DASHBOARD_FAKE_KEYS \|\| \(SNAP \? "missing" : ""\)/);
  assert.doesNotMatch(read("dashboard/keys-ipc.cjs"), /ipcMain/);
  assert.match(read("dashboard/keys-ipc.cjs"), /keys:set[\s\S]{0,300}limit\(\)/);
  // 4b. Migration has exactly two triggers: the button's IPC and the CLI. Never startup.
  const callers = files.filter((f) => /migrateKeysToKeychain|keysMigrate|keys:migrate/.test(read(f)) && !/\.test\.ts$/.test(f)).sort();
  assert.deepEqual(callers, [
    "dashboard/keys-ipc.cjs",
    "dashboard/preload.cjs",
    "dashboard/settings.js",
    "src/keychain.cjs",
    "src/keychain.ts",
    "src/keys-cli.ts",
  ]);
  assert.doesNotMatch(read("tray/main.cjs"), /migrateKeys|keysMigrate|keys:migrate/); // (the data-folder copy in shared/migrate.cjs is unrelated)
  // 5. Renderer: password input, no value in state/storage/attributes.
  const ui = read("dashboard/settings.js");
  assert.match(ui, /type: "password",\s*id,\s*autocomplete: "off",\s*spellcheck: "false"/);
  assert.doesNotMatch(ui, /localStorage|sessionStorage/);
  assert.match(ui, /const v = inp\.value;\s*inp\.value = ""/);
});

// Why static: The overlay main process needs crash and hang handlers; Electron cannot run in a unit test.
test("overlay main.cjs: crash and hang handlers are wired, poll cannot throw out, errors only log", () => {
  const src = readFileSync(join(ROOT, "overlay", "main.cjs"), "utf8");
  for (const needle of [
    '"uncaughtException"',
    '"unhandledRejection"',
    '"render-process-gone"',
    '"unresponsive"',
    '"did-fail-load"',
    "forcefullyCrashRenderer",
    "replayBacklog",
    "readNewRows",
  ])
    assert.ok(src.includes(needle), needle);
  assert.match(src, /function poll\(\) \{\s*try \{/);
});

// Why static: a new Electron window or spawn site is where these slip in; there is no runtime path to exercise.
test("every Electron main process installs the permission lockdown", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["tray/main.cjs", "overlay/main.cjs"])
    assert.match(readFileSync(join(ROOT, f), "utf8"), /require\("\.\.\/shared\/permissions\.cjs"\)\.install\(app\)/, f);
});

// Why static: a child process that inherits the environment would inherit the API keys; the spawn sites are the only place to check it.
test("child processes get a scrubbed environment: the engine drops key variables at start, and caffeinate, ffmpeg and the settings tools use childEnv()", () => {
  const boot = read("src/engine/boot.ts"),
    sources = read("src/engine/audio-sources.ts"),
    audio = read("src/audio.ts");
  assert.match(boot, /for \(const v of KEY_ENV_VARS\) delete process\.env\[v\]/);
  assert.match(sources, /spawn\("caffeinate"[\s\S]*?env: childEnv\(\)/);
  assert.equal((audio.match(/spawn\("ffmpeg"/g) || []).length, (audio.match(/env: childEnv\(\)/g) || []).length);
  assert.match(read("dashboard/window.cjs"), /settingsEnv = \(\) => \(\{ \.\.\.require\("\.\.\/src\/keychain\.cjs"\)\.childEnv/);
});

// Why static: the dashboard window host decides, per command, whether writes are queued; that branch lives in an Electron main process.
test("the window host sends settings write commands through the serial queue", () => {
  assert.match(read("dashboard/window.cjs"), /args\.includes\("write"\) \? writes\(/);
});

test("every HTML page has a CSP with default-src 'none' and no unsafe-inline, and no inline style or script", () => {
  for (const f of ["dashboard/index.html", "overlay/index.html", "tray/prompt.html"]) {
    const t = read(f);
    assert.match(t, /Content-Security-Policy/, f);
    assert.match(t, /default-src 'none'/, f);
    assert.doesNotMatch(t, /unsafe-inline|unsafe-eval/, f);
    assert.doesNotMatch(t, /<style[\s>]|\sstyle="|\son[a-z]+="/i, `${f} has inline style or handler`);
    assert.doesNotMatch(t.replace(/<!--[\s\S]*?-->/g, ""), /<script(?![^>]*\ssrc=)/i, `${f} has an inline script`);
  }
});

// These rules used to be source-text tests here. They are ESLint rules now (eslint.config.mjs), which see syntax, not comments, and cover new files too.
// This test proves the rules still fire, so the protection cannot be dropped by accident.
test("lint rules that replaced source-text tests still fire", async () => {
  const { ESLint } = await import("eslint");
  const eslint = new ESLint({ cwd: ROOT });
  const rulesFor = async (code: string, filePath: string) => (await eslint.lintText(code, { filePath: join(ROOT, filePath) }))[0].messages.map((m) => m.ruleId);
  for (const bad of [
    "el.innerHTML = x;",
    "el.outerHTML = x;",
    "el.insertAdjacentHTML('beforeend', x);",
    "document.write(x);",
    "eval('1');",
    "new Function('a');",
    "setTimeout('f()', 1);",
  ])
    for (const f of ["dashboard/app.js", "overlay/app.js"]) assert.ok((await rulesFor(bad, f)).length > 0, `${f}: ${bad} must be flagged`);
  for (const f of ["src/x.ts", "tray/x.cjs", "dashboard/home.js"])
    assert.ok((await rulesFor('const p = ".bin";\nvoid p;', f)).includes("no-restricted-syntax"), `${f}: .bin`);
  assert.ok((await rulesFor('void "Briefing";', "dashboard/home.js")).includes("no-restricted-syntax"), "glossary word");
  assert.ok((await rulesFor('void "Control+Alt+1";', "tray/main.cjs")).includes("no-restricted-syntax"), "Ctrl+Opt+1 shortcut");
  assert.deepEqual(await rulesFor("el.textContent = x;", "dashboard/app.js"), [], "textContent is fine");
});
