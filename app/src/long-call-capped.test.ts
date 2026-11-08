// A reader with a call-wide cursor keeps reading after the transcript drops its middle lines (long calls).
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CappedTranscript } from "./engine/capped.ts";

test("lineAt and absLength: a cursor reader sees every kept line once after compaction", () => {
  const t = new CappedTranscript<{ text: string }>();
  t.maxWords = 400;
  t.headWords = 40;
  let cursor = 0;
  const seen: string[] = [];
  const pull = () => {
    for (; cursor < t.absLength; cursor++) {
      const l = t.lineAt(cursor);
      if (l) seen.push(l.text);
    }
  };
  for (let i = 0; i < 600; i++) {
    t.push({ text: `line${i} a b c d e f g h i` });
    if (i % 7 === 0) pull();
  }
  pull();
  assert.ok(t.omitted > 0, "the transcript compacted");
  assert.equal(cursor, 600);
  assert.equal(seen[seen.length - 1], "line599 a b c d e f g h i");
  // No line twice, in order, and the newest 20 were all read.
  assert.equal(new Set(seen).size, seen.length);
  for (let i = 580; i < 600; i++) assert.ok(seen.includes(`line${i} a b c d e f g h i`), `line${i} read`);
  assert.equal(t.lineAt(0)?.text, "line0 a b c d e f g h i");
  assert.equal(t.lineAt(599)?.text, "line599 a b c d e f g h i");
});

test("lineAt: without compaction it is the plain index", () => {
  const t = new CappedTranscript<{ text: string }>();
  t.push({ text: "a" }, { text: "b" });
  assert.equal(t.absLength, 2);
  assert.equal(t.lineAt(1)?.text, "b");
  assert.equal(t.lineAt(2), undefined);
});
