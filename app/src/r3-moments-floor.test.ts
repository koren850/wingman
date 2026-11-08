// Round 12, r3-moments-floor: the language-neutral floor (moments/floor.ts), the lists moved out of the engine core (lang/followup.ts, engine/vertical.ts),
// the word + 3-gram scorer, the cue, long finals and the file rename. No model, no network. The golden replay with numbers is src/e2e/r3-floor.test.ts.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { floorQuestion, addressedElsewhere, vocativeOf } from "./moments/floor.ts";
import { features } from "./moments/intake.ts";
import { isFollowUp } from "./lang/followup.ts";
import { setVerticalGate, noteTopicLine } from "./engine/vertical.ts";
import { st } from "./engine/state.ts";
import { capFinal, MAX_FINAL_CHARS } from "./engine/ingest.ts";
import { loadBank, topCandidates, matchBankSmart } from "./bank.ts";
import { stem, wordTokens } from "./bank-score.ts";
import { localCue } from "./moments/cue.ts";
import { loadSettings } from "./settings.ts";
import { BANK_CROSS_CASES, BANK_PARAPHRASE_CASES } from "./bank-cases.ts";
import type { SttResult, Word } from "./providers/stt/types.ts";

const fl = (text: string, ctx: Parameters<typeof floorQuestion>[1], side: "them" | "me" = "them") => floorQuestion(features({ text, side, at: 0 }), ctx);

// ---------------------------------------------------------------- the floor
test("floor: a speech-to-text question mark is a question, in Hebrew, English and mixed text", () => {
  for (const t of ["What does the plan include?", "מה כלול בחבילה?", "האם ה-API תומך ב-SSO?", "מחיר?"]) {
    const r = fl(t, { addressed: false });
    assert.equal(r.isQuestion, true, t);
    assert.equal(r.reason, "question-mark");
  }
});

test("floor: a figure in a short line aimed at the user counts; a figure in a long statement does not", () => {
  assert.equal(fl("so 25,000 shekels in total", { addressed: true }).reason, "figure-to-you");
  assert.equal(fl("אז זה 25,000 שקל בסך הכול", { addressed: true }).isQuestion, true);
  assert.equal(
    fl("last year we paid 1500 for the plan and then the quote went up because of the monitoring we added this spring", { addressed: true }).isQuestion,
    false,
  );
  assert.equal(fl("the total is 25,000 shekels", { addressed: false }).isQuestion, false, "not aimed at the user");
});

test("floor: a short line with no full stop that is aimed at the user is a request; with a full stop it is not", () => {
  assert.equal(fl("send me the file", { addressed: true }).reason, "short-imperative");
  assert.equal(fl("תשלח לי את הקובץ", { addressed: true }).reason, "short-imperative");
  assert.equal(fl("send me the file.", { addressed: true }).isQuestion, false);
  assert.equal(fl("send me the file", { addressed: false }).isQuestion, false);
});

test("floor: the bank and the stall rule", () => {
  assert.equal(fl("how much is the monthly plan", { addressed: false, bankScore: 2, stall: true }).reason, "stall-bank");
  assert.equal(fl("the site is slow on phones again", { addressed: true, bankScore: 1 }).reason, "bank");
  assert.equal(fl("the site is slow on phones again", { addressed: false, scorer: true }).reason, "bank", "no full stop and a scorer card");
  assert.equal(fl("the site is slow on phones again.", { addressed: false, bankScore: 1 }).isQuestion, false, "a statement that only touches a card");
  const long = "so the thing is that the site has been slow on phones for a while now and we tried a few things but nothing really helped at all";
  assert.equal(fl(long, { addressed: true, bankScore: 2 }).isQuestion, false, "a speech is left to the model");
});

test("floor: a line that opens with the name of someone else is aimed elsewhere, even with a question mark", () => {
  assert.equal(vocativeOf("Dana, can you pull the invoice?"), "dana");
  assert.equal(vocativeOf("Okay so what is next"), undefined);
  assert.equal(addressedElsewhere("Dana, can you pull the invoice?", ["Dana", "Omar"], ["Dan"]), true);
  assert.equal(addressedElsewhere("Dan, can you send me the file?", ["Dana", "Dan"], ["Dan"]), false, "the user's own name is not elsewhere");
  assert.equal(addressedElsewhere("דנה, תוכלי למשוך חשבונית?", ["דנה"], []), true);
  assert.equal(fl("Dana, can you pull the invoice?", { addressed: true, elsewhere: true }).isQuestion, false);
});

test("floor: the legacy hint only breaks ties; it never overrules a line the shape rules decided, and the floor works without it", () => {
  const t = "I would like to know what a go-live checklist looks like";
  assert.equal(fl(t, { addressed: false }).isQuestion, false);
  const strong = fl(t, { addressed: false, hint: "strong" });
  assert.equal(strong.isQuestion, true);
  assert.equal(strong.via, "hint");
  assert.equal(fl(t, { addressed: false, hint: "weak" }).isQuestion, false, "a weak hint needs a card or an addressed line");
  assert.equal(fl(t, { addressed: true, hint: "weak" }).via, "hint");
  assert.equal(fl("What is the price?", { addressed: false, hint: "none" }).via, "floor");
  assert.equal(fl("What is this?", { addressed: false }, "me").isQuestion, false, "the user's own line is not a question for the floor");
});

// ---------------------------------------------------------------- lists out of the core
test("isFollowUp: the interview follow-up openers, per language", () => {
  assert.equal(isFollowUp("What did you do?", "en"), true);
  assert.equal(isFollowUp("And how did you fix it", "en"), true);
  assert.equal(isFollowUp("Why?"), true);
  assert.equal(isFollowUp("ומה עשית", "he"), true);
  assert.equal(isFollowUp("ואיך פתרת את זה?"), true);
  assert.equal(isFollowUp("ומה עשית", "en"), false, "a language limits the check");
  assert.equal(isFollowUp("Tell me about your team", "en"), false);
  assert.equal(isFollowUp(""), false);
});

test("ingest.ts holds no follow-up list and no vertical words; the vertical topic gate is a hook", () => {
  const src = readFileSync(new URL("./engine/ingest.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /FOLLOW_UP/);
  assert.doesNotMatch(src, /agency|hosting|isAgencyTopic/i);
  setVerticalGate((t) => t.includes("zebra"));
  try {
    st.turn.lastAgencyTopicAt = 0;
    noteTopicLine("a plain line", 111);
    assert.equal(st.turn.lastAgencyTopicAt, 0);
    noteTopicLine("the zebra project", 222);
    assert.equal(st.turn.lastAgencyTopicAt, 222);
  } finally {
    setVerticalGate(undefined);
    st.turn.lastAgencyTopicAt = 0;
  }
});

test("gate.ts is a one-line re-export of stt-gate.ts", () => {
  const src = readFileSync(new URL("./gate.ts", import.meta.url), "utf8")
    .trim()
    .split("\n");
  assert.equal(src.length, 1);
  assert.match(src[0], /^export \* from "\.\/stt-gate\.ts";/);
  assert.match(readFileSync(new URL("./stt-gate.ts", import.meta.url), "utf8"), /^\/\/ NOT the question gate/);
});

// ---------------------------------------------------------------- long finals
test("capFinal: a final over 2000 characters keeps its newest words, and the text and the word list stay in step", () => {
  const words: Word[] = Array.from({ length: 700 }, (_, i) => ({ word: `w${i}x`, start: i, end: i + 0.5 }));
  const text = words.map((w) => w.word).join(" ");
  assert.ok(text.length > MAX_FINAL_CHARS);
  const r = capFinal({ channel: "them", text, isFinal: true, speechFinal: true, words, arrivedAt: 0 } as SttResult);
  assert.ok(r.text.length <= MAX_FINAL_CHARS);
  assert.ok(r.text.startsWith("w"), "starts at a word boundary");
  assert.equal(r.text.split(" ").length, r.words.length, "same number of words");
  assert.deepEqual(
    r.text.split(" "),
    r.words.map((w) => w.word),
    "same words, same order",
  );
  assert.equal(r.words.at(-1)!.word, "w699x");
  const short = { channel: "them", text: "hi there", isFinal: true, speechFinal: true, words: [], arrivedAt: 0 } as SttResult;
  assert.equal(capFinal(short), short, "a normal final is untouched");
});

// ---------------------------------------------------------------- scorer and cue
const bank = loadBank();

test("scorer: a Hebrew prefix is stripped only when the rest is a word the vocabulary knows", () => {
  const vocab = new Set(["דומיין", "אתר"]);
  assert.equal(stem("בדומיין", vocab), "דומיין");
  assert.equal(stem("והאתר", vocab), "אתר");
  assert.equal(stem("בקבוק", vocab), "בקבוק", "no known rest: the word stays");
  assert.deepEqual(wordTokens("Hello, world! 25,000 ₪"), ["hello", "world", "25", "000"]);
});

test("scorer: paraphrases and English questions against Hebrew cards reach the right card in the top 3", () => {
  for (const [q, id] of [...BANK_PARAPHRASE_CASES, ...BANK_CROSS_CASES]) {
    const ids = topCandidates(q, 3, bank).map((c) => c.card.id);
    const smart = matchBankSmart(q, bank, /[א-ת]/.test(q) ? "he" : "en");
    assert.ok(ids.includes(id) || smart.hit?.card.id === id, `${q}: wanted ${id}, got ${ids.join(",")}`);
  }
});

test("cue: the same objection again is found through glued prefixes; an unrelated line is not", () => {
  const f = (text: string) => features({ text, side: "them", at: 0 });
  const open = ["המחיר גבוה מדי בשבילנו והתקציב שלנו מוגבל"];
  const again = "והמחיר גבוה מדי בשבילנו ובתקציב מוגבל";
  assert.equal(localCue(again, f(again), [], { openObjections: open }), "repeat");
  const other = "נשמח לקבוע פגישה בשבוע הבא אחרי הצהריים";
  assert.equal(localCue(other, f(other), [], { openObjections: open }), undefined);
});

// ---------------------------------------------------------------- the setting
test("moments.earlyStart is off by default", () => {
  const { settings } = loadSettings({ env: {}, userFile: "/nonexistent/wingman-r3-floor-settings.yaml" });
  assert.equal(settings.moments.earlyStart, false);
});
