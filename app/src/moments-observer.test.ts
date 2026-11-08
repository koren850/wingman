// Observer pacing on a virtual clock: triggers, the per-minute cap, and merged windows that lose no line.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Observer, type ObserverLine, type ObserverWindow } from "./moments/observer.ts";
import type { HintLevel } from "./moments/types.ts";

function rig(cfg = {}) {
  let t = 0;
  const o = new Observer(() => t, cfg);
  let n = 0;
  const line = (text: string, hint: HintLevel = "none", side: "me" | "them" = "them"): ObserverLine => ({ id: `l${++n}`, text, side, at: t, hint });
  return { o, line, at: (ms: number) => (t = ms), adv: (ms: number) => (t += ms), now: () => t };
}

test("observer: a strong hint fires at once with the pending lines", () => {
  const r = rig();
  assert.equal(r.o.push(r.line("we met yesterday")), undefined);
  r.adv(1000);
  const w = r.o.push(r.line("how much is it?", "strong"));
  assert.equal(w?.trigger, "strong");
  assert.deepEqual(
    w?.lines.map((l) => l.text),
    ["we met yesterday", "how much is it?"],
  );
  assert.equal(r.o.pendingCount, 0);
});

test("observer: a weak hint waits for 0.7 s of quiet; a new line restarts the wait", () => {
  const r = rig();
  assert.equal(r.o.push(r.line("so what about hosting", "weak")), undefined);
  assert.equal(r.o.nextDueAt(), 700);
  r.at(500);
  assert.equal(r.o.poll(), undefined);
  assert.equal(r.o.push(r.line("and the domain", "none")), undefined);
  assert.equal(r.o.nextDueAt(), 1200);
  r.at(1100);
  assert.equal(r.o.poll(), undefined);
  r.at(1200);
  const w = r.o.poll();
  assert.equal(w?.trigger, "weak");
  assert.equal(w?.lines.length, 2);
  assert.equal(r.o.nextDueAt(), undefined);
});

test("observer: 12 new words fire, a topic change fires, a user ask fires", () => {
  const r = rig();
  assert.equal(r.o.push(r.line("one two three four five six")), undefined);
  const w = r.o.push(r.line("seven eight nine ten eleven twelve"));
  assert.equal(w?.trigger, "words");
  r.adv(5000);
  r.o.push(r.line("a few words"));
  assert.equal(r.o.topicChange()?.trigger, "topic");
  r.adv(5000);
  r.o.push(r.line("short one"));
  assert.equal(r.o.userAsk()?.trigger, "ask");
});

test("observer: lines from me never set a hint trigger but their words count", () => {
  const r = rig();
  assert.equal(r.o.push(r.line("how much is it?", "strong", "me")), undefined);
  assert.equal(r.o.nextDueAt(), undefined);
});

test("observer: never more than 6 calls in any 60 s window, and no line is lost", () => {
  const r = rig();
  const fired: ObserverWindow[] = [];
  const all: string[] = [];
  let i = 0;
  // 3 minutes, a strong hint every 2 s (30 per minute wanted), polling on a timer
  for (let ms = 0; ms < 180_000; ms += 500) {
    r.at(ms);
    if (ms % 2000 === 0) {
      const text = `line number ${i++}?`;
      all.push(text);
      const w = r.o.push(r.line(text, "strong"));
      if (w) fired.push(w);
    }
    const w = r.o.poll();
    if (w) fired.push(w);
  }
  for (let k = 0; k < fired.length; k++)
    assert.ok(fired.filter((w) => w.firedAt > fired[k].firedAt - 60_000 && w.firedAt <= fired[k].firedAt).length <= 6, `window at ${fired[k].firedAt}`);
  // drain: after the quiet, the rest goes out in the next slot
  for (let ms = 180_000; ms < 260_000 && r.o.pendingCount; ms += 500) {
    r.at(ms);
    const w = r.o.poll();
    if (w) fired.push(w);
  }
  const sentTexts = fired.flatMap((w) => w.lines.map((l) => l.text));
  assert.deepEqual(sentTexts, all, "every line sent once, in order");
  assert.ok(
    fired.some((w) => w.merged > 0),
    "held triggers were merged into later windows",
  );
  assert.ok(fired.length <= 6 * 5);
});

test("observer: nextDueAt waits for a free slot when the cap is used up", () => {
  const r = rig({ perMinute: 2 });
  r.at(0);
  r.o.push(r.line("a?", "strong"));
  r.at(1000);
  r.o.push(r.line("b?", "strong"));
  r.at(2000);
  assert.equal(r.o.push(r.line("c?", "strong")), undefined);
  assert.equal(r.o.nextDueAt(), 60_000);
  r.at(60_000);
  const w = r.o.poll();
  assert.deepEqual(
    w?.lines.map((l) => l.text),
    ["c?"],
  );
  assert.deepEqual(
    w?.context.map((l) => l.text),
    ["a?", "b?"],
  ); // earlier lines are context, not sent again
});

test("observer: the window carries earlier lines as context", () => {
  const r = rig();
  r.at(0);
  r.o.push(r.line("first question?", "strong"));
  r.at(10_000);
  r.o.push(r.line("some talk"));
  const w = r.o.push(r.line("second question?", "strong"));
  assert.deepEqual(
    w?.context.map((l) => l.text),
    ["first question?"],
  );
  assert.deepEqual(
    w?.lines.map((l) => l.text),
    ["some talk", "second question?"],
  );
});

test("observer: a runaway stream cannot grow the pending list without bound", () => {
  const r = rig({ maxPending: 10, newWords: 100000 });
  for (let i = 0; i < 100; i++) r.o.push(r.line("x y"));
  assert.equal(r.o.pendingCount, 10);
});
