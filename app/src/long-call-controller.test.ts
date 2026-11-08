// Final pass: the tray controller waits for the last stdout lines after "exit", and honours stop-and-delete while stopping.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { ROOT } from "./env.ts";

const { createController } = createRequire(import.meta.url)("../tray/controller.cjs");

function fake(streaming: boolean) {
  const spawned: any[] = [],
    timers: { fn: () => void; ms: number }[] = [],
    notes: string[] = [];
  const spawn = () => {
    const c: any = new EventEmitter();
    c.pid = 4242;
    c.written = [] as string[];
    c.stdin = Object.assign(new EventEmitter(), {
      writable: true,
      write: (s: string) => {
        c.written.push(s);
        return true;
      },
    });
    c.stdout = Object.assign(new EventEmitter(), streaming ? { readable: true } : {});
    c.stderr = new EventEmitter();
    c.kill = () => {};
    c.say = (ev: string, data: object = {}) => c.stdout.emit("data", Buffer.from(`\n@@wingman ${JSON.stringify({ ev, ...data })}\n`));
    spawned.push(c);
    return c;
  };
  const ctl = createController({
    spawn,
    root: ROOT,
    tmpDir: mkdtempSync(join(tmpdir(), "wm-ctl-")),
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
    kill: () => {},
    notify: (t: string) => notes.push(t),
    onChange: () => {},
    env: {},
  });
  return { ctl, spawned, timers, notes };
}

test("an ended line that arrives after exit still counts: no crash notice", () => {
  const { ctl, spawned, notes } = fake(true);
  ctl.start({});
  const c = spawned[0];
  c.say("waiting", { id: "X" });
  c.say("consented");
  c.emit("exit", 1, null); // exit first ...
  assert.equal(ctl.getState().running, true, "still waiting for the pipe to drain");
  c.say("ended", { id: "X" }); // ... then the last line
  c.stdout.emit("end");
  assert.equal(ctl.getState().running, false);
  assert.equal(ctl.getState().endedCleanly, true);
  assert.ok(!notes.some((n) => /unexpected/i.test(n)), `no crash notice: ${notes.join(" | ")}`);
});

test("a pipe that never ends does not hold the call open: the drain timer finishes it", () => {
  const { ctl, spawned, timers } = fake(true);
  ctl.start({});
  const c = spawned[0];
  c.say("waiting", { id: "X" });
  c.emit("exit", 0, null);
  assert.equal(ctl.getState().running, true);
  const t = timers.find((x) => x.ms === 300);
  assert.ok(t, "a short drain timer is set");
  t!.fn();
  assert.equal(ctl.getState().running, false);
});

test("stop-and-delete is sent even after a plain Stop", () => {
  const { ctl, spawned } = fake(false);
  ctl.start({});
  const c = spawned[0];
  c.say("waiting", { id: "X" });
  c.say("consented");
  assert.equal(ctl.stop(), true);
  assert.equal(ctl.stop(), false, "a second plain stop is still ignored");
  assert.equal(ctl.stopDelete(), true, "delete is honoured while stopping");
  assert.equal(c.written.at(-1), "stop-delete\n");
  assert.equal(ctl.getState().deleted, true);
});
