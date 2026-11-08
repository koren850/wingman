// Reliability: bounded per-call state and a logger that never throws.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CappedTranscript, capSize, capTail, CALL_CAP } from "./engine/capped.ts";
import { CallLog } from "./log.ts";

test("capSize: a map and a set drop the oldest entries first", () => {
  const m = new Map<string, number>();
  for (let i = 0; i < 1200; i++) {
    m.set(`t${i}`, i);
    capSize(m);
  }
  assert.equal(m.size, CALL_CAP);
  assert.equal(m.has("t699"), false);
  assert.equal(m.has("t700"), true);
  const s = new Set<number>();
  for (let i = 0; i < 700; i++) {
    s.add(i);
    capSize(s, 10);
  }
  assert.deepEqual([...s], [690, 691, 692, 693, 694, 695, 696, 697, 698, 699]);
});

test("capTail: an array keeps its newest items", () => {
  const a = Array.from({ length: 900 }, (_, i) => i);
  capTail(a);
  assert.equal(a.length, CALL_CAP);
  assert.equal(a[0], 400);
});

test("a 4-hour synthetic call keeps the per-call state bounded", () => {
  const turnModel = new Map<string, string>(),
    decided = new Map<string, object>(),
    turnsWithCard = new Set<string>(),
    lat: object[] = [],
    meLat: object[] = [];
  const transcript = new CappedTranscript<{ ch: string; text: string; at: number }>();
  // 4 hours, a line every 2 s on average, 20 words a line, a question and a card every 20 s
  const lines = (4 * 3600) / 2;
  for (let i = 0; i < lines; i++) {
    transcript.push({ ch: i % 2 ? "me" : "them", text: Array.from({ length: 20 }, (_, k) => `w${i}x${k}`).join(" "), at: i * 2000 });
    if (i % 3 === 0) {
      turnModel.set(`t${i}`, "m");
      capSize(turnModel);
      decided.set(`c${i}`, {});
      capSize(decided);
      turnsWithCard.add(`t${i}`);
      capSize(turnsWithCard);
      lat.push({ i });
      capTail(lat);
      meLat.push({ i });
      capTail(meLat);
    }
  }
  assert.ok(lines * 20 > 100_000, "the call is far past the word cap");
  assert.ok(turnModel.size <= CALL_CAP && decided.size <= CALL_CAP && turnsWithCard.size <= CALL_CAP && lat.length <= CALL_CAP && meLat.length <= CALL_CAP);
  assert.ok(transcript.wordTotal <= transcript.maxWords, `words ${transcript.wordTotal}`);
  assert.ok(transcript.length < 2500, `lines ${transcript.length}`);
  assert.equal(transcript.length + transcript.omitted, lines, "every line is either kept or counted as omitted");
  assert.equal(transcript[0].at, 0, "the head stays");
  assert.equal(transcript.at(-1)!.at, (lines - 1) * 2000, "the newest line stays");
  assert.ok(Array.isArray(transcript.slice(-12)) && !(transcript.slice(-12) instanceof CappedTranscript), "slice gives a plain array");
});

test("transcript: under the cap nothing is dropped, and push returns the length", () => {
  const t = new CappedTranscript<{ text: string }>();
  assert.equal(t.push({ text: "a b" }), 1);
  assert.equal(t.push({ text: "c" }, { text: "d" }), 3);
  assert.equal(t.omitted, 0);
  assert.equal(t.wordTotal, 4);
});

// ---- the logger ----
test("log.write never throws for circular or BigInt rows, and counts them", () => {
  const log = new CallLog({ a: 1 });
  const circ: Record<string, unknown> = { name: "loop" };
  circ.self = circ;
  assert.doesNotThrow(() => log.write("cards", { type: "card", bad: circ }));
  assert.doesNotThrow(() => log.write("events", { type: "x", n: 10n ** 20n }));
  assert.equal(log.bad, 2);
  log.write("events", { type: "fine", n: 1 });
  const ev = readFileSync(join(log.dir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.ok(ev.some((r) => r.type === "fine"));
  assert.ok(
    ev.some((r) => r.type === "x" && r.n === "100000000000000000000"),
    "a BigInt is kept as text",
  );
  const cards = readFileSync(join(log.dir, "cards.jsonl"), "utf8").trim();
  assert.match(cards, /\[circular\]/);
  assert.ok(ev.some((r) => r.type === "log.bad"));
});

test("log.write: a throwing toJSON drops the row, counts it, and later rows still land", () => {
  const log = new CallLog({ a: 1 });
  const evil = {
    toJSON() {
      throw new Error("no");
    },
  };
  assert.doesNotThrow(() => log.write("events", { type: "evil", evil }));
  assert.equal(log.bad, 1);
  log.write("events", { type: "after" });
  const ev = readFileSync(join(log.dir, "events.jsonl"), "utf8");
  assert.match(ev, /"after"/);
  assert.doesNotMatch(ev, /"evil"/);
});
