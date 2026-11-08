// Round 2 moments core, in-process on the virtual clock and the policy fake model: live reading is the default, the neutral speed hint and the observer
// triggers (cue, topic, question then silence), the practice-interview mode, one scheduler with feedback from tags.jsonl, labels and checks.
// No real model, no network, no real time: the virtual clock moves the timers.
import "../test-setup.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { setupEngine, type Engine } from "../testkit/engine-inproc.ts";

let e: Engine;
before(async () => {
  e = await setupEngine();
});
after(() => e?.stop());

const events = () =>
  readFileSync(e.boot.log.dir + "/events.jsonl", "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const reply = (tag: string, say: string, value = 3, aim = "me", extra = "") =>
  `${tag}\nVALUE: ${value}\nAIM: ${aim}\nSAY: ${say}\n${extra ? extra + "\n" : ""}WHY: test`;
const calls = (role: string) => e.pm.callsFor(role);

// ---------------------------------------------------------------- the default
test("a fresh default configuration runs live reading (v2)", async () => {
  const { loadSettings } = await import("../settings.ts");
  const { settings } = loadSettings({ env: {}, userFile: "/nonexistent/wingman-r2-settings.yaml" });
  assert.equal(settings.moments.engine, "v2");
  assert.equal(e.boot.momentsV2, true);
  assert.equal((await import("../engine/degrade.ts")).v2Active(), true);
});

// ---------------------------------------------------------------- speed hint on the hot path
test("a Hebrew question with no question mark and no full stop is read as fast: the card is up inside the latency budget", async () => {
  await e.reset();
  e.pm.reply({ role: "moment", lastLine: "חודשיים" }, reply("ANS", "המנהלת של צוות הנתונים אחראית עליהם"), { ms: 850 });
  const at = e.say("them", "מי אחראי על הדוחות החודשיים");
  await e.vc.advance(3000);
  const card = e.screen().find((c) => c.kind === "answer");
  assert.ok(card, JSON.stringify(e.screen()));
  const ms = e.firstCardMs(at)!;
  assert.ok(ms <= 1500, `first card after ${ms} ms`);
  assert.equal(calls("moment").length, 1, "the direct path, not the observer");
  assert.ok(events().some((x) => x.type === "detect" && x.via === "speed-hint"));
});

test("the same question ending in a full stop (a Hebrew question the speech-to-text did not mark) reaches the model through the observer within 2.5 s", async () => {
  await e.reset();
  e.pm.reply({ role: "observer", lastLine: "חודשיים" }, reply("ANS", "המנהלת של צוות הנתונים אחראית עליהם"), { ms: 850 });
  const at = e.say("them", "מי אחראי על הדוחות החודשיים.");
  await e.vc.advance(3500);
  assert.ok(
    e.screen().some((c) => c.kind === "answer"),
    JSON.stringify(e.screen()),
  );
  assert.ok(e.firstCardMs(at)! <= 2500, `first card after ${e.firstCardMs(at)} ms`);
  assert.equal(calls("moment").length, 0);
  assert.equal(calls("observer").length, 1);
});

test("the legacy question detector is not on the live-reading hot path", async () => {
  await e.reset();
  const det = await import("../detector.ts");
  // The detector module is imported by other code, so we check the events: no `detect` row from the old rules is written for a normal line.
  e.say("them", "We moved the whole team to the new office last spring and it was quite a project.");
  await e.vc.advance(1500);
  assert.ok(typeof det.detect === "function");
  assert.ok(
    !events()
      .slice(-20)
      .some((x) => x.type === "detect" && x.text?.startsWith("We moved")),
    "no detect row for a plain statement",
  );
});

// ---------------------------------------------------------------- observer triggers
test("a short objection with no hint triggers an observer call from the reserved budget", async () => {
  await e.reset();
  e.pm.reply({ role: "observer", lastLine: "איטי" }, reply("REPLY", "שאל מה הם מודדים כרגע", 3, "me", "LABEL: מהירות האתר"), { ms: 400 });
  const at = e.say("them", "האתר שלכם איטי מאוד.");
  await e.vc.advance(2500);
  assert.equal(calls("observer").length, 1);
  const card = e.screen().find((c) => c.kind === "prompt");
  assert.ok(card, JSON.stringify(e.screen()));
  assert.equal(card.label, "מהירות האתר");
  assert.ok(e.firstCardMs(at)! <= 1500);
});

test("a short line with a figure triggers a call; a short line of small talk does not", async () => {
  await e.reset();
  e.pm.reply({ role: "observer" }, "SKIP\nWHY: nothing needed", { ms: 100 });
  e.boot.speakers.number(1);
  e.boot.speakers.number(2); // a group call: a short line is not aimed at the user unless it says the name
  e.say("them", "OK sounds good.");
  e.say("them", "Nice weather today.");
  await e.vc.advance(3000);
  assert.equal(calls("observer").length, 0, "small talk is kept for the window but starts nothing");
  e.say("them", "It is 4 percent.");
  await e.vc.advance(1500);
  assert.equal(calls("observer").length, 1);
});

test("a question to the user and 2 s of silence make a look when the direct call showed nothing; an answer in time cancels it", async () => {
  await e.reset();
  e.pm.reply({ role: "moment" }, "SKIP\nWHY: nothing to add", { ms: 300 });
  e.pm.reply({ role: "observer" }, reply("PROMPT", "Mention the security review now", 2), { ms: 300 });
  e.say("them", "Is everything clear so far?");
  await e.vc.advance(1900);
  assert.equal(calls("observer").length, 0, "not before 2 s");
  await e.vc.advance(400);
  assert.equal(calls("observer").length, 1, "after 2 s of silence");
  assert.equal(calls("observer")[0].view.messages.join("\n").includes("Is everything clear so far?"), true);
  await e.reset();
  e.say("them", "Is everything clear so far?");
  await e.vc.advance(800);
  e.say("me", "Yes, all clear from my side.");
  await e.vc.advance(5000);
  assert.equal(calls("observer").length, 0, "the user answered: no silence look");
});

test("no silence look when the direct call already showed a card", async () => {
  await e.reset();
  e.pm.reply({ role: "moment" }, reply("ANS", "Both Postgres and MySQL work"), { ms: 300 });
  e.say("them", "Which databases are supported?");
  await e.vc.advance(5000);
  assert.equal(e.screen().length, 1);
  assert.equal(calls("observer").length, 0);
  assert.ok(events().some((x) => x.type === "moment.observer-drop" && x.why === "answered"));
});

test("no silence look while a slow direct call is still on its way", async () => {
  await e.reset();
  e.pm.reply({ role: "moment" }, reply("ANS", "Both Postgres and MySQL work"), { ms: 3500 });
  e.say("them", "Which databases are supported?");
  await e.vc.advance(2600);
  assert.equal(calls("observer").length, 0, "the direct call has not answered yet");
  assert.ok(events().some((x) => x.type === "moment.observer-drop" && x.why === "answering"));
  await e.vc.advance(3000);
  assert.equal(e.screen().length, 1);
  assert.equal(calls("observer").length, 0);
});

test("a topic label change fires an observer window now (virtual clock)", async () => {
  await e.reset();
  e.pm.reply({ role: "observer" }, reply("NOTE", "New topic: the rollout plan", 3), { ms: 200 });
  e.say("them", "OK, so next.");
  await e.vc.advance(300);
  assert.equal(calls("observer").length, 0);
  e.st.m.mem = { ...e.st.m.mem, ver: e.st.m.mem.ver + 1, topic: { now: "rollout plan", history: [{ label: "pricing", from: Date.now() }] } };
  e.moments.topicChanged();
  await e.vc.advance(1000);
  assert.equal(calls("observer").length, 1);
  assert.equal(calls("observer")[0].view.messages.join("\n").includes("OK, so next."), true);
  assert.ok(e.screen().some((c) => /rollout plan/.test(String(c.say))));
});

test("never more than 6 observer calls in any minute, with cues, long lines and topic changes together", async () => {
  await e.reset();
  e.pm.reply({ role: "observer" }, "SKIP\nWHY: nothing needed", { ms: 100 });
  for (let i = 0; i < 90; i++) {
    const kind = i % 3;
    e.say(
      "them",
      kind === 0 ? `It costs ${100 + i} dollars.` : kind === 1 ? `We talked about the rollout plan for region number ${i} and the people involved` : "OK.",
    );
    if (i % 10 === 0) e.moments.topicChanged();
    await e.vc.advance(1500);
  }
  await e.vc.advance(3000);
  const times = calls("observer")
    .map((c) => c.at)
    .sort((a, b) => a - b);
  assert.ok(times.length >= 6);
  for (const t of times) assert.ok(times.filter((x) => x >= t && x < t + 60_000).length <= 6, "6 calls at most in a minute");
});

// ---------------------------------------------------------------- practice interview
test("practice interview: the call runs on v2 with the interview prompt; coaching cards show; a silent window stays silent", async () => {
  await e.reset();
  e.st.m.mem = { ...e.st.m.mem, kind: "interview" };
  e.pm.reply({ role: "moment" }, reply("ANS", "Start with the situation, then what you did", 2), { ms: 300 });
  e.say("them", "Tell me about a time you led a migration?");
  await e.vc.advance(1500);
  assert.equal(calls("moment").length, 1);
  assert.match(calls("moment")[0].view.system, /practice interview/);
  assert.match(calls("moment")[0].view.system, /answer is getting too long|too long/);
  assert.ok(e.screen().some((c) => /situation/.test(String(c.say))));
  // the user talks for a long time: one coaching look, and it can show a card
  e.pm.reply({ role: "observer" }, reply("NOTE", "This answer is long: give the result now", 2, "me", "LABEL: Answer length"), { ms: 300 });
  for (let i = 0; i < 8; i++) {
    e.say("me", `So what I did in step ${i} was to plan the whole move in many small steps with the team and then`);
    await e.vc.advance(1000);
  }
  await e.vc.advance(1500);
  assert.equal(calls("observer").length, 1, "one coaching look for the long answer");
  assert.match(calls("observer")[0].view.system, /practice interview/);
  const card = e.screen().find((c) => /long/.test(String(c.say)));
  assert.ok(card, JSON.stringify(e.screen()));
  assert.equal(card.label, "Answer length");
  // a short, good answer: SKIP stays silent
  await e.reset();
  e.st.m.mem = { ...e.st.m.mem, kind: "interview" };
  e.pm.reply({ role: "observer" }, "SKIP\nWHY: on track", { ms: 200 });
  e.say("me", "The result was a clean move with no downtime for the users.");
  await e.vc.advance(5000);
  assert.equal(e.screen().length, 0);
  e.st.m.mem = { ...e.st.m.mem, kind: "other" };
});

test("practice interview: an unanswered part of the question can be shown as a PROMPT; value 1 is enough there, not elsewhere", async () => {
  await e.reset();
  e.st.m.mem = { ...e.st.m.mem, kind: "interview" };
  e.pm.reply({ role: "observer" }, reply("PROMPT", "You have not said what the result was", 1), { ms: 200 });
  for (let i = 0; i < 6; i++) {
    e.say("me", `I organised the work ${i} and we split the tasks between the whole group of engineers`);
    await e.vc.advance(1000);
  }
  await e.vc.advance(2000);
  assert.ok(
    e.screen().some((c) => /result/.test(String(c.say)) && !c.chip),
    JSON.stringify(e.screen()),
  );
  await e.reset();
  e.st.m.mem = { ...e.st.m.mem, kind: "client" };
  e.pm.reply({ role: "observer" }, reply("PROMPT", "You have not said what the result was", 1), { ms: 200 });
  e.say("them", "We spoke about the rollout plan for the whole region and who owns it");
  await e.vc.advance(3000);
  const c = e.screen().find((x) => /result/.test(String(x.say)));
  assert.ok(!c || c.chip || c.dim, "a value 1 card is only a small chip in a normal call");
  e.st.m.mem = { ...e.st.m.mem, kind: "other" };
});

// ---------------------------------------------------------------- one scheduler and feedback
test("tags.jsonl rows reach the live scheduler; three 'not useful' on one kind raise the bar for direct, observer and open-loop cards", async () => {
  await e.reset();
  const line = (n: number) => `We talked about the rollout plan for region number ${n} and the people involved`;
  // three REPLY cards: two from the observer, one direct
  for (let i = 0; i < 2; i++) {
    e.pm.reply({ role: "observer", lastLine: line(i) }, reply("REPLY", `Ask what they compared us with ${i}`, 2), { ms: 100 });
    e.say("them", line(i));
    await e.vc.advance(130_000); // the novelty window and the per-minute cap pass
  }
  e.pm.reply({ role: "moment", lastLine: "old reporting tool" }, reply("REPLY", "Ask what is behind the question", 2), { ms: 100 });
  e.say("them", "Why would you not simply keep the old reporting tool?");
  await e.vc.advance(2000);
  const cards = e.screen().filter((c) => c.kind === "prompt");
  assert.equal(cards.length, 3, JSON.stringify(e.screen()));
  // the overlay wrote tags.jsonl: the whole file, one row per card
  const rows = cards.map((c) => ({ id: c.id, useful: "n", badge: "ai", cardId: c.id, rating: "not_useful" }));
  writeFileSync(e.boot.log.dir + "/tags.jsonl", rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const n = e.moments.applyFeedback(
    readFileSync(e.boot.log.dir + "/tags.jsonl", "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l)),
  );
  assert.equal(n, 3);
  assert.equal(e.moments.applyFeedback(rows), 0, "a replay changes nothing");
  assert.equal(e.st.m.sched.boost.REPLY, 3, "the REPLY bar is up");
  // observer REPLY with value 2: not a card now
  await e.vc.advance(130_000);
  e.pm.reply({ role: "observer", lastLine: "region number 99" }, reply("REPLY", "Ask about the budget owner", 2), { ms: 100 });
  e.say("them", line(99));
  await e.vc.advance(3000);
  assert.ok(!e.screen().some((c) => /budget owner/.test(String(c.say)) && !c.chip && !c.dim), JSON.stringify(e.screen()));
  // direct REPLY with value 2: same
  e.pm.reply({ role: "moment", lastLine: "next quarter" }, reply("REPLY", "Ask what budget they have", 2), { ms: 100 });
  e.say("them", "Why would you not simply wait until next quarter?");
  await e.vc.advance(3000);
  assert.ok(!e.screen().some((c) => /what budget/.test(String(c.say)) && !c.chip && !c.dim), JSON.stringify(e.screen()));
  // value 3 still shows
  await e.vc.advance(130_000);
  e.pm.reply({ role: "moment", lastLine: "end of the year" }, reply("REPLY", "Ask what blocks the decision", 3), { ms: 100 });
  e.say("them", "Why would you not simply wait for the end of the year?");
  await e.vc.advance(3000);
  assert.ok(e.screen().some((c) => /blocks the decision/.test(String(c.say))));
  // the open-loop path (emitMoment) reads the same state
  const cards2 = await import("../engine/cards.ts");
  cards2.emitMoment(
    { tag: "REPLY", value: 2, aim: "me", say: "Open loop reply", why: "w", more: [], source: "observer", lineAt: Date.now() },
    { memV: 1, question: "open loop" },
  );
  assert.ok(!e.screen().some((c) => c.say === "Open loop reply" && !c.chip), "the open-loop path sees the raised bar too");
});

// ---------------------------------------------------------------- labels, src and checks
test("a LABEL becomes the card label; a missing LABEL is fine; the source of a fact comes from its memory id", async () => {
  await e.reset();
  e.st.m.mem = { ...e.st.m.mem, ver: 3, facts: [{ id: "f1", text: "Contract ends in June", at: 1, src: "brief" }] };
  e.pm.reply(
    { role: "observer", lastLine: "hosting contract" },
    reply("TERM", "Notes say the contract ends in June", 3, "me", "LABEL: Hosting contract\nREF: f1"),
    { ms: 100 },
  );
  e.say("them", "What about the hosting contract and when does it run out for us");
  await e.vc.advance(3000);
  const card = e.screen().find((c) => c.kind === "fact");
  assert.ok(card, JSON.stringify(e.screen()));
  assert.equal(card.label, "Hosting contract");
  assert.equal(card.src, "brief");
  await e.reset();
  e.pm.reply({ role: "observer", lastLine: "daily backups" }, reply("NOTE", "They want daily backups", 3), { ms: 100 });
  e.say("them", "We need daily backups and a clear plan to restore everything in one hour");
  await e.vc.advance(3000);
  const c2 = e.screen().find((c) => c.kind === "fact");
  assert.ok(c2 && c2.label === undefined && c2.src === undefined);
  assert.ok(!events().some((x) => x.type === "moment.invalid"));
});

test("checks: at most 3 open, same ref merges, they close with the topic and after 5 minutes", async () => {
  await e.reset();
  const cards = await import("../engine/cards.ts");
  const check = (id: string, ref?: string) =>
    cards.emitCard({ id, turnId: "t", badge: "careful", kind: "check", question: "", say: `Check ${id}`, facts: [], at: Date.now(), ...(ref ? { ref } : {}) });
  const screen = () => e.screen().filter((c) => c.kind === "check" && !c.closes);
  check("k1", "c1");
  check("k2", "c2");
  check("k3", "c3");
  check("k4", "c4");
  assert.deepEqual(
    screen().map((c) => c.id),
    ["k2", "k3", "k4"],
    "the oldest closed when the fourth came",
  );
  assert.ok(e.rows.some((r) => r.id === "k1" && r.closes));
  check("k5", "c3"); // same ref as k3: merged into k3
  assert.equal(screen().length, 3);
  assert.equal(screen().find((c) => c.id === "k3")!.say, "Check k5", "the newest text on the open card");
  e.moments.topicChanged();
  await e.vc.advance(10);
  assert.equal(screen().length, 0, "closed with the topic");
  check("k6");
  await e.vc.advance(299_000);
  cards2close(cards, Date.now());
  assert.equal(screen().length, 1, "still open before 5 minutes");
  await e.vc.advance(2000);
  cards2close(cards, Date.now());
  assert.equal(screen().length, 0, "closed after 5 minutes");
});
function cards2close(cards: typeof import("../engine/cards.ts"), now: number) {
  cards.closeCards(cards.cardSched.expire(now));
}
