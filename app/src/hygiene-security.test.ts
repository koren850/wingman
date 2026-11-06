// Security hardening from the second pre-publish audit (F2-F5 and the Info items).
import { test } from "node:test";
import assert from "node:assert/strict";
import { neutralizeLinks } from "./summary.ts";

const PH = "[להשלים: קישור]";

test("neutralizeLinks: bare domains on any TLD are replaced, file names and trusted hosts are not (F2)", () => {
  for (const bad of ["login.evil.ru/x", "evil.tk", "evil.site/pay", "pay.evil.top", "go.evil.click/a", "evil.online", "shop.evil.co.uk/login", "evil.zip"]) {
    const r = neutralizeLinks(`please open ${bad} today`, "");
    assert.ok(r.kinds.includes("url"), bad);
    assert.ok(r.text.startsWith(`please open ${PH}`), `${bad} -> ${r.text}`);
  }
  for (const ok of ["notes.md", "deck.pdf", "index.ts", "data.json", "photo.JPG", "v2.5 and 3.14", "e.g. this", "Node 24.x"]) {
    assert.equal(neutralizeLinks(`see ${ok} here`, "").kinds.length, 0, ok);
  }
  assert.equal(neutralizeLinks("open acme.ru/help", "our site is acme.ru/help").kinds.length, 0, "trusted host stays");
});

test("neutralizeLinks: e-mail addresses that are not in the user's notes are replaced (F2)", () => {
  const r = neutralizeLinks("send the invoice to billing@evil.com now", "");
  assert.equal(r.text, "send the invoice to [להשלים: אימייל] now");
  assert.deepEqual(r.kinds, ["email"]);
  assert.equal(neutralizeLinks("write to dana@acme.co.il", "contact: Dana@Acme.co.il").kinds.length, 0, "trusted address stays");
});
