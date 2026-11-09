// Stop hooks (engine/lifecycle.ts): modules stop their own timers when Stop begins, and nothing is built for a call that is ending without ever going live.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { onStop, runStopHooks } from "./engine/lifecycle.ts";
import { transition } from "./engine/phase.ts";
import { log } from "./engine/boot.ts";
import { memoryLoop, tipsTick } from "./engine/coach.ts";
import "./engine/moments-observer.ts"; // registers stopObserver

test("stop hooks run once each, and a throwing hook does not block the others", () => {
  const ran: string[] = [];
  onStop(() => ran.push("a"));
  onStop(() => {
    throw new Error("boom");
  });
  onStop(() => ran.push("b"));
  runStopHooks();
  runStopHooks();
  assert.deepEqual(ran, ["a", "b"]);
});

test("a call that is stopped before it was live builds no memory loop, starts no timer and writes no session.json", () => {
  transition("closing");
  assert.equal(memoryLoop(), undefined);
  tipsTick(); // used to start the 1 s memory timer, which comes back 5 s after Stop
  assert.equal(memoryLoop(), undefined);
  assert.equal(existsSync(join(log.dir, "session.json")), false);
});
