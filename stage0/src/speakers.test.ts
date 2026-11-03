// The other side's voices: call-local numbers, names, labels for the models.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dominantSpeaker, SpeakerBook, lineLabel } from "./speakers.ts";

const w = (speaker?: number) => ({ word: "x", start: 0, end: 0.1, ...(speaker === undefined ? {} : { speaker }) });

test("dominant speaker: most words win; no speaker data gives undefined", () => {
  assert.equal(dominantSpeaker([w(3), w(3), w(0)]), 3);
  assert.equal(dominantSpeaker([w(), w()]), undefined);
});

test("speaker book: numbers in order of first voice, names override, labels for the models", () => {
  const b = new SpeakerBook();
  assert.deepEqual(b.of([w(7)]), { spk: 1 });
  assert.deepEqual(b.of([w(2), w(2)]), { spk: 2 });
  assert.deepEqual(b.of([w(7)]), { spk: 1 });
  b.setName(2, "Dana");
  assert.deepEqual(b.of([w(2)]), { spk: 2, name: "Dana" });
  assert.equal(b.count, 2);
  assert.equal(lineLabel("them", { spk: 1 }), "them (Speaker 1)");
  assert.equal(lineLabel("them", { spk: 2, name: "Dana" }), "them (Dana)");
  assert.equal(lineLabel("me", { spk: 1 }), "me");
  assert.equal(lineLabel("them"), "them");
});
