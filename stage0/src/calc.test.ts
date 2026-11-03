// Local arithmetic for spoken questions (calc.ts), and keeping it (and non-service prices) away from the price stall (bank.ts).
// Pure logic, no fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evalMath, looksArithmetic, fmtNum } from "./calc.ts";
import { loadBank, matchBank, matchBankFor, priceOffTopic } from "./bank.ts";

const r = (q: string) => evalMath(q)?.result;

test("digits: Hebrew and English operators", () => {
  assert.equal(r("כמה זה 36 ועוד 42?"), "78");
  assert.equal(r("כמה זה 36 ועוד 42"), "78");
  assert.equal(r("36 ועוד 42?"), "78");                    // a bare expression counts when it ends in "?"
  assert.equal(r("כמה זה 12 כפול 3"), "36");
  assert.equal(r("כמה זה 100 חלקי 4"), "25");
  assert.equal(r("כמה זה 10 פחות 3"), "7");
  assert.equal(r("כמה זה 10 מינוס 3"), "7");
  assert.equal(r("what's 6 times 7"), "42");
  assert.equal(r("how much is 100 divided by 8"), "12.5");
  assert.equal(r("calculate 5 plus 5"), "10");
  assert.equal(r("what is 9 minus 12"), "-3");
});
test("percent", () => {
  assert.equal(r("what's 15% of 200"), "30");
  assert.equal(r("כמה זה 15 אחוז מ-200"), "30");
  assert.equal(r("כמה זה 20 אחוז מ 50"), "10");
  assert.equal(r("what is 7.5 percent of 80"), "6");
});
test("number words: Hebrew and English, with precedence", () => {
  assert.equal(r("כמה זה שלוש ועוד ארבע"), "7");
  assert.equal(r("מה זה שלוש מאות ארבעים ושתיים ועוד שמונה"), "350");
  assert.equal(r("כמה זה עשרים ושלוש פחות אחד עשר"), "12");
  assert.equal(r("כמה זה אלף ועוד חמש מאות"), "1500");
  assert.equal(r("כמה זה שני אלפים ועוד שלוש"), "2003");
  assert.equal(r("how much is twenty-five times four"), "100");
  assert.equal(r("what is one hundred and twenty plus three"), "123");
  assert.equal(r("כמה זה 7 ועוד 5 כפול 2"), "17");        // × before +
  assert.equal(r("כמה זה 1,200 ועוד 300"), "1500");
});
test("the card text: expression and result, as one left-to-right island", () => {
  const m = evalMath("כמה זה 36 ועוד 42?")!;
  assert.equal(m.expr, "36 + 42"); assert.equal(m.value, 78);
  assert.match(m.say, /^⁦36 \+ 42 = 78⁩$/);
  assert.equal(fmtNum(0.1 + 0.2), "0.3");
});
test("not arithmetic: money, plain statements, division by zero, no expression", () => {
  for (const q of ["כמה זה עולה 100 שקל ועוד 50", "כמה זה 100 שקל ועוד 50 שקל", "יש לי 3 ועוד 2 אנשים", "מה זה DNS", "כמה זה עולה", "כמה זה 5", "how much is 5 dollars plus 3"]) assert.equal(evalMath(q), undefined, q);
  assert.equal(evalMath("כמה זה 5 חלקי 0"), undefined);
  assert.equal(looksArithmetic("כמה זה 5 חלקי 0"), true);   // still arithmetic: it must not become a price stall
  assert.equal(looksArithmetic("כמה זה עולה אתר"), false);
});

test("the price stall is for prices of Dan's services, not arithmetic or general prices", () => {
  const bank = loadBank();
  // real price questions keep the stall
  for (const q of ["כמה זה עולה", "מה המחיר", "כמה זה עולה לבנות אתר חנות", "כמה זה יעלה לי בסוף כולל תחזוקה", "how much is hosting", "what's your pricing"]) assert.equal(matchBankFor(q, bank)?.card.id, "stall-price", q);
  // arithmetic and general prices lose it
  for (const q of ["how much is 12 times 3", "כמה עולה דולר היום", "how much memory does it use", "מה המחיר של הטיסה לניו יורק", "what is the price of bitcoin"]) {
    assert.equal(matchBank(q, bank)?.card.id, "stall-price", q + " (the plain matcher would stall)");
    assert.notEqual(matchBankFor(q, bank)?.card.id, "stall-price", q);
    assert.ok(priceOffTopic(q), q);
  }
  assert.equal(priceOffTopic("כמה זה עולה אתר"), undefined);
});

test("speech-to-text's 'מהם' before a number still means 'of'; the model's thinking out loud is never shown to Dan", async () => {
  assert.equal(evalMath("כמה זה 15% מהם 2000")?.result, "300");
  const { guardMe } = await import("./assist.ts");
  assert.equal(guardMe('בעברית אומרים "הפתיע". Hmm, not the question.', "איך אומרים uptime").ok, false);
  assert.equal(guardMe("זמינות.", "איך אומרים uptime בעברית").ok, true);
});

test("robust to fillers and prefixes: the phrasing heard on a live solo call (invented numbers)", () => {
  for (const [q, want] of [["וכמה איזה 7 כפול 350?", "2450"], ["רגע, נגיד 12 ועוד 30", "42"], ["תגיד לי כמה זה בערך 9 כפול 11", "99"], ["ובכן וכמה זה 81 לחלק ל 9", "9"], ["כמה זה 12 בריבוע?", "144"], ["אז כמה זה ואיזה 25 פלוס 17", "42"], ["כמה זה 20 אחוז מ 450 בבקשה", "90"], ["וכמה יוצא 1000 פחות 275?", "725"]] as const) assert.equal(evalMath(q)?.result, want, q);
  for (const q of ["רגע, נגיד שיש לי 12 ועוד 30 דברים", "תגיד לי מה אתה חושב על 7 כפול 350 אנשים", "אמרתי 7 כפול 350"]) assert.equal(evalMath(q), undefined, q);
});
