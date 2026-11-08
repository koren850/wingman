// Card pipeline v2 (engine/cards-v2.ts): row schema, the cap, the scheduler hookup, closing rows, the feedback loop and the digit guards.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { CardScheduler, capDecision, parseTags, validateRowV2, kindOfBadge, type CapInput, type CardRow } from "./engine/cards-v2.ts";
import { DEFAULT_SCHEDULER, type ScheduledMoment } from "./moments/scheduler.ts";
import { asciiDigits, numbersIn, unsupportedNumbers, guardDigits, FIGURE } from "./guards.ts";
import { guardEmail } from "./summary-email.ts";
import type { MomentTag } from "./moments/types.ts";

const req = createRequire(import.meta.url);
const F = req("../dashboard/livefeed.js");

let sayN = 0; // a card with the same words as a recent one is a repeat: every default card says something else
const mom = (o: Partial<ScheduledMoment> & { tag: MomentTag }): ScheduledMoment => ({
  value: 2,
  aim: "me",
  say: `Say it plainly, version ${(++sayN).toString(26).replace(/\d/g, (d) => "abcdefghij"[+d])}`, // letters, not digits: a number in a model answer is checked
  why: "they asked",
  more: [],
  source: "direct",
  turnId: 1,
  ...o,
});
const T0 = 1_000_000;
const sched = () => new CardScheduler(DEFAULT_SCHEDULER, T0);
const meta = (o: object = {}) => ({ memV: 3, question: "How long does it take?", ...o });
const shown = (o: ReturnType<CardScheduler["offer"]>): CardRow => {
  assert.ok(o.action !== "drop", o.action === "drop" ? o.why : "");
  return (o as { row: CardRow }).row;
};

// ---------------------------------------------------------------- rows
test("v2 rows validate against the contract for every card kind, and carry ctx", () => {
  const s = sched();
  const tags: [MomentTag, string, string][] = [
    ["ANS", "answer", "ai"],
    ["PROMPT", "prompt", "tip"],
    ["CHECK", "check", "careful"],
    ["TERM", "fact", "info"],
    ["NOTE", "fact", "info"],
    ["REPLY", "answer", "ai"],
  ];
  let t = T0;
  for (const [tag, kind, badge] of tags) {
    t += 200_000; // far apart: no novelty or cap interference
    s.tick(t, 4);
    const row = shown(
      s.offer(
        mom({ tag, value: 3, turnId: t, ref: tag === "PROMPT" ? "q3" : undefined, more: ["a", "b"], lineAt: t }),
        meta({ ctx: { role: "moment", memV: 4, tokens: 30, parts: { a: 10, b: 20 }, trimmed: [], hash: "h", aHash: "a", chunks: [] } }),
      ),
    );
    assert.deepEqual(validateRowV2(row), [], `${tag}: ${validateRowV2(row)}`);
    assert.equal(row.kind, kind);
    assert.equal(row.badge, badge);
    assert.equal(row.ctx?.memV, 4);
    assert.equal(row.value, 3);
    assert.equal(row.scheduled, true);
  }
});

test("a row without ctx still gets one; tokens equal the sum of the parts", () => {
  const s = sched();
  s.tick(T0, 7);
  const row = shown(s.offer(mom({ tag: "ANS" }), meta({ memV: 7 })));
  assert.deepEqual(row.ctx, { memV: 7, tokens: 0, parts: {} });
  assert.deepEqual(validateRowV2({ ...row, ctx: { memV: 1, tokens: 31, parts: { a: 10, b: 20 } } }), ["ctx.tokens"]);
});

test("validateRowV2 names every broken field and accepts legacy rows", () => {
  const legacy = { id: "q1", turnId: "t3", badge: "ai", question: "q", say: "a", facts: [], at: 5 };
  assert.deepEqual(validateRowV2(legacy), []);
  const bad = { ...legacy, kind: "wow", value: 9, more: ["1", "2", "3", "4"], closes: "never", pinned: "yes", ctx: { memV: "x" } };
  assert.deepEqual(validateRowV2(bad).sort(), ["closes", "ctx", "kind", "more", "pinned", "value"].sort());
  assert.deepEqual(validateRowV2(null), ["not an object"]);
});

test("old tools still read v2 rows: the dashboard feed keeps the card and passes the new fields", () => {
  const s = sched();
  s.tick(T0, 1);
  const a = shown(s.offer(mom({ tag: "ANS", more: ["detail"], ref: "q1" }), meta()));
  const c = F.cleanCard({ type: "card", ...a });
  assert.match(c.say, /^Say it plainly, version /);
  assert.equal(c.badge, "ai");
  assert.equal(c.kind, "answer");
  assert.equal(c.value, 2);
  assert.deepEqual(c.more, ["detail"]);
  assert.equal(c.ref, "q1");
  // a prompt uses the tip badge, so the old window shows it as a tip
  s.tick(T0 + 200_000, 1);
  const p = shown(s.offer(mom({ tag: "PROMPT", turnId: 2, lineAt: T0 + 200_000 }), meta()));
  assert.equal(F.cleanCard({ type: "card", ...p }).tipType, "ask");
  // a legacy row passes through unchanged (no v2 keys appear)
  const old = F.cleanCard({ type: "card", id: "x", badge: "bank", question: "q", say: "s", facts: [], at: 9, turnId: "t1" });
  assert.deepEqual(Object.keys(old).sort(), ["badge", "dim", "id", "question", "say", "t"]);
});

test("the dashboard feed cleans the memory view and drops junk", () => {
  const good = F.cleanMemory({
    type: "memory",
    view: {
      ver: 4,
      topic: "pricing",
      soFar: ["a", "b", "c", "d", "e"],
      open: [{ id: "q1", text: "who?" }, { id: "q2" }],
      promises: [{ id: "c1", who: "me", text: "send" }],
      coverLeft: [],
      numbers: [{ id: "n1", what: "budget", value: "40k" }],
    },
  });
  assert.equal(good.soFar.length, 4);
  assert.equal(good.open.length, 1);
  assert.deepEqual(good.promises, [{ id: "c1", text: "send", who: "me" }]);
  assert.equal(F.cleanMemory({ type: "memory", view: 5 }), null);
  assert.equal(F.cleanMemory({ type: "card" }), null);
  const feed = F.create();
  assert.equal(feed.addMemoryRows([{ type: "memory", view: { ver: 2, topic: "a" } }]).ver, 2);
  assert.equal(feed.addMemoryRows([{ type: "memory", view: { ver: 1, topic: "old" } }]), null, "an older version does not replace a newer one");
  assert.equal(feed.snapshot().memory.topic, "a");
});

// ---------------------------------------------------------------- the cap
const cap = (o: Partial<CapInput> = {}): CapInput => ({
  now: 100_000,
  quiet: false,
  special: false,
  forMe: false,
  badge: "ai",
  capMax: 3,
  capWindowMs: 60_000,
  shown: [
    { id: "a", t: 99_000 },
    { id: "b", t: 98_000 },
    { id: "c", t: 97_000 },
  ],
  ...o,
});
test("a Check card is shown even at the cap; an answer is hidden", () => {
  assert.deepEqual(capDecision(cap()), { hidden: true, reason: "cap", counted: false });
  assert.equal(capDecision(cap({ badge: "careful", kind: "check" })).hidden, false);
  assert.equal(capDecision(cap({ badge: "fix" })).hidden, false);
  assert.equal(capDecision(cap({ kind: "check" })).hidden, false);
  assert.equal(capDecision(cap({ badge: "ai", priority: true })).hidden, false);
  assert.equal(capDecision(cap({ badge: "stall" })).hidden, false);
  assert.equal(capDecision(cap({ scheduled: true })).hidden, false, "the scheduler already decided");
  assert.equal(capDecision(cap({ shown: [] })).counted, true);
});
test("quiet mode hides a check too; health and info rows are never hidden", () => {
  assert.equal(capDecision(cap({ quiet: true, kind: "check", badge: "careful" })).hidden, true);
  assert.equal(capDecision(cap({ quiet: true, special: true })).hidden, false);
});
test("the scheduler does not drop a CHECK when three cards filled the minute", () => {
  const s = sched();
  let t = T0;
  const actions: string[] = [];
  const tags: MomentTag[] = ["TERM", "ANS", "REPLY", "ANS"]; // each one outranks the hero except the last
  for (let i = 0; i < tags.length; i++) {
    t += 5000;
    s.tick(t, i);
    actions.push(s.offer(mom({ tag: tags[i], value: 3, turnId: i, ref: `q${i}`, lineAt: t }), meta({ memV: i })).action);
  }
  assert.deepEqual(actions, ["show", "show", "show", "chip"], "the fourth is over the per-minute cap or held by the hero");
  t += 3000;
  s.tick(t, 9);
  const c = s.offer(mom({ tag: "CHECK", value: 1, turnId: 9, lineAt: t, ref: "n1" }), meta({ memV: 9 }));
  assert.notEqual(c.action, "drop");
  assert.equal((c as { row: CardRow }).row.priority, true, "a check is exempt from the cap");
});

// ---------------------------------------------------------------- scheduler hookup
test("a stronger card takes over the hero and a closing row for the old one is written", () => {
  const s = sched();
  s.tick(T0, 1);
  const a = shown(s.offer(mom({ tag: "ANS", value: 2, turnId: 1, lineAt: T0, ref: "q1" }), meta()));
  s.tick(T0 + 4000, 2);
  const o = s.offer(
    mom({ tag: "STALL", stall: "price", value: 3, turnId: 2, lineAt: T0 + 4000 }),
    meta({ memV: 2, say: "Let me check and come back", question: "price?" }),
  );
  assert.equal(o.action, "show");
  const closes = (o as { closes: CardRow[] }).closes;
  assert.equal(closes.length, 1);
  assert.equal(closes[0].id, a.id);
  assert.equal(closes[0].closes, "topic");
  assert.equal(closes[0].say, a.say, "the closing row keeps the full text");
  assert.deepEqual(validateRowV2(closes[0]), []);
});

test("a weaker card while the hero lives is a chip, not hidden", () => {
  const s = sched();
  s.tick(T0, 1);
  shown(s.offer(mom({ tag: "ANS", value: 3, turnId: 1, lineAt: T0 }), meta()));
  s.tick(T0 + 4000, 2);
  const o = s.offer(mom({ tag: "TERM", value: 2, turnId: 2, lineAt: T0 + 4000 }), meta({ memV: 2 }));
  assert.equal(o.action, "chip");
  assert.equal((o as { row: CardRow }).row.chip, true);
});

test("cards close with 'time' after the topic lifetime, but a pinned card and a check stay", () => {
  const s = sched();
  s.tick(T0, 1);
  const a = shown(s.offer(mom({ tag: "ANS", turnId: 1, lineAt: T0 }), meta()));
  s.tick(T0 + 100_000, 2);
  const k = shown(s.offer(mom({ tag: "CHECK", turnId: 2, lineAt: T0 + 100_000, value: 2 }), meta({ memV: 2 })));
  s.tick(T0 + 200_000, 3);
  const p = shown(s.offer(mom({ tag: "TERM", turnId: 3, lineAt: T0 + 200_000, value: 3 }), meta({ memV: 3 })));
  s.pin(p.id, true);
  assert.deepEqual(s.expire(T0 + 59_000), []);
  const closed = s.expire(T0 + 261_000);
  assert.deepEqual(
    closed.map((r) => [r.id, r.closes]),
    [[a.id, "time"]],
  );
  assert.ok(![k.id, p.id].includes(closed[0].id));
  assert.deepEqual(s.expire(T0 + 300_000), [], "closed once");
});

test("a resolved memory item closes the card that points at it, with 'answered'", () => {
  const s = sched();
  s.tick(T0, 1);
  const a = shown(s.offer(mom({ tag: "PROMPT", turnId: 1, lineAt: T0, ref: "q5" }), meta()));
  assert.deepEqual(s.resolved(["q9"]), []);
  const rows = s.resolved(["q5"]);
  assert.equal(rows[0].id, a.id);
  assert.equal(rows[0].closes, "answered");
  assert.deepEqual(s.resolved(["q5"]), [], "closed once");
  assert.equal(s.openCards, 0);
});

test("the user dismissing a card closes it; the next card is no longer held back", () => {
  const s = sched();
  s.tick(T0, 1);
  const a = shown(s.offer(mom({ tag: "ANS", value: 3, turnId: 1, lineAt: T0 }), meta()));
  assert.equal(s.dismissed(a.id)?.closes, "dismissed");
  s.tick(T0 + 2000, 2);
  assert.equal(s.offer(mom({ tag: "TERM", value: 2, turnId: 2, lineAt: T0 + 2000 }), meta({ memV: 2 })).action, "show");
});

test("drops carry the scheduler reason: a SKIP, aim other, a stale turn, a late observer card, below the minimum", () => {
  const s = sched();
  s.tick(T0, 1);
  const why = (m: ScheduledMoment) => {
    const o = s.offer(m, meta());
    return o.action === "drop" ? o.why : o.action;
  };
  assert.equal(why(mom({ tag: "SKIP", value: 0 })), "skip");
  assert.equal(why(mom({ tag: "ANS", aim: "other" })), "aim-other");
  assert.equal(why(mom({ tag: "NOTE", value: 0, lineAt: T0 })), "below-min-value");
  s.tick(T0 + 20_000, 1);
  assert.equal(why(mom({ tag: "TERM", source: "observer", lineAt: T0 + 10_000, value: 3 })), "late");
});

// ---------------------------------------------------------------- guards on the model text
test("a model answer with a figure nobody said is replaced by the stall line, or dropped", () => {
  const s = sched();
  s.tick(T0, 1);
  const stall = { say: "Let me check and get back to you", facts: [] };
  const o = s.offer(mom({ tag: "ANS", say: "It takes 14 days", turnId: 1, lineAt: T0 }), meta({ allowed: "they asked about the migration", stall }));
  const row = shown(o);
  assert.equal(row.say, stall.say);
  assert.equal(row.badge, "stall");
  assert.equal((o as { guarded?: string }).guarded, "number");
  const s2 = sched();
  s2.tick(T0, 1);
  const d = s2.offer(mom({ tag: "ANS", say: "It takes 14 days", turnId: 1, lineAt: T0 }), meta({ allowed: "nothing" }));
  assert.equal(d.action, "drop");
  assert.match((d as { why: string }).why, /^guard:/);
});
test("a figure that the call said is fine; a prepared card is not checked", () => {
  const s = sched();
  s.tick(T0, 1);
  const ok = s.offer(mom({ tag: "ANS", say: "About 14 days, as you said", turnId: 1, lineAt: T0 }), meta({ allowed: "she said the move takes 14 days" }));
  assert.equal(ok.action, "show");
  s.tick(T0 + 100_000, 1);
  const bank = s.offer(
    mom({ tag: "BANK", bankId: "backup", say: "", value: 3, turnId: 2, lineAt: T0 + 100_000 }),
    meta({ say: "Backups run every 24 hours", allowed: "" }),
  );
  assert.equal(bank.action, "show");
  assert.equal(shown(bank).badge, "bank");
});
test("existing guards stay: a price or a promise in a model answer is caught", () => {
  const s = sched();
  s.tick(T0, 1);
  const o = s.offer(mom({ tag: "ANS", say: "I guarantee it will work", turnId: 1, lineAt: T0 }), meta({ allowed: "" }));
  assert.equal(o.action, "drop");
  assert.equal((o as { why: string }).why, "guard:promise");
});

// ---------------------------------------------------------------- feedback
test("three 'not useful' ratings in a row raise the minimum for that kind; 'useful' resets the streak", () => {
  const s = sched();
  const ids: string[] = [];
  let t = T0;
  for (let i = 0; i < 3; i++) {
    t += 200_000;
    s.tick(t, i);
    ids.push(shown(s.offer(mom({ tag: "ANS", value: 2, turnId: i, lineAt: t, ref: `q${i}` }), meta({ memV: i }))).id);
  }
  const lines = [
    JSON.stringify({ cardId: ids[0], rating: "not_useful" }),
    JSON.stringify({ id: ids[1], useful: "n" }),
    "garbage",
    JSON.stringify({ cardId: ids[2], rating: "not_useful" }),
  ];
  assert.equal(s.feedback(lines.join("\n")), 3);
  assert.equal(s.tagBoost().ANS, 3);
  t += 200_000;
  s.tick(t, 9);
  const o = s.offer(mom({ tag: "ANS", value: 2, turnId: 9, lineAt: t, ref: "q9" }), meta({ memV: 9 }));
  assert.equal(o.action, "chip", "a value-2 answer is now a chip");
  // already read rows are not counted twice
  assert.equal(s.feedback(lines.join("\n")), 0);
  const s2 = sched();
  s2.tick(T0, 1);
  const a = shown(s2.offer(mom({ tag: "ANS", turnId: 1, lineAt: T0 }), meta()));
  s2.feedback(`${JSON.stringify({ cardId: a.id, rating: "useful" })}\n`);
  assert.deepEqual(s2.tagBoost(), {});
});
test("parseTags reads both row shapes and skips junk, 'none' and unknown ratings", () => {
  const t = [
    '{"cardId":"a","rating":"useful"}',
    '{"cardId":"b","rating":"not_useful"}',
    '{"cardId":"c","rating":"none"}',
    '{"id":"d","useful":"y"}',
    '{"id":"e","useful":"n"}',
    "not json",
    "42",
    '{"rating":"useful"}',
  ].join("\n");
  assert.deepEqual(parseTags(t), [
    { id: "a", rating: "useful" },
    { id: "b", rating: "not-useful" },
    { id: "d", rating: "useful" },
    { id: "e", rating: "not-useful" },
  ]);
});
test("kindOfBadge matches the overlay rule", () => {
  assert.deepEqual(["careful", "fix", "ai", "bank", "info", "tip", "me", "stall"].map(kindOfBadge), [
    "check",
    "check",
    "answer",
    "answer",
    "fact",
    "prompt",
    "answer",
    "answer",
  ]);
});

// ---------------------------------------------------------------- digit guards
test("digits: any script, separators and decimals", () => {
  assert.equal(asciiDigits("٤٥ and ۱۲ and １２"), "45 and 12 and 12");
  assert.deepEqual(numbersIn("1,500 or 1.500 or 4.5 or 0042"), ["1500", "1500", "4.5", "42"]);
  assert.deepEqual(numbersIn("אלף ו-250 שקל, ב-3.5%"), ["250", "3.5"]);
});
test("unsupportedNumbers: only numbers the call never said; one digit is not counted", () => {
  assert.deepEqual(unsupportedNumbers("We can do 20 or 35 of them in 3 steps", "she said 35 pages"), ["20"]);
  assert.deepEqual(unsupportedNumbers("הקמה תיקח 14 ימים", "אמרת שזה לוקח 14 ימים"), []);
  assert.deepEqual(unsupportedNumbers("הקמה תיקח 14 ימים", ""), ["14"]);
});
test("guardDigits: an invented figure or a currency/percent sign the call did not have is a hit; in any language", () => {
  assert.deepEqual(guardDigits("It costs 500", "they asked what it costs"), { ok: false, rule: "number" });
  assert.deepEqual(guardDigits("It costs $50", "they said 50"), { ok: false, rule: "number" }, "a currency sign the call did not use");
  assert.deepEqual(guardDigits("זה עולה 500", ""), { ok: false, rule: "number" });
  assert.deepEqual(guardDigits("Ask what the budget is", ""), { ok: true });
  assert.deepEqual(guardDigits("Their budget is 40000", "budget 40,000"), { ok: true });
  assert.ok(FIGURE.test("20%") && FIGURE.test("₪ 300") && FIGURE.test("100€") && !FIGURE.test("20 people"));
});
test("the follow-up email: a sentence with a number nobody said becomes a placeholder; a figure from the call stays", () => {
  const email = "Hi,\nThank you for the call. We can serve 77 users. The storage you asked about is 500 GB.";
  const r = guardEmail(email, "", "en", "they asked about 500 GB of storage");
  assert.doesNotMatch(r.text, /77/);
  assert.match(r.text, /fill in/);
  assert.match(r.text, /500 GB/);
  assert.ok(r.rules.includes("number"));
  // without figures the old behaviour is unchanged
  assert.equal(guardEmail(email, undefined, "en").replaced, 0);
});

test("review: numbersIn reads mixed separators and keeps plain decimals", async () => {
  const { numbersIn, unsupportedNumbers } = await import("./guards.ts");
  assert.deepEqual(numbersIn("12,345.67 and 12.345,67"), ["12345.67", "12345.67"]);
  assert.deepEqual(numbersIn("1,500 4.5 4,5 007"), ["1500", "4.5", "4.5", "7"]);
  assert.deepEqual(unsupportedNumbers("it costs 12,345.67", "we said 12.345,67 before"), []);
});
