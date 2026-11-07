// The starter packs in data/starter-packs load, have every pack file, and pass the guards.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadBank, matchBank } from "./bank.ts";
import { guard } from "./guards.ts";
import { parseTopics, PACK_FILES } from "./pack.ts";
import { DATA } from "./env.ts";

const ROOT = join(DATA, "starter-packs");
const ids = readdirSync(ROOT).sort();

test("starter packs: sales, support, interview and empty exist", () => {
  assert.deepEqual(ids, ["empty", "interview", "sales", "support"]);
});

for (const id of ids) {
  const dir = join(ROOT, id);
  test(`starter pack ${id}: has every pack file`, () => {
    for (const f of PACK_FILES) assert.ok(existsSync(join(dir, f)), f);
  });
  test(`starter pack ${id}: bank loads, every card is English-ready and passes the guards`, () => {
    const bank = loadBank(join(dir, "bank.yaml"));
    assert.ok(bank.some((c) => c.id === "stall"));
    if (id !== "empty") assert.ok(bank.length >= 14 && bank.length <= 24, `${bank.length} cards`);
    for (const c of bank) {
      assert.ok(c.en, `${c.id} has no English entry`);
      for (const t of [c.say, ...c.facts, ...(c.alts ?? []), c.en?.say ?? ""]) assert.ok(guard(t).ok, `${id}/${c.id}: ${t}`);
      assert.ok(c.say.split(/\s+/).length <= 30, `${id}/${c.id}: say is too long`);
    }
    if (id !== "empty") {
      const own = bank.filter((c) => !c.id.startsWith("stall"));
      for (const c of own) assert.ok(c.triggers.length >= 3, `${id}/${c.id}: few triggers`);
    }
  });
  test(`starter pack ${id}: topics and keyterms parse`, () => {
    const t = parseTopics(readFileSync(join(dir, "topics.txt"), "utf8"));
    if (id !== "empty") assert.ok(t.loose);
    const terms = readFileSync(join(dir, "keyterms.txt"), "utf8")
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#"));
    if (id !== "empty") assert.ok(terms.length >= 10);
  });
}

test("starter packs: sample questions pick the expected cards", () => {
  const pick = (id: string, q: string) => matchBank(q, loadBank(join(ROOT, id, "bank.yaml")))?.card.id;
  assert.equal(pick("sales", "does it integrate with our CRM and slack"), "integrations");
  assert.equal(pick("sales", "how much does it cost"), "stall-price");
  assert.equal(pick("support", "I can't log in, I forgot my password"), "login");
  assert.equal(pick("interview", "tell me about a time you disagreed with a colleague"), "star-method");
  assert.equal(pick("interview", "what are your salary expectations"), "salary-practice");
});
