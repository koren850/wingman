// matchBankFor remembers recent answers; the answer must not change, and a different bank or language must not reuse a stale one.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchBank, matchBankFor, setTurnLang, type BankCard } from "./bank.ts";

const card = (id: string, trigger: string): BankCard => ({ id, title: id, triggers: [trigger], say: `say ${id}`, facts: [] });

test("repeated calls give the same hit as matching directly", () => {
  const bank = [card("site-slow", "האתר איטי"), card("backups", "גיבוי")];
  const q = "למה האתר איטי כל כך";
  const direct = matchBank(q, bank);
  assert.ok(direct);
  for (let i = 0; i < 3; i++) assert.equal(matchBankFor(q, bank)?.card.id, direct.card.id);
});

test("a different bank is not answered from the cache", () => {
  const q = "אפשר לקבל גיבוי של האתר";
  const a = [card("backups", "גיבוי")];
  const b = [card("backups-two", "גיבוי")];
  assert.equal(matchBankFor(q, a)?.card.id, "backups");
  assert.equal(matchBankFor(q, b)?.card.id, "backups-two");
});

test("a card added to the same bank array is seen", () => {
  const bank = [card("site-slow", "האתר איטי")];
  const q = "מה לגבי גיבוי של האתר";
  assert.equal(matchBankFor(q, bank), undefined);
  bank.push(card("backups", "גיבוי"));
  assert.equal(matchBankFor(q, bank)?.card.id, "backups");
});

test("the English card is used for an English question and the cache does not leak it into a Hebrew turn", () => {
  const bank: BankCard[] = [{ ...card("site-slow", "site is slow"), en: { say: "english say" } }];
  const q = "why is the site is slow today";
  setTurnLang("he");
  assert.equal(matchBankFor(q, bank)?.card.say, "english say");
  assert.equal(matchBankFor(q, bank)?.card.say, "english say");
  assert.equal(matchBankFor("why is the site is slow today again", bank)?.card.say, "english say");
});
