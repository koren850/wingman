// Intake: structural filter properties and TurnFeatures for Hebrew, English and mixed lines.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Intake, features, tokenCount, type IntakeLine } from "./moments/intake.ts";

const L = (text: string, at = 0, o: Partial<IntakeLine> = {}): IntakeLine => ({ text, side: "them", at, ...o });

test("intake: tokens come from Intl.Segmenter in both scripts", () => {
  assert.equal(tokenCount("כמה זה עולה לבנות חנות?"), 5);
  assert.equal(tokenCount("how much does it cost?"), 5);
  assert.equal(tokenCount("האתר עובד on WordPress 6.4"), 5);
  assert.equal(tokenCount("... , !"), 0);
});

test("intake: too short, repeat within 3 s, echo, low confidence", () => {
  const i = new Intake({ isEcho: (t) => t.includes("copy of them") });
  assert.deepEqual(i.accept(L("כן")).keep, false);
  assert.equal(i.accept(L("אוקיי")).keep, false);
  assert.equal(i.accept(L("האתר נטען לאט מאוד", 1000)).keep, true);
  const rep = i.accept(L("האתר נטען לאט מאוד!", 2500));
  assert.equal(rep.keep, false);
  assert.equal(!rep.keep && rep.why, "repeat");
  assert.equal(i.accept(L("האתר נטען לאט מאוד", 9000)).keep, true); // later it counts again
  const echo = i.accept({ text: "this is a copy of them", side: "me", at: 10_000 });
  assert.equal(!echo.keep && echo.why, "echo");
  assert.equal(i.accept(L("this is a copy of them", 10_100)).keep, true); // the echo test is for the mic side only
  const low = i.accept(L("חלק ממשפט לא ברור בכלל", 20_000, { confidence: 0.1 }));
  assert.equal(!low.keep && low.why, "low-confidence");
  assert.equal(i.accept(L("חלק ממשפט ברור בהחלט", 30_000, { confidence: 0.9 })).keep, true);
});

test("intake property: a line with a digit or currency sign is never dropped", () => {
  const i = new Intake({ isEcho: () => true, minConfidence: 0.99 });
  const lines = ["5", "3", "ב 5", "$", "₪ 40", "כן 2", "אוקיי 10%", "1,200", "ok 3", "ok 3"];
  lines.forEach((t, n) => {
    assert.equal(i.accept({ text: t, side: "me", at: n * 100, confidence: 0.01 }).keep, true, t);
  });
});

test("intake property: a line of 2+ tokens ending with '?' is never dropped", () => {
  const i = new Intake({ isEcho: () => true, minConfidence: 0.99 });
  const lines = ["מה זה?", "why not?", "אה כן?", "אתה בטוח ?", 'האם זה "בסדר?"', "what? what?", "מה? מה?"];
  lines.forEach((t, n) => {
    assert.equal(i.accept({ text: t, side: "me", at: n * 10, confidence: 0 }).keep, true, t);
  });
});

test("intake: a lone '?' or sound is dropped; a one-word question is kept", () => {
  const i = new Intake();
  assert.equal(i.accept(L("?")).keep, false);
  assert.equal(i.accept(L("אה")).keep, false);
  assert.equal(i.accept(L("מחיר?")).keep, true);
});

test("features: Hebrew, English, mixed, numbers, question mark, gap", () => {
  const he = features(L("כמה עולה אחסון בשנה?", 5000, { speaker: "Dana" }), 3000);
  assert.equal(he.lang, "he");
  assert.equal(he.words, 4);
  assert.equal(he.endsWithQuestion, true);
  assert.equal(he.hasDigits, false);
  assert.equal(he.speaker, "Dana");
  assert.equal(he.gapMs, 2000);
  assert.ok(he.script.he > 0.99);
  const en = features(L("It will cost $400 per month"), undefined);
  assert.equal(en.lang, "en");
  assert.equal(en.hasDigits && en.hasCurrency, true);
  assert.equal(en.gapMs, undefined);
  assert.equal(en.endsWithQuestion, false);
  const mixed = features(L("האתר רץ על WordPress ו WooCommerce"));
  assert.equal(mixed.lang, "mixed");
  assert.ok(mixed.script.he > 0.2 && mixed.script.latin > 0.2);
  assert.equal(features(L("עלות 40 ₪?")).hasCurrency, true);
  assert.equal(features(L("12345")).lang, "none");
  assert.equal(features(L("שלום?‏")).endsWithQuestion, true);
  assert.equal(features({ text: "hi", side: "me", at: 1 }).side, "me");
});
