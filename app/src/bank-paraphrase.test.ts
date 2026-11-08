// hint tests, in-sample, not product truth: these check the frozen word-list hint (detector.ts, bank.ts). The product decides with the model; see r3-moments-floor.test.ts for the floor.
// Bank scorer: paraphrases, no false cards on chatter, the matching order, and no language global (two interleaved turns in different languages).
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadBank,
  matchBank,
  matchBankFor,
  matchBankSmart,
  stallSay,
  stallCard,
  localizeCard,
  getTurnLang,
  setTurnLang,
  topCandidates,
  STALL_TIER,
} from "./bank.ts";
import { grams } from "./bank-score.ts";
import { BANK_CASES, BANK_PARAPHRASE_CASES, BANK_NEGATIVE_CASES } from "./bank-cases.ts";

const bank = loadBank();

test("bank scorer: the right card is among the top 3 for every paraphrase", () => {
  for (const [q, id] of BANK_PARAPHRASE_CASES) {
    const ids = topCandidates(q, 3, bank).map((c) => c.card.id);
    assert.ok(ids.includes(id), `${q}: wanted ${id}, got ${ids.join(",")}`);
  }
});

test("bank scorer: the two review paraphrases (site-slow, forms-not-arriving) now hit a card with no model", () => {
  const a = matchBankSmart("הדף הראשי לוקח נצח להיטען", bank, "he");
  assert.equal(a.via, "scorer");
  assert.equal(a.hit?.card.id, "site-slow");
  const b = matchBankSmart("הטופס באתר לא נשלח אלי למייל", bank, "he");
  assert.equal(b.hit?.card.id, "forms-not-arriving");
});

test("bank scorer: order is exact trigger, then scorer, else the top 3 for the model", () => {
  const exact = matchBankSmart("האתר איטי מאוד", bank, "he");
  assert.equal(exact.via, "trigger");
  assert.equal(exact.hit?.card.id, matchBankFor("האתר איטי מאוד", bank, "he")?.card.id);
  const none = matchBankSmart("העמוד הראשי נפתח אחרי המון זמן", bank, "he");
  assert.equal(none.via, "none");
  assert.equal(none.hit, undefined);
  assert.equal(none.candidates.length, 3);
  assert.equal(none.candidates[0].card.id, "site-slow");
});

test("bank scorer: chatter that no card answers gives no hit", () => {
  for (const q of BANK_NEGATIVE_CASES) assert.equal(matchBankSmart(q, bank).hit, undefined, q);
});

test("bank scorer: never returns a stall-tier card; price needs an exact trigger", () => {
  for (const [q] of BANK_CASES) {
    const m = matchBankSmart(q, bank, "he");
    if (m.via === "scorer") assert.ok(!STALL_TIER.has(m.hit!.card.id), q);
  }
});

test("bank accuracy: held-out cases are not worse than the trigger-only matcher, and wrong cards do not rise", () => {
  let before = 0,
    after = 0,
    wrongBefore = 0,
    wrongAfter = 0;
  for (const [q, want] of BANK_CASES) {
    const b = matchBank(q, bank)?.card.id ?? "-";
    const a = b !== "-" ? b : (matchBankSmart(q, bank, "he").hit?.card.id ?? "-");
    if (b === want) before++;
    else if (b !== "-") wrongBefore++;
    if (a === want) after++;
    else if (a !== "-") wrongAfter++;
  }
  assert.ok(after >= before, `${after} < ${before}`);
  assert.ok(wrongAfter <= wrongBefore, `${wrongAfter} > ${wrongBefore}`);
  assert.ok(after / BANK_CASES.length >= 0.93);
});

test("bank scorer: 3-grams are padded per token and the index follows a bank that grows", () => {
  assert.deepEqual(grams("אה"), ["^אה", "אה$"]);
  assert.deepEqual(grams("a"), []);
  const mine = [{ id: "one", title: "slow pages", triggers: ["slow"], say: "pages load slowly because of images", facts: [] }];
  assert.equal(topCandidates("why do my pages load slowly", 3, mine)[0]?.card.id, "one");
  mine.push({ id: "two", title: "email spam", triggers: ["spam"], say: "mail goes to the spam folder", facts: [] });
  assert.equal(topCandidates("my mail goes to spam", 3, mine)[0]?.card.id, "two");
  assert.deepEqual(topCandidates("x", 3, []), []);
});

test("language: two interleaved turns in different languages each get a card in their own language", () => {
  setTurnLang("he"); // the legacy default must not leak into turns that pass a language
  const heQ = "כמה זמן ייקח לסיים את האתר החדש";
  const enQ = "How long will it take to move everything";
  const stall = stallCard(bank);
  const heHit1 = matchBankFor(heQ, bank, "he");
  const enHit = matchBankFor(enQ, bank, "en");
  const heHit2 = matchBankFor(heQ, bank, "he"); // cached from the Hebrew turn, after the English one
  assert.equal(heHit1?.card.id, "stall-timeline");
  assert.equal(heHit2?.card.say, heHit1?.card.say);
  assert.match(heHit1!.card.say, /[א-ת]/);
  assert.equal(enHit?.card.id, "stall-timeline");
  assert.doesNotMatch(enHit!.card.say, /[א-ת]/);
  // stall lines and localized cards for each turn, in any order
  const lines = [stallSay(stall, 0, "en"), stallSay(stall, 0, "he"), stallSay(stall, 1, "en"), stallSay(stall, 1, "he")];
  assert.doesNotMatch(lines[0], /[א-ת]/);
  assert.match(lines[1], /[א-ת]/);
  assert.doesNotMatch(lines[2], /[א-ת]/);
  assert.match(lines[3], /[א-ת]/);
  assert.equal(localizeCard(heHit1!.card, "he"), heHit1!.card);
  // an explicit language never changes the legacy default
  assert.equal(getTurnLang(), "he");
  // the same text with different languages is not mixed up by the cache
  const q = "How long will it take to move everything";
  assert.notEqual(matchBankFor(q, bank, "en")?.card.say, matchBankFor(q, bank, "he")?.card.say);
  // the scorer path is per turn too
  const smartEn = matchBankSmart("why is my page loading so slowly today", bank, "en");
  const smartHe = matchBankSmart("הדף הראשי לוקח נצח להיטען", bank, "he");
  assert.match(smartHe.hit!.card.say, /[א-ת]/);
  if (smartEn.hit) assert.doesNotMatch(smartEn.hit.card.say, /[א-ת]/);
  for (const c of smartEn.candidates) assert.ok(c.card.en, "English turn candidates have an English version");
});

test("language: callers that pass no language keep the old behaviour", () => {
  setTurnLang("he");
  matchBankFor("How much will the migration cost", bank);
  assert.equal(getTurnLang(), "en");
  matchBankFor("כמה זה עולה לכם בערך", bank);
  assert.equal(getTurnLang(), "he");
  setTurnLang("he");
});
