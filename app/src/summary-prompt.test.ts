// The summary prompt never names the user in the summary lists.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarySystem } from "./summary.ts";

// the profile name leaked into the call summary ("Alex (Dan) walked ...") when the call used another name for the user.
test("summary prompt: the user is never named in the summary lists", () => {
  for (const lang of ["en", "he"] as const) {
    const p = summarySystem(lang);
    assert.match(p, /never write .* name in "summary", "decisions", "nextSteps" or "openQuestions"/);
    assert.match(p, lang === "en" ? /"you" or "the user"/ : /"אתה" or "המשתמש"/);
  }
});
