// "What about X" questions after a lead-in, as real STT writes them (no "?").
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { detect } from "./detector.ts";

test("detector: 'מה קורה עם / מה לגבי' after a lead-in is a question; greetings and 'don't know' are not", () => {
  for (const q of ["טוב, נחזור לעברית מה קורה עם הטפסים והניוזלטר", "ועכשיו בקשר לאתר הישן מה לגבי התמונות", "רגע אחד לפני שנסיים מה המצב עם הדומיין"])
    assert.equal(detect(q).isQuestion, true, q);
  for (const s of ["מה קורה", "היי מה קורה איתך", "אני באמת לא יודע מה קורה עם זה"])
    assert.equal(detect(s).isQuestion, false, s);
});

import { detect as detectStranded } from "./detector.ts";
test("detector: English wh-questions ending in a stranded preposition are complete; real cut-offs still wait", () => {
  for (const q of ["what are you looking for", "who did you work with", "who is this for", "what is it used for", "what are you talking about", "where are you from"])
    assert.equal(detectStranded(q).isQuestion, true, q);
  for (const q of ["do you have experience with", "what is the price of", "tell me about"]) assert.equal(detectStranded(q).reason, "unfinished", q);
});
