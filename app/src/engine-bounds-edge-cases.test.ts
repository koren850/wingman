// Edge cases of the small engine parts: speaker numbering across reconnects, bounded transcript, mic watch and the shutdown deadline.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { SpeakerBook } from "./speakers.ts";
import { CappedTranscript, capSize } from "./engine/capped.ts";
import { MicWatch } from "./engine/mic-watch.ts";
import { lastResortDelayMs, LAST_RESORT_MS, TRAY_SIGKILL_MS } from "./engine/shutdown-deadline.ts";
import { CallLog } from "./log.ts";

const w = (speaker: number) => [{ word: "x", start: 0, end: 1, speaker, confidence: 1 }];

test("speakers: rebase before any voice, and twice in a row, does not shift numbers", () => {
  const b = new SpeakerBook();
  assert.equal(b.rebase("them"), false);
  assert.equal(b.of(w(0))?.spk, 1);
  assert.equal(b.rebase("them"), true);
  assert.equal(b.rebase("them"), false, "a burst counts once");
  assert.equal(b.of(w(0))?.spk, 2, "same raw id after a reconnect is a new person");
  assert.equal(b.peek(w(1)), undefined, "an interim id with no number takes none");
});

test("speakers: two people with the same name in one connection are not merged", () => {
  const b = new SpeakerBook();
  b.number(0);
  b.number(1);
  b.setName(1, "Dana");
  b.setName(2, "Dana");
  assert.equal(b.name(1), "Dana");
  assert.equal(b.name(2), "Dana");
  assert.equal(b.count, 2);
});

test("speakers: a name match joins an older person across epochs, case-insensitively, and the count follows", () => {
  const b = new SpeakerBook();
  b.number(0);
  b.setName(1, "Dana");
  b.rebase();
  const n = b.number(0);
  assert.equal(b.count, 2);
  b.setName(n, "dana");
  assert.equal(b.resolve(n), 1);
  assert.equal(b.count, 1);
  assert.equal(b.number(0), 1, "later lines of the new voice go to the same person");
});

test("capped transcript: one huge line does not loop or empty the transcript", () => {
  const t = new CappedTranscript<{ text: string }>();
  t.maxWords = 100;
  t.headWords = 10;
  t.push({ text: "a ".repeat(500) });
  t.push({ text: "b c" });
  assert.ok(t.length >= 1);
  assert.equal(t.at(-1)?.text, "b c");
});

test("capped transcript: filter and map return plain arrays", () => {
  const t = new CappedTranscript<{ text: string }>();
  t.push({ text: "one" }, { text: "two" });
  const f = t.filter((x) => x.text === "one");
  assert.ok(!(f instanceof CappedTranscript));
  assert.equal(f.length, 1);
});

test("capSize on a Set drops the oldest", () => {
  const s = new Set([1, 2, 3, 4]);
  capSize(s, 2);
  assert.deepEqual([...s], [3, 4]);
});

test("mic watch: a mic that never started never raises a bar, even with consent", async () => {
  const bars: string[] = [];
  const m = new MicWatch({
    intervalMs: 5,
    micPeak: 0.1,
    longSilentMs: 1e9,
    shuttingDown: () => false,
    onNever: () => bars.push("never"),
    onLong: () => {},
    onHeard: () => {},
  });
  m.consent();
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(bars, []);
  assert.equal(m.armed, false);
  m.micStarted();
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(bars, ["never"]);
  m.stop();
});

test("mic watch: stop before arming keeps it off", () => {
  const m = new MicWatch({ intervalMs: 5, micPeak: 0.1, longSilentMs: 1e9, shuttingDown: () => false, onNever: () => {}, onLong: () => {}, onHeard: () => {} });
  m.stop();
  m.consent();
  m.micStarted();
  assert.equal(m.armed, false);
});

test("shutdown deadline: lands before the tray SIGKILL for any arming time", () => {
  for (const lag of [0, 500, 9_000, 15_900, 30_000]) {
    const d = lastResortDelayMs(0, lag);
    assert.ok(lag + d < TRAY_SIGKILL_MS - 1000 || lag > LAST_RESORT_MS, `lag ${lag}`);
  }
});

test("log.write: circular and BigInt rows do not throw", () => {
  const l = new CallLog({ a: 1 });
  const a: Record<string, unknown> = { n: 1n };
  a.self = a;
  assert.doesNotThrow(() => l.write("events", a));
  assert.ok(l.bad >= 1);
});
