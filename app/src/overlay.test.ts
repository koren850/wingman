// Answer window helpers: overlay/lib.cjs (call phase from call.json, capture chip list) and overlay/text.js (bidi segments, health text).
// Pure functions only; no Electron needed.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolveUiLanguage, schema } from "./settings.ts";
const require = createRequire(import.meta.url);
const lib = require("../overlay/lib.cjs");
const text = require("../overlay/text.js");

test("callPhase: real phase, liveAt, ended, no phase, bad file", () => {
  assert.deepEqual(lib.callPhase(JSON.stringify({ phase: "live", liveAt: 1700 })), { phase: "live", liveAt: 1700 });
  assert.deepEqual(lib.callPhase(JSON.stringify({ phase: "waiting" })), { phase: "waiting", liveAt: 0 });
  assert.deepEqual(lib.callPhase(JSON.stringify({ phase: "live", endedAt: "2026-11-03" })), { phase: "ended", liveAt: 0 });
  assert.deepEqual(lib.callPhase(JSON.stringify({ id: "x" })), { phase: null, liveAt: 0 }); // old call.json: page uses its timer
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
  return {
    reg,
    register: (a: string, f: () => void) => {
      if (failOn.includes(a)) return false;
      reg.set(a, f);
      return true;
    },
    unregister: (a: string) => {
      reg.delete(a);
    },
  };
}
test("capture keys: Ctrl+Opt+1..3 copy chip N, unregistered on quit", () => {
  const gs = fakeGs(),
    list = ["050-1234567", "dana@x.co.il"],
    copied: string[] = [];
  const held = lib.registerCaptureKeys(
    gs,
    () => list,
    (v: string) => copied.push(v),
  );
  assert.deepEqual(held, ["Control+Alt+1", "Control+Alt+2", "Control+Alt+3"]);
  gs.reg.get("Control+Alt+1")!();
  gs.reg.get("Control+Alt+2")!();
  gs.reg.get("Control+Alt+3")!(); // chip 3 does not exist: nothing
  assert.deepEqual(copied, ["050-1234567", "dana@x.co.il"]);
  lib.unregisterCaptureKeys(gs, held);
  assert.equal(gs.reg.size, 0);
  assert.equal(held.length, 0);
});
test("capture keys: skip taken or refused accelerators", () => {
  const gs = fakeGs(["Control+Alt+3"]);
  const held = lib.registerCaptureKeys(
    gs,
    () => [],
    () => {},
    ["Control+Alt+2"],
  );
  assert.deepEqual(held, ["Control+Alt+1"]);
});
test("capture keys do not collide with window or tray keys", () => {
  const used = ["Control+Alt+C", "Control+Alt+P", "Control+Alt+R", "Control+Alt+K", "Control+Alt+L", "Control+Alt+Return", "Control+Alt+N", "Control+Alt+A"];
  for (let n = 1; n <= 3; n++) assert.ok(!used.includes(lib.captureAccel(n)));
});

const join = (s: string) =>
  text
    .segments(s)
    .map((x: any) => x.text)
    .join("");
const ltr = (s: string) =>
  text
    .segments(s)
    .filter((x: any) => x.ltr)
    .map((x: any) => x.text);
test("segments: dates, versions, prices, multi-word Latin stay whole and lossless", () => {
  for (const s of [
    "נגמר ב-(8 Nov) ושרת: PHP 8.1",
    "הפעילו Facebook Ads עם Node 18 דרך ה-API",
    "תקציב 40-50 אלף ₪ + מע״מ ו-2,400 ₪",
    "שלח ל-dana@example-shop.co.il.",
  ])
    assert.equal(join(s), s);
  assert.deepEqual(ltr("נגמר ב-(8 Nov) ושרת: PHP 8.1"), ["8 Nov", "PHP 8.1"]);
  assert.deepEqual(ltr("הפעילו Facebook Ads עם Node 18 דרך ה-API"), ["Facebook Ads", "Node 18", "API"]);
  assert.deepEqual(ltr("תקציב 40-50 אלף ₪ ו-2,400 ₪"), ["40-50", "2,400"]);
  assert.deepEqual(ltr("שלח ל-dana@example-shop.co.il."), ["dana@example-shop.co.il"]);
});

test("healthText: Hebrew only, with a next step", () => {
  assert.equal(text.healthText("health-x", "NOT HEARING THE OTHER SIDE – אין שמע מהצד השני"), "אין שמע מהצד השני");
  assert.match(text.healthText("health-stt-them", "STT (them) – Error 401"), /^הצד השני: Error 401\. בדוק את חיבור האינטרנט/);
  const r = text.healthText("health-stt-me", "STT DISCONNECTED (me) – אין תמלול, מנסה להתחבר מחדש");
  assert.ok(!/STT/.test(r) && /המיקרופון שלך/.test(r) && /בדוק/.test(r));
  assert.match(text.healthText("health-only-you", "I only hear you", "Ctrl+Opt+A"), /לשאול אותי: Ctrl\+Opt\+A/);
  assert.equal(text.healthText("health-mic", "המיקרופון לא קולט. בדוק הרשאה"), "המיקרופון לא קולט. בדוק הרשאה");
});

test("an English-only line is shown left to right as a whole; Hebrew with English islands is not", () => {
  assert.equal(text.isLatin("What's the first problem you'd want solved in 90 days?"), true);
  assert.equal(text.isLatin("מה ההבדל בין RAG ל-fine-tuning?"), false);
  assert.equal(text.isLatin("30 יום"), false);
  assert.equal(text.isLatin("90"), false);
});

// ---- UI language (overlay/strings.js, setting ui.language) ----
const strings = require("../overlay/strings.js");

test("strings: every key exists in both languages, placeholders match, and English has no Hebrew", () => {
  const he = Object.keys(strings.STRINGS.he).sort(),
    en = Object.keys(strings.STRINGS.en).sort();
  assert.deepEqual(en, he, "he and en key sets differ");
  for (const k of he) {
    const ph = (s: string) => (s.match(/\{\w+\}/g) || []).sort().join();
    assert.equal(ph(strings.STRINGS.en[k]), ph(strings.STRINGS.he[k]), k + " placeholders");
    assert.ok(strings.STRINGS.he[k].length && strings.STRINGS.en[k].length, k);
    assert.doesNotMatch(strings.STRINGS.en[k], /[֐-׿]/, k + " English label contains Hebrew");
  }
});

test("t(): placeholders, unknown language falls back to Hebrew, direction follows the language", () => {
  assert.equal(strings.t("en", "rewind.close", { key: "Ctrl+Opt+R" }), "Ctrl+Opt+R to close");
  assert.equal(strings.t("he", "rewind.close", { key: "Ctrl+Opt+R" }), "Ctrl+Opt+R לסגירה");
  assert.equal(strings.t("fr", "state.listening"), "מקשיב");
  assert.equal(strings.t("en", "no.such.key"), "no.such.key");
  assert.equal(strings.dirOf("en"), "ltr");
  assert.equal(strings.dirOf("he"), "rtl");
  assert.equal(strings.dirOf(undefined), "rtl");
});

test("healthText: English when the UI language is en, Hebrew by default", () => {
  assert.match(text.healthText("health-only-you", "x", "Ctrl+Opt+A", "en"), /^Hearing only you\..* Ask AI: Ctrl\+Opt\+A$/);
  assert.match(text.healthText("health-only-you", "x", "", "he"), /^שומע רק אותך/);
  assert.equal(text.healthText("health-mic", "המיקרופון לא קולט. בדוק הרשאה"), "המיקרופון לא קולט. בדוק הרשאה"); // default language: unchanged
  assert.match(
    text.healthText("health-stt-them", "תמלול הצד השני התנתק – מנסה להתחבר מחדש. בדוק את חיבור האינטרנט", "", "en"),
    /^The other side: transcription disconnected, reconnecting\. Check your internet connection$/,
  );
  assert.match(text.healthText("health-sleep", "המחשב נרדם ל-45 שניות. חלק מהשיחה לא נשמע", "", "en"), /^The computer slept for 45 seconds/);
  assert.match(text.healthText("health-them-silent", "אין שמע מהצד השני (ערוץ השמע של המערכת לא שולח כלום)", "", "en"), /^No audio from the other side/);
  assert.equal(text.healthText("health-stt-me", "STT (me) – Error 401", "", "en"), "Your microphone: Error 401. Check your internet connection");
  for (const id of ["disk", "ai", "ai-anthropic:x", "control", "sleep", "idle", "minutes", "mic", "stt-switch-me", "them-silent", "stt-me"]) {
    assert.doesNotMatch(text.healthText("health-" + id, "אירוע 3 – מנסה שוב, בדוק הרשאת מ-a ל-b", "", "en"), /[֐-׿]/, id);
  }
});

test("ui.language: auto resolves to Hebrew unless the call language is English; explicit values win; schema rejects others", () => {
  const mk = (ui: string, stt: string) => ({ ui: { language: ui }, stt: { language: stt } }) as any;
  assert.equal(resolveUiLanguage(mk("auto", "multi")), "he");
  assert.equal(resolveUiLanguage(mk("auto", "he")), "he");
  assert.equal(resolveUiLanguage(mk("auto", "auto")), "he");
  assert.equal(resolveUiLanguage(mk("auto", "en")), "en");
  assert.equal(resolveUiLanguage(mk("en", "he")), "en");
  assert.equal(resolveUiLanguage(mk("he", "en")), "he");
  assert.equal(schema.shape.ui.safeParse({ language: "fr" }).success, false);
});

test("healthLevel: the status dot shows the worst bar, info and quiet do not count", () => {
  const bar = (level: string) => ({ level, text: "x" });
  assert.equal(text.healthLevel(new Map()), "ok");
  assert.equal(text.healthLevel(new Map([["health-only-you", bar("info")]])), "ok");
  assert.equal(text.healthLevel(new Map([["health-quiet", bar("red")]])), "ok");
  assert.equal(text.healthLevel(new Map([["health-ladder", bar("amber")]])), "amber");
  assert.equal(
    text.healthLevel(
      new Map([
        ["health-ladder", bar("amber")],
        ["health-mic", bar("red")],
      ]),
    ),
    "red",
  );
});

test("healthText: English engine texts are not changed or doubled", () => {
  const t = "Transcription (the other side) has no connection: network. Retrying until it returns. Check your internet connection";
  assert.equal(text.healthText("health-stt-them", t, "", "en"), t);
});
