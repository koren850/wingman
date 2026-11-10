// Bidi tokenizer (dashboard/bidi.js splitBidi): Latin/number/email/URL/phone runs inside Hebrew text become LTR islands,
// and joining all segments always gives back the original text. Loaded via require since the file is a classic browser script.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { splitBidi } = createRequire(import.meta.url)("../dashboard/bidi.js") as { splitBidi: (s: string) => { text: string; ltr: boolean }[] };
const ltr = (s: string) =>
  splitBidi(s)
    .filter((x) => x.ltr)
    .map((x) => x.text);
const join = (s: string) =>
  splitBidi(s)
    .map((x) => x.text)
    .join("");

test("prefix letter + hyphen stays outside the island", () => {
  const s = "יש ניסיון עם Monday, API ו-webhooks.";
  assert.deepEqual(ltr(s), ["Monday", "API", "webhooks"]);
  assert.equal(join(s), s);
  const t = "צריך חיבור ל-CRM של Monday";
  assert.deepEqual(ltr(t), ["CRM", "Monday"]);
  assert.equal(join(t), t);
});
test("email, phone, URL are single islands without trailing punctuation", () => {
  assert.deepEqual(ltr("שלח ל-dan@example.com."), ["dan@example.com"]);
  assert.deepEqual(ltr("תתקשר ל +972-50-1234567, תודה"), ["+972-50-1234567"]);
  assert.deepEqual(ltr("האתר https://example.com/a-b?x=1 נפל"), ["https://example.com/a-b?x=1"]);
  assert.equal(join("האתר https://example.com/a-b?x=1 נפל"), "האתר https://example.com/a-b?x=1 נפל");
});
test("thousands separators stay in one island", () => {
  assert.deepEqual(ltr("האתר עם כ-2,000 מוצרים"), ["2,000"]);
});
test("a phrase or a version number next to an island stays one island", () => {
  const a = "אנחנו על Google Cloud Platform כבר שנה";
  assert.deepEqual(ltr(a), ["Google Cloud Platform"]);
  assert.equal(join(a), a);
  const b = "האתר רץ על PHP 8.2 בשרת";
  assert.deepEqual(ltr(b), ["PHP 8.2"]);
  assert.equal(join(b), b);
});
test("a percent or a currency sign next to a number keeps every character", () => {
  for (const s of ["ההנחה היא 100% על המחיר", "המחיר הוא $200 לחודש", "המחיר הוא 200$ לחודש", "עלות של €50 ושל ₪300"]) {
    assert.equal(join(s), s);
    assert.ok(splitBidi(s).some((x) => x.ltr));
  }
  assert.deepEqual(ltr("ההנחה היא 100% על המחיר"), ["100"]);
});
