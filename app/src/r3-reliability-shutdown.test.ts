// r3-reliability: one computed shutdown deadline.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HARD_EXIT_MS, LAST_RESORT_MS, TRAY_SIGKILL_MS, lastResortDelayMs } from "./engine/shutdown-deadline.ts";

test("shutdown: the last-resort exit lands before 19 s from the start for any close time", () => {
  const start = 1_000_000;
  for (let closeMs = 0; closeMs <= 30_000; closeMs += 250) {
    const fireAt = closeMs + lastResortDelayMs(start, start + closeMs);
    // a close that ends after the 16 s mark gets the 1 s floor, but the 10 s hard timer ends the process long before such a close
    if (closeMs <= HARD_EXIT_MS) assert.ok(fireAt <= 19_000 - 1, `close at ${closeMs} ms fires at ${fireAt} ms`);
    if (closeMs <= LAST_RESORT_MS - 1000) assert.equal(fireAt, LAST_RESORT_MS, "armed late still fires at the same absolute time");
  }
  assert.ok(LAST_RESORT_MS < TRAY_SIGKILL_MS - 3000);
});

test("shutdown: the delay never drops below 1 s", () => {
  assert.equal(lastResortDelayMs(0, 15_900), 1000);
  assert.equal(lastResortDelayMs(0, 99_000), 1000);
});

test("shutdown: shutdown() arms the last-resort timer before any slow step, from the start, with the helper", () => {
  const src = readFileSync(new URL("./engine/shutdown.ts", import.meta.url), "utf8");
  assert.ok(src.indexOf("lastResortDelayMs(startedAt") < src.indexOf("await Promise.all(stops"), "armed before anything slow");
  assert.match(src, /lastResortDelayMs\(startedAt, Date\.now\(\)\)/);
  assert.doesNotMatch(src, /, 16_000\)/);
});
