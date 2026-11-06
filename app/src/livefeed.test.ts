// Live conversation view: dashboard/livefeed.js (JSONL parsing, card cleaning and pinning, caps) and
// dashboard/livetail.cjs (the main-process file tail).
// Uses real temp files; the tail's setInterval is injected, so tests drive each poll by calling the captured tick().
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const req = createRequire(import.meta.url);
const F = req("../dashboard/livefeed.js");
const { createLiveTail } = req("../dashboard/livetail.cjs");

const line = (t: number, ch: string, text: string) => ({ t, ch, text, words: [] });
const card = (o: any) => ({ type: "card", turnId: "q", ...o });

test("parseJsonl: complete rows only, the half-written last row waits, junk is skipped", () => {
  const a = F.parseJsonl("", '{"t":1,"ch":"me","text":"a"}\nnot json\n{"t":2,"ch":"them","te');
  assert.equal(a.rows.length, 1);
  assert.equal(a.carry, '{"t":2,"ch":"them","te');
  const b = F.parseJsonl(a.carry, 'xt":"b"}\n');
  assert.deepEqual(
    b.rows.map((r: any) => r.text),
    ["b"],
  );
  assert.equal(b.carry, "");
  assert.deepEqual(F.parseJsonl("", "[1,2]\n42\n").rows, []);
});

test("cleaners validate and cap; only bank/ai/stall cards are shown", () => {
  assert.equal(F.cleanLine({ t: 1, ch: "x", text: "hi" }), null);
  assert.equal(F.cleanLine({ t: "1", ch: "me", text: "hi" }), null);
  assert.equal(F.cleanLine({ t: 1, ch: "me", text: "   " }), null);
  assert.equal(F.cleanLine({ t: 1, ch: "them", text: "x".repeat(5000) }).text.length, 600);
  assert.equal(F.cleanLine({ t: 1, ch: "them", text: "a‮b" }).text, "ab"); // bidi override characters are stripped
  assert.equal(F.cleanCard(card({ id: "f", badge: "fact", say: "x" })), null);
  assert.equal(F.cleanCard(card({ id: "h", badge: "bank", health: true, say: "x" })), null);
  assert.equal(F.cleanCard(card({ id: "s", badge: "bank", turnId: "side", say: "x" })), null);
  assert.equal(F.cleanCard(card({ id: "p", badge: "bank", hidden: true, say: "x" })), null);
  assert.equal(F.cleanCard({ type: "capture", id: "c", badge: "bank", say: "x" }), null);
  assert.deepEqual(F.cleanCard(card({ id: "w", badge: "bank", say: "x", withdraw: true })), { id: "w", withdraw: true });
  const c = F.cleanCard(card({ id: "b", badge: "bank", at: 7, question: "q".repeat(999), say: "s".repeat(5000), junk: "no" }));
  assert.equal(c.t, 7);
  assert.equal(c.question.length, 300);
  assert.equal(c.say.length, 900);
  assert.equal(c.junk, undefined);
});

test("pinIndex: same question text wins, glued questions land on the last fragment, else the latest client line before the card", () => {
  const L = [
    line(10, "them", "שלום, יש לי שאלה"),
    line(20, "me", "בטח"),
    line(30, "them", "כמה זמן לוקח להעביר את האתר?"),
    line(40, "them", "ועוד משהו קטן"),
    line(50, "me", "כן"),
  ].map((l, n) => ({ n, ...l }));
  assert.equal(F.pinIndex(L, { question: "כמה זמן לוקח להעביר את האתר", t: 45 }), 2); // by text, even though a newer client line exists
  assert.equal(F.pinIndex(L, { question: "", t: 45 }), 3); // by time
  assert.equal(F.pinIndex(L, { question: "שאלה לא קיימת בכלל", t: 25 }), 0); // unknown text: time fallback skips the "me" line
  assert.equal(F.pinIndex(L, { question: "", t: 5 }), -1); // nothing said yet
  assert.equal(F.pinIndex(L, { question: "SHOULD NOT MATCH ME LINES", t: 60 }), 3);
  const G = [line(1, "them", "אני רוצה לדעת כמה"), line(2, "them", "זה עולה לי בסוף")].map((l, n) => ({ n, ...l }));
  assert.equal(F.pinIndex(G, { question: "אני רוצה לדעת כמה זה עולה לי בסוף", t: 3 }), 1);
  const R = [line(1000, "them", "מה המחיר"), line(10000, "them", "מה המחיר")].map((l, n) => ({ n, ...l }));
  assert.equal(F.pinIndex(R, { question: "מה המחיר", t: 11000 }), 1); // a repeated question: the latest one
  assert.equal(F.pinIndex(R, { question: "מה המחיר", t: 3000 }), 0); // ...unless the card came before it
});

test("feed: cards are pinned under their client line, re-sent cards replace, withdraw removes, a late line re-pins", () => {
  const f = F.create();
  f.addCards([card({ id: "a", badge: "ai", t: 15, question: "מה המחיר", say: "טיוטה" })]);
  assert.equal(f.view().loose.length, 1); // card first: shown loose, never lost
  f.addLines([line(10, "them", "מה המחיר?"), line(12, "me", "רגע")]);
  let v = f.view();
  assert.equal(v.loose.length, 0);
  assert.equal(v.items[0].cards[0].say, "טיוטה");
  f.addCards([card({ id: "a", badge: "ai", t: 15, question: "מה המחיר", say: "טיוטה מלאה" })]);
  v = f.view();
  assert.equal(v.items[0].cards.length, 1);
  assert.equal(v.items[0].cards[0].say, "טיוטה מלאה");
  f.addCards([{ type: "card", id: "a", withdraw: true }]);
  assert.equal(f.view().items[0].cards.length, 0);
});

test("feed: at most 400 lines and 150 cards, duplicates skipped, stamps are mm:ss from the call start", () => {
  const f = F.create();
  f.addLines(Array.from({ length: 450 }, (_, i) => line(1000 + i * 1000, i % 2 ? "me" : "them", "line " + i)));
  assert.equal(f.lines.length, 400);
  assert.equal(f.lines[0].text, "line 50");
  f.addLines([line(1000 + 449 * 1000, "me", "line 449")]);
  assert.equal(f.lines.length, 400);
  f.addCards(Array.from({ length: 200 }, (_, i) => card({ id: "c" + i, badge: "bank", t: 1000 + i, say: "s" + i })));
  assert.equal(f.snapshot().cards.length, 150);
  assert.equal(F.stamp(65_000, 0), "01:05");
  assert.equal(F.stamp(3_725_000, 0), "1:02:05");
  assert.equal(F.stamp(0, 5000), "00:00");
  assert.equal(F.startOf(1000, 3000), 1000);
  assert.equal(F.startOf(0, 3000), 3000);
  assert.equal(F.startOf(90000, 3000), 3000);
});

test("tail: reads new rows in batches, keeps a half row and a split multibyte char, resets on a new call, stops with the call", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wm-live-")));
  const id = "01JTESTLIVECALL00000000001",
    dir = join(base, id);
  mkdirSync(dir);
  const sent: any[] = [];
  let tick: (() => void) | undefined;
  let cleared = 0;
  const t = createLiveTail({
    callsDir: base,
    send: (p: any) => sent.push(p),
    setInterval: (fn: () => void) => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {
      cleared++;
    },
  });
  t.sync({ running: true, callId: id });
  assert.equal(sent[0].reset, true);
  assert.equal(sent[0].callId, id);
  writeFileSync(join(dir, "transcript.jsonl"), JSON.stringify(line(10, "them", "שלום")) + "\n");
  tick!();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].lines[0].text, "שלום");
  const full = JSON.stringify(line(20, "them", "עוד שורה בעברית")) + "\n",
    buf = Buffer.from(full);
  const cut = buf.indexOf(Buffer.from("בעברית")) + 3; // inside a 2-byte Hebrew letter
  appendFileSync(join(dir, "transcript.jsonl"), buf.subarray(0, cut));
  tick!();
  assert.equal(sent.length, 2); // half a row: nothing yet
  appendFileSync(join(dir, "transcript.jsonl"), buf.subarray(cut));
  tick!();
  assert.equal(sent[2].lines[0].text, "עוד שורה בעברית");
  writeFileSync(
    join(dir, "cards.jsonl"),
    JSON.stringify(card({ id: "q1", badge: "bank", t: 25, question: "", say: "תשובה" })) +
      "\n" +
      JSON.stringify(card({ id: "f", badge: "fact", say: "no" })) +
      "\n",
  );
  tick!();
  assert.equal(sent[3].cards.length, 1);
  assert.equal(sent[3].lines.length, 0);
  assert.equal(t.snapshot(id).lines.length, 2);
  assert.equal(t.snapshot("other").lines.length, 0);
  const n = sent.length;
  tick!();
  assert.equal(sent.length, n); // nothing new: nothing sent
  appendFileSync(join(dir, "transcript.jsonl"), JSON.stringify(line(30, "me", "אחרון")) + "\n");
  t.sync({ running: false, callId: id }); // call ended: one last read, then stop
  assert.equal(sent[sent.length - 2].lines[0].text, "אחרון");
  assert.equal(sent[sent.length - 1].callId, "");
  assert.equal(cleared, 1);
  assert.equal(t.active, "");
  t.sync({ running: true, callId: "../etc" });
  assert.equal(t.active, ""); // ids are validated
});

test("tail: a big backlog is sent as one capped snapshot; a missing folder or a symlink is ignored", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wm-live-")));
  const id = "01JTESTLIVECALL00000000002";
  const sent: any[] = [];
  let tick: (() => void) | undefined;
  const t = createLiveTail({
    callsDir: base,
    send: (p: any) => sent.push(p),
    setInterval: (fn: () => void) => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {},
  });
  t.sync({ running: true, callId: id });
  tick!();
  assert.equal(sent.length, 1); // folder not there yet
  mkdirSync(join(base, id));
  writeFileSync(join(base, id, "transcript.jsonl"), Array.from({ length: 700 }, (_, i) => JSON.stringify(line(1000 + i, "them", "x" + i))).join("\n") + "\n");
  tick!();
  const last = sent[sent.length - 1];
  assert.equal(last.reset, true);
  assert.equal(last.lines.length, 400);
  t.sync({ running: false });
});

test('a "For you" card (badge me) is shown and pinned under Dan\'s own line, a calc card keeps its source', () => {
  const f = F.create();
  f.addLines([line(10, "them", "אז בקשר לאתר"), line(20, "me", "כמה זה 36 ועוד 42?"), line(30, "them", "מעולה")]);
  f.addCards([
    card({ id: "m1-me", turnId: "m1", badge: "me", forMe: true, source: "calc", t: 22, question: "כמה זה 36 ועוד 42?", say: "36 + 42 = 78" }),
    card({ id: "q1-calc", turnId: "q1", badge: "ai", source: "calc", t: 31, question: "", say: "12 × 3 = 36" }),
  ]);
  const v = f.view();
  assert.deepEqual(
    v.items[1].cards.map((c: any) => [c.badge, c.source]),
    [["me", "calc"]],
  ); // under the me line, not under the client line before it
  assert.equal(v.items[2].cards[0].say, "12 × 3 = 36");
  assert.equal(v.items[2].cards[0].source, "calc");
  assert.equal(F.cleanCard(card({ id: "ask", badge: "me", turnId: "side", say: "x" })), null);
});

test("speaker rows: names map, rename wins over the written name, cleared falls back to Speaker n, junk rejected", () => {
  const f = F.create();
  f.addLines([
    { t: 1000, ch: "them", spk: 2, text: "hello there" },
    { t: 2000, ch: "them", spk: 1, name: "Pierre", text: "good morning" },
    { t: 3000, ch: "me", text: "hi" },
  ]);
  assert.equal(f.view().items[0].name, undefined);
  assert.equal(f.view().items[1].name, "Pierre");
  assert.deepEqual(f.addSpeakerRows([{ type: "speaker", spk: 2, name: "Dana‮", source: "user", t: 5 }]), { 2: "Dana" });
  assert.equal(f.view().items[0].name, "Dana", "older line gets the name");
  assert.equal(f.view().items[0].spk, 2);
  assert.equal(f.addSpeakerRows([{ type: "speaker", spk: 2, name: "Dana" }]), null, "no change");
  for (const bad of [
    { type: "speaker", spk: 0, name: "x" },
    { type: "speaker", spk: 21, name: "x" },
    { type: "speaker", spk: 1.5, name: "x" },
    { type: "speaker", spk: "2", name: "x" },
    { type: "speaker", spk: 3, name: 7 },
    { type: "card", spk: 3, name: "x" },
  ])
    assert.equal(f.addSpeakerRows([bad]), null, JSON.stringify(bad));
  assert.equal(f.addSpeakerRows([{ type: "speaker", spk: 1, name: "Ruth" }])[1], "Ruth");
  assert.equal(f.view().items[1].name, "Ruth", "a rename replaces the old name");
  f.addSpeakerRows([{ type: "speaker", spk: 1, name: "" }]);
  assert.equal(f.view().items[1].name, undefined, "cleared");
  assert.equal(f.view().items[2].name, undefined, "my own line never gets a name");
  assert.equal(f.addSpeakerRows([{ type: "speaker", spk: 4, name: "x".repeat(80) }])[4].length, 40);
  assert.equal(F.cleanLine({ t: 1, ch: "them", text: "a", spk: 2, name: "Dana" }).spk, 2);
  assert.deepEqual(f.snapshot().names[2], "Dana");
  assert.equal(f.setNames({ 2: "Ruth", 99: "no", x: "no" })[2], "Ruth");
  f.clear();
  assert.deepEqual(f.names, {});
});
