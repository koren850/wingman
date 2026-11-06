// Pure engine rules (engine/rules.ts): who a question is aimed at, recent notes for the notes model, the interview answer clock.
// (The call-loop behaviour of the same fixes is in e2e/engine-modes.test.ts.)
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { addressesUser, recentNotes, NOTES_EXISTING_MAX, nextAnswerStart } from "./engine/rules.ts";

test("rules: addressesUser covers Hebrew and English forms of 'you'", () => {
  for (const s of [
    "מה דעתך על זה?",
    "מה לדעתך כדאי לעשות",
    "מה אתה חושב",
    "מה את חושבת",
    "תוכלי להסביר",
    "what do you think?",
    "can you help",
    "do u know",
    "you're the expert",
  ])
    assert.equal(addressesUser(s), true, s);
  for (const s of ["מה אתם אומרים", "את הדומיין", "מפתחים פלטפורמה שמיועדת לארגונים", "הוא אמר שדעתו"]) assert.equal(addressesUser(s), false, s);
});
test("8. the notes model gets only the recent notes", () => {
  const notes = Array.from({ length: 200 }, (_, i) => `note ${i}`);
  const got = recentNotes(notes);
  assert.equal(got.length, NOTES_EXISTING_MAX);
  assert.equal(got.at(-1), "note 199");
  assert.deepEqual(recentNotes(["a", "b"]), ["a", "b"]);
});
test("11. interview: the 90 s answer clock restarts after a pause of the user, even when the interviewer's audio is dead", () => {
  const T = 1_000_000;
  // first line: the clock starts 5 s back
  assert.equal(nextAnswerStart({ answerStart: 0, lastThemSpeech: 0, lastMeLineAt: 0, now: T }), T - 5000);
  // a line 3 s later: same answer
  assert.equal(nextAnswerStart({ answerStart: T - 5000, lastThemSpeech: 0, lastMeLineAt: T, now: T + 3000 }), T - 5000);
  // the interviewer spoke in between: new answer
  assert.equal(nextAnswerStart({ answerStart: T - 5000, lastThemSpeech: T + 1000, lastMeLineAt: T, now: T + 3000 }), T + 1000);
  // nobody else is heard, but the user was quiet for 60 s: a new answer, not "30 minutes of talking"
  assert.equal(nextAnswerStart({ answerStart: T - 5000, lastThemSpeech: 0, lastMeLineAt: T, now: T + 60_000 }), T + 55_000);
});
