// The relay keeps the newest memory view apart from the card rows, so a restarted window gets it back even after a flood of cards.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { RowRelay, isMemoryRow } from "./relay.ts";

const sink = () => {
  const got: string[] = [];
  return { got, w: { writable: true, destroyed: false, write: (l: string) => (got.push(l.trim()), true) } as never };
};
const mem = (ver: number) => JSON.stringify({ t: 5, type: "memory", view: { ver, topic: "x" }, at: 5 });
const card = (i: number) => JSON.stringify({ t: 5, type: "card", id: `c${i}`, say: 'it says "type":"memory",' });

test("isMemoryRow: a memory row, with or without a leading time field; never a card that quotes it", () => {
  assert.equal(isMemoryRow(mem(1)), true);
  assert.equal(isMemoryRow('{"type":"memory","view":{}}'), true);
  assert.equal(isMemoryRow(card(1)), false);
  assert.equal(isMemoryRow('{"type":"card","id":"a"}'), false);
});

test("the newest memory row survives a flood of card rows and is replayed to a new window, after the cards", () => {
  const r = new RowRelay(5);
  const a = sink();
  r.attach(a.w);
  r.feed(mem(1) + "\n");
  for (let i = 0; i < 20; i++) r.feed(card(i) + "\n");
  r.feed(mem(2) + "\n");
  assert.equal(a.got.filter(isMemoryRow).length, 2, "both are forwarded live");
  assert.equal(r.remembered, 5, "memory rows do not take ring places");
  const b = sink();
  r.attach(b.w);
  assert.equal(b.got.length, 6);
  assert.equal(b.got.filter(isMemoryRow).length, 1);
  assert.equal(JSON.parse(b.got.at(-1)!).view.ver, 2, "only the newest, and last");
});
