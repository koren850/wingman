// Settings page backend (settings-edit.ts): comment-preserving edits, zod validation, mode 600, reset to default.
// Each test works on its own temp settings.yaml.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEdits, readState } from "./settings-edit.ts";
import { assertMode } from "./test-platform.ts";

const tmp = () => join(mkdtempSync(join(tmpdir(), "wingman-set-")), "settings.yaml");

test("edit writes only the changed key, keeps comments and other keys, mode 600", () => {
  const f = tmp();
  writeFileSync(f, "# my note\nbudget:\n  maxUsdPerCall: 3  # keep this comment\nreflex:\n  allowAns: false\n");
  const r = applyEdits(f, { "cards.maxPerMinute": 5 });
  assert.equal(r.ok, true);
  const t = readFileSync(f, "utf8");
  assert.match(t, /# my note/);
  assert.match(t, /keep this comment/);
  assert.match(t, /allowAns: false/);
  assert.match(t, /maxPerMinute: 5/);
  assertMode(f, 0o600);
  const s = readState(f);
  assert.equal(s.values["cards.maxPerMinute"], 5);
  assert.deepEqual(s.changed.sort(), ["budget.maxUsdPerCall", "cards.maxPerMinute", "reflex.allowAns"]);
});

test("a value equal to the default, or null, removes the key and empty parents", () => {
  const f = tmp();
  assert.equal(applyEdits(f, { "cards.maxPerMinute": 7, "summary.enabled": false }).ok, true);
  assert.equal(applyEdits(f, { "cards.maxPerMinute": 3 }).ok, true); // 3 is the default
  assert.doesNotMatch(readFileSync(f, "utf8"), /maxPerMinute|cards:/);
  assert.equal(applyEdits(f, { "summary.enabled": null }).ok, true);
  assert.doesNotMatch(readState(f).changed.join(), /summary/);
  assert.doesNotMatch(readFileSync(f, "utf8"), /^summary:/m);
});

test("the starter file's comments survive the first edit", () => {
  const f = tmp();
  assert.equal(applyEdits(f, { "overlay.contentProtection": false }).ok, true);
  const t = readFileSync(f, "utf8");
  assert.match(t, /Wingman personal settings/);
  assert.match(t, /contentProtection: false/);
});

test("invalid values are refused by the real schema and nothing is written", () => {
  const f = tmp();
  writeFileSync(f, "cards:\n  maxPerMinute: 4\n");
  const before = readFileSync(f, "utf8");
  for (const bad of [
    { "cards.maxPerMinute": 99 },
    { "cards.maxPerMinute": "lots" },
    { "stt.language": "klingon" },
    { "reflex.stallAfterMs": 6000 },
    { "nope.key": 1 },
  ]) {
    const r = applyEdits(f, bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
  assert.equal(readFileSync(f, "utf8"), before);
  assert.equal(existsSync(f + ".tmp"), false);
});

test("a broken user file is reported, not overwritten", () => {
  const f = tmp();
  writeFileSync(f, "cards: [unclosed\n");
  const r = applyEdits(f, { "cards.maxPerMinute": 5 });
  assert.equal(r.ok, false);
  assert.equal(readFileSync(f, "utf8"), "cards: [unclosed\n");
});

// ---- two saves at once must both land ----
import { execFile } from "node:child_process";
import { mkdirSync, utimesSync, readFileSync as rf } from "node:fs";
import { createRequire } from "node:module";
import { ROOT } from "./env.ts";

const writeVia = (file: string, edits: object) =>
  new Promise<string>((resolve) => {
    const p = execFile(
      join(ROOT, "node_modules", ".bin", "tsx"),
      ["src/settings-edit-cli.ts", "write"],
      { cwd: ROOT, env: { ...process.env, WINGMAN_USER_SETTINGS: file, NO_COLOR: "1" } },
      (_e, out) => resolve(String(out).trim().split("\n").pop() || ""),
    );
    p.stdin!.end(JSON.stringify(edits));
  });

test("two settings writes started together (separate processes) both land", async () => {
  for (let round = 0; round < 3; round++) {
    const f = tmp();
    const [a, b] = await Promise.all([writeVia(f, { "cards.quiet": true }), writeVia(f, { "privacy.askBeforeCliStart": false })]);
    assert.equal(JSON.parse(a).ok, true);
    assert.equal(JSON.parse(b).ok, true);
    const t = rf(f, "utf8");
    assert.match(t, /quiet: true/, `round ${round}: quiet lost\n${t}`);
    assert.match(t, /askBeforeCliStart: false/, `round ${round}: askBeforeCliStart lost\n${t}`);
  }
});

test("a stale lock left by a dead process is broken and the lock is released", () => {
  const f = tmp(),
    lock = join(f, "..", ".settings.yaml.lock");
  mkdirSync(lock);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  assert.equal(applyEdits(f, { "cards.quiet": true }).ok, true);
  assert.equal(existsSync(lock), false, "the lock is released afterwards");
});

test("the window host runs settings and setup writes through a one-at-a-time queue", async () => {
  const { createQueue } = createRequire(import.meta.url)("../dashboard/serial.cjs");
  const add = createQueue(),
    log: string[] = [];
  const task =
    (n: string, ms: number, fail = false) =>
    () =>
      new Promise((res, rej) => {
        log.push("start " + n);
        setTimeout(() => {
          log.push("end " + n);
          fail ? rej(new Error(n)) : res(n);
        }, ms);
      });
  const r = await Promise.allSettled([add(task("a", 30)), add(task("b", 1, true)), add(task("c", 1))]);
  assert.deepEqual(log, ["start a", "end a", "start b", "end b", "start c", "end c"]);
  assert.deepEqual(
    r.map((x) => x.status),
    ["fulfilled", "rejected", "fulfilled"],
  );
  assert.match(rf(join(ROOT, "dashboard", "window.cjs"), "utf8"), /args\.includes\("write"\) \? writes\(/);
});
