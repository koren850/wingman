// Static invariants: checks that read the source text of the repo on purpose.
//
// Most tests in this repo call code and assert on what it does. The ones here cannot, for one of three reasons, and each test says which:
//  - the property is "this never appears" (innerHTML, a hand-built .bin path, a key in a log call), so no run can prove it;
//  - the code is an Electron main process, a shell installer or a browser page, none of which a unit test can start;
//  - the code is an engine singleton (boot.ts and the modules that import it load settings and keys on import).
// They are kept few and labelled, in the way a lint rule is. Anything that can be tested by calling a function lives in a behavioural test instead.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./env.ts";
import { BASH } from "./test-platform.ts";

const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const require = createRequire(import.meta.url);
const strings = require("../overlay/strings.js");
const readOverlayFile = readFileSync;

// Why static: Every window must keep its CSP, sender checks and fixed command lists. A regression here is silent at runtime (the page just becomes less safe), so the check reads the source.
test("renderer scripts never inject HTML or evaluate strings", () => {
  for (const f of ["dashboard/app.js", "dashboard/home.js", "dashboard/settings.js", "dashboard/setup.js", "dashboard/boot.js", "dashboard/bidi.js"]) {
    const t = read(f);
    for (const bad of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function\(/, /setTimeout\(\s*["'`]/])
      assert.doesNotMatch(t, bad, `${f} uses ${bad}`);
  }
});

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
  assert.equal(subs.length, 18);
  assert.deepEqual(
    Object.keys(api).filter((k) => !k.startsWith("on")),
    ["copy"],
  );
  for (const name of subs) {
    const got: unknown[] = [];
    assert.equal(
      api[name]!((...a: unknown[]) => got.push(a)),
      undefined,
      "a bridge function must not return the ipcRenderer proxy",
    );
  }
  assert.equal(Object.keys(registered).length, 18);
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
test("the unused skins are gone: no skins.css, no ?skin= param, no SK() branches, no data-skin selector", () => {
  assert.equal(existsSync(join(ROOT, "dashboard/skins.css")), false);
  assert.doesNotMatch(read("dashboard/index.html"), /skins\.css/);
  for (const f of readdirSync(join(ROOT, "dashboard")).filter((x) => /\.(js|cjs|css|html)$/.test(x))) {
    const t = read("dashboard/" + f);
    assert.doesNotMatch(t, /data-skin|\bSK\(\)|WINGMAN_DASHBOARD_SKIN|DEFAULT_SKIN|searchParams|get\("skin"\)/, f + " still mentions skins");
  }
  assert.match(read("dashboard/app.css"), /\.tip:focus-visible::after/); // base rules the default look needs moved here
  assert.match(read("dashboard/app.css"), /\.sheet-ov \{/);
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
test("the practice button and the Start card are wired to the plan and the settings read", () => {
  const t = read("dashboard/home.js");
  assert.match(t, /HL\.practiceLabel\(target\)/);
  assert.match(t, /id: "start-call"[\s\S]*?startFlow\(\{ noAi: false \}\)/); // the Quick call button starts with no meeting
  assert.match(t, /startFlow\(\{ planId: r\.id \}\)/); // a row's Start button starts that meeting
  assert.match(t, /api\s*\.getSettings\(\)\s*\.then\(\(r\) => \{\s*H\.ai = r && r\.ok \? HL\.aiMode\(r\.items\)/);
  assert.match(t, /HL\.stopSteps\(s\)/);
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

// Why static: The dashboard pages are plain browser scripts loaded by Electron; wiring, one badge palette and main-process-only plan files are checked in the source.
test("calls:delete asks deleteRefusal before the dialog, and the page hides the button for the live call", async () => {
  const { readFileSync } = await import("node:fs"),
    { join } = await import("node:path"),
    { ROOT } = await import("./env.ts");
  const w = readFileSync(join(ROOT, "dashboard/window.cjs"), "utf8"),
    a = readFileSync(join(ROOT, "dashboard/app.js"), "utf8");
  assert.ok(w.indexOf("data.deleteRefusal(controller.getState(), id)") > 0 && w.indexOf("data.deleteRefusal") < w.indexOf('title: "Delete call"'));
  assert.match(a, /const isLive = !!\(state\.call && state\.call\.running && state\.call\.callId === state\.id/);
  assert.equal((a.match(/isLive \? null : /g) || []).length, 3, "all three Delete call buttons");
});

// Why static: The dashboard pages are plain browser scripts loaded by Electron; wiring, one badge palette and main-process-only plan files are checked in the source.
test("the nativeTheme listener is added once per window host, not on every open", async () => {
  const { readFileSync } = await import("node:fs"),
    { join } = await import("node:path"),
    { ROOT } = await import("./env.ts");
  const w = readFileSync(join(ROOT, "dashboard/window.cjs"), "utf8");
  assert.equal((w.match(/nativeTheme\.on\(/g) || []).length, 1);
  assert.ok(w.indexOf("nativeTheme.on(") < w.indexOf("function open("), "registered before open(), in create()");
});

// Why static: Stdin command names, the IPC channel and the page script tags are wiring between processes that a unit test cannot start.
test("engine: fixed stdin commands stop-no-summary and skip-summary, abort signal passed to the summary call", () => {
  const t = read("src/engine/shutdown.ts"),
    ctl = read("src/engine/control.ts"); // (the stdin commands live in control.ts, the summary in shutdown.ts)
  assert.match(ctl, /cmd === "stop-no-summary"\) \{\s*skipSummaryNow\(\);\s*void shutdown\(\);\s*\}/);
  assert.match(ctl, /cmd === "skip-summary"\) \{\s*if \(st\.call\.shuttingDown\) skipSummaryNow\(\);\s*\}/);
  assert.match(t, /signal: summaryAbort\.signal/);
  assert.match(t, /Promise\.race\(\[postCallSummary\(\), summarySkipWait,/);
  assert.match(t, /reason: "user"/);
  assert.match(read("tray/controller.cjs"), /COMMANDS = Object\.freeze\(\[[^\]]*"stop-no-summary", "skip-summary"\]/);
});

// Why static: Stdin command names, the IPC channel and the page script tags are wiring between processes that a unit test cannot start.
test("pages wired: Skip summary button + fixed IPC, Write summary in Calls, countdown in the answer window", () => {
  assert.match(read("dashboard/home.js"), /btn\("Skip summary", \{ id: "skip-summary"/);
  assert.match(read("dashboard/preload.cjs"), /skipSummary: \(\) => ipcRenderer\.invoke\("call:cmd", "skipSummary"\)/);
  assert.match(read("dashboard/window.cjs"), /case "skipSummary":\s*return \{ ok: controller\.skipSummary\(\) \}/);
  assert.match(read("dashboard/app.js"), /btn\("Write summary"/);
  assert.match(read("dashboard/window.cjs"), /handle\(\s*"calls:writeSummary"/);
  assert.match(read("overlay/app.js"), /WingmanAsk\.askSecondsLeft/);
  assert.match(read("overlay/index.html"), /src="\.\.\/shared\/ask\.js"/);
  assert.match(read("dashboard/index.html"), /src="\.\.\/shared\/ask\.js"/);
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
    "src/keys.test.ts",
    "src/stt.ts",
    "src/providers/stt/channel.ts",
    "src/overlay.ts",
    "src/audio.ts",
    "src/cli/status.ts",
    "src/cli/pack-cmd.ts",
  ]; // cli/status.ts: `wingman keys status`, present/missing only (asserted in cli.test.ts); cli/pack-cmd.ts: hands the keys to the model registry, nothing else
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

// Why static: Phase and stop-step names are a protocol between run.ts and the menu-bar app; their order is checked in the source.
// ---- run.ts: phases and stop steps are wired in order ----
test("engine writes call.json phases and emits stop steps in order", () => {
  const read = (f: string) => readFileSync(join(ROOT, "src", f), "utf8");
  const src = read("engine/shutdown.ts"),
    consent = read("engine/consent.ts"); // (phases: run.ts "starting", consent.ts "waiting" / "live"; stop steps: shutdown.ts)
  assert.ok(read("run.ts").includes('setPhase("starting")'), 'setPhase("starting")');
  for (const p of ['setPhase("waiting")', 'setPhase("live", { liveAt']) assert.ok(consent.includes(p), p);
  const at = (t: string) => src.indexOf(t);
  assert.ok(at('status("stopphase", { phase: "saving" })') < at('status("stopphase", { phase: "summary" })'));
  assert.ok(at('status("stopphase", { phase: "summary" })') < at('status("stopphase", { phase: "done" })'));
  assert.ok(at('status("stopphase", { phase: "done" })') < at('status("ended"'));
  assert.match(src, /phase: "ended"/);
  assert.match(
    read("engine/boot.ts"),
    /loadAttachments\(S\.attachments\.maxChars, \{ consume: !fileArg \}\)/,
    "a practice call never deletes the real call's files",
  );
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

// Why static: i18n completeness: every tr() key exists in the string table and no Hebrew literal sits outside strings.js (a lint-style rule over the page scripts).
test("every tr('...') key used by app.js and text.js exists in the table, and Hebrew UI literals live only in strings.js", () => {
  // Hebrew allowed outside strings.js: the one regex alternation in text.js that recognises the engine's Hebrew health texts.
  const ALLOWED_LINES = [/healthText|englishHealth|HEB = |\/[^/\n]*[֐-׿][^/\n]*\//];
  for (const f of ["app.js", "text.js", "index.html"]) {
    const src = readOverlayFile(new URL("../overlay/" + f, import.meta.url), "utf8");
    src.split("\n").forEach((line: string, i: number) => {
      if (!/[֐-׿]/.test(line)) return;
      const code = line.replace(/\/\/.*$/, ""); // comments may contain Hebrew examples
      if (!/[֐-׿]/.test(code)) return;
      assert.ok(
        f === "text.js" && ALLOWED_LINES.some((r) => r.test(code)),
        `${f}:${i + 1} has a Hebrew literal outside strings.js: ${line.trim().slice(0, 80)}`,
      );
    });
  }
  const used = new Set<string>();
  for (const f of ["app.js", "text.js"])
    for (const m of readOverlayFile(new URL("../overlay/" + f, import.meta.url), "utf8").matchAll(/\btr\("([\w.-]+)"[,)]/g)) used.add(m[1]);
  // keys built at run time in app.js ("badge." + type, "kind." + kind, ...)
  const dyn: Record<string, string[]> = {
    badge: ["bank", "ai", "stall", "me", "fix", "careful", "calc", "info", "consent"],
    kind: ["client", "support", "vendor", "team", "consult", "personal", "other"],
    tip: ["ask", "clarify", "term", "remind", "note"],
    cap: ["phone", "email", "domain"],
    keys: ["ask", "rewind", "checklist", "pause", "clear", "copy"],
    "health.who": ["stt-me", "stt-them"],
  };
  for (const [p, names] of Object.entries(dyn)) for (const n of names) assert.ok(`${p}.${n}` in strings.STRINGS.en, `${p}.${n}`);
  for (const st of ["ended", "paused", "quiet", "starting", "waiting", "listening"])
    for (const part of ["", ".title", ".sub"]) assert.ok(`state.${st}${part}` in strings.STRINGS.en, `state.${st}${part}`);
  for (const k of used) assert.ok(k in strings.STRINGS.en, "unknown key " + k);
  const html = readOverlayFile(new URL("../overlay/index.html", import.meta.url), "utf8");
  for (const m of html.matchAll(/data-i18n="([\w.]+)"/g)) assert.ok(m[1] in strings.STRINGS.en, "unknown key " + m[1]);
});

// Why static: Engine singletons (watchdogs, boot) run on import and cannot be driven from a unit test; the orphan-overlay guard spans two Electron processes.
test("engine: the silent-while-talking heuristic never sets themDead (source check)", () => {
  const src = readFileSync(join(ROOT, "src", "engine", "watchdogs.ts"), "utf8");
  const calm = src.slice(
    src.indexOf('log.write("events", { type: "watchdog.silent-them"'),
    src.indexOf("}), 2000).unref();", src.indexOf("watchdog.silent-them")),
  );
  assert.ok(calm.includes('"only-you"') && !/themDead/.test(calm), "calm branch must not touch themDead");
});

// Why static: Engine singletons (watchdogs, boot) run on import and cannot be driven from a unit test; the orphan-overlay guard spans two Electron processes.
// ---- overlay orphan guard, linger, doctor ----
test("overlay: spawned with a stdin pipe + parent watch; main.cjs quits when the parent goes away", () => {
  const o = readFileSync(join(ROOT, "src", "overlay.ts"), "utf8"),
    m = readFileSync(join(ROOT, "overlay", "main.cjs"), "utf8");
  assert.match(o, /stdio: \["pipe"/);
  assert.match(o, /WINGMAN_WATCH_PARENT/);
  assert.match(m, /WINGMAN_WATCH_PARENT/);
  assert.match(m, /process\.stdin\.on\("end"/);
  assert.match(m, /process\.kill\(parent, 0\)/);
  const c = readFileSync(join(ROOT, "src", "call.ts"), "utf8");
  assert.match(c, /SIGKILL/, "call.ts escalates to SIGKILL for a hung overlay");
});

// Why static: a new Electron window or spawn site is where these slip in; there is no runtime path to exercise.
test("every Electron main process installs the permission lockdown", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["tray/main.cjs", "overlay/main.cjs"])
    assert.match(readFileSync(join(ROOT, f), "utf8"), /require\("\.\.\/shared\/permissions\.cjs"\)\.install\(app\)/, f);
});

// Why static: a new Electron window or spawn site is where these slip in; there is no runtime path to exercise.
test("no spawn site builds .bin/tsx or .bin/electron by hand", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const bad: string[] = [];
  for (const d of ["src", "src/cli", "src/engine", "tray", "dashboard", "overlay"])
    for (const f of readdirSync(join(ROOT, d))) {
      if (!/\.(ts|cjs|js)$/.test(f) || /\.test\./.test(f)) continue;
      if (/"\.bin"/.test(readFileSync(join(ROOT, d, f), "utf8"))) bad.push(`${d}/${f}`);
    }
  assert.deepEqual(bad, []);
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

// Why static: the menu-bar app registers global shortcuts in an Electron main process; a collision with the answer window's keys is silent.
test("the menu-bar app's main process registers no Ctrl+Opt+1-3 (the answer window's keys)", () => {
  assert.ok(!/Control\+Alt\+[123]\b/.test(read("tray/main.cjs")), "main.cjs registers no Ctrl+Opt+1-3");
});

// Why static: a wording rule over the page scripts (a lint rule in test form); there is no function to call.
test("visible dashboard text follows the glossary (no consent, briefing, bank, stall, doctor wording)", () => {
  for (const f of ["dashboard/home.js", "dashboard/live.js", "dashboard/app.js", "dashboard/settings.js", "dashboard/boot.js", "tray/settings-catalog.cjs"]) {
    const t = read(f);
    assert.doesNotMatch(
      t,
      /Waiting for consent|Consent given|consent line|Check everything|Stop and delete|"Bank"|"Stall"|Briefing\b|"Calc"|(?<!run)Doctor\b/,
      f,
    );
  }
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
