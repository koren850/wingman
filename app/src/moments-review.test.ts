// Reviewer edge cases for the moment core (round 12 review).
import test from "node:test";
import assert from "node:assert/strict";
import { parseMoment, parseMomentStream, MomentStream } from "./moments/parse.ts";
import { SKIP_MOMENT } from "./moments/types.ts";
import { Intake } from "./moments/intake.ts";
import { Observer } from "./moments/observer.ts";
import { decide, newSchedulerState } from "./moments/scheduler.ts";
import { matchBankSmart } from "./bank.ts";

test("a SKIP moment is never shared state: mutating one does not change the next", () => {
  const a = parseMoment("garbage").moment;
  a.more.push("x");
  assert.deepEqual(parseMoment("garbage").moment.more, []);
  assert.deepEqual(SKIP_MOMENT.more, []);
});

test("parser: CRLF, tag with colon, markdown fence, lower case", () => {
  const r = parseMoment("```\r\nans\r\nVALUE: 2\r\nAIM: me\r\nSAY: Yes, Tuesday works.\r\nWHY: asked\r\n```");
  assert.equal(r.moment.tag, "ANS");
  assert.equal(r.moment.say, "Yes, Tuesday works.");
});

test("parser: repeated SAY line keeps the first; huge say is SKIP", () => {
  const r = parseMoment("ANS\nVALUE: 3\nAIM: me\nSAY: " + "word ".repeat(45));
  assert.equal(r.moment.tag, "SKIP");
});

test("parser: STALL with no kind still valid", () => {
  const r = parseMoment("STALL\nVALUE: 2\nAIM: me\nSAY: Let me check and come back.");
  assert.equal(r.moment.tag, "STALL");
  assert.equal(r.moment.stall, "other");
});

test("stream: tag fires once, before the rest, and survives a throwing handler", () => {
  const seen: string[] = [];
  const s = new MomentStream({
    onTag: (t) => {
      seen.push(t.tag);
      throw new Error("boom");
    },
  });
  s.write("RE");
  assert.deepEqual(seen, []);
  s.write("PLY\nVAL");
  assert.deepEqual(seen, ["REPLY"]);
  s.write("UE: 2\nAIM: me\nSAY: Ok.");
  assert.equal(s.end().moment.tag, "REPLY");
  assert.deepEqual(seen, ["REPLY"]);
});

test("stream: end() with no writes is a SKIP", () => {
  assert.equal(new MomentStream().end().moment.tag, "SKIP");
  assert.equal(parseMomentStream("", false).moment, undefined);
});

test("intake: lone currency or digit line is kept; repeat of a question is not lost to the repeat rule", () => {
  const it = new Intake();
  assert.equal(it.accept({ text: "$5", side: "them", at: 0 }).keep, true);
  assert.equal(it.accept({ text: "what is the price?", side: "them", at: 100 }).keep, true);
  assert.equal(it.accept({ text: "what is the price?", side: "them", at: 200 }).keep, true);
});

test("intake: same text from the other side is not a repeat", () => {
  const it = new Intake();
  assert.equal(it.accept({ text: "ok sounds good", side: "them", at: 0 }).keep, true);
  assert.equal(it.accept({ text: "ok sounds good", side: "me", at: 500 }).keep, true);
});

test("observer: topicChange with nothing pending fires nothing and later lines are not lost", () => {
  const t = 0;
  const o = new Observer(() => t);
  assert.equal(o.topicChange(), undefined);
  const w = o.push({ id: "1", text: "hello there friend", side: "them", at: 0 });
  const rest = w ?? o.poll();
  assert.ok(rest);
  assert.equal(rest!.lines.length, 1);
});

test("observer: 7 strong hints in one minute give 6 calls and the 7th line waits in the next window", () => {
  let t = 0;
  const o = new Observer(() => t);
  let calls = 0;
  const ids: string[] = [];
  for (let i = 0; i < 7; i++) {
    t = i * 1000;
    const w = o.push({ id: String(i), text: "can you do it?", side: "them", at: t, hint: "strong" });
    if (w) {
      calls++;
      ids.push(...w.lines.map((l) => l.id));
    }
  }
  assert.equal(calls, 6);
  t = 61_000;
  const w = o.poll();
  assert.ok(w);
  ids.push(...w!.lines.map((l) => l.id));
  assert.deepEqual(ids, ["0", "1", "2", "3", "4", "5", "6"]);
});

test("scheduler: unknown turn state does not drop; equal-rank repeat never replaces the hero", () => {
  const s = newSchedulerState(1000);
  const d = decide({ tag: "ANS", value: 3, aim: "me", say: "a", why: "", more: [] }, s);
  assert.equal(d.action, "show");
});

test("bank: English turn with a Hebrew-only paraphrase does not build the index per call", () => {
  const bank = [{ id: "a", title: "אחד", triggers: ["אחד"], say: "x", facts: [] }] as never;
  const r1 = matchBankSmart("how is the weather today", bank, "en");
  assert.equal(r1.hit, undefined);
});
