import { test } from "node:test";
import assert from "node:assert/strict";
import { EchoFilter, MicGate, overlap } from "./echo.ts";
import { extract, digitWords, spokenToSymbols } from "./capture.ts";

test("echo: overlap counts the mic line's words found in the client line", () => {
  assert.equal(overlap("כמה עולה האחסון", "כמה עולה האחסון אצלכם"), 1);
  assert.equal(overlap("אני חושב שזה בסדר", "כמה עולה האחסון"), 0);
});
test("echo filter drops a repeat of the client within the window, keeps Dan's own words", () => {
  const f = new EchoFilter({ windowMs: 2500, threshold: 0.6 });
  f.noteThem("כמה עולה האחסון אצלכם לחודש", 1000);
  assert.ok(f.isEcho("כמה עולה האחסון אצלכם", 2000).echo);
  assert.ok(!f.isEcho("זה תלוי בגודל האתר", 2000).echo);
  assert.ok(!f.isEcho("כמה עולה האחסון אצלכם", 5000).echo, "outside the window");
  assert.ok(!f.isEcho("כן", 1500).echo, "one word needs full overlap");
  f.noteThem("כן", 1500);
  assert.ok(f.isEcho("כן", 1600).echo);
});
test("mic gate closes while the client is voiced, plus the hangover", () => {
  const g = new MicGate({ hangoverMs: 400, peak: 0.02 });
  assert.ok(!g.closed(0));
  g.noteThemPeak(0.01, 100); assert.ok(!g.closed(150), "below the peak");
  g.noteThemPeak(0.3, 200); assert.ok(g.closed(300)); assert.ok(g.closed(599)); assert.ok(!g.closed(601));
});

test("capture: Hebrew digit words become digits", () => {
  assert.equal(digitWords("המספר שלי אפס חמש ארבע אחת שתיים שלוש ארבע חמש שש שבע"), "המספר שלי 0541234567");
  assert.equal(digitWords("אפס חמש שתיים 123 4567"), "0521234567");
});
test("capture: spoken @ and dot", () => {
  assert.match(spokenToSymbols("דן שטרודל ג'ימייל נקודה קום"), /@\s+gmail\s+\.\s+com/);
});
test("capture: phones (digits, words, +972), emails and domains", () => {
  const v = (t: string) => extract(t).map((c) => `${c.kind}:${c.value}`);
  assert.deepEqual(v("תתקשר אליי ל 054-1234567"), ["phone:054-1234567"]);
  assert.deepEqual(v("אפס חמש ארבע אחת שתיים שלוש ארבע חמש שש שבע"), ["phone:054-1234567"]);
  assert.deepEqual(v("+972 54 123 4567"), ["phone:054-1234567"]);
  assert.deepEqual(v("המשרד 03-6123456"), ["phone:03-6123456"]);
  assert.deepEqual(v("תשלח ל dana@acme.co.il בבקשה"), ["email:dana@acme.co.il"]);
  assert.deepEqual(v("dana שטרודל gmail נקודה com"), ["email:dana@gmail.com"]);
  assert.deepEqual(v("האתר הוא shop.example.co.il והוא איטי"), ["domain:shop.example.co.il"]);
  assert.deepEqual(v("www.example.co.il"), ["domain:example.co.il"]);
  assert.deepEqual(v("acme נקודה קו נקודה איל"), ["domain:acme.co.il"]);
});
test("capture: no false hits on plain talk, prices or short numbers", () => {
  assert.deepEqual(extract("זה יעלה בערך 1500 שקל לחודש"), []);
  assert.deepEqual(extract("יש לי שתי שאלות על האתר"), []);
  assert.deepEqual(extract("גרסה 5.5 של וורדפרס"), []);
  assert.deepEqual(extract("שבע שנים אנחנו איתכם"), []);
});
