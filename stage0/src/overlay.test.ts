// Answer window helpers: overlay/lib.cjs (call phase from call.json, capture chip list) and overlay/text.js (bidi segments, health text).
// Pure functions only; no Electron needed.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const lib = require("../overlay/lib.cjs");
const text = require("../overlay/text.js");

test("callPhase: real phase, liveAt, ended, no phase, bad file", () => {
  assert.deepEqual(lib.callPhase(JSON.stringify({ phase: "live", liveAt: 1700 })), { phase: "live", liveAt: 1700 });
  assert.deepEqual(lib.callPhase(JSON.stringify({ phase: "waiting" })), { phase: "waiting", liveAt: 0 });
  assert.deepEqual(lib.callPhase(JSON.stringify({ phase: "live", endedAt: "2026-11-03" })), { phase: "ended", liveAt: 0 });
  assert.deepEqual(lib.callPhase(JSON.stringify({ id: "x" })), { phase: null, liveAt: 0 });   // old call.json: page uses its timer
  assert.deepEqual(lib.callPhase(JSON.stringify({ phase: "bogus" })), { phase: null, liveAt: 0 });
  assert.equal(lib.callPhase("{half"), null);
  assert.equal(lib.callPhase(""), null);
});

test("pushCapture: newest first, no repeats, max 3", () => {
  let l: string[] = [];
  for (const v of ["a", "b", "c", "d"]) l = lib.pushCapture(l, v);
  assert.deepEqual(l, ["d", "c", "b"]);
  assert.equal(lib.pushCapture(l, "c"), l);
  assert.equal(lib.pushCapture(l, ""), l);
});

function fakeGs(failOn: string[] = []) {
  const reg = new Map<string, () => void>();
  return { reg, register: (a: string, f: () => void) => { if (failOn.includes(a)) return false; reg.set(a, f); return true; }, unregister: (a: string) => { reg.delete(a); } };
}
test("capture keys: Ctrl+Opt+1..3 copy chip N, unregistered on quit", () => {
  const gs = fakeGs(), list = ["052-0000000", "dana@x.co.il"], copied: string[] = [];
  const held = lib.registerCaptureKeys(gs, () => list, (v: string) => copied.push(v));
  assert.deepEqual(held, ["Control+Alt+1", "Control+Alt+2", "Control+Alt+3"]);
  gs.reg.get("Control+Alt+1")!(); gs.reg.get("Control+Alt+2")!(); gs.reg.get("Control+Alt+3")!();   // chip 3 does not exist: nothing
  assert.deepEqual(copied, ["052-0000000", "dana@x.co.il"]);
  lib.unregisterCaptureKeys(gs, held);
  assert.equal(gs.reg.size, 0); assert.equal(held.length, 0);
});
test("capture keys: skip taken or refused accelerators", () => {
  const gs = fakeGs(["Control+Alt+3"]);
  const held = lib.registerCaptureKeys(gs, () => [], () => {}, ["Control+Alt+2"]);
  assert.deepEqual(held, ["Control+Alt+1"]);
});
test("capture keys do not collide with window or tray keys", () => {
  const used = ["Control+Alt+C", "Control+Alt+P", "Control+Alt+R", "Control+Alt+K", "Control+Alt+L", "Control+Alt+Return", "Control+Alt+N", "Control+Alt+A"];
  for (let n = 1; n <= 3; n++) assert.ok(!used.includes(lib.captureAccel(n)));
});

const join = (s: string) => text.segments(s).map((x: any) => x.text).join("");
const ltr = (s: string) => text.segments(s).filter((x: any) => x.ltr).map((x: any) => x.text);
test("segments: dates, versions, prices, multi-word Latin stay whole and lossless", () => {
  for (const s of ["נגמר ב-(8 Nov) ושרת: PHP 8.1", "הפעילו Facebook Ads עם Node 18 דרך ה-API", "תקציב 40-50 אלף ₪ + מע״מ ו-2,400 ₪", "שלח ל-dana@example-electronics.co.il."]) assert.equal(join(s), s);
  assert.deepEqual(ltr("נגמר ב-(8 Nov) ושרת: PHP 8.1"), ["8 Nov", "PHP 8.1"]);
  assert.deepEqual(ltr("הפעילו Facebook Ads עם Node 18 דרך ה-API"), ["Facebook Ads", "Node 18", "API"]);
  assert.deepEqual(ltr("תקציב 40-50 אלף ₪ ו-2,400 ₪"), ["40-50", "2,400"]);
  assert.deepEqual(ltr("שלח ל-dana@example-electronics.co.il."), ["dana@example-electronics.co.il"]);
});

test("healthText: Hebrew only, with a next step", () => {
  assert.equal(text.healthText("health-x", "NOT HEARING THE OTHER SIDE – אין שמע מהצד השני"), "אין שמע מהצד השני");
  assert.match(text.healthText("health-stt-them", "STT (them) – Error 401"), /^הצד השני: Error 401\. בדוק את חיבור האינטרנט/);
  const r = text.healthText("health-stt-me", "STT DISCONNECTED (me) – אין תמלול, מנסה להתחבר מחדש");
  assert.ok(!/STT/.test(r) && /המיקרופון שלך/.test(r) && /בדוק/.test(r));
  assert.match(text.healthText("health-only-you", "I only hear you", "Ctrl+Opt+A"), /לשאול אותי: Ctrl\+Opt\+A/);
  assert.equal(text.healthText("health-mic", "המיקרופון לא קולט. בדוק הרשאה"), "המיקרופון לא קולט. בדוק הרשאה");
});
