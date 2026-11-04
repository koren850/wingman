import "./test-setup.ts";
import { test } from "node:test";
import "./test-setup.ts";
import assert from "node:assert/strict";
import { detectCareful, looksFactual, parseVerdict, checkFix, SelfCheckGate, runSelfCheck, quoteOf } from "./selfcheck.ts";

test("careful: price, date, promise; plain lines none", () => {
  assert.equal(detectCareful("זה יעלה 5000 שקל לחודש בערך")?.kind, "price");
  assert.match(detectCareful("זה יעלה 5000 שקל לחודש בערך")!.say, /^התחייבת למחיר/);
  assert.equal(detectCareful("נסיים את הכל עד סוף החודש בלי בעיה")?.kind, "date");
  assert.match(detectCareful("נסיים את הכל עד סוף החודש בלי בעיה")!.say, /^התחייבת לתאריך/);
  assert.equal(detectCareful("אני מבטיח שהאתר יעלה בלי שום תקלה")?.kind, "promise");
  assert.match(detectCareful("אני מבטיח שהאתר יעלה בלי שום תקלה")!.say, /^הבטחת/);
  assert.equal(detectCareful("ספר לי קצת על העסק שלכם ועל הלקוחות"), undefined);
  assert.equal(detectCareful("עד סוף החודש"), undefined);   // under 5 words
});
test("quote is capped", () => {
  const q = quoteOf("מילה ".repeat(60));
  assert.ok(q.length <= 92);
  assert.equal(detectCareful("זה יעלה 5000 שקל " + "לחודש ".repeat(40))!.question.length <= 92, true);
});
test("looksFactual", () => {
  assert.ok(looksFactual("יש לנו שלושה שרתים באירוח הזה"));
  assert.ok(looksFactual("אנחנו עובדים עם WordPress כבר שנים"));
  assert.ok(!looksFactual("נשמע טוב בוא נמשיך הלאה לנושא הבא"));
});
test("parseVerdict", () => {
  assert.deepEqual(parseVerdict('{"verdict":"ok"}'), { verdict: "ok" });
  assert.deepEqual(parseVerdict("garbage"), { verdict: "ok" });
  assert.deepEqual(parseVerdict(undefined), { verdict: "ok" });
  assert.deepEqual(parseVerdict('{"verdict":"fix","said":"x"}'), { verdict: "ok" });
  const v: any = parseVerdict('```json\n{"verdict":"fix","said":"יש שלושה שרתים","correct":"יש שני שרתים, לא שלושה","source":"בריף: תשתית"}\n```');
  assert.equal(v.verdict, "fix"); assert.equal(v.correct, "יש שני שרתים, לא שלושה"); assert.equal(v.source, "בריף: תשתית");
  const long: any = parseVerdict(JSON.stringify({ verdict: "fix", said: "a b", correct: "מילה ".repeat(60), source: "ב ".repeat(60) }));
  assert.ok(long.correct.length <= 120 && long.source.length <= 80);
});
test("guard drops a correction that states a price", () => {
  const v: any = parseVerdict('{"verdict":"fix","said":"זה בחינם","correct":"העלות היא 3000 שקל","source":"בריף"}');
  assert.equal(checkFix(v).ok, false);
  const ok: any = parseVerdict('{"verdict":"fix","said":"שלושה","correct":"יש שני שרתים","source":"בריף"}');
  assert.equal(checkFix(ok).ok, true);
});
test("gate: rate limits and dedupe", () => {
  const g = new SelfCheckGate({ minGapMs: 8000 });
  assert.ok(g.canModel(1000)); g.startModel(1000);
  assert.ok(!g.canModel(20000), "in flight"); g.endModel();
  assert.ok(!g.canModel(5000), "min gap"); assert.ok(g.canModel(9000));
  assert.ok(g.canFix(0, "יש שני שרתים")); g.noteFix(100_000, "יש שני שרתים");
  assert.ok(!g.canFix(130_000, "משהו אחר"), "60s");
  assert.ok(!g.canFix(200_000, "יש  שני שרתים!"), "repeat");
  assert.ok(g.canFix(200_000, "יש שלושה עובדים"));
  assert.ok(g.canCareful(0)); g.noteCareful(1000);
  assert.ok(!g.canCareful(40_000)); assert.ok(g.canCareful(46_000));
});
test("runSelfCheck with injected generate", async () => {
  const registry: any = { resolve: async () => ({}) };
  const base = { registry, model: "anthropic:claude-haiku-5-5", cache: "off" as const, transcript: "me: x", line: "יש לנו שלושה שרתים בחבילה", signal: new AbortController().signal, timeoutMs: 1000 };
  let calls = 0;
  const generate: any = async () => { calls++; return { text: '{"verdict":"fix","said":"שלושה שרתים","correct":"יש שני שרתים","source":"בריף"}', usage: {} }; };
  const r = await runSelfCheck({ ...base, background: "BACKGROUND: two servers", generate });
  assert.equal(r.verdict.verdict, "fix");
  const none = await runSelfCheck({ ...base, background: "  ", generate });
  assert.equal(none.verdict.verdict, "ok"); assert.equal(calls, 1, "no background = no model call");
});
