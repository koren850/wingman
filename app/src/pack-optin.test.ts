// The example pack is opt-in: a user with no pack has no prepared cards, and the example is read only when it is asked for.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// a fresh user got the web and hosting example pack in every meeting. The example pack is now read only when it is asked for.
test("pack: no user pack means no prepared cards; the example pack is read only on request", async () => {
  const { packDirs, packPath, exampleAllowed, EXAMPLE_PACK } = await import("./pack.ts");
  const empty = mkdtempSync(join(tmpdir(), "wm-nopack-"));
  const env = { WINGMAN_PACK_DIR: empty } as NodeJS.ProcessEnv;
  assert.deepEqual(packDirs(env), [empty]);
  assert.equal(packPath("bank.yaml", env), undefined);
  assert.equal(packPath("topics.txt", env), undefined);
  for (const on of [{ WINGMAN_EXAMPLE_PACK: "1" }, { WINGMAN_DEMO: "1" }, { WINGMAN_STT_SCRIPT: "/x.json" }])
    assert.deepEqual(packDirs({ ...env, ...on }), [empty, EXAMPLE_PACK]);
  // a user pack with its own bank may lack other files: those come from the example pack (doctor warns)
  writeFileSync(join(empty, "bank.yaml"), "[]\n");
  assert.equal(exampleAllowed({}, empty), true);
  assert.equal(packPath("house-style.md", env), join(EXAMPLE_PACK, "house-style.md"));
});

test("bank: loadBank() with no pack returns no cards instead of throwing", async () => {
  const { loadBank } = await import("./bank.ts");
  const prev = process.env.WINGMAN_PACK_DIR,
    prevEx = process.env.WINGMAN_EXAMPLE_PACK;
  process.env.WINGMAN_PACK_DIR = mkdtempSync(join(tmpdir(), "wm-nopack-"));
  delete process.env.WINGMAN_EXAMPLE_PACK;
  try {
    assert.deepEqual(loadBank(), []);
    assert.throws(() => loadBank(""));
  } finally {
    process.env.WINGMAN_PACK_DIR = prev;
    process.env.WINGMAN_EXAMPLE_PACK = prevEx;
  }
});
