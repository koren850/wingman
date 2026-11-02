import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { joinSplit } from "./split.ts";

const lib = createRequire(import.meta.url)("../tray/lib.cjs");

test("split question: short fragment without end mark is glued within the window", () => {
  assert.equal(joinSplit({ text: "כמה זה", at: 1000, question: false }, "עולה לבנות חנות?", 1800, 1200), "כמה זה עולה לבנות חנות?");
});
test("split question: no glue after a question, an end mark, a long fragment or a late reply", () => {
  assert.equal(joinSplit({ text: "כמה זה עולה?", at: 1000, question: true }, "ומה עם אחסון", 1500, 1200), "ומה עם אחסון");
  assert.equal(joinSplit({ text: "בסדר.", at: 1000, question: false }, "מה השלב הבא?", 1500, 1200), "מה השלב הבא?");
  assert.equal(joinSplit({ text: "כמה זה", at: 1000, question: false }, "עולה?", 3000, 1200), "עולה?");
  assert.equal(joinSplit({ text: "a b c d e f g h i j k l m", at: 1000, question: false }, "x?", 1500, 1200), "x?");
  assert.equal(joinSplit({ text: "כמה זה", at: 1000, question: false }, "עולה?", 1500, 0), "עולה?");
});

test("tray: status lines parse; junk is ignored", () => {
  assert.deepEqual(lib.parseStatus('@@wingman {"ev":"waiting","id":"x"}'), { ev: "waiting", id: "x" });
  assert.equal(lib.parseStatus("Saved calls/x"), undefined);
  assert.equal(lib.parseStatus("@@wingman {broken"), undefined);
});
test("tray: call life cycle drives the menu-bar title", () => {
  let s = lib.reduce(lib.initialState(), { ev: "starting" });
  assert.equal(lib.view(s, Date.now()).title, " …");
  s = lib.reduce(s, { ev: "waiting", id: "c1" });
  assert.equal(s.phase, "waiting");
  assert.equal(lib.notifications(lib.initialState(), s, { ev: "waiting" }).length, 1);
  s = lib.reduce(s, { ev: "consented" });
  s = { ...s, liveAt: 0 };
  assert.match(lib.view(s, 65_000).title, /● 1:05/);
  s = lib.reduce(s, { ev: "health", id: "mic", level: "red", text: "MIC SILENT" });
  assert.match(lib.view(s, 65_000).title, /🔴/);
  s = lib.reduce(s, { ev: "health.clear", id: "mic" });
  assert.doesNotMatch(lib.view(s, 65_000).title, /🔴/);
  s = lib.reduce(s, { ev: "propose", title: "Acme" }); s = lib.reduce(s, { ev: "client", title: "Acme" });
  assert.match(lib.view(s, 65_000).statusLine, /Acme/);
  s = lib.reduce(s, { ev: "exit", code: 0 });
  assert.equal(s.phase, "idle"); assert.deepEqual(s.health, {});
});
test("tray: note text is cleaned; briefing form becomes a brief that loadBrief can read", () => {
  assert.equal(lib.cleanText("  hi\nthere\u0007 ", 300), "hi there");
  assert.equal(lib.briefFrom({ who: "", goal: "", notes: "", mustCover: "" }), undefined);
  const b = lib.briefFrom({ who: 'דנה "בע״מ"', goal: "חידוש אחסון", notes: "לקוח ותיק; רגיש למחיר", mustCover: "תקציב; לוח זמנים" });
  const dir = mkdtempSync(join(tmpdir(), "wm-brief-"));
  lib.writeBrief(dir, b);
  const back = YAML.parse(readFileSync(join(dir, "latest.yaml"), "utf8"));
  assert.equal(back.who, 'דנה "בע״מ"');
  assert.deepEqual(back.mustCover, ["תקציב", "לוח זמנים"]);
  assert.deepEqual(back.notes, ["לקוח ותיק", "רגיש למחיר"]);
});
test("tray: doctor verdict", () => {
  assert.equal(lib.doctorVerdict("... READY").ok, true);
  assert.equal(lib.doctorVerdict("... NOT READY").ok, false);
});
