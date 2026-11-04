// Settings page backend (settings-edit.ts): comment-preserving edits, zod validation, mode 600, reset to default.
// Each test works on its own temp settings.yaml.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEdits, readState } from "./settings-edit.ts";

const tmp = () => join(mkdtempSync(join(tmpdir(), "wingman-set-")), "settings.yaml");

test("edit writes only the changed key, keeps comments and other keys, mode 600", () => {
  const f = tmp();
  writeFileSync(f, "# my note\nbudget:\n  maxUsdPerCall: 3  # keep this comment\nreflex:\n  allowAns: false\n");
  const r = applyEdits(f, { "cards.maxPerMinute": 5 });
  assert.equal(r.ok, true);
  const t = readFileSync(f, "utf8");
  assert.match(t, /# my note/); assert.match(t, /keep this comment/); assert.match(t, /allowAns: false/); assert.match(t, /maxPerMinute: 5/);
  assert.equal(statSync(f).mode & 0o777, 0o600);
  const s = readState(f);
  assert.equal(s.values["cards.maxPerMinute"], 5);
  assert.deepEqual(s.changed.sort(), ["budget.maxUsdPerCall", "cards.maxPerMinute", "reflex.allowAns"]);
});

test("a value equal to the default, or null, removes the key and empty parents", () => {
  const f = tmp();
  assert.equal(applyEdits(f, { "cards.maxPerMinute": 7, "summary.enabled": false }).ok, true);
  assert.equal(applyEdits(f, { "cards.maxPerMinute": 3 }).ok, true);   // 3 is the default
  assert.doesNotMatch(readFileSync(f, "utf8"), /maxPerMinute|cards:/);
  assert.equal(applyEdits(f, { "summary.enabled": null }).ok, true);
  assert.doesNotMatch(readState(f).changed.join(), /summary/);
  assert.doesNotMatch(readFileSync(f, "utf8"), /^summary:/m);
});

test("the starter file's comments survive the first edit", () => {
  const f = tmp();
  assert.equal(applyEdits(f, { "overlay.contentProtection": false }).ok, true);
  const t = readFileSync(f, "utf8");
  assert.match(t, /Wingman personal settings/); assert.match(t, /contentProtection: false/);
});

test("invalid values are refused by the real schema and nothing is written", () => {
  const f = tmp();
  writeFileSync(f, "cards:\n  maxPerMinute: 4\n");
  const before = readFileSync(f, "utf8");
  for (const bad of [{ "cards.maxPerMinute": 99 }, { "cards.maxPerMinute": "lots" }, { "stt.language": "klingon" }, { "reflex.stallAfterMs": 6000 }, { "nope.key": 1 }]) {
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
