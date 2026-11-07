// The example packs in docs/examples must load, match what docs/EXAMPLES.md says, and pass the guards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadBank, matchBank } from "./bank.ts";
import { guard } from "./guards.ts";
import { parseTopics } from "./pack.ts";

const EX = join(import.meta.dirname, "..", "..", "docs", "examples");
const pack = join(EX, "studio-pack");

test("docs example pack loads, every card has an English version, no guard hits", () => {
  const bank = loadBank(join(pack, "bank.yaml"));
  assert.equal(bank.length, 7);
  assert.equal(bank.filter((c) => c.en).length, 7);
  for (const c of bank) for (const t of [c.say, ...c.facts, ...(c.alts ?? []), c.en?.say ?? ""]) assert.ok(guard(t).ok, `${c.id}: ${t}`);
});

test("docs example pack: the questions in EXAMPLES.md pick the stated cards", () => {
  const bank = loadBank(join(pack, "bank.yaml"));
  const want: [string, string | undefined][] = [
    ["האתר שלנו מציג אזהרה, האתר לא מאובטח", "ssl-warning"],
    ["יש לכם גיבוי של האתר?", "backups"],
    ["האתר נטען לאט", "site-slow"],
    ["כמה זה עולה?", "stall-price"],
    ["מתי זה יהיה מוכן", "stall-timeline"],
    ["do you have a backup", "backups"],
    ["what is a CDN", undefined],
  ];
  for (const [q, id] of want) assert.equal(matchBank(q, bank)?.card.id, id, q);
});

test("docs example topics file has loose and strict words", () => {
  const t = parseTopics(readFileSync(join(pack, "topics.txt"), "utf8"));
  assert.ok(t.loose?.test("my website is down"));
  assert.ok(!t.strict?.test("my website is down"));
  assert.ok(t.strict?.test("the SSL certificate"));
});

test("docs practice cards load and the salary card matches", () => {
  const bank = loadBank(join(EX, "practice-cards.yaml"));
  assert.equal(matchBank("What are your salary expectations?", bank)?.card.id, "salary");
  assert.equal(matchBank("Can you tell me about yourself?", bank)?.card.id, "intro");
});
