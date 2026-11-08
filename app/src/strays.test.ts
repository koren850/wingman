import { test } from "node:test";
import assert from "node:assert/strict";
import { strayCounter, strayAction, STRAY_RUNAWAY, STRAY_WINDOW_MS } from "./engine/strays.ts";

test("strays: the count slides over a one-minute window", () => {
  const count = strayCounter();
  assert.equal(count(0), 1);
  assert.equal(count(1000), 2);
  assert.equal(count(STRAY_WINDOW_MS), 2, "the first error has aged out");
  assert.equal(count(STRAY_WINDOW_MS + 1000), 2, "the second has too");
});

test("strays: a live call survives repeated errors, warning once past 3", () => {
  assert.deepEqual(
    [1, 2, 3].map((n) => strayAction(n, true, false)),
    ["log", "log", "log"],
  );
  assert.equal(strayAction(4, true, false), "warn");
  assert.equal(strayAction(5, true, false), "log");
  assert.equal(strayAction(STRAY_RUNAWAY - 1, true, false), "log");
});

test("strays: only a runaway loop ends the call; an error before it is live or while stopping is logged", () => {
  assert.equal(strayAction(STRAY_RUNAWAY, true, false), "crash");
  assert.equal(strayAction(1, false, false), "log");
  assert.equal(strayAction(1, true, true), "log");
  assert.equal(strayAction(STRAY_RUNAWAY + 50, true, true), "log", "the stop guards end a stopping process, not a stray");
});
