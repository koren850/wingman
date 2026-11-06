// Pure engine rules (engine/rules.ts): who a question is aimed at, recent notes for the notes model, the interview answer clock.
// (The call-loop behaviour of the same fixes is in e2e/engine-modes.test.ts.)
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addressesUser,
  recentNotes,
  NOTES_EXISTING_MAX,
  nextAnswerStart,
  wordCount,
  recentWindow,
  capTail,
  TRANSCRIPT_MAX_CHARS,
  frameDue,
  llmFailurePolicy,
  SPEND_CAP_PARK_MS,
  isFresh,
  isBankRepeat,
  REPEAT_BANK_MS,
  agencyGate,
  questionSkip,
  factsActive,
} from "./engine/rules.ts";

test("rules: addressesUser covers Hebrew and English forms of 'you'", () => {
  for (const s of [
    "מה דעתך על זה?",
    "מה לדעתך כדאי לעשות",
    "מה אתה חושב",
    "מה את חושבת",
    "תוכלי להסביר",
    "what do you think?",
    "can you help",
    "do u know",
    "you're the expert",
  ])
    assert.equal(addressesUser(s), true, s);
  for (const s of ["מה אתם אומרים", "את הדומיין", "מפתחים פלטפורמה שמיועדת לארגונים", "הוא אמר שדעתו"]) assert.equal(addressesUser(s), false, s);
});
test("8. the notes model gets only the recent notes", () => {
  const notes = Array.from({ length: 200 }, (_, i) => `note ${i}`);
  const got = recentNotes(notes);
  assert.equal(got.length, NOTES_EXISTING_MAX);
  assert.equal(got.at(-1), "note 199");
  assert.deepEqual(recentNotes(["a", "b"]), ["a", "b"]);
});
test("11. interview: the 90 s answer clock restarts after a pause of the user, even when the interviewer's audio is dead", () => {
  const T = 1_000_000;
  // first line: the clock starts 5 s back
  assert.equal(nextAnswerStart({ answerStart: 0, lastThemSpeech: 0, lastMeLineAt: 0, now: T }), T - 5000);
  // a line 3 s later: same answer
  assert.equal(nextAnswerStart({ answerStart: T - 5000, lastThemSpeech: 0, lastMeLineAt: T, now: T + 3000 }), T - 5000);
  // the interviewer spoke in between: new answer
  assert.equal(nextAnswerStart({ answerStart: T - 5000, lastThemSpeech: T + 1000, lastMeLineAt: T, now: T + 3000 }), T + 1000);
  // nobody else is heard, but the user was quiet for 60 s: a new answer, not "30 minutes of talking"
  assert.equal(nextAnswerStart({ answerStart: T - 5000, lastThemSpeech: 0, lastMeLineAt: T, now: T + 60_000 }), T + 55_000);
});

// ---- engine/coach.ts: transcript window and frame pacing ----
test("coach: wordCount splits on any whitespace and ignores empty pieces", () => {
  assert.equal(wordCount("  שלום   עולם\n hello "), 3);
  assert.equal(wordCount(""), 0);
});
test("coach: recentWindow keeps the last minutes, at most maxLines, oldest first", () => {
  const now = 1_000_000;
  const lines = [
    { at: now - 11 * 60_000, t: "old" },
    { at: now - 9 * 60_000, t: "a" },
    { at: now - 5 * 60_000, t: "b" },
    { at: now - 1000, t: "c" },
  ];
  assert.deepEqual(
    recentWindow(lines, now, 10).map((l) => l.t),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    recentWindow(lines, now, 10, 2).map((l) => l.t),
    ["b", "c"],
  );
  assert.deepEqual(recentWindow([], now, 10), []);
});
test("coach: capTail keeps the newest part of a long transcript and leaves a short one alone", () => {
  assert.equal(capTail("short"), "short");
  const long = "x".repeat(TRANSCRIPT_MAX_CHARS) + "END";
  assert.equal(capTail(long).length, TRANSCRIPT_MAX_CHARS);
  assert.ok(capTail(long).endsWith("END"));
});
test("coach: frameDue waits for words and pacing; the first frame comes early; the final look needs only 8 words", () => {
  const base = { final: false, hasFrame: true, newWords: 100, minNewWords: 60, now: 100_000, lastFrameAt: 50_000, everyMs: 30_000 };
  assert.equal(frameDue(base), true);
  assert.equal(frameDue({ ...base, newWords: 59 }), false, "not enough new words");
  assert.equal(frameDue({ ...base, now: 70_000 }), false, "too soon after the last frame");
  assert.equal(frameDue({ ...base, hasFrame: false, newWords: 20, now: 50_001 }), true, "first frame: 20 words, no waiting");
  assert.equal(frameDue({ ...base, hasFrame: false, newWords: 19 }), false);
  assert.equal(frameDue({ ...base, final: true, newWords: 8, now: 50_001 }), true, "final look ignores the pacing");
  assert.equal(frameDue({ ...base, final: true, newWords: 7 }), false);
});

// ---- engine/degrade.ts: what a failed model call does ----
test("degrade: auth, spend cap, quota and unsupported are hard errors; only a spend cap parks the model, for 6 h", () => {
  for (const kind of ["auth", "spend_cap", "quota", "unsupported"]) assert.equal(llmFailurePolicy(kind).hard, true, kind);
  for (const kind of ["rate", "overload", "timeout", "network", "unknown"]) assert.equal(llmFailurePolicy(kind).hard, false, kind);
  assert.equal(llmFailurePolicy("spend_cap").parkMs, SPEND_CAP_PARK_MS);
  assert.equal(SPEND_CAP_PARK_MS, 6 * 3600_000);
  assert.equal(llmFailurePolicy("auth").parkMs, 0);
});
test("degrade: only overload-type errors tell the supervisor the AI is in trouble", () => {
  for (const kind of ["rate", "overload", "timeout", "network"]) assert.equal(llmFailurePolicy(kind).noteTrouble, true, kind);
  for (const kind of ["auth", "spend_cap", "quota", "unsupported", "bad_request"]) assert.equal(llmFailurePolicy(kind).noteTrouble, false, kind);
});

// ---- engine/question.ts: freshness, repeats, agency gate, skip rules ----
test("question: an answer is fresh until reflex.dropStaleMs after the end of speech", () => {
  assert.equal(isFresh(1000, 1000 + 7999, 8000), true);
  assert.equal(isFresh(1000, 1000 + 8000, 8000), false);
});
test("question: a prepared card shown before repeats only for a clear question after 2 minutes", () => {
  const now = 1_000_000;
  assert.equal(isBankRepeat({ shownAt: undefined, now, clearQuestion: false }), false, "never shown: not a repeat");
  assert.equal(isBankRepeat({ shownAt: now - 1000, now, clearQuestion: true }), true, "too soon");
  assert.equal(isBankRepeat({ shownAt: now - REPEAT_BANK_MS - 1, now, clearQuestion: false }), true, "long ago but not a clear question");
  assert.equal(isBankRepeat({ shownAt: now - REPEAT_BANK_MS - 1, now, clearQuestion: true }), false);
});
test("question: the agency gate blocks the user's services on other call kinds, and an interview never gets a stall line", () => {
  const base = { interview: false, kind: "client", kindIsAgency: true, agencyTopic: false, agencyRecent: false, stallEnabled: true };
  assert.deepEqual(agencyGate(base), { noAgency: false, noStall: false });
  assert.deepEqual(agencyGate({ ...base, kind: "team", kindIsAgency: false }), { noAgency: true, noStall: true });
  assert.deepEqual(
    agencyGate({ ...base, kind: "team", kindIsAgency: false, agencyTopic: true }),
    { noAgency: false, noStall: false },
    "a hosting question on a team call",
  );
  assert.deepEqual(agencyGate({ ...base, kind: "team", kindIsAgency: false, agencyRecent: true }), { noAgency: false, noStall: false }, "a short follow-up");
  assert.deepEqual(agencyGate({ ...base, kind: undefined, kindIsAgency: false }), { noAgency: false, noStall: false }, "kind not known yet");
  assert.deepEqual(agencyGate({ ...base, stallEnabled: false }), { noAgency: false, noStall: true });
  assert.deepEqual(agencyGate({ ...base, interview: true }), { noAgency: false, noStall: true });
});
test("question: skip rules run in order, and the costly checks only run when reached", () => {
  const calls: string[] = [];
  const o = (over: Partial<Parameters<typeof questionSkip>[0]> = {}): Parameters<typeof questionSkip>[0] => ({
    interview: false,
    reason: "q-mark",
    aimedAtYou: () => (calls.push("you"), false),
    hasBankHit: () => (calls.push("bank"), false),
    focusOn: false,
    focusWorthy: () => (calls.push("focus"), true),
    flowHolds: () => (calls.push("flow"), false),
    ...over,
  });
  assert.equal(questionSkip(o()), undefined);
  assert.deepEqual(calls, ["flow"], "no focus, no if-open, no interview: only the flow check ran");
  assert.equal(questionSkip(o({ reason: "if-open: if you" })), "ifopen.skip");
  assert.equal(questionSkip(o({ reason: "if-open", aimedAtYou: () => true })), undefined, "an if-opener aimed at the user is kept");
  assert.equal(questionSkip(o({ interview: true, reason: "head: יש" })), "head.skip");
  assert.equal(questionSkip(o({ interview: true, reason: "head: יש", hasBankHit: () => true })), undefined, "a prepared card matches");
  assert.equal(questionSkip(o({ interview: true, reason: "if-open" })), undefined, "if-open is a work-meeting rule only");
  assert.equal(questionSkip(o({ focusOn: true, focusWorthy: () => false })), "focus.skip");
  assert.equal(questionSkip(o({ focusOn: true, interview: true, focusWorthy: () => false })), undefined, "focus never applies in an interview");
  assert.equal(questionSkip(o({ flowHolds: () => true })), "flow.hold");
});

test("boot: an interview never loads the client snapshot, so it produces no fact cards about the user's own clients and servers", () => {
  assert.equal(factsActive({ factsEnabled: true, interview: false }), true);
  assert.equal(factsActive({ factsEnabled: true, interview: true }), false);
  assert.equal(factsActive({ factsEnabled: false, interview: false }), false);
});
