// A direct answer may keep a price or a date when the user's own notes state that exact figure; a figure from nowhere, or a near miss, is still guarded.
// In-process on the virtual clock and the policy fake model (one engine per test process).
import "./test-setup.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupEngine, type Engine } from "./testkit/engine-inproc.ts";
import { guardGrounded } from "./guards.ts";

let e: Engine;
before(async () => {
  e = await setupEngine();
});
after(() => e?.stop());

const reply = (say: string) => `ANS\nVALUE: 3\nAIM: me\nSAY: ${say}\nWHY: direct question`;
const userFact = (text: string) => {
  e.st.m.mem = { ...e.st.m.mem, facts: [{ id: "f1", text, at: 0, src: "user" as const }] };
};
async function ask(q: string, say: string) {
  await e.reset();
  return { q, say };
}
async function run(notes: string | undefined, q: string, say: string) {
  await ask(q, say);
  if (notes) userFact(notes);
  e.pm.reply({ role: "moment", lastLine: q }, reply(say), { ms: 300 });
  e.say("them", q);
  await e.vc.advance(2500);
  return e.screen();
}

const EN_Q = "What does the Pro plan run per month for a team of five?";
const HE_Q = "מה דמי ההקמה של הפרויקט?";

test("figure in the notes: English and Hebrew answers keep it", async () => {
  const en = await run("The Pro plan is $49 per month for a team.", EN_Q, "The Pro plan is $49 per month");
  assert.ok(
    en.some((c) => c.badge === "ai" && /\$49/.test(String(c.say))),
    JSON.stringify(en),
  );
  const he = await run("דמי ההקמה הם 490 ₪ חד פעמי.", HE_Q, "דמי ההקמה הם 490 ₪");
  assert.ok(
    he.some((c) => c.badge === "ai" && /490/.test(String(c.say))),
    JSON.stringify(he),
  );
});

test("figure not in the notes, or a near miss: no figure on screen", async () => {
  const cases: [string | undefined, string, string, RegExp][] = [
    [undefined, EN_Q, "The Pro plan is $49 per month", /\$49/],
    ["The Pro plan is $49 per month for a team.", EN_Q, "The Pro plan is $45 per month", /\$45/],
    ["The Pro plan is $450 per month for a team.", EN_Q, "The Pro plan is $45 per month", /\$45/],
    [undefined, HE_Q, "דמי ההקמה הם 490 ₪", /490/],
    ["דמי ההקמה הם 490 ₪ חד פעמי.", HE_Q, "דמי ההקמה הם 450 ₪", /450/],
  ];
  for (const [notes, q, say, re] of cases) {
    const s = await run(notes, q, say);
    assert.ok(!s.some((c) => re.test(String(c.say))), `${say}: ${JSON.stringify(s)}`);
  }
});

test("what the other side said is not the user's material", async () => {
  await e.reset();
  e.say("them", "Our budget is $49 per month, no more than that.");
  await e.vc.advance(300);
  e.pm.reply({ role: "moment", lastLine: EN_Q }, reply("The Pro plan is $49 per month"), { ms: 300 });
  e.say("them", EN_Q);
  await e.vc.advance(2500);
  assert.ok(!e.screen().some((c) => /\$49/.test(String(c.say))), JSON.stringify(e.screen()));
});

test("guardGrounded: figures, dates and promises", () => {
  const own = "Pro plan: $1,500 per month. Delivery by Friday. Kickoff 5/11 at 14:30.";
  assert.equal(guardGrounded("It is $1500 per month", own).ok, true);
  assert.equal(guardGrounded("It is $1,500 per month", own).ok, true);
  assert.equal(guardGrounded("It is $150 per month", own).ok, false);
  assert.equal(guardGrounded("It is $15,000 per month", own).ok, false);
  assert.equal(guardGrounded("Kickoff is 5/11 at 14:30", own).ok, true);
  assert.equal(guardGrounded("Kickoff is 5/12 at 14:30", own).ok, false);
  assert.equal(guardGrounded("We deliver by Friday", own).ok, true);
  assert.equal(guardGrounded("We deliver by Friday", "Delivery is flexible").ok, false);
  assert.equal(guardGrounded("We deliver tomorrow", "Call tomorrow").ok, false);
  assert.equal(guardGrounded("I guarantee it", own).ok, false);
  assert.equal(guardGrounded("It is $1,500 per month", "").ok, false);
});

test("a guarded answer to a question that opens with another person's name gives no stall line; the same question to the user still does", async () => {
  const roster = (e2: Engine) => {
    e2.st.m.mem = { ...e2.st.m.mem, roster: [{ id: "p1", name: "Dana", side: "them" as const }] };
  };
  const q = "What does the Pro plan run per month for a team of five?";
  for (const [line, stall] of [
    [`Dana, ${q.charAt(0).toLowerCase()}${q.slice(1)}`, false],
    [q, true],
  ] as const) {
    await e.reset();
    roster(e);
    e.pm.reply({ role: "moment", lastLine: line }, reply("The Pro plan is $49 per month"), { ms: 300 });
    e.say("them", line);
    await e.vc.advance(2500);
    assert.equal(
      e.screen().some((c) => c.badge === "stall"),
      stall,
      line + JSON.stringify(e.screen()),
    );
  }
});
