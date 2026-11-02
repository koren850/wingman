// The Settings page catalog must match the real schema and defaults.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { applyEdits, defaultsFlat, readState } from "./settings-edit.ts";

const cat = createRequire(import.meta.url)("../tray/settings-catalog.cjs");
const tmp = () => join(mkdtempSync(join(tmpdir(), "wingman-cat-")), "settings.yaml");

test("every catalog key exists, its default is inside the allowed range, and the plain-words fields are filled", () => {
  const d = defaultsFlat();
  assert.ok(cat.ITEMS.length >= 10 && cat.ITEMS.length <= 24, "about 10-24 settings");
  for (const i of cat.ITEMS) {
    assert.ok(i.key in d, i.key); assert.ok(i.label && i.help && i.help.length > 30 && i.help.length < 260, i.key + " help"); assert.ok(cat.GROUPS.some((g: any) => g.id === i.group));
    const shown = cat.toDisplay(i, d[i.key]);
    assert.doesNotThrow(() => cat.toStored(i, shown), i.key + " default round-trips");
    assert.deepEqual(cat.toStored(i, shown), d[i.key], i.key + " round trip equals default");
  }
});

test("min and max of every number are accepted by the real schema; one step outside is refused", () => {
  for (const i of cat.ITEMS.filter((x: any) => x.kind === "int" || x.kind === "number")) {
    for (const v of [i.min, i.max]) {
      const f = tmp(); const r = applyEdits(f, { [i.key]: cat.toStored(i, v) });
      assert.equal(r.ok, true, `${i.key}=${v}: ${JSON.stringify(r)}`);
    }
    assert.throws(() => cat.toStored(i, i.max + 1)); assert.throws(() => cat.toStored(i, i.min - 1));
  }
});

test("select options and booleans are valid; inverted booleans store the opposite; seconds store milliseconds", () => {
  for (const i of cat.ITEMS.filter((x: any) => x.kind === "select")) for (const [v] of i.options) assert.equal(applyEdits(tmp(), { [i.key]: v }).ok, true, i.key + v);
  assert.equal(cat.toStored(cat.BY_KEY.get("run.noAi"), true), false);
  assert.equal(cat.toStored(cat.BY_KEY.get("overlay.contentProtection"), false), true);
  assert.equal(cat.toStored(cat.BY_KEY.get("reflex.stallAfterMs"), 2.5), 2500);
  assert.throws(() => cat.toStored(cat.BY_KEY.get("stt.language"), "klingon"));
  assert.throws(() => cat.toStored(cat.BY_KEY.get("cards.quiet"), "yes"));
  assert.throws(() => cat.toStored(cat.BY_KEY.get("cards.maxPerMinute"), 2.5));
});

test("describe marks changed rows and shows screen values", () => {
  const f = tmp(); applyEdits(f, { "run.noAi": true, "reflex.stallAfterMs": 2500 });
  const rows = cat.describe(readState(f)); const get = (k: string) => rows.find((r: any) => r.key === k);
  assert.equal(get("run.noAi").value, false); assert.equal(get("run.noAi").def, true); assert.equal(get("run.noAi").changed, true);
  assert.equal(get("reflex.stallAfterMs").value, 2.5); assert.equal(get("cards.quiet").changed, false);
});
