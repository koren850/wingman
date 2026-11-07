// The example pack and the demo call in data/ stay valid: the bank loads, every file is present, and the English file and the demo script point at real things.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { loadBank } from "./bank.ts";
import { EXAMPLE_PACK, PACK_FILES } from "./pack.ts";
import { DATA } from "./env.ts";

test("example pack: every pack file exists and is not empty", () => {
  for (const f of PACK_FILES) assert.ok(readFileSync(join(EXAMPLE_PACK, f), "utf8").trim().length > 0, f);
});

test("example pack: bank.yaml loads with unique ids and at least one trigger per card", () => {
  const bank = loadBank(join(EXAMPLE_PACK, "bank.yaml"));
  assert.ok(bank.length >= 10);
  for (const c of bank) {
    assert.ok(c.title && c.say, c.id);
    assert.ok(c.triggers.length > 0, c.id);
  }
});

test("example pack: bank.en.yaml only names cards that exist", () => {
  const ids = new Set(loadBank(join(EXAMPLE_PACK, "bank.yaml")).map((c) => c.id));
  const en = YAML.parse(readFileSync(join(EXAMPLE_PACK, "bank.en.yaml"), "utf8")) as Record<string, { say?: string }>;
  for (const [id, card] of Object.entries(en)) {
    assert.ok(ids.has(id), `bank.en.yaml has an unknown card id: ${id}`);
    assert.ok(card.say, `${id} has no English text`);
  }
});

test("demo call: a list of lines, each from me or them", () => {
  const lines = JSON.parse(readFileSync(join(DATA, "demo", "demo-call.json"), "utf8")) as { speaker: string; text: string }[];
  assert.ok(lines.length > 0);
  for (const l of lines) {
    assert.ok(l.speaker === "me" || l.speaker === "them", l.speaker);
    assert.ok(l.text.trim());
  }
});
