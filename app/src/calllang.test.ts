import { test } from "node:test";
import "./test-setup.ts";
import assert from "node:assert/strict";
import { callLanguage, resetCallLang } from "./calllang.ts";
import { summarySystem, buildPrompt, fixGreeting, generateSummary, type CallData } from "./summary.ts";
import { guardEmail, neutralizeLinks } from "./summary-email.ts";
import { notesSystem, takeNotes } from "./notes.ts";
import { tipsSystem, runTip, talkTip, wrapUpTip } from "./tips.ts";
import { topicSystem, runTopic } from "./flow.ts";
import { selfcheckSystem, detectCareful, runSelfCheck } from "./selfcheck.ts";
import { guard } from "./guards.ts";
import { scriptedAnswer } from "./providers/scripted.ts";

const EN =
  "me: Hi Dana, thanks for calling.\nthem: Hi. My website is very slow and I need to know about backups.\nme: Sure, let me look at the hosting setup first.";
const HE = "me: שלום דנה, תודה שהתקשרת.\nthem: היי, האתר שלי איטי מאוד ואני צריכה לדעת על גיבויים.\nme: בטח, אני אבדוק קודם את הגדרות האחסון.";
const HE_MIXED = "them: האתר שלנו רץ על WordPress עם WooCommerce ואנחנו צריכים לשפר את ה-caching ואת ה-CDN לפני הקמפיין";

test("callLanguage: Hebrew by default, English by letters, Hebrew with English terms stays Hebrew", () => {
  assert.equal(callLanguage(""), "he");
  assert.equal(callLanguage("ok"), "he", "too little text");
  assert.equal(callLanguage("1234 5678"), "he");
  assert.equal(callLanguage(EN), "en");
  assert.equal(callLanguage(HE), "he");
  assert.equal(callLanguage(HE_MIXED), "he");
  // speaker labels are not speech: a Hebrew call with short lines does not turn English because of "them:"
  assert.equal(callLanguage("them: כן\nme: אוקיי\nthem: טוב\nme: בסדר\nthem: כן"), "he");
  assert.equal(callLanguage("אני: hello there my friend\nלקוח: yes I am here today"), "en");
});

test("callLanguage: stt.language en decides; other settings leave it to the text", () => {
  assert.equal(callLanguage(HE, "en"), "en");
  resetCallLang();
  assert.equal(callLanguage(EN, "multi"), "en");
  resetCallLang();
  assert.equal(callLanguage(EN, "auto"), "en");
  resetCallLang();
  assert.equal(callLanguage(HE, "multi"), "he");
  assert.equal(callLanguage(HE, "he"), "he");
  assert.equal(callLanguage("", "en"), "en");
});

test("summary prompt: English call asks for English output and English placeholders; Hebrew call is unchanged", () => {
  const en = summarySystem("en"),
    he = summarySystem("he");
  assert.match(en, /The meeting was in English/);
  assert.match(en, /short English bullet lines/);
  assert.match(en, /\[fill in: price\] or \[fill in: date\]/);
  assert.doesNotMatch(en, /להשלים|Hebrew|שלום/);
  assert.match(he, /The meeting was in Hebrew with English terms/);
  assert.match(he, /short Hebrew bullet lines/);
  assert.match(he, /\[להשלים: מחיר\] or \[להשלים: תאריך\]/);
  assert.equal(summarySystem(), he, "default = Hebrew");
  assert.ok(en.includes("write the post-call summary") && he.includes("write the post-call summary"), "the scripted double keys on this phrase");
});

test("summary: the cut marker, the email guard and the link guard follow the language", () => {
  const long = "word ".repeat(60_000),
    longHe = "מילה ".repeat(60_000);
  const mk = (t: string): CallData => ({ lines: [{ ch: "them", text: t }], contextNotes: [], aiNotes: [] });
  assert.match(buildPrompt(mk(`hello there my friend ${long}`)), /\[\.\.\. part of the call omitted \.\.\.\]/);
  assert.match(buildPrompt(mk(`שלום וברוכים הבאים ${longHe}`)), /\[\.\.\. חלק מהשיחה הושמט \.\.\.\]/);
  const mail = "Hi,\nThe package costs $500 per month.\nWe will get back to you by Monday.\nI promise it will be done.\nSee www.evil.example now\nBest regards";
  const en = guardEmail(mail, "", "en");
  assert.match(en.text, /\[fill in: price\]/);
  assert.match(en.text, /\[fill in: date\]/);
  assert.match(en.text, /\[fill in: promise\]/);
  assert.match(en.text, /\[fill in: link\]/);
  assert.doesNotMatch(en.text, /להשלים/);
  assert.match(guardEmail("זה עולה 500 שקל לחודש", "", "he").text, /\[להשלים: מחיר\]/);
  assert.equal(neutralizeLinks("write to a@evil.example or call +1 202 555 0143", "", "en").text, "write to [fill in: email] or call [fill in: phone]");
  assert.equal(fixGreeting("Hi Dana,\nthanks", "x", []), "Hi,\nthanks", "an English greeting name needs the same proof");
  assert.equal(fixGreeting("Hi Dana,\nthanks", "Dana here, Dana there", []), "Hi Dana,\nthanks");
});

test("notes, tips, topic, frame and self-check prompts: language line for English and Hebrew calls", () => {
  assert.match(notesSystem("en"), /an English call/);
  assert.match(notesSystem("en"), /Rules: English/);
  assert.match(notesSystem("en"), /You promised:/);
  assert.doesNotMatch(notesSystem("en"), /הבטחת|דנה/);
  assert.match(notesSystem("he"), /Rules: Hebrew/);
  assert.match(notesSystem("he"), /הבטחת:/);
  assert.ok(notesSystem("en").includes("You keep short live notes"));

  assert.match(tipsSystem("en"), /plain English/);
  assert.doesNotMatch(tipsSystem("en"), /"הם"|one sentence, Hebrew/);
  assert.match(tipsSystem("he"), /one sentence, Hebrew/);
  assert.ok(tipsSystem("en").includes("You write at most one live tip"));

  assert.match(topicSystem("en"), /ONE short English line/);
  assert.doesNotMatch(topicSystem("en"), /איזה|Hebrew/);
  assert.match(topicSystem("he"), /ONE short Hebrew line/);

  assert.match(selfcheckSystem("en"), /the correct fact, English/);
  assert.doesNotMatch(selfcheckSystem("en"), /Hebrew|שאל/);
  assert.match(selfcheckSystem("he"), /the correct fact, Hebrew/);
  assert.match(selfcheckSystem("he"), /addressed to/);
});

test("local tips and self-check nudges: English line gets English text that passes the guards", () => {
  const r = { me: 90, total: 100, ratio: 0.9 };
  for (const interview of [false, true]) {
    const en = talkTip(r, 0.75, interview, "en")!;
    assert.match(en.text, /^You are talking about 90% of the time/);
    assert.equal(guard(en.text).ok, true, en.text);
    assert.match(talkTip(r, 0.75, interview)!.text, /^אתה מדבר כ-90%/);
  }
  const frame = {
    kind: "client" as const,
    topic: "t",
    goal: "g",
    people: [],
    entities: [],
    checklist: [{ item: "Ask about backups", done: false, must: true }],
  };
  const o = { latestText: "talk soon", elapsedMin: 1, wrapUpAfterMin: 20, alreadyNudged: false };
  const en = wrapUpTip(frame, { ...o, lang: "en" })!;
  assert.match(en.text, /^Before you finish, you have not covered yet: Ask about backups/);
  assert.equal(guard(en.text).ok, true);
  assert.match(wrapUpTip(frame, o)!.text, /^לפני שמסיימים/);

  assert.match(detectCareful("I promise the site will be ready without any problem")!.say, /^You promised something/);
  assert.match(detectCareful("אני מבטיח שהאתר יעלה בלי שום תקלה")!.say, /^הבטחת/);
  assert.match(detectCareful("אני מבטיח שהאתר יעלה בלי שום תקלה", "en")!.say, /^You promised something/, "stt en decides");
});

// The model functions pick the prompt language from their own transcript; check what they really send.
const registry: any = { resolve: async () => ({}) };
const base = { registry, model: "anthropic:claude-haiku-5-5", signal: new AbortController().signal, timeoutMs: 1000 };
const spy = () => {
  const seen: string[] = [];
  const generate: any = async (o: any) => {
    seen.push(o.instructions.content);
    return { text: "NONE", output: { summary: ["x"], decisions: [], nextSteps: [], openQuestions: [], followUpEmail: "" }, usage: {} };
  };
  return { seen, generate };
};

test("run functions send an English prompt for an English transcript and a Hebrew prompt for a Hebrew one", async () => {
  for (const [name, transcript, want] of [
    ["en", EN, /English/],
    ["he", HE, /Hebrew/],
  ] as const) {
    const s = spy();
    const common = { ...base, generate: s.generate };
    const lines = transcript.split("\n");
    await takeNotes({ ...common, existing: [], lines });
    await runTopic({ ...common, lines });
    await runTip({ ...common, cache: "off", transcript, contextNotes: [], background: "", factLines: [], given: [], elapsedMin: 3 });
    await runSelfCheck({ ...common, cache: "off", background: "BG", transcript, line: lines[2].replace(/^me: /, "") });
    assert.equal(s.seen.length, 4, name);
    for (const sys of s.seen) assert.match(sys, want, `${name}: ${sys.slice(0, 60)}`);
    if (name === "en")
      for (const sys of s.seen)
        assert.doesNotMatch(
          sys,
          /Hebrew for topic|ONE short Hebrew|Rules: Hebrew|a Hebrew (call|meeting)|one sentence, Hebrew|correct fact, Hebrew|הבטחת|דנה|איזה תוכן/,
          "no Hebrew instruction in an English prompt",
        );
  }
});

test("run functions: stt.language en forces English even for a short or empty transcript", async () => {
  const s = spy();
  await takeNotes({ ...base, generate: s.generate, existing: [], lines: ["them: ok"], sttLanguage: "en" });
  assert.match(s.seen[0], /an English call/);
  await takeNotes({ ...base, generate: s.generate, existing: [], lines: ["them: ok"] });
  assert.match(s.seen[1], /a Hebrew call/);
});

test("generateSummary: English transcript gets the English summary prompt, Hebrew transcript the Hebrew one", async () => {
  const run = async (text: string) => {
    const s = spy();
    await generateSummary({ ...base, data: { lines: [{ ch: "them", text }], contextNotes: [], aiNotes: [] }, generate: s.generate });
    return s.seen[0];
  };
  assert.match(await run("Hello, my website is very slow and I need help with the backups today"), /The meeting was in English/);
  assert.match(await run("שלום, האתר שלי איטי מאוד ואני צריכה עזרה עם הגיבויים"), /The meeting was in Hebrew/);
});

test("scripted doubles still answer the new English prompts", () => {
  const prompt = (sys: string, t: string) => `${sys}\n<call_transcript>\n${t}\n</call_transcript>`;
  assert.match(scriptedAnswer(prompt(notesSystem("en"), "them: my site is slow")), /^- The client wants/);
  assert.match(scriptedAnswer(prompt(tipsSystem("en"), "them: what about backups")), /Ask where the backups/);
  assert.match(scriptedAnswer(prompt(summarySystem("en"), "them: my site is slow")), /Hi Dana/);
});

test("callLanguage with multi/auto: decided once, kept across batches, changed only by two strong verdicts in a row", () => {
  resetCallLang();
  const heLong = "אנחנו רוצים לשפר את האתר שלנו לפני הקמפיין ולהבין כמה זמן זה ייקח וגם מה העלות של התחזוקה החודשית";
  assert.equal(callLanguage("Yes sure.", "auto"), "he", "too little text: default");
  assert.equal(callLanguage(heLong, "multi"), "he");
  // short English batches of names do not flip a Hebrew call
  for (const b of ["Salesforce HubSpot integration", "SAP NetSuite Oracle Workday Coupa", "Yes sure."]) assert.equal(callLanguage(b, "auto"), "he", b);
  const enA = "Hi, my website is very slow and I need to know about backups and how long a migration would take for us";
  const enB = "Sure, let me look at the hosting setup first and then we can talk about the plan and the monthly maintenance";
  assert.equal(callLanguage(enA, "multi"), "he", "one English verdict is not enough");
  assert.equal(callLanguage(enA, "multi"), "he", "the same text again is not new evidence");
  assert.equal(callLanguage(enB, "multi"), "en", "second strong verdict flips");
  assert.equal(callLanguage("שלום", "multi"), "en", "stays");
  resetCallLang();
  assert.equal(callLanguage(enA, "auto"), "en", "first verdict of an English call");
  assert.equal(callLanguage(heLong, "auto"), "en");
  // stt.language "en" and the plain rule are unchanged
  assert.equal(callLanguage("hi", "en"), "en");
  assert.equal(callLanguage(heLong), "he");
});
