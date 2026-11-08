import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createVClock, withVClock } from "./testkit/vclock.ts";
import { wallNow, monoNow } from "./clock.ts";

test("vclock: timers fire in time order, ties in creation order, and Date.now / performance.now follow", async () => {
  await withVClock(async (vc) => {
    const seen: string[] = [];
    const t0 = Date.now(),
      p0 = performance.now();
    setTimeout(() => seen.push(`b@${Date.now() - t0}`), 200);
    setTimeout(() => seen.push(`a@${Date.now() - t0}`), 100);
    setTimeout(() => seen.push(`c@${Date.now() - t0}`), 200);
    await vc.advance(150);
    assert.deepEqual(seen, ["a@100"]);
    assert.equal(Date.now() - t0, 150);
    assert.equal(performance.now() - p0, 150);
    await vc.advance(100);
    assert.deepEqual(seen, ["a@100", "b@200", "c@200"]);
    assert.equal(new Date().getTime(), Date.now());
  });
});

test("vclock: intervals repeat, clearTimeout and clearInterval work, timers set by timers fire inside the window", async () => {
  await withVClock(async (vc) => {
    let n = 0;
    const iv = setInterval(() => n++, 1000);
    const dead = setTimeout(() => assert.fail("cleared timer fired"), 500);
    clearTimeout(dead);
    let chained = 0;
    setTimeout(() => setTimeout(() => chained++, 300), 100);
    await vc.advance(3500);
    assert.equal(n, 3);
    assert.equal(chained, 1);
    clearInterval(iv);
    await vc.advance(5000);
    assert.equal(n, 3);
    assert.equal(vc.pending(), 0);
  });
});

test("vclock: promise chains continue between timers (await sleep in the code under test)", async () => {
  await withVClock(async (vc) => {
    const log: number[] = [];
    const t0 = Date.now();
    const work = (async () => {
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        log.push(Date.now() - t0);
      }
    })();
    await vc.advance(3000);
    await work;
    assert.deepEqual(log, [1000, 2000, 3000]);
  });
});

test("vclock: unref and the timer handle behave like a Node timer; clocks are restored after uninstall", async () => {
  const realNow = Date.now;
  const vc = createVClock({ start: 5000 });
  vc.install();
  assert.equal(Date.now(), 5000);
  assert.equal(wallNow(), 5000);
  assert.ok(monoNow() >= 1000);
  const h = setTimeout(() => {}, 10) as unknown as { unref: () => unknown };
  assert.doesNotThrow(() => h.unref());
  vc.uninstall();
  assert.equal(Date.now, realNow);
  assert.ok(Math.abs(wallNow() - realNow()) < 1000);
});

test("vclock: a 90 s meeting with a 1 s pacing timer runs in under 1 s of real time", async () => {
  const real0 = process.hrtime.bigint();
  await withVClock(async (vc) => {
    let ticks = 0;
    setInterval(() => ticks++, 1000);
    let lines = 0;
    for (let s = 0; s < 90; s += 3) setTimeout(() => lines++, s * 1000);
    await vc.advance(90_000);
    assert.equal(ticks, 90);
    assert.equal(lines, 30);
    assert.equal(vc.elapsed(), 90_000);
  });
  assert.ok(Number(process.hrtime.bigint() - real0) / 1e6 < 1000, "under 1 s real time");
});

test("vclock: runAll drains one-shot timers and stops at the cap for intervals", async () => {
  await withVClock(async (vc) => {
    let a = 0;
    setTimeout(() => a++, 50_000);
    setTimeout(() => a++, 80_000);
    await vc.runAll();
    assert.equal(a, 2);
    setInterval(() => {}, 1000);
    await vc.runAll(10_000);
    assert.equal(vc.pending(), 1);
  });
});

test("vclock: Date() without new still returns a string, and instanceof Date holds", () => {
  const vc = createVClock();
  vc.install();
  try {
    assert.equal(typeof Date(), "string");
    assert.ok(new Date() instanceof Date);
    assert.equal(new Date("2020-01-01T00:00:00Z").getTime(), 1577836800000);
    assert.equal(Date.now(), vc.now());
  } finally {
    vc.uninstall();
  }
});
