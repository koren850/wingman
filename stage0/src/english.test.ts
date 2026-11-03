// English / mixed-language support: question detection without a "?", French-accented STT, English Prepared cards and stall lines,
// the English-turn instruction and the background-files rule in the reflex prompt. All data invented.
import test from "node:test";
import assert from "node:assert/strict";
import { detect } from "./detector.ts";
import { loadBank, matchBankFor, stallCard, stallSay, localizeCard, setTurnLang, getTurnLang } from "./bank.ts";
import { buildPrefix, reflexUserMessage, resolveBankId } from "./reflex.ts";
import { guard } from "./guards.ts";

const QUESTIONS = [
  "How long will the import take", "Can we keep editing the old site", "What happens to the old URLs", "Who needs to send you the database",
  "Will the news articles be migrated automatically", "Are you going to redirect the old pages", "Would it be possible to have a staging site",
  "I was wondering whether the donors pages will be kept", "I would like to understand how the languages are managed",
  "We keep the same URLs, right", "So you will migrate everything, correct", "Has the old site been backed up already", "Did you receive the access",
  "Could we maybe do it in two phases", "Any idea when it will be ready", "Walk me through the process", "What's the plan for the menus",
  "Okay, so, how many pages do you need to move", "Let me ask you something about the menu", "Will it work with WPML",
  // French-accented STT
  "Wat happen to ze old URL", "Are zey going to be on ze new site", "Ze old pages, can you redirect zem",
];
const STATEMENTS = [
  "Hi Dan, good to meet you.", "We have around five hundred news articles.", "The old site is on WordPress.", "Okay, that makes sense.",
  "Thank you very much.", "I don't know why it is slow.", "So that's what we have.", "I think we should start next week.",
  "I will send you the database tomorrow.", "That is a good idea.", "We are using WPML for the translation.", "I already asked about the URLs.",
  "What I mean is that the site is old.", "Do not worry about it.", "Have a nice day.", "Zis is ze old site.",
];

test("English questions without a question mark are detected", () => {
  for (const q of QUESTIONS) assert.equal(detect(q).isQuestion, true, q);
});
test("English statements are not questions", () => {
  for (const s of STATEMENTS) assert.equal(detect(s).isQuestion, false, `${s} -> ${detect(s).reason}`);
});
test("Hebrew detection is unchanged by the English rules", () => {
  assert.equal(detect("מה קורה עם הכתובות הישנות").isQuestion, true);
  assert.equal(detect("יש לנו אתר וורדפרס ישן").isQuestion, false);
  assert.equal(detect("כמה זמן ייקח לייבא את ה news").isQuestion, true);
  assert.equal(detect("אנחנו עובדים עם WPML לתרגום").isQuestion, false);
  for (const q of ["האם הוא נגיש לאנשים עם מוגבלות", "מה קורה עם הטפסים והניוזלטר", "מה עם הטפסים", "יש אפשרות להעביר את הניוזלטר", "אפשר להמשיך לערוך את האתר הישן", "רציתי להבין בקשר לטפסים והניוזלטר החדש האם הם יועברו", "ואז האם הם יועברו"]) assert.equal(detect(q).isQuestion, true, q);
  for (const q of ["מה קורה?", "מה קורה", "אני לא יודע האם זה נכון", "אמרתי להם האם לבוא"]) assert.equal(detect(q).isQuestion, q.includes("?"), q);
});

test("English question: Prepared card and buy-time line come out in English", () => {
  const bank = loadBank();
  setTurnLang("he");
  const price = matchBankFor("How much will the migration cost", bank);
  assert.equal(getTurnLang(), "en");
  assert.ok(price && /^The price depends/.test(price.card.say), price?.card.say);
  assert.equal(price!.card.id, "stall-price");
  const t = matchBankFor("How long will it take to move everything", bank);
  assert.equal(t?.card.id, "stall-timeline");
  assert.match(t!.card.say, /^It depends/);
  assert.match(stallSay(stallCard(bank), 0), /check/i);
  assert.doesNotMatch(stallSay(stallCard(bank), 1), /[א-ת]/);
  // the model-chosen card (BANK <id>) is localized too
  assert.match(resolveBankId("staging", bank)!.say, /^A staging site/);
  // every English stall/Prepared line obeys the house style
  for (const c of bank) if (c.en) for (const s of [c.en.say, ...(c.en.alts ?? [])]) assert.equal(guard(s).ok, true, `${c.id}: ${s}`);
});
test("a Hebrew question after an English one gets the Hebrew card again", () => {
  const bank = loadBank();
  matchBankFor("How much will the migration cost", bank);
  const h = matchBankFor("כמה זה עולה לכם בערך", bank);
  assert.equal(getTurnLang(), "he");
  assert.match(h!.card.say, /[א-ת]/);
  assert.match(stallSay(stallCard(bank), 0), /[א-ת]/);
});
test("a card without an English version is not shown in an English turn", () => {
  const bank = loadBank();
  const fake = { ...bank[0], en: undefined };
  assert.equal(localizeCard(fake, "en"), undefined);
  assert.equal(localizeCard(fake, "he"), fake);
});

test("reflex user message: English turn instruction only for English questions", () => {
  matchBankFor("How much will the migration cost", loadBank());   // loads and sets the English ids
  const en = reflexUserMessage({ transcript: "them: hi", question: "Which content types will you move?" });
  assert.match(en, /speaking ENGLISH/);
  assert.match(en, /staging/);
  const he = reflexUserMessage({ transcript: "them: היי", question: "איזה סוגי תוכן תעבירו?" });
  assert.doesNotMatch(he, /ENGLISH/);
  const me = reflexUserMessage({ transcript: "", question: "what is a CDN", asker: "me" });
  assert.doesNotMatch(me, /speaking ENGLISH/);
});
test("reflex prefix: background rule only when background files exist; prompt unchanged otherwise", () => {
  const bank = loadBank();
  const without = buildPrefix("style", bank);
  assert.doesNotMatch(without, /Using the background files/);
  const bg = "Background files Dan attached:\n<background_files>\n### brief.md\nAcme Foundation (invented): old WordPress site, 500 news items, 100 projects, WPML multisite, donors pages dropped.\n</background_files>";
  const withBg = buildPrefix("style", bank, "", bg);
  assert.match(withBg, /Using the background files/);
  assert.match(withBg, /STALL on a client call/);
  assert.ok(withBg.indexOf("Using the background files") < withBg.indexOf("500 news items"));
});
