// scripts/replay.ts: re-run an events.jsonl through the moment role with the policy fake, print kept / new / gone cards, export "not useful" cards as cases.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffCards, echoRegistry, formatDiff, main, readCall, replayCall, toCases, linesToAsk } from "../scripts/replay.ts";
import { MOMENT_RULES } from "./moments/prompt.ts";
import { replyFor } from "../qa/judge-set.ts";
import { policyModel } from "./testkit/policy-model.ts";
import { denylistHits } from "../qa/denylist.ts";
import { JudgeCaseSchema } from "../qa/judge-set.ts";

const FIX = join(import.meta.dirname, "testkit", "fixtures", "replay-call");
const call = readCall(FIX);

test("readCall: final lines, the cards that were shown (not the hidden one), and the ratings", () => {
  assert.equal(call.lines.length, 14);
  assert.equal(call.cards.length, 4);
  assert.deepEqual(
    call.cards.map((c) => [c.tag, c.line, c.rating]),
    [
      ["ANS", 2, "y"],
      ["ANS", 6, "y"],
      ["PROMPT", 11, "n"],
      ["TERM", 13, "y"],
    ],
  );
  assert.deepEqual(readCall(join(FIX, "events.jsonl")).cards.length, 4, "a path to events.jsonl works too");
});

test("the policy fake repeats the call: nothing is new, nothing is gone", async () => {
  const r = await replayCall(call, { registry: echoRegistry(call, MOMENT_RULES) });
  assert.equal(r.errors, 0);
  const d = diffCards(call.cards, r.cards);
  assert.equal(d.kept.length, 4);
  assert.equal(d.added.length, 0);
  assert.equal(d.gone.length, 0);
  assert.ok(r.asked >= 8 && r.asked < call.lines.length + 1, "the other side's lines are asked");
  assert.ok(!linesToAsk(call).includes(1), "the user's own lines without a card are not asked");
});

test("another model behaviour shows as kept, new and gone", async () => {
  // A model that drops the card on line 6, adds one on line 8, changes the kind on line 2 and keeps the one on line 13.
  const pm = policyModel({ strict: false, defaultText: "SKIP" });
  const on = (text: string) => (v: { user: string }) => v.user.endsWith(`<trigger>${text}</trigger>`);
  pm.reply(on("How long does an installation take?"), replyFor("REPLY", "Offer one day."), { ms: 1 });
  pm.reply(on("Do you also provide toner?"), replyFor("ANS", "Toner is included."), { ms: 1 });
  pm.reply(on("Send me the offer by Thursday, please."), replyFor("TERM", "Offer owed by Thursday."), { ms: 1 });
  const r = await replayCall(call, { registry: { resolve: async () => pm.model } });
  const d = diffCards(call.cards, r.cards);
  assert.deepEqual(
    d.kept.map((k) => [k.line, k.was, k.now]),
    [
      [2, "ANS", "REPLY"],
      [13, "TERM", "TERM"],
    ],
  );
  assert.deepEqual(
    d.added.map((a) => a.line),
    [8],
  );
  assert.deepEqual(
    d.gone.map((g) => g.line).sort((a, b) => a - b),
    [6, 11],
  );
  const text = formatDiff(call, r, d, r.cards);
  assert.match(text, /kept 2 \(1 with another kind\), new 1, gone 2/);
  assert.match(text, /^\s+gone\s+l12 PROMPT \(you rated it not useful\)/m);
});

test("pnpm replay prints the counts and the three lists, and a prompt file changes the prompt that is sent", async () => {
  const out: string[] = [];
  assert.equal(await main([FIX], { log: (l) => out.push(l) }), 0);
  const text = out.join("\n");
  assert.match(text, /Replay of replay-call: 14 lines/);
  assert.match(text, /kept 4 \(0 with another kind\), new 0, gone 0/);
  assert.match(text, /^\s+kept\s+l3 ANS/m);
  // a prompt file: the echo registry is built for it, so the diff stays empty, and the rules in the prompt are the file's
  const dir = mkdtempSync(join(tmpdir(), "wingman-replay-"));
  try {
    const pf = join(dir, "prompt.txt");
    writeFileSync(pf, "You are Wingman. Reply SKIP unless asked.");
    const out2: string[] = [];
    assert.equal(await main([FIX, "--prompt", pf], { log: (l) => out2.push(l) }), 0);
    assert.match(out2.join("\n"), /prompt .*prompt\.txt/);
    assert.equal(await main([FIX, "--prompt", join(dir, "nope.txt")], { log: () => {} }), 2);
    assert.equal(await main(["/no/such/call"], { log: () => {} }), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--to-case: a card rated not useful becomes a judgement case that passes the schema and the no-real-names check", () => {
  const { cases, refused } = toCases(call);
  assert.equal(refused.length, 0);
  assert.equal(cases.length, 1);
  const c = cases[0];
  assert.doesNotThrow(() => JudgeCaseSchema.parse(c));
  assert.equal(c.expected.tag, "SKIP");
  assert.equal(c.lines.at(-1)!.text, "The weather is awful today.");
  assert.ok(c.lines.length <= 6);
  assert.deepEqual(denylistHits(JSON.stringify(c)), []);
});

test("--to-case masks e-mail and phone, and refuses a case with a denylisted name", () => {
  const dir = mkdtempSync(join(tmpdir(), "wingman-replay-"));
  try {
    cpSync(FIX, dir, { recursive: true });
    const ev = readFileSync(join(dir, "events.jsonl"), "utf8").replace(
      "The weather is awful today.",
      "Write to dana@example.com or call 054-1234567 about it.",
    );
    writeFileSync(join(dir, "events.jsonl"), ev);
    const masked = toCases(readCall(dir));
    assert.equal(masked.cases.length, 1);
    assert.match(JSON.stringify(masked.cases[0]), /\[email\]/);
    assert.match(JSON.stringify(masked.cases[0]), /\[phone\]/);
    assert.deepEqual(denylistHits(JSON.stringify(masked.cases[0])), []);
    // a word from the no-real-names list in the lines: the case is refused and no file is written
    const bad = ev.replace("Write to dana@example.com", "Our contact at " + "goo" + "gle says");
    writeFileSync(join(dir, "events.jsonl"), bad);
    const r = toCases(readCall(dir));
    assert.equal(r.cases.length, 0);
    assert.equal(r.refused.length, 1);
    assert.match(r.refused[0].why.join(), /goo/);
    const out = join(dir, "cases");
    const logs: string[] = [];
    return main([dir, "--to-case", "--out", out], { log: (l) => logs.push(l) })
      .then((code) => {
        assert.equal(code, 0);
        assert.match(logs.join("\n"), /0 case\(s\) written/);
        assert.match(logs.join("\n"), /not written: card c3/);
        assert.deepEqual(readdirSync(out), []);
      })
      .finally(() => rmSync(dir, { recursive: true, force: true }));
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
});
