// Moments precision, through the real engine (in process, virtual clock, policy fake model): a card text that fits by construction (one retry for an
// observer card, a clause cut for a direct card), confidence chips, labels with a fallback that never uses the first words, the "fewer" rating, and learning across calls.
// No real model, no network, no real time.
import "../test-setup.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupEngine, type Engine } from "../testkit/engine-inproc.ts";
import { _dropLearnCache, LEARN_FILE, noteCallEnd, resetLearning } from "../moments/learn.ts";

let e: Engine;
before(async () => {
  e = await setupEngine();
});
after(() => {
  resetLearning();
  return e?.stop();
});

const words = (s: unknown) =>
  String(s ?? "")
    .split(/\s+/)
    .filter(Boolean).length;
const reply = (tag: string, say: string, value = 3, aim = "me", extra: string[] = []) =>
  [tag, `VALUE: ${value}`, `AIM: ${aim}`, ...extra.filter((x) => /^CONF/.test(x)), `SAY: ${say}`, ...extra.filter((x) => !/^CONF/.test(x)), "WHY: test"].join(
    "\n",
  );
const calls = (role: string) => e.pm.callsFor(role);
const events = () =>
  readFileSync(e.boot.log.dir + "/events.jsonl", "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const LONG = "Tell them the rollout needs three steps, the first is the content freeze, then the build and finally the review with the whole team on Friday";
const SHORT = "Tell them the rollout needs three steps";

// ---------------------------------------------------------------- fit by construction
test("an over-long observer card gets exactly one retry with a 'shorter' instruction; the long first reply is never shown", async () => {
  await e.reset();
  e.pm.reply({ role: "observer", lastLine: "really slow" }, reply("REPLY", LONG, 3, "me", ["LABEL: Rollout steps"]), { ms: 200, times: 1 });
  e.pm.reply({ role: "observer", lastLine: "really slow" }, reply("REPLY", SHORT, 3, "me", ["LABEL: Rollout steps"]), { ms: 200 });
  e.say("them", "Your site feels really slow to us.");
  await e.vc.advance(5000);
  const obs = calls("observer");
  assert.equal(obs.length, 2, "one call and exactly one retry");
  assert.ok(!obs[0].view.system.includes("Your SAY was over"), "the first call has no retry text");
  assert.ok(obs[1].view.system.includes("Your SAY was over 12 words"), "the retry carries the shorter instruction");
  const cards = e.screen().filter((c) => c.kind === "prompt");
  assert.equal(cards.length, 1, JSON.stringify(e.screen()));
  assert.equal(cards[0].say, SHORT);
  assert.equal(cards[0].fit, undefined, "the retry fit, nothing was cut");
  assert.ok(!e.screen().some((c) => String(c.say).includes("review with the whole team")), "the long text never reached the screen");
  assert.ok(events().some((x) => x.type === "moment.retry"));
  assert.equal(e.boot.log.dir.length > 0, true);
});

test("when the retry is still too long there is no second retry: the card is cut at a clause end, fit is false, the rest is in more", async () => {
  await e.reset();
  e.pm.reply({ role: "observer", lastLine: "really slow" }, reply("REPLY", LONG, 3, "me", ["LABEL: Rollout steps"]), { ms: 200 });
  e.say("them", "Your site feels really slow to us.");
  await e.vc.advance(6000);
  assert.equal(calls("observer").length, 2, "never more than one retry");
  const card = e.screen().find((c) => c.kind === "prompt");
  assert.ok(card, JSON.stringify(e.screen()));
  assert.equal(card.fit, false);
  assert.ok(words(card.say) <= 14, String(card.say));
  assert.ok(!/…|\.\.\./.test(String(card.say)));
  assert.equal(card.say, "Tell them the rollout needs three steps, the first is the content freeze");
});

test("when the retry fails (the model is down) the first reply is shown, cut at a clause end", async () => {
  await e.reset();
  e.pm.reply({ role: "observer", lastLine: "really slow" }, reply("REPLY", LONG, 3, "me", ["LABEL: Rollout steps"]), { ms: 200, times: 1 });
  e.pm.on({ role: "observer", lastLine: "really slow" }, (await import("../testkit/policy-model.ts")).error(529));
  e.say("them", "Your site feels really slow to us.");
  await e.vc.advance(8000);
  const card = e.screen().find((c) => c.kind === "prompt");
  assert.ok(card, JSON.stringify(e.screen()));
  assert.equal(card.fit, false);
  assert.ok(words(card.say) <= 14);
});

test("an over-long direct card is not retried: it is cut at a clause end, fit is false, and the rest is the first line of more", async () => {
  await e.reset();
  e.pm.reply(
    { role: "moment", lastLine: "old reporting tool" },
    reply("ANS", "The old tool keeps running during the move, but the new one needs the audit result and a sign off from your team lead", 3, "me", [
      "LABEL: Reports move",
    ]),
    { ms: 300 },
  );
  e.say("them", "Why would you not simply keep the old reporting tool?");
  await e.vc.advance(3000);
  assert.equal(calls("moment").length, 1, "no retry on the direct path");
  const card = e.screen().find((c) => c.kind === "answer");
  assert.ok(card, JSON.stringify(e.screen()));
  assert.equal(card.fit, false);
  assert.equal(card.say, "The old tool keeps running during the move");
  assert.ok(String((card.more as string[])[0]).startsWith("but the new one needs"), JSON.stringify(card.more));
  assert.ok(!/…|\.\.\./.test(String(card.say)));
});

// ---------------------------------------------------------------- confidence chips
test("CONF low is a chip and does not take the hero; a VALUE 1 card is a chip too; both keep their text", async () => {
  await e.reset();
  e.pm.reply({ role: "moment", lastLine: /which plan/i }, reply("ANS", "The business plan is the usual choice", 3, "me", ["LABEL: Plan choice"]), { ms: 300 });
  e.say("them", "Which plan would you pick for us?");
  await e.vc.advance(2000);
  const hero = e.screen().find((c) => c.kind === "answer");
  assert.ok(hero && !hero.chip && !hero.dim, JSON.stringify(e.screen()));
  await e.vc.advance(70_000);
  e.pm.reply({ role: "moment", lastLine: /which region/i }, reply("ANS", "Probably the Frankfurt region", 3, "me", ["CONF: low", "LABEL: Region guess"]), {
    ms: 300,
  });
  e.say("them", "Which region will you host in?");
  await e.vc.advance(2000);
  const low = e.screen().find((c) => /Frankfurt/.test(String(c.say)));
  assert.ok(low, JSON.stringify(e.screen()));
  assert.ok(low.chip || low.dim, "a guess is a small chip (the live path marks it dim)");
  assert.equal(low.conf, "low");
  assert.notEqual(e.st.m.sched.hero?.id, low.id, "the chip did not become the hero");
  assert.ok(events().some((x) => x.type === "moment.chip" && x.why === "low-confidence"));
  await e.vc.advance(70_000);
  e.pm.reply({ role: "moment", lastLine: /invoice address/i }, reply("ANS", "Use the address on the contract", 1, "me", ["LABEL: Invoice address"]), {
    ms: 300,
  });
  e.say("them", "Where should we send the invoice address?");
  await e.vc.advance(2000);
  const one = e.screen().find((c) => /address on the contract/.test(String(c.say)));
  assert.ok(one && (one.chip || one.dim), JSON.stringify(e.screen()));
});

// ---------------------------------------------------------------- labels, about, val
test("label: the model's LABEL and ABOUT are kept; a fact card shows the value of its memory number; with no label the memory topic is used, never the first words", async () => {
  await e.reset();
  e.st.m.mem = {
    ...e.st.m.mem,
    topic: { now: "Shop launch", history: [] },
    numbers: [{ id: "n1", what: "PHP version", value: "PHP 8.1 on the server", at: 1 }],
  };
  e.pm.reply(
    { role: "observer", lastLine: /runs on php/i },
    reply("NOTE", "The shop runs on PHP 8.1 today", 2, "me", ["LABEL: PHP version", "ABOUT: which PHP version runs the shop", "REF: n1"]),
    { ms: 200 },
  );
  e.say("them", "Our shop runs on PHP right now, I think.");
  await e.vc.advance(4000);
  const note = e.screen().find((c) => c.kind === "fact");
  assert.ok(note, JSON.stringify(e.screen()));
  assert.equal(note.label, "PHP version");
  assert.equal(note.about, "which PHP version runs the shop");
  assert.equal(note.val, "PHP 8.1 on the", "four words of the memory number");

  await e.reset();
  e.st.m.mem = { ...e.st.m.mem, topic: { now: "Shop launch", history: [] } };
  e.pm.reply({ role: "moment", lastLine: /which plan/i }, "ANS\nVALUE: 3\nAIM: me\nSAY: The business plan is the usual choice\nWHY: asked", { ms: 300 });
  e.say("them", "Which plan would you pick for us?");
  await e.vc.advance(2000);
  const nolabel = e.screen().find((c) => c.kind === "answer");
  assert.ok(nolabel, JSON.stringify(e.screen()));
  assert.equal(nolabel.label, "Shop launch", "memory topic");
  assert.notEqual(nolabel.label, "The business plan");

  await e.reset();
  e.st.m.mem = { ...e.st.m.mem, topic: { now: "", history: [] } };
  e.pm.reply({ role: "moment", lastLine: /which plan/i }, "ANS\nVALUE: 3\nAIM: me\nSAY: The business plan is the usual choice\nWHY: asked", { ms: 300 });
  e.say("them", "Which plan would you pick for us?");
  await e.vc.advance(2000);
  const none = e.screen().find((c) => c.kind === "answer");
  assert.ok(none, JSON.stringify(e.screen()));
  assert.equal(none.label, undefined, "no label at all rather than the first words");
});

// ---------------------------------------------------------------- the fewer rating
test("a 'fewer' row in tags.jsonl raises that tag's minimum VALUE at once; value 2 is then a chip and value 3 still shows", async () => {
  await e.reset();
  e.pm.reply({ role: "moment", lastLine: /which plan/i }, reply("ANS", "The business plan is the usual choice", 2, "me", ["LABEL: Plan choice"]), { ms: 300 });
  e.say("them", "Which plan would you pick for us?");
  await e.vc.advance(2000);
  const card = e.screen().find((c) => c.kind === "answer");
  assert.ok(card && !card.chip && !card.dim, "a value 2 answer shows before the rating");
  const row = { id: card.id, cardId: card.id, useful: "n", rating: "fewer", badge: "ai" };
  writeFileSync(e.boot.log.dir + "/tags.jsonl", JSON.stringify(row) + "\n");
  assert.equal(e.moments.applyFeedback([row]), 1);
  assert.equal(e.st.m.sched.boost.ANS, 3, "up by one at once, after a single rating");
  await e.vc.advance(130_000);
  e.pm.reply({ role: "moment", lastLine: /which region/i }, reply("ANS", "Frankfurt is the nearest region", 2, "me", ["LABEL: Region"]), { ms: 300 });
  e.say("them", "Which region will you host in?");
  await e.vc.advance(2000);
  const again = e.screen().find((c) => /Frankfurt/.test(String(c.say)));
  assert.ok(!again || again.chip || again.dim, "a value 2 answer is now small");
  await e.vc.advance(130_000);
  e.pm.reply({ role: "moment", lastLine: /which backups/i }, reply("ANS", "Backups run every night at two", 3, "me", ["LABEL: Backups"]), { ms: 300 });
  e.say("them", "Which backups do you keep for us?");
  await e.vc.advance(2000);
  const strong = e.screen().find((c) => /Backups run every night/.test(String(c.say)));
  assert.ok(strong && !strong.chip && !strong.dim, "a value 3 answer still shows");
});

// ---------------------------------------------------------------- learning across calls
test("learning: ratings of one call reach learn.json at the end of the call; after 3 negatives over 2 calls the next call starts one step higher", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-learn-e2e-"));
  const file = join(dir, "learn.json");
  resetLearning(file);
  // two earlier calls with negative ratings for REPLY (3 in all)
  noteCallEnd({ REPLY: 2 }, file);
  noteCallEnd({ REPLY: 1 }, file);
  // the engine reads the default file; point it at the same data by writing the same content there
  writeFileSync(LEARN_FILE, readFileSync(file, "utf8"), { mode: 0o600 });
  _dropLearnCache();
  await e.reset();
  e.pm.reply({ role: "observer", lastLine: "really slow" }, reply("REPLY", "Ask what they measure today", 2, "me", ["LABEL: Speed"]), { ms: 200 });
  e.say("them", "Your site feels really slow to us.");
  await e.vc.advance(4000);
  const card = e.screen().find((c) => /measure today/.test(String(c.say)));
  assert.ok(!card || card.chip || card.dim, `REPLY value 2 is a chip for this user now: ${JSON.stringify(e.screen())}`);
  assert.deepEqual(e.st.m.sched.learn, { REPLY: 1 });
  resetLearning();
  _dropLearnCache();
});

test("learning: ending a call writes the negative ratings of the call (counts, no text) to learn.json", async () => {
  resetLearning();
  _dropLearnCache();
  await e.reset();
  e.pm.reply({ role: "moment", lastLine: /which plan/i }, reply("ANS", "The business plan is the usual choice", 3, "me", ["LABEL: Plan choice"]), { ms: 300 });
  e.say("them", "Which plan would you pick for us?");
  await e.vc.advance(2000);
  const card = e.screen().find((c) => c.kind === "answer")!;
  writeFileSync(e.boot.log.dir + "/tags.jsonl", JSON.stringify({ id: card.id, cardId: card.id, useful: "n", rating: "not_useful" }) + "\n");
  e.moments.endCallLearning();
  const j = JSON.parse(readFileSync(LEARN_FILE, "utf8"));
  assert.equal(j.calls, 1);
  assert.equal(j.tags.ANS.neg, 1);
  assert.ok(!readFileSync(LEARN_FILE, "utf8").includes("business plan"), "no card text in the file");
  e.moments.endCallLearning(); // a second call of the same end does nothing
  assert.equal(JSON.parse(readFileSync(LEARN_FILE, "utf8")).calls, 1);
  resetLearning();
  _dropLearnCache();
});
