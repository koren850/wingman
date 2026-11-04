// Answer behaviour: Wingman never speaks for the user on calls that are not with their customer; BANK is id-only; late SKIP / wrong language discard;
// me-answer prompt (clock, solo, short); tips (masculine, personal = none); summary (no "לקוח" on other calls, untrusted names). Offline: scripted doubles only.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrefix, runReflex, resolveBankId, worldClock, reflexUserMessage, nowText, wrongLanguage, langOf, type ReflexHandlers } from "./reflex.ts";
import { isAgencyTopic, type Frame } from "./frame.ts";
import { classify, MeGate, classifySystem } from "./assist.ts";
import { parseTip, masculine, runTip, wrapUpTip, tipsSystem } from "./tips.ts";
import { parseSummary, fixGreeting, otherName, buildPrompt, summarySystem, kindGuidance } from "./summary.ts";
import { ModelRegistry } from "./providers/llm.ts";
import { loadSettings } from "./settings.ts";

const S = loadSettings({ env: {}, userFile: "/nonexistent/x.yaml" }).settings;
const reg = { resolve: async (ref: string) => ({ ref }) } as unknown as ModelRegistry;
const stream = (chunks: string[]) => ((opts: any) => { stream.last = opts; return { textStream: (async function* () { for (const c of chunks) yield c; })(), finishReason: Promise.resolve("stop"), usage: Promise.resolve({}), providerMetadata: Promise.resolve({}) }; }) as any;
stream.last = undefined as any;
async function run(chunks: string[], extra: Record<string, unknown> = {}) {
  const log: string[] = [];
  const h: ReflexHandlers = { onTag: (t) => log.push(`tag:${t.kind}${t.bankId ? " " + t.bankId : ""}`), onSay: () => {}, onFacts: (f) => log.push(`facts:${f.length}`), onSayComplete: (s) => log.push(`say:${s}`), onDone: () => log.push("done"), onDiscard: (w) => log.push(`discard:${w}`) };
  await runReflex({ registry: reg, models: ["anthropic:a"], cfg: S.llm.reflex, prefix: "p", transcript: "t", question: "מתי אנחנו סוגרים את הגרסה?", signal: new AbortController().signal, h, stream: stream(chunks), ...extra });
  return log;
}

test("reflex prompt: id-only BANK, STALL only on client calls, never answer for Dan, decide before line 1", () => {
  const p = buildPrefix("style", [{ id: "dns", title: "DNS basics", triggers: ["dns"], say: "SAYLINE-NOT-IN-PROMPT", facts: ["FACT-NOT-IN-PROMPT"] }], "", "");
  assert.match(p, /- dns: DNS basics/); assert.doesNotMatch(p, /SAYLINE-NOT-IN-PROMPT|FACT-NOT-IN-PROMPT/);
  assert.match(p, /Output ONLY "BANK <id>"/);
  assert.match(p, /STALL is only for a price, a date or a commitment about Dan's own services, on a call with Dan's customer/);
  assert.match(p, /Never answer yes\/no on Dan's behalf/); assert.match(p, /BEFORE you write line 1/);
  assert.match(p, /Dan's documents, experience, skills, availability/); assert.match(p, /why Dan left a job/);
  assert.match(p, /at most 15 words/); assert.match(p, /opinions or recommendations/);
  assert.doesNotMatch(p, /sales pitch|upsell|convert the lead/i);
});

test("reflex: BANK reply is the id only, text after it is ignored; late SKIP discards the card; wrong language discards ANS", async () => {
  assert.deepEqual(await run(["BANK dns-basics\nשורה שהמודל הוסיף\n- עובדה\n"]), ["tag:BANK dns-basics", "done"]);
  assert.deepEqual(await run(["STALL\nSKIP\n"]), ["tag:STALL", "discard:late-skip", "done"]);
  assert.deepEqual(await run(["BANK woo-payments\n", "SKIP\n"]), ["tag:BANK woo-payments", "discard:late-skip", "done"]);
  assert.deepEqual(await run(["ANS\nThis is an English answer to a Hebrew question\n- fact\n"]), ["tag:ANS", "discard:language", "done"]);
  assert.deepEqual(await run(["ANS\nזה תהליך שבו כל שינוי נבדק\n- עובדה\n"]), ["tag:ANS", "say:זה תהליך שבו כל שינוי נבדק", "facts:1", "facts:1", "done"]);   // facts are re-sent on every delta and once at the end (run.ts upserts)
  assert.deepEqual(await run(["ANS\nSkip the details, it is fine\n"], { question: "Is it ok?" }), ["tag:ANS", "say:Skip the details, it is fine", "done"]);   // lower-case "Skip" in an answer is not a SKIP line
  assert.ok(wrongLanguage("מה זה API?", "It is an interface")); assert.ok(!wrongLanguage("מה ההבדל בין staging ל-production?", "סביבת staging היא עותק של האתר")); assert.ok(wrongLanguage("what is staging?", "סביבה נפרדת לבדיקות")); assert.ok(!wrongLanguage("what is staging?", "A test copy of the site (staging)")); assert.ok(!wrongLanguage("מה זה API?", "ממשק בין תוכנות, API")); assert.equal(langOf("123"), undefined);
});

test("reflex ME mode: no facts, short token cap, clock in the user message, solo flag", async () => {
  const log = await run(["ANS\nהתשובה היא 8.\n- עובדה\n"], { asker: "me", question: "מה השעה בניו יורק?", maxTokens: 100, solo: true, now: new Date("2026-11-02T13:00:00Z") });
  assert.deepEqual(log, ["tag:ANS", "say:התשובה היא 8.", "done"]);   // facts never forwarded for ME answers
  assert.equal(stream.last.maxOutputTokens, 100);
  const msg = stream.last.messages[0].content as string;
  assert.match(msg, /Monday, 2 November 2026|2 November 2026/); assert.match(msg, /15:00/); assert.match(msg, /Europe\/Athens, UTC\+2/);
  assert.match(msg, /Dan is alone/); assert.match(msg, /at most 15 words/);
});

test("nowText: Athens winter and summer offsets", () => {
  assert.match(nowText(new Date("2026-11-02T13:00:00Z")), /15:00 \(Europe\/Athens, UTC\+2\)/);
  assert.match(nowText(new Date("2026-07-01T13:00:00Z")), /16:00 \(Europe\/Athens, UTC\+3\)/);
});

test("user message: off-kind calls are told no STALL / BANK", () => {
  const m = reflexUserMessage({ transcript: "x", question: "מי מכסה אותה?", noAgency: true });
  assert.match(m, /NOT a call with Dan's own customer: never reply STALL/);
  assert.doesNotMatch(reflexUserMessage({ transcript: "x", question: "q" }), /NOT a call/);
});

test("agency topic: team and interview questions are not, hosting questions are", () => {
  for (const q of ["מתי אנחנו סוגרים את הגרסה?", "מי מכסה אותה?", "יש לך חשבונית?", "אני תקוע על ה-API של התשלומים", "יש לך שאלות אלינו?"]) assert.equal(isAgencyTopic(q), false, q);
  for (const q of ["כמה יעלה לי אחסון לאתר?", "מה זה DNS?", "do you do WordPress hosting"]) assert.equal(isAgencyTopic(q), true, q);
});

test("classifier shares the reflex system prompt (one cached prefix) and keeps its task in the user message", async () => {
  let seen: any;
  const generate: any = async (o: any) => { seen = o; return { text: "ASSIST", usage: {}, providerMetadata: {} }; };
  const r = await classify({ registry: reg, model: "anthropic:claude-haiku-5-5", cache: "1h", system: "REFLEX-PREFIX", text: "מה אתה חושב על Cloudflare?", recent: "", solo: false, themQuietMs: 0, signal: new AbortController().signal, timeoutMs: 1000, generate });
  assert.equal(r.verdict, "ASSIST"); assert.equal(seen.instructions.content, "REFLEX-PREFIX");
  assert.deepEqual(seen.instructions.providerOptions, { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } });
  assert.match(seen.messages[0].content, /You decide who Dan is talking to/);
  assert.match(classifySystem(), /opinion or recommendation/);
});

test("MeGate: calc ignores the protect-them window, other answers do not", () => {
  const g = new MeGate({ minGapMs: 0, maxPerMin: 6, protectThemMs: 15000 });
  assert.deepEqual(g.check(1000, { forced: false, lastThemCardAt: 500, calc: true }), { ok: true });
  assert.equal((g.check(1000, { forced: false, lastThemCardAt: 500 }) as any).why, "protect-them");
});

test("tips: masculine form, garbled-term and personal rules in the prompt, no model call on a friend call", async () => {
  assert.equal(parseTip(JSON.stringify({ type: "ask", text: "שאלי את יעל איזו מערכת היא רוצה ובדקי את ההיקף" }))!.text, "שאל את יעל איזו מערכת היא רוצה ובדוק את ההיקף");
  assert.equal(masculine("שאלי ושאלה"), "שאל ושאלה");   // only whole-word imperatives
  assert.match(tipsSystem(), /masculine/); assert.match(tipsSystem(), /"personal"/); assert.match(tipsSystem(), /garbled/);
  let called = false;
  const fr: Frame = { kind: "personal", topic: "t", goal: "g", people: [], entities: [], checklist: [{ item: "x", done: false, must: true }] };
  const r = await runTip({ registry: reg, model: "anthropic:a", cache: "off", frame: fr, transcript: "t", contextNotes: [], background: "", factLines: [], given: [], elapsedMin: 3, signal: new AbortController().signal, timeoutMs: 1000, generate: (async () => { called = true; return { text: "{}" }; }) as any });
  assert.equal(r.tip, undefined); assert.equal(called, false);
  assert.equal(wrapUpTip(fr, { latestText: "להתראות", elapsedMin: 1, wrapUpAfterMin: 20, alreadyNudged: false }), undefined);
});

const team: Frame = { kind: "team", topic: "t", goal: "g", people: [{ who: "וורד", role: "מנהלת" }, { who: "me", role: "דן" }], entities: [], checklist: [] };
test("summary: no 'לקוח' on non-client calls, names from the plan, greeting with an untrusted name is dropped", () => {
  const raw = { summary: ["א"], decisions: [], nextSteps: [{ who: "לקוח", what: "לשלוח מסמך" }, { who: "דן", what: "לחזור" }], openQuestions: [], followUpEmail: "" };
  assert.equal(parseSummary(raw, { frame: team })!.nextSteps[0].who, "וורד");
  assert.equal(parseSummary(raw, { frame: { ...team, people: [] } })!.nextSteps[0].who, "הצד השני");
  assert.equal(parseSummary(raw, { frame: { ...team, kind: "client" } })!.nextSteps[0].who, "לקוח");   // a client call keeps it
  assert.equal(parseSummary(raw)!.nextSteps[0].who, "לקוח");
  assert.equal(otherName(team), "וורד");
  const p = buildPrompt({ lines: [{ ch: "them", text: "שלום" }, { ch: "me", text: "היי" }], contextNotes: [], aiNotes: [], frame: team });
  assert.match(p, /וורד: שלום/); assert.match(p, /אני: היי/); assert.doesNotMatch(p, /לקוח: /);
  assert.match(summarySystem(), /Names: speech-to-text garbles names/); assert.match(kindGuidance("team"), /never "לקוח"/);
  // greeting
  assert.equal(fixGreeting("שלום אורג,\nתודה", "אורג אמר משהו\nוורד כתבה", ["Plan: פגישה עם וורד"]), "שלום,\nתודה");     // once, not in the notes
  assert.equal(fixGreeting("שלום וורד,\nתודה", "x", ["Plan: פגישה עם וורד"]), "שלום וורד,\nתודה");                               // in the notes
  assert.equal(fixGreeting("היי דנה,\nתודה", "דנה, דנה", []), "היי דנה,\nתודה");                                                // said twice
  assert.equal(fixGreeting("תודה על השיחה", "x", []), "תודה על השיחה");
});

test("BANK id: exact, bent id resolves to the one card sharing a word, ambiguous or unknown does not", () => {
  const b = (id: string) => ({ id, title: id, triggers: [], say: "", facts: [] });
  const bank = [b("builder-vs-wordpress"), b("wp-updates"), b("woo-payments"), b("site-slow"), b("site-down"), b("stall-price")];
  assert.equal(resolveBankId("woo-payments", bank)?.id, "woo-payments");
  assert.equal(resolveBankId("wordpress-basics", bank)?.id, "builder-vs-wordpress");
  assert.equal(resolveBankId("site-speed", bank)?.id, undefined);        // site-slow and site-down both share "site": ambiguous
  assert.equal(resolveBankId("stall", bank), undefined);
  assert.equal(resolveBankId(undefined, bank), undefined);
});

test("worldClock: New York is 7 h behind home time in November, Tokyo ahead", () => {
  const w = worldClock(new Date("2026-11-02T13:00:00Z"));   // 15:00 at home
  assert.match(w, /New York 08:00 \(7 h behind home time\)/); assert.match(w, /London 13:00 \(2 h behind home time\)/); assert.match(w, /Tokyo 22:00 \(7 h ahead of home time\)/);
});

test("MeGate: calc and solo answers are not rate-limited; others are", () => {
  const g = new MeGate({ minGapMs: 4000, maxPerMin: 2, protectThemMs: 15000 });
  for (let i = 0; i < 5; i++) { assert.equal(g.check(1000 + i * 100, { forced: false, lastThemCardAt: 0, calc: true }).ok, true); g.note(1000 + i * 100); }
  assert.equal(g.check(2000, { forced: false, lastThemCardAt: 0, solo: true }).ok, true);
  assert.equal(g.check(2000, { forced: false, lastThemCardAt: 0 }).ok, false);
});
