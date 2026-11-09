// The memory patch reader repairs two known shape slips (plain-string facts, an unusable roster entry) and keeps the rest of the patch.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./env.ts";
import { validatePatch } from "./session/patch.ts";

// the memory updater with the real model lost 54 of 73 replies: it writes facts as plain strings, and one unusable roster entry dropped the whole patch.

test("memory patch: facts written as plain strings are kept as facts", () => {
  const r = validatePatch({
    add: { facts: ["North branch goes first", { text: "Harbor branch two weeks later", who: "Yael" }], numbers: [{ what: "delay", value: "two weeks" }] },
  });
  assert.equal(r.ok, true);
  if (r.ok)
    assert.deepEqual(
      r.patch.add.map((a) => a.f.text ?? a.f.what),
      ["North branch goes first", "Harbor branch two weeks later", "delay"],
    );
});

test("memory patch: a roster entry with an unknown side is left out and the rest of the patch is kept", () => {
  const r = validatePatch({
    add: { commitments: [{ who: "me", what: "ask billing to split the invoice", due: "before 1 December" }] },
    roster: [
      { name: "problem", side: "unknown", role: "unclear" },
      { name: "Dana", side: "them" },
    ],
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.patch.add.length, 1);
    assert.deepEqual(r.patch.roster, [{ name: "Dana", side: "them" }]);
  }
  assert.equal(validatePatch({ add: { decisions: ["x"] } }).ok, false, "a string is repaired only for facts");
});

test("memory patch: the recorded real replies (memory cassette) are no longer dropped for their shape", () => {
  const cas = JSON.parse(readFileSync(join(ROOT, "data/cassettes/memory.cassette.json"), "utf8")) as { entries: { chunks: { text?: string }[] }[] };
  let ok = 0,
    shape = 0;
  for (const e of cas.entries) {
    const text = e.chunks.map((c) => c.text ?? "").join("");
    const a = text.indexOf("{"),
      b = text.lastIndexOf("}");
    if (a < 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(text.slice(a, b + 1));
    } catch {
      continue;
    }
    const r = validatePatch(raw);
    if (r.ok) ok++;
    else if (/not an object|bad side/.test(r.reason)) shape++;
  }
  assert.equal(shape, 0);
  assert.ok(ok >= 60, `only ${ok} replies valid`);
});
