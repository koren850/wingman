// Bidi tokenizer (dashboard/bidi.js splitBidi): Latin/number/email/URL/phone runs inside Hebrew text become LTR islands,
// and joining all segments always gives back the original text. Loaded via require since the file is a classic browser script.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { splitBidi } = createRequire(import.meta.url)("../dashboard/bidi.js") as { splitBidi: (s: string) => { text: string; ltr: boolean }[] };
const ltr = (s: string) => splitBidi(s).filter((x) => x.ltr).map((x) => x.text);
const join = (s: string) => splitBidi(s).map((x) => x.text).join("");

test("prefix letter + hyphen stays outside the island", () => {
  const s = "יש ניסיון עם Monday, API ו-webhooks.";
  assert.deepEqual(ltr(s), ["Monday", "API", "webhooks"]);
  assert.equal(join(s), s);
  const t = "צריך חיבור ל-CRM של Monday";
  assert.deepEqual(ltr(t), ["CRM", "Monday"]);
  assert.equal(join(t), t);
});
test("email, phone, URL are single islands without trailing punctuation", () => {
  assert.deepEqual(ltr("שלח ל-Dan@example.com."), ["Dan@example.com"]);
  assert.deepEqual(ltr("תתקשר ל +972-50-1234567, תודה"), ["+972-50-1234567"]);
  assert.deepEqual(ltr("האתר https://example.com/a-b?x=1 נפל"), ["https://example.com/a-b?x=1"]);
  assert.equal(join("האתר https://example.com/a-b?x=1 נפל"), "האתר https://example.com/a-b?x=1 נפל");
});
test("thousands separators stay in one island", () => {
  assert.deepEqual(ltr("האתר עם כ-2,000 מוצרים"), ["2,000"]);
});
