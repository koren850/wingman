// Security hardening from the second pre-publish audit (F2-F5 and the Info items).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// ---- F3: attachment secret-folder refusal ----
const req = createRequire(import.meta.url);

test(
  "attachments: the secret-folder refusal is case-insensitive on macOS and ignores $HOME (F3)",
  { skip: process.platform !== "darwin" && "case-insensitive file systems only" },
  () => {
    const A = req("../tray/attachments.cjs");
    const home = mkdtempSync(join(tmpdir(), "wm-hy-"));
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh", "notes.txt"), "token");
    for (const dir of [".ssh", ".SSH", ".Ssh"]) assert.throws(() => A.readSourceFile(join(home, dir, "notes.txt"), { home }), { code: "secret" }, dir);
  },
);

test("attachments: $HOME from the environment does not move the home folder (F3)", () => {
  const A = req("../tray/attachments.cjs");
  const fake = mkdtempSync(join(tmpdir(), "wm-hy-"));
  writeFileSync(join(fake, "a.txt"), "hello");
  const before = process.env.HOME;
  process.env.HOME = fake;
  try {
    // With HOME honoured, fake would be "the home folder" and this read would succeed. The passwd home is used, so the file is outside it.
    assert.throws(() => A.readSourceFile(join(fake, "a.txt")), { code: "outside" });
    assert.equal(A.readSourceFile(join(fake, "a.txt"), { force: true }).toString(), "hello");
  } finally {
    if (before === undefined) delete process.env.HOME;
    else process.env.HOME = before;
  }
});
