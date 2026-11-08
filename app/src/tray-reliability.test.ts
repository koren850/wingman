// Menu-bar app and call launcher fixes: a hung call is still ended after "ended", the practice wav has its own folder, the menu and the quit
// confirmation follow the interface language, Cmd+Q asks while a call runs, a dead overlay page stops the poll, a failed spawn is handled.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ROOT } from "./env.ts";

const require = createRequire(import.meta.url);
const { createController } = require("../tray/controller.cjs");
const { tt, T } = require("../tray/menu-text.cjs");
const lib = require("../tray/lib.cjs");
const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string) => readFileSync(join(APP, f), "utf8");

function fake() {
  const spawned: any[] = [],
    kills: any[] = [],
    timers: { fn: () => void; ms: number }[] = [];
  const tmpDir = mkdtempSync(join(tmpdir(), "wm-r1tray-"));
  const ctl = createController({
    spawn: () => {
      const c: any = new EventEmitter();
      c.pid = 777;
      c.stdin = Object.assign(new EventEmitter(), { writable: true, write: () => true });
      c.stdout = new EventEmitter();
      c.stderr = new EventEmitter();
      c.kill = () => {};
      c.args = [];
      c.say = (ev: string, data: object = {}) => c.stdout.emit("data", Buffer.from(`@@wingman ${JSON.stringify({ ev, ...data })}\n`));
      spawned.push(c);
      return c;
    },
    root: ROOT,
    tmpDir,
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
    kill: (pid: number, sig: string) => kills.push([pid, sig]),
    notify: () => {},
    onChange: () => {},
    env: {},
  });
  return { ctl, spawned, kills, timers, tmpDir };
}

test("a call that lingers hung after 'ended' is still stopped by the 12 s and 20 s escalation", () => {
  const { ctl, spawned, kills, timers } = fake();
  ctl.start({});
  const c = spawned[0];
  c.say("waiting", { id: "X" });
  c.say("consented");
  ctl.stop();
  c.say("ended", { id: "X" }); // saved; call.ts now only lingers for the answer window, and hangs
  assert.equal(ctl.isRunning(), false);
  timers[0].fn();
  timers[1].fn();
  assert.deepEqual(kills, [
    [-777, "SIGINT"],
    [-777, "SIGKILL"],
  ]);
});

test("a call that exited by itself is not signalled", () => {
  const { ctl, spawned, kills, timers } = fake();
  ctl.start({});
  const c = spawned[0];
  c.say("consented");
  ctl.stop();
  c.say("ended", { id: "X" });
  c.emit("exit", 0);
  timers[0].fn();
  timers[1].fn();
  assert.deepEqual(kills, []);
});

test("practice: --file points into a fresh folder under the temp folder", () => {
  const seen: string[] = [];
  const ctl = createController({
    spawn: (_c: string, args: string[]) => {
      seen.push(args[args.indexOf("--file") + 1]);
      const c: any = new EventEmitter();
      c.pid = 1;
      c.stdin = Object.assign(new EventEmitter(), { writable: true, write: () => true });
      c.stdout = new EventEmitter();
      c.stderr = new EventEmitter();
      return c;
    },
    root: ROOT,
    tmpDir: mkdtempSync(join(tmpdir(), "wm-r1prac-")),
    setTimeout: () => {},
    kill: () => {},
    notify: () => {},
    onChange: () => {},
    env: {},
  });
  assert.equal(ctl.practice(), true);
  const first = seen[0];
  assert.ok(existsSync(first));
  assert.doesNotMatch(first, /wingman-practice\.wav$/, "no fixed name");
  assert.match(first, /wingman-practice-[^/\\]+[/\\]practice\.wav$/);
});

test("menu texts: every key has English and Hebrew, English has no Hebrew letters, placeholders are filled", () => {
  for (const [k, row] of Object.entries(T) as [string, string[]][]) {
    assert.equal(row.length, 2, k);
    assert.doesNotMatch(row[0], /[֐-׿]/, `${k} (en)`);
    assert.match(row[1], /[֐-׿]/, `${k} (he)`);
    assert.deepEqual(row[0].match(/\{\w+\}/g) ?? [], row[1].match(/\{\w+\}/g) ?? [], `${k} placeholders`);
  }
  assert.equal(tt("en", "confirmClient", { name: "Acme" }), "Confirm client: Acme");
  assert.match(tt("he", "confirmClient", { name: "Acme" }), /Acme/);
  assert.equal(tt("xx", "stop"), tt("he", "stop"), "unknown language = Hebrew, like htext");
});

test("tray/main.cjs has no English menu label left outside the text table", () => {
  const src = read("tray/main.cjs");
  const bad = [...src.matchAll(/label:\s*(["`])([^"`]*[A-Za-z]{3,}[^"`]*)\1/g)].map((m) => m[2]);
  assert.deepEqual(bad, []);
  assert.match(src, /key = L \+ lib\.menuKey/, "the language is part of the menu key");
});

test("the quit confirmation takes its texts from the caller", async () => {
  let shown: any;
  const dialog = {
    showMessageBoxSync: (o: any) => {
      shown = o;
      return 0;
    },
  };
  const r = await lib.requestQuit({
    isRunning: () => true,
    dialog,
    stop: () => {},
    quit: () => {},
    whenStopped: async () => true,
    text: { keep: "K", stop: "S", message: "M", detail: "D" },
  });
  assert.equal(r, "kept");
  assert.deepEqual([shown.buttons, shown.message, shown.detail], [["K", "S"], "M", "D"]);
  await lib.requestQuit({ isRunning: () => true, dialog, stop: () => {}, quit: () => {}, whenStopped: async () => true });
  assert.equal(shown.message, "A call is running.", "English when no text is given");
});

test("Cmd+Q while a call runs goes through the quit confirmation", () => {
  const src = read("tray/main.cjs");
  const bq = src.slice(src.indexOf('app.on("before-quit"'));
  assert.match(bq, /!allowQuit && ctl && ctl\.isRunning\(\)[\s\S]*e\.preventDefault\(\)[\s\S]*quitApp\(\)/);
  assert.match(src, /quit: \(\) => \{\s*allowQuit = true;\s*app\.quit\(\);/);
});

test("a dead overlay page stops the poll until the reload starts it again", () => {
  const src = read("overlay/main.cjs");
  const gone = src.slice(src.indexOf('"render-process-gone"'), src.indexOf('"did-fail-load"'));
  assert.match(gone, /clearInterval\(timer\)/);
  assert.match(src, /timer = setInterval\(poll, 100\)/);
});

test("call.ts handles a failed spawn of the engine", () => {
  const src = read("src/call.ts");
  assert.match(src, /run\.on\("error", \(e\) => \{[\s\S]*finalExit\(1\)/);
});
