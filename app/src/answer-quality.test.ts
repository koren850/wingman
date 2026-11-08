// Answer-quality regressions: mixed Hebrew/English questions, speech-to-text garble of bank terms,
// supplier / team calls, interview-style prompts. Tests detector.ts, bank.ts, reflex.ts (prompt prefix), frame.ts.
// Offline; all sentences are invented. The kind is passed to isAgencyTopic() by the caller (frame.ts has no module-level kind any more).
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBank, matchBank, sttAliases } from "./bank.ts";
import { detect } from "./detector.ts";
import { buildPrefix } from "./reflex.ts";
import { isAgencyTopic } from "./frame.ts";

const bank = loadBank();

test("detector: asking for a view or experience is a question even without a question word or mark", () => {
  for (const q of [
    "אתה חושב שזה קשור לגרסה של php",
    "את חושבת שצריך לעבור לשרת אחר",
    "אתה ממליץ על תוסף גיבוי",
    "מה דעתך על הפתרון הזה",
    "אפשר לדעת כמה אתרים יש לכם על השרת",
    "תאר לי פרויקט שניהלת",
    "תן לי דוגמה לקונפליקט בצוות",
    "ספר לי על פעם שטעית",
  ])
    assert.equal(detect(q).isQuestion, true, q);
  for (const q of ["אני חושב שזה קשור לגרסה", "הוא חושב שנעבור לשרת אחר", "תודה רבה על הזמן"]) assert.equal(detect(q).isQuestion, false, q);
});

test("bank matching: STT garble of SSL, cache and 'slow' still finds the card", () => {
  assert.equal(matchBank("ואיך מגדירים ss על הדומיין החדש?", bank)?.card.id, "ssl-basics");
  assert.equal(matchBank("מה אם קש צריך תוסף", bank)?.card.id, "caching");
  assert.equal(matchBank("והאתר גם איתי לפעמים מה אפשר לעשות כדי שהוא יהיה מהיר יותר?", bank)?.card.id, "site-slow");
  assert.equal(matchBank("האתר נהיה איתי", bank)?.card.id, "site-slow");
});

test("bank matching: a person called Itay is not a slow site", () => {
  for (const q of ["תקבעו פגישה עם איתי מחר", "האתר של איתי נפל", "דברתי עם איתי על הדומיין"]) assert.ok(!/איטי/.test(sttAliases(q)), q);
  assert.equal(matchBank("תקבעו פגישה עם איתי מחר", bank), undefined);
});

test("agency topic: on a supplier or team call only unmistakable service terms count", () => {
  const q = "אנחנו מארחים אצלכם כארבעים אתרים, מה עם האחסון";
  assert.equal(isAgencyTopic(q), true); // no call frame yet: loose
  assert.equal(isAgencyTopic(q, "vendor"), false);
  assert.equal(isAgencyTopic("אפשר להעביר את הדומיין לספק אחר", "vendor"), true);
  assert.equal(isAgencyTopic("איך מגדירים SSL", "team"), true);
  assert.equal(isAgencyTopic(q, "other"), true); // a call still being recognised keeps the loose rule
});

test("agency topic follows the kind the caller passes (the call memory's kind), not a module global", () => {
  assert.equal(isAgencyTopic("כמה אתרים יש לכם באחסון", "vendor"), false);
  assert.equal(isAgencyTopic("כמה אתרים יש לכם באחסון", "client"), true);
  assert.equal(isAgencyTopic("כמה אתרים יש לכם באחסון"), true, "no kind = the loose rule");
});

test("reflex prompt: technical questions and interview prompts are answered, nothing is invented about Dan", () => {
  const p = buildPrefix("style", bank.slice(0, 2), "", "");
  assert.match(p, /Technical or factual questions are ANS even when asked to the whole room or at an interview/);
  assert.match(p, /STAR/);
  assert.match(p, /never any content about Dan's own experience/);
  assert.match(p, /exception to "only Dan can answer"/);
  assert.match(p, /who takes a task, schedules, owners/); // ownership and scheduling stay SKIP
  assert.match(p, /never a card about one possible cause/); // broad card over a specific-cause card
});
