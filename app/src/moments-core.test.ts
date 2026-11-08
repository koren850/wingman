// Moments core (unit part): modes, the LABEL field, the neutral speed hint, the cheap local cue, the observer's new triggers and reserve,
// one shared scheduler state with feedback, and the check book (cap, merge, close). Engine-level behaviour is in src/e2e/moments.test.ts.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { modeInstructions, modeProfile } from "./moments/modes.ts";
import { buildMomentPrompt, MOMENT_RULES } from "./moments/prompt.ts";
import { parseMoment, parseMomentStream, cleanLabel } from "./moments/parse.ts";
import { features } from "./moments/intake.ts";
import { speedHint, speedReason, SHORT_LINE_WORDS } from "./moments/hint.ts";
import { localCue } from "./moments/cue.ts";
import { Observer, type ObserverLine, type ObserverWindow } from "./moments/observer.ts";
import { decide, newSchedulerState, thresholdFor, DEFAULT_SCHEDULER, type ScheduledMoment, type SchedulerState } from "./moments/scheduler.ts";
import { CardScheduler, CheckBook, MAX_OPEN_CHECKS, CHECK_LIFETIME_MS, normalizeTagRows, type CardRow } from "./engine/cards-v2.ts";
import { loadBank } from "./bank.ts";
import { KINDS } from "./session/types.ts";

const reply = (extra: string) => `REPLY\nVALUE: 2\nAIM: me\nSAY: Ask what they compared us with\n${extra}\nWHY: objection`;

// ---------------------------------------------------------------- modes
test("modes: interview has coaching text and a profile; the kinds without a mode (vendor, other) are neutral", () => {
  const text = modeInstructions("interview");
  for (const w of [/structure/i, /too long/i, /vague/i, /not answered yet/i]) assert.match(text, w);
  assert.ok(modeProfile("interview").monologueWords! > 0);
  assert.ok(modeProfile("interview").minValue);
  for (const k of KINDS.filter((k) => k === "vendor" || k === "other")) {
    assert.equal(modeInstructions(k), "", k);
    assert.deepEqual(modeProfile(k), {}, k);
  }
  assert.equal(modeInstructions(undefined), "");
  assert.deepEqual(modeProfile(undefined), {});
});

test("prompt: the interview text follows the static rules; the rules never change with the kind; LABEL is described", () => {
  const a = buildMomentPrompt({ userName: "Dan", kind: "interview" });
  const b = buildMomentPrompt({ userName: "Dan", kind: "other" });
  const c = buildMomentPrompt({ userName: "Dan" });
  assert.ok(a.startsWith(MOMENT_RULES) && b.startsWith(MOMENT_RULES));
  assert.ok(buildMomentPrompt({ userName: "Dan", kind: "client" }).startsWith(MOMENT_RULES), "a mode adds text after the static rules");
  assert.match(a, /practice interview/);
  assert.doesNotMatch(b, /practice interview/);
  assert.equal(b, c, "the neutral kind adds nothing");
  assert.match(MOMENT_RULES, /LABEL: 2 to 4 words/);
});

test("scheduler: the interview profile lowers the bar, and feedback still raises it", () => {
  const m: ScheduledMoment = { tag: "REPLY", value: 1, aim: "me", say: "x", why: "", more: [], source: "observer" };
  const neutral = newSchedulerState(1000);
  assert.equal(decide(m, neutral).action, "chip");
  const interview: SchedulerState = { ...newSchedulerState(1000), kind: "interview" };
  assert.equal(decide(m, interview).action, "show", "a marginal coaching card shows in a practice interview");
  assert.equal(thresholdFor("REPLY", { ...interview, boost: { REPLY: 2 } }), 2);
});

// ---------------------------------------------------------------- LABEL
test("LABEL: parsed, trimmed, optional", () => {
  assert.equal(parseMoment(reply("LABEL: PHP version")).moment.label, "PHP version");
  assert.equal(parseMoment(reply('LABEL: "Backups"')).moment.label, "Backups");
  assert.equal(parseMoment(reply("LABEL: גרסת PHP")).moment.label, "גרסת PHP");
  const none = parseMoment(reply(""));
  assert.equal(none.moment.label, undefined);
  assert.equal(none.errors.length, 0, "a missing LABEL is not an error");
  assert.equal(parseMoment(reply("LABEL:")).errors.length, 0);
  assert.equal(parseMoment(reply("LABEL:   ")).moment.label, undefined);
});

test("LABEL: over 5 words is cut to 4; a sentence is cut to 4 and loses its end mark; 5 words stay", () => {
  assert.equal(cleanLabel("one two three four five six seven"), "one two three four");
  assert.equal(cleanLabel("one two three four five"), "one two three four five");
  assert.equal(cleanLabel("They want a discount today."), "They want a discount");
  assert.equal(cleanLabel("Backups. Then more words"), "Backups");
  assert.equal(cleanLabel("PHP version?"), "PHP version");
  assert.equal(
    cleanLabel("x".repeat(100)),
    "x"
      .repeat(40)
      .slice(0, 40)
      .replace(/\s+\S*$/, ""),
  );
  assert.equal(cleanLabel("SKIP"), "", "a verdict word is not a label");
  assert.equal(cleanLabel("   "), "");
});

test("LABEL: fuzz with and without the line never throws, never breaks the other fields, never exceeds the limits", () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pieces = ["PHP", "version", "גרסת", "גיבוי", "a", "!", ".", "?", "—", "<b>", "SKIP", "ANS", "`x`", "😀", "‏", "12", "$5", "…", ":"];
  for (let i = 0; i < 400; i++) {
    const n = Math.floor(rnd() * 12);
    const label = Array.from({ length: n }, () => pieces[Math.floor(rnd() * pieces.length)]).join(rnd() < 0.5 ? " " : "");
    const withLabel = rnd() < 0.7;
    const order = rnd() < 0.5;
    const body = ["VALUE: 2", "AIM: me", "SAY: Ask what they compared us with", "WHY: test", ...(withLabel ? [`LABEL: ${label}`] : [])];
    if (order) body.reverse();
    const text = `REPLY\n${body.join("\n")}`;
    const r = parseMoment(text);
    assert.equal(r.moment.tag, "REPLY", text);
    assert.equal(r.moment.say, "Ask what they compared us with");
    if (r.moment.label !== undefined) {
      assert.ok(r.moment.label.split(/\s+/).length <= 5 && r.moment.label.length <= 40 && r.moment.label.length > 0, JSON.stringify(r.moment.label));
      assert.doesNotMatch(r.moment.label, /[<>`]/);
    }
    // streaming: any prefix of the reply is safe
    const cut = Math.floor(rnd() * text.length);
    const p = parseMomentStream(text.slice(0, cut), false);
    assert.ok(p.fields.label === undefined || p.fields.label.length <= 40);
  }
});

test("LABEL: a partly streamed LABEL line is not read until the line is finished", () => {
  const p = parseMomentStream("REPLY\nVALUE: 2\nAIM: me\nSAY: Ask\nLABEL: PHP ver", false);
  assert.equal(p.fields.label, undefined);
  const q = parseMomentStream("REPLY\nVALUE: 2\nAIM: me\nSAY: Ask\nLABEL: PHP version\nWHY", false);
  assert.equal(q.fields.label, "PHP version");
});

// ---------------------------------------------------------------- speed hint
const f = (text: string, side: "me" | "them" = "them") => features({ text, side, at: 0 });
const TABLE: { text: string; addressed: boolean; fast: boolean; why?: string; note: string }[] = [
  { text: "What databases do you support?", addressed: false, fast: true, why: "question-mark", note: "EN, STT question mark" },
  { text: "אילו מסדי נתונים אתם תומכים?", addressed: false, fast: true, why: "question-mark", note: "HE, STT question mark (Hebrew letters, Latin mark)" },
  { text: "מחיר?", addressed: false, fast: true, why: "question-mark", note: "HE, one token" },
  { text: "Can you send the quote today ?", addressed: true, fast: true, why: "question-mark", note: "space before the mark" },
  { text: "Tell me the price for three seats", addressed: true, fast: true, why: "short-to-you", note: "EN, short request to you, no full stop" },
  { text: "תגיד לי כמה זה עולה לחודש", addressed: true, fast: true, why: "short-to-you", note: "HE, no mark, 1:1" },
  { text: "כמה זה עולה לחודש", addressed: true, fast: true, why: "short-to-you", note: "HE, a direct question without a mark" },
  { text: "It will cost 5000 a month.", addressed: true, fast: true, why: "figure-to-you", note: "figure in a short line to you" },
  { text: "זה יעלה ₪5000 לחודש.", addressed: true, fast: true, why: "figure-to-you", note: "HE currency sign" },
  { text: "כמה זה עולה לחודש", addressed: false, fast: false, note: "HE, not aimed at the user (group call): the observer reads it" },
  { text: "We finished the migration last week.", addressed: true, fast: false, note: "a statement with a full stop" },
  { text: "סיימנו את המיגרציה בשבוע שעבר.", addressed: true, fast: false, note: "HE statement with a full stop" },
  { text: "one two three four five six seven eight nine ten", addressed: true, fast: false, note: `longer than ${SHORT_LINE_WORDS} words, no mark` },
  { text: "It costs 40 dollars", addressed: false, fast: false, note: "a figure, not aimed at the user" },
  { text: "", addressed: true, fast: false, note: "empty" },
];
test("speedHint: table of English and Hebrew lines, no word list", () => {
  for (const row of TABLE) {
    const ft = f(row.text);
    assert.equal(speedHint(ft, { addressed: row.addressed }), row.fast ? "fast" : "normal", `${row.note}: ${row.text}`);
    assert.equal(speedReason(ft, { addressed: row.addressed }), row.why, row.note);
  }
});
test("speedHint: the user's own lines and interim results are never fast; a changed word does not change the answer", () => {
  assert.equal(speedHint(f("What databases do you support?", "me"), { addressed: true }), "normal");
  assert.equal(speedHint(f("What databases do you support?"), { addressed: true, final: false }), "normal");
  // the hint is the same for any words of the same shape: it reads shape, not words
  assert.equal(speedHint(f("zzz qqq www?"), { addressed: false }), "fast");
  assert.equal(speedHint(f("zzz qqq www"), { addressed: true }), "fast");
  assert.equal(speedHint(f("zzz qqq www."), { addressed: true }), "normal");
});

// ---------------------------------------------------------------- local cue
test("localCue: a figure, a likeness to the user's own cards or to an open objection, the user's name; nothing for small talk", () => {
  const bank = loadBank();
  assert.ok(bank.length > 0);
  const cue = (t: string, ctx = {}, side: "me" | "them" = "them") => localCue(t, f(t, side), bank, ctx);
  assert.equal(cue("it is 4 percent"), "figure");
  assert.equal(cue("זה ₪900"), "figure");
  assert.equal(cue("האתר שלכם איטי מאוד"), "objection", "Hebrew: close to the card site-slow");
  assert.equal(cue("Dana what do you think", { named: true }), "named");
  for (const small of [
    "nice weather today",
    "how was your weekend",
    "let me share my screen",
    "I think that sounds good to me",
    "בוא נעבור לנושא הבא",
    "מה שלומך היום",
    "נחזור אליכם אחרי החג",
  ])
    assert.equal(cue(small), undefined, small);
  const open = ["we cannot accept a long contract with a yearly lock in"];
  assert.equal(cue("a yearly lock in contract is something we cannot accept", { openObjections: open }), "repeat");
  assert.equal(cue("the weather is lovely today in the north", { openObjections: open }), undefined);
  assert.equal(cue("it is 4 percent", {}, "me"), undefined, "the user's own lines have no cue");
});

// ---------------------------------------------------------------- observer
function rig(cfg = {}) {
  let t = 0;
  const o = new Observer(() => t, cfg);
  let n = 0;
  const line = (text: string, extra: Partial<ObserverLine> = {}): ObserverLine => ({ id: `l${++n}`, text, side: "them", at: t, ...extra });
  return { o, line, at: (ms: number) => (t = ms), adv: (ms: number) => (t += ms) };
}

test("observer: a short line with a cue fires after 0.7 s of quiet", () => {
  const r = rig();
  assert.equal(r.o.push(r.line("too expensive for us", { cue: true })), undefined);
  assert.equal(r.o.nextDueAt(), 700);
  r.at(700);
  const w = r.o.poll();
  assert.equal(w?.trigger, "cue");
  assert.equal(w?.lines.length, 1);
});

test("observer: 2 of 6 calls a minute are reserved for cues, asks and the like; general triggers stop at 4 until they have waited 2.5 s", () => {
  const r = rig();
  const fired: ObserverWindow[] = [];
  // general triggers: a long line (12 words) every 1 s; the first four fire at once, the fifth has to wait
  for (let i = 0; i < 6; i++) {
    r.at(i * 1000);
    const w = r.o.push(r.line("one two three four five six seven eight nine ten eleven twelve"));
    if (w) fired.push(w);
  }
  assert.equal(fired.length, 4, "general triggers used 4 of 6 and no more while they are fresh");
  assert.ok(fired.every((w) => w.trigger === "words"));
  r.at(6400);
  assert.equal(r.o.poll(), undefined, "the oldest waiting line has waited 2.4 s: the reserved calls are still kept");
  r.at(6500);
  assert.equal(r.o.poll()?.trigger, "words", "after 2.5 s a waiting general look may use a reserved call");
  // a cue gets the last call of the minute; then the cap holds
  r.at(36_000);
  r.o.push(r.line("it is 4 percent", { cue: true }));
  r.at(36_800);
  assert.equal(r.o.poll()?.trigger, "cue");
  r.o.push(r.line("a number 900", { cue: true }));
  r.at(37_600);
  assert.equal(r.o.poll(), undefined, "6 calls in the minute: nothing more");
  r.at(60_000 + 1);
  assert.equal(r.o.poll()?.trigger, "cue", "a slot frees up when the first call is a minute old");
});

test("observer: unfire gives the call slot and the waiting lines back, and does not re-arm the silence timer", () => {
  const r = rig();
  r.at(0);
  r.o.push(r.line("a line about the plan today", { hint: "weak" }));
  r.at(100);
  r.o.push(r.line("Is that clear?", { asked: true }));
  r.at(2200);
  const w = r.o.poll();
  assert.equal(w?.trigger, "silence");
  assert.equal(r.o.pendingCount, 0);
  r.o.unfire(w!);
  assert.equal(r.o.pendingCount, 2, "both lines are pending again");
  r.at(2300);
  assert.equal(r.o.poll()?.trigger, "weak", "the waiting weak line gets its own look, from the slot that came back");
  r.o.unfire(w!); // a second unfire of the same window does nothing
  assert.equal(r.o.pendingCount, 0);
});

test("observer: never more than 6 calls in any 60 s window with every kind of trigger at once", () => {
  const r = rig({ monologueWords: 20 });
  const fired: number[] = [];
  let i = 0;
  for (let ms = 0; ms < 240_000; ms += 250) {
    r.at(ms);
    const push = (l: ObserverLine) => {
      const w = r.o.push(l);
      if (w) fired.push(w.firedAt);
    };
    if (ms % 1000 === 0) push(r.line(`line ${i++} with 5 euro and more words in it`, { cue: true, hint: i % 3 === 0 ? "strong" : "weak" }));
    if (ms % 3000 === 0) push(r.line("a question to you?", { asked: true }));
    if (ms % 5000 === 0) push(r.line("my answer is long ".repeat(8), { side: "me" }));
    if (ms % 7000 === 0) {
      const w = r.o.topicChange();
      if (w) fired.push(w.firedAt);
    }
    const w = r.o.poll();
    if (w) fired.push(w.firedAt);
  }
  assert.ok(fired.length > 12);
  for (const t of fired) assert.ok(fired.filter((x) => x > t - 60_000 && x <= t).length <= 6, `window ending ${t}`);
});

test("observer: a question to the user and 2 s of silence fires; an answer or a new line cancels it", () => {
  const r = rig();
  r.o.push(r.line("can you start on monday", { asked: true }));
  assert.equal(r.o.nextDueAt(), 2000);
  r.at(1999);
  assert.equal(r.o.poll(), undefined);
  r.at(2000);
  const w = r.o.poll();
  assert.equal(w?.trigger, "silence");
  assert.deepEqual(
    w?.lines.map((l) => l.text),
    ["can you start on monday"],
  );
  // the user answers inside 2 s
  r.at(10_000);
  r.o.push(r.line("is that ok", { asked: true }));
  r.at(11_000);
  r.o.userSpoke();
  r.at(13_000);
  assert.equal(r.o.poll(), undefined);
  assert.equal(r.o.nextDueAt(), undefined);
  // the other side keeps talking: no silence
  r.at(20_000);
  r.o.push(r.line("is that ok", { asked: true }));
  r.at(21_000);
  r.o.push(r.line("it is just a small thing"));
  r.at(24_000);
  assert.notEqual(r.o.poll()?.trigger, "silence");
});

test("observer: an asked line does not count as new words", () => {
  const r = rig();
  assert.equal(r.o.push(r.line("one two three four five six seven eight nine ten eleven twelve thirteen", { asked: true })), undefined);
});

test("observer: a long monologue of the user fires a coaching look, and only in a mode that asks for it", () => {
  const off = rig();
  assert.equal(
    off.o.push(off.line("blah ".repeat(200), { side: "me" })),
    undefined,
    "no monologue trigger by default, and the user's words make no general look",
  );
  const r = rig({ monologueWords: 30 });
  assert.equal(r.o.push(r.line("word ".repeat(20), { side: "me" }))?.trigger === "monologue", false);
  const w = r.o.push(r.line("word ".repeat(15), { side: "me" }));
  assert.equal(w?.trigger, "monologue");
  r.adv(100);
  const again = r.o.push(r.line("word ".repeat(40), { side: "me" }));
  assert.equal(again?.trigger, "monologue", "the count restarts after a look");
});

test("observer: a cue flag from a line of the user does nothing", () => {
  const r = rig();
  r.o.push(r.line("it is 4 percent", { side: "me", cue: true }));
  r.at(5000);
  assert.equal(r.o.poll(), undefined);
});

// ---------------------------------------------------------------- one scheduler state
const mom = (o: Partial<ScheduledMoment> & { tag: ScheduledMoment["tag"] }): ScheduledMoment => ({
  value: 2,
  aim: "me",
  say: "Say it",
  why: "w",
  more: [],
  ...o,
});

test("one scheduler: three 'not useful' on one kind raise the bar for direct, observer and open-loop cards (one state)", () => {
  let state = newSchedulerState(1_000_000);
  const cs = new CardScheduler(DEFAULT_SCHEDULER, 0, { get: () => state, set: (s) => void (state = s) });
  // a REPLY from the direct path, one from the observer, one open-loop PROMPT
  const ids = ["d1", "o1", "o2"];
  cs.know("d1", "REPLY");
  cs.know("o1", "REPLY");
  cs.know("o2", "REPLY");
  assert.equal(thresholdFor("REPLY", state), 2);
  const n = cs.applyFeedback(ids.map((id) => ({ id, rating: "not-useful" as const })));
  assert.equal(n, 3);
  assert.equal(thresholdFor("REPLY", state), 3, "the bar is up for the kind");
  for (const source of ["direct", "observer"] as const) {
    assert.notEqual(decide(mom({ tag: "REPLY", value: 2, source }), state).action, "show", `${source} REPLY with value 2 no longer shows`);
    assert.equal(decide(mom({ tag: "REPLY", value: 3, source }), state).action, "show", `${source} REPLY with value 3 still shows`);
  }
  // the open-loop path (CardScheduler.offer) reads the same state
  cs.tick(1_000_000, 1);
  const o = cs.offer(mom({ tag: "REPLY", value: 2, source: "observer", ref: "q1" }), { memV: 1 });
  assert.notEqual(o.action, "show");
  // other kinds are not affected
  assert.equal(decide(mom({ tag: "ANS", value: 2 }), state).action, "show");
});

test("one scheduler: a rating is applied once; a changed rating counts; a replay of the file changes nothing", () => {
  let state = newSchedulerState(1000);
  const cs = new CardScheduler(DEFAULT_SCHEDULER, 0, { get: () => state, set: (s) => void (state = s) });
  for (const id of ["a", "b", "c", "d"]) cs.know(id, "NOTE");
  const rows = (...r: [string, "useful" | "not-useful"][]) => r.map(([id, rating]) => ({ id, rating }));
  assert.equal(cs.applyFeedback(rows(["a", "not-useful"], ["b", "not-useful"])), 2);
  assert.equal(cs.applyFeedback(rows(["a", "not-useful"], ["b", "not-useful"])), 0, "replay");
  assert.equal(state.streak.NOTE, 2);
  assert.equal(cs.applyFeedback(rows(["a", "not-useful"], ["b", "not-useful"], ["c", "not-useful"])), 1, "only the new card");
  assert.equal(state.boost.NOTE, 3, "NOTE bar 2 -> 3 after three");
  assert.equal(cs.applyFeedback(rows(["unknown", "not-useful"])), 0, "a card the scheduler never saw");
  assert.equal(cs.applyFeedback(rows(["d", "useful"])), 1);
});

test("one scheduler: tags.jsonl rows in both shapes are read; junk is skipped", () => {
  const rows = normalizeTagRows([
    { id: "a", useful: "n", badge: "ai", cardId: "a", rating: "not_useful" },
    { id: "b", useful: "y" },
    { cardId: "c", rating: "useful" },
    { id: "d", rating: "none" },
    null,
    "x",
    { rating: "useful" },
    {},
  ]);
  assert.deepEqual(rows, [
    { id: "a", rating: "not-useful" },
    { id: "b", rating: "useful" },
    { id: "c", rating: "useful" },
  ]);
});

test("one scheduler: direct, observer and open-loop cards count in one per-minute total and one hero", () => {
  let state = newSchedulerState(5_000_000);
  const cs = new CardScheduler({ ...DEFAULT_SCHEDULER, maxPerMinute: 2 }, 0, { get: () => state, set: (s) => void (state = s) });
  cs.tick(5_000_000, 1);
  const a = cs.offer(mom({ tag: "NOTE", value: 3, topic: "a", source: "observer", lineAt: 5_000_000 }), { memV: 1 });
  assert.equal(a.action, "show");
  assert.equal(state.shown.length, 1, "the shared state saw it");
  // the engine's own paths write to the same state object: simulate with recordShown through the store
  state = { ...state, shown: [...state.shown, { id: "dx", at: 5_000_100, tag: "ANS", memVer: 1, rank: 1, exempt: false }] };
  cs.tick(5_000_200, 1);
  const b = cs.offer(mom({ tag: "TERM", value: 3, topic: "b", source: "observer", lineAt: 5_000_200 }), { memV: 1 });
  assert.equal(b.action, "chip", "two cards already shown this minute (one from another path)");
});

// ---------------------------------------------------------------- checks
const check = (id: string, ref?: string, extra: Partial<CardRow> = {}): CardRow => ({
  id,
  turnId: "t",
  badge: "careful",
  question: "",
  say: `check ${id}`,
  facts: [],
  at: 0,
  kind: "check",
  ...(ref ? { ref } : {}),
  ...extra,
});

test("checks: at most 3 open; the 4th closes the oldest", () => {
  const b = new CheckBook();
  const out: CardRow[] = [];
  for (let i = 1; i <= 5; i++) {
    const a = b.admit(check(`c${i}`), i * 1000);
    out.push(...a.closes);
  }
  assert.equal(b.open, MAX_OPEN_CHECKS);
  assert.deepEqual(
    out.map((r) => r.id),
    ["c1", "c2"],
  );
  assert.ok(
    out.every((r) => r.closes && r.say.startsWith("check")),
    "a closing row keeps the last text",
  );
});

test("checks: same ref merges into the open card; a new id with no ref does not", () => {
  const b = new CheckBook();
  b.admit(check("c1", "c3"), 1000);
  const m = b.admit(check("c2", "c3", { say: "newer text" }), 2000);
  assert.equal(m.row.id, "c1");
  assert.equal(m.row.say, "newer text");
  assert.equal(m.merged, "c1");
  assert.equal(b.open, 1);
  b.admit(check("c9"), 3000);
  b.admit(check("c10"), 3000);
  assert.equal(b.open, 3);
  const same = b.admit(check("c1", "c3", { say: "update of the same card" }), 4000);
  assert.equal(same.row.id, "c1");
  assert.equal(b.open, 3, "an update of an open card is not a new check");
});

test("checks: close with the topic, after 5 minutes, when resolved, on dismiss; other cards pass through", () => {
  const b = new CheckBook();
  const note = { ...check("n1"), kind: "fact" as const, badge: "info" };
  assert.equal(b.admit(note, 0).row, note);
  assert.equal(b.open, 0);
  b.admit(check("c1", "q1"), 0);
  b.admit(check("c2"), 100_000);
  assert.deepEqual(
    b.expire(CHECK_LIFETIME_MS - 1).map((r) => r.id),
    [],
  );
  assert.deepEqual(
    b.expire(CHECK_LIFETIME_MS).map((r) => [r.id, r.closes]),
    [["c1", "time"]],
  );
  b.admit(check("c3", "q7"), 200_000);
  assert.deepEqual(
    b.resolved(new Set(["q7"]), 210_000).map((r) => [r.id, r.closes]),
    [["c3", "answered"]],
  );
  b.admit(check("c4"), 220_000);
  b.dismissed("c4");
  assert.equal(b.open, 1);
  assert.deepEqual(
    b.closeAll("topic", 230_000).map((r) => [r.id, r.closes]),
    [["c2", "topic"]],
  );
  assert.equal(b.open, 0);
  // a closing row written by the engine removes the card
  b.admit(check("c5"), 300_000);
  b.admit({ ...check("c5"), closes: "dismissed" }, 300_100);
  assert.equal(b.open, 0);
});

test("checks: the card scheduler's expire() and resolved() reach the same book", () => {
  const book = new CheckBook();
  const cs = new CardScheduler(DEFAULT_SCHEDULER, 0, undefined, book);
  book.admit(check("c1", "q1"), 0);
  assert.deepEqual(
    cs.expire(CHECK_LIFETIME_MS).map((r) => r.id),
    ["c1"],
  );
  book.admit(check("c2", "q2"), 0);
  assert.deepEqual(
    cs.resolved(["q2"]).map((r) => r.id),
    ["c2"],
  );
});
