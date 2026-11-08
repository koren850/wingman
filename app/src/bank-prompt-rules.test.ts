// hint tests, in-sample, not product truth: these check the frozen word-list hint (detector.ts, bank.ts). The product decides with the model; see moments-floor.test.ts for the floor.
// Bank matching and prompt rules found in call reviews: wrong bank hits, leaked control words, prompt rules.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBank, matchBankFor, matchBank } from "./bank.ts";
import { buildPrefix, leakedTag } from "./reflex.ts";

const bank = loadBank();
const hit = (t: string) => (matchBankFor(t, bank) ?? matchBank(t, bank))?.card.id;

test("'whose responsibility' and 'rest assured' are not warranty or discount questions", () => {
  assert.equal(hit("רגע אני לא הבנתי באחריות מי שמתרגם"), undefined);
  assert.equal(hit("באחריות מי זה"), undefined);
  assert.equal(hit("תהי נחה. כן כן כן."), undefined);
  assert.equal(hit("יש לכם אחריות על העבודה?"), "stall-guarantee");
  assert.equal(hit("יש הנחה אם משלמים מראש?"), "stall-price");
});

test("a say-line with a leaked control word is caught; ordinary text is not", () => {
  assert.ok(leakedTag("ממש לא בטוח מה נאמר בדיוק, לכן SKIP עדיף כרגע."));
  assert.ok(leakedTag("STALL"));
  assert.ok(!leakedTag("נעביר את ה-DNS ל-Cloudflare ונבדוק את ה-SSL."));
  assert.ok(!leakedTag("Answers and banking skills"));
});

test("the prompt tells the model: statements are SKIP, no side on the client's decisions, no guessing how Dan's system works", () => {
  const p = buildPrefix("style", bank, "", "Background files Dan attached:\n<background_files>\nInvented brief.\n</background_files>");
  assert.match(p, /states a fact, describes their situation, thinks aloud/);
  assert.match(p, /Never recommend or take a side on a decision that belongs to the other side/);
  assert.match(p, /Never describe how Dan's own system/);
});

test("important cards only: clear questions pass, statements that merely start with a question word do not", async () => {
  const { detect, isClearQuestion } = await import("./detector.ts");
  const ok = (t: string) => {
    const d = detect(t);
    return d.isQuestion && isClearQuestion(t, d.reason);
  };
  assert.ok(ok("יש לנו חנות והאתר נטען ממש לאט בזמן האחרון, למה זה קורה")); // question word later, no "?"
  assert.ok(ok("ויש לכם גיבוי של האתר אם משהו נופל")); // speaks to the user
  assert.ok(ok("כמה זמן לוקח להעביר את האתר?"));
  assert.ok(!isClearQuestion("מה שקיים באנגלית לא תמיד קיים בעברית", "head:מה"));
});
