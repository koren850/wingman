// Security hardening from the second pre-publish audit (F2-F5 and the Info items).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { neutralizeLinks } from "./summary.ts";
import { TMP_OUTSIDE_HOME } from "./test-platform.ts";
import { errStack } from "./errtext.ts";

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

test("attachments: $HOME from the environment does not move the home folder (F3)", TMP_OUTSIDE_HOME, () => {
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

// ---- F4: install.sh --purge guard ----
test(
  "install.sh --purge: refuses '..' paths, symlinks out of the Wingman folder and the home folder; accepts a real Wingman folder (F4)",
  { skip: process.platform === "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "wm-purge-"));
    const home = join(root, "h");
    const data = join(home, "Library", "Application Support", "Wingman");
    mkdirSync(data, { recursive: true });
    mkdirSync(join(home, "Documents"));
    symlinkSync(join(home, "Documents"), join(home, "Library", "Application Support", "Wingman-link"));
    const run = (dir: string, ...extra: string[]) =>
      spawnSync("bash", [join(import.meta.dirname, "..", "..", "install.sh"), "--uninstall", "--purge", "--dry-run", ...extra], {
        env: { ...process.env, HOME: home, WINGMAN_DATA_DIR: dir },
        encoding: "utf8",
      });
    const ok = run(data);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /would ask you to type DELETE/);
    for (const bad of [`${data}/../../../Documents`, join(home, "Library", "Application Support", "Wingman-link"), join(home, "Documents"), home]) {
      const r = run(bad);
      assert.equal(r.status, 1, bad);
      assert.match(r.stderr, /refusing to delete/);
    }
    // A settings folder that is a link to somewhere else (a dotfiles repo, Documents) is not deleted either.
    mkdirSync(join(home, ".config"));
    symlinkSync(join(home, "Documents"), join(home, ".config", "wingman"));
    const viaLink = run(data);
    assert.equal(viaLink.status, 1);
    assert.match(viaLink.stderr, /not a wingman folder inside your home folder/);
    assert.match(run(`${data}/../Wingman`, "--force").stderr, /contains "\.\."/, '".." is refused even with --force');
  },
);

// ---- Info: stack traces in events.jsonl ----

test("errStack: one safe line plus at most a few frames, capped at 2000 characters", () => {
  const e = new Error("boom");
  e.stack = ["Error: boom", ...Array.from({ length: 30 }, (_, i) => `    at fn${i} (/x/y.ts:${i}:1)`)].join("\n");
  const s = errStack(e);
  assert.equal(s.split("\n").length, 1 + 4);
  assert.match(s, /^Error: boom\n\s*at fn0/);
  assert.ok(!s.includes("fn5"));
  assert.ok(errStack(Object.assign(new Error("x".repeat(5000)), { stack: "" })).length <= 2000);
  assert.equal(errStack("plain string"), "plain string");
  assert.equal(errStack(undefined), "unknown error");
});

test("neutralizeLinks: hidden hosts (zero-width, ideographic dot, fullwidth), IP addresses and odd schemes are replaced", () => {
  const ph = PH;
  for (const bad of [
    "evil\u3002com",
    "evil\u200b.com/x",
    "evil.com\u200b/pay",
    "\uff45\uff56\uff49\uff4c\uff0e\uff43\uff4f\uff4d",
    "1.2.3.4/pay",
    "javascript:alert(1)",
    "ftp://x.y/z",
    "\uff28\uff34\uff34\uff30://x.y",
  ])
    assert.ok(neutralizeLinks(`see ${bad} now`, "").text.includes(ph), bad);
  assert.equal(neutralizeLinks("שלום, נדבר בשלוש. \u200d👍", "").text, "שלום, נדבר בשלוש. \u200d👍", "Hebrew and emoji joiners untouched");
  assert.equal(neutralizeLinks("use 1.2.3.4", "1.2.3.4").text, "use 1.2.3.4", "a trusted address stays");
});

test("errText scrubs credentials that a provider error echoes", async () => {
  const { errText } = await import("./errtext.ts");
  const t = errText(new Error("bad key sk-ant-api03-ABCDEF123456 and Authorization: Token 0123456789abcdef0123456789abcdef01234567"));
  assert.ok(!/ABCDEF|0123456789abcdef/.test(t), t);
  assert.ok(errText("plain text error").includes("plain text"));
});
