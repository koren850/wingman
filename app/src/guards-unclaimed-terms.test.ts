// Interview guards and card helpers: plan names for speech-to-text, the unclaimed-tool guard, "aimed at you".
import { test } from "node:test";
import assert from "node:assert/strict";
import { briefTerms } from "./brief.ts";
import { unclaimedTerm, guardInterview } from "./guards.ts";
import { addressesYou } from "./detector.ts";

test("briefTerms: names from who and title, no filler words", () => {
  assert.deepEqual(briefTerms({ who: "Dana Levi (Acme HR)", title: "Acme HR call" }), ["Dana", "Levi", "Acme"]);
  assert.deepEqual(briefTerms({ who: "דנה לוי, ראש צוות", title: "Acme round 2" }), ["דנה", "לוי", "Acme"]);
  assert.deepEqual(briefTerms(undefined), []);
});

test("unclaimedTerm: a tool the profile does not name is caught, whole words only", () => {
  assert.equal(unclaimedTerm("אני משתמש ב-Claude ובמקביל ב-OpenAI API", "Claude Agent SDK, TypeScript"), "OpenAI");
  assert.equal(unclaimedTerm("I deploy on AWS", "basic AWS"), undefined);
  assert.equal(unclaimedTerm("let us go over it", "TypeScript"), undefined); // case-sensitive: the word "go" is not Go
  assert.equal(unclaimedTerm("Angularity is not a tool", "TypeScript"), undefined);
});

test("guardInterview blocks unclaimed tools only when an allowed text is given", () => {
  assert.deepEqual(guardInterview("I use Kubernetes daily", "TypeScript React"), { ok: false, rule: "unclaimed" });
  assert.deepEqual(guardInterview("I use Kubernetes daily"), { ok: true });
  assert.deepEqual(guardInterview("I use React daily", "TypeScript React"), { ok: true });
});

test("addressesYou: second person, not a description of their own company", () => {
  assert.equal(addressesYou("עבדת פעם עם טלפוניה"), true);
  assert.equal(addressesYou("יצא לך לשמוע על ג'יי פרוג"), true);
  assert.equal(addressesYou("tell me about your last project"), true);
  assert.equal(addressesYou("מפתחים פלטפורמה שמיועדת לארגונים גדולים"), false);
  assert.equal(addressesYou("והצוות של ג'ין טוק הוא"), false);
});
