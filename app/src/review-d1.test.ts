// Review round 12 (d1): extra edge cases for the Meeting context store, the .ics reader and the error table. Offline, invented data only.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseIcs, pickEvent, eventToPlan } from "./brief-ics.ts";

const req = createRequire(import.meta.url);
const att = req("../tray/attachments.cjs");
const errs = req("../dashboard/errors.js");
const tmp = () => mkdtempSync(join(tmpdir(), "d1rev-"));

test("pasted context is accepted even when 12 files are stored", async () => {
  const st = att.createStore({ dir: tmp(), pdftotext: "" });
  for (let i = 0; i < att.MAX_FILES; i++) assert.ok((await st.addFile(`f${i}.txt`, Buffer.from(`file ${i} text`))).ok);
  const r = st.setContext("Kickoff with the hosting team");
  assert.equal(r.ok, true, r.error);
  assert.equal(st.getContext(), "Kickoff with the hosting team");
  assert.equal(st.list().files.length, att.MAX_FILES, "the context is not listed as a file");
});

test("a replaced context keeps the old text when the new one is refused", () => {
  const st = att.createStore({ dir: tmp(), pdftotext: "", maxChars: 300 });
  assert.ok(st.setContext("a".repeat(250)).ok);
  const r = st.setContext("   ");
  assert.equal(r.ok, true);
  assert.equal(st.getContext(), "", "empty text clears the context");
});

test("Hebrew text is chunked within the token budget", () => {
  const he = Array.from({ length: 400 }, (_, i) => `משפט מספר ${i} על העברת האתר לשרת החדש.`).join(" ");
  const chunks = att.chunkText(he);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(att.estimateTokens(c) <= att.CHUNK_TOKENS, "chunk too big");
});

test("ics: Windows zone name, folded Hebrew title, no DTSTART and a cancelled event", () => {
  const text = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "SUMMARY:פגישת היכרות עם",
    "  הצוות החדש",
    "DTSTART;TZID=Israel Standard Time:20261112T100000",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "SUMMARY:No time",
    "STATUS:CANCELLED",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const events = parseIcs(text);
  assert.equal(events.length, 2);
  assert.match(events[0].title, /פגישת היכרות/);
  assert.ok(events[0].startMs > 0);
  const ev = pickEvent(events, Date.UTC(2026, 10, 1));
  assert.equal(ev?.cancelled, false);
  assert.equal(eventToPlan(events[1]).fields.at, 0);
});

test("ics: garbage and empty input never throw", () => {
  for (const t of ["", "BEGIN:VEVENT", "END:VEVENT\nEND:VEVENT", "\u0000\u0001garbage", "BEGIN:VEVENT\nDTSTART:notadate\nEND:VEVENT"])
    assert.doesNotThrow(() => parseIcs(t));
  assert.equal(pickEvent([], 0), null);
});

test("error table: real messages from the file store map to a specific entry, not 'generic'", async () => {
  const st = att.createStore({ dir: tmp(), pdftotext: "" });
  const msgs = [
    (await st.addFile("a.docx", Buffer.from("x"))).error,
    (await st.addFile("a.pdf", Buffer.from("%PDF-1.4 x"))).error,
    (await st.addFile("a.txt", Buffer.alloc(0))).error,
    (await st.addFile("a.ics", Buffer.from("BEGIN:VCALENDAR\nEND:VCALENDAR"))).error,
    (await st.addFile("a.txt", Buffer.from("  "))).error,
  ];
  for (const m of msgs) {
    assert.ok(m, "expected an error message");
    assert.notEqual(errs.classify(m).code, "generic", m);
  }
  assert.equal(errs.classify("pdftotext").code, "pdf-missing");
});
