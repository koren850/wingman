// Pure-logic fundamentals: normalize.ts, detector.ts, guards.ts, bank.ts matching and the reflex tag parser. Offline, no fixtures.
// Later imports sit mid-file, next to the tests that use them.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, containsPhrase } from "./normalize.ts";
import { detect } from "./detector.ts";
import { guard, sanitize } from "./guards.ts";
import { loadBank, matchBank } from "./bank.ts";
import { parseTag } from "./reflex.ts";

test("normalize folds finals, niqqud and punctuation", () => {
  assert.equal(normalize("אֵיךְ?"), "איכ");
  assert.equal(normalize("SSL-ה"), "ssl ה");
});
test("phrase match strips Hebrew prefixes", () => {
  assert.ok(containsPhrase("הבעיה בדומיין שלי", "דומיין"));
  assert.ok(containsPhrase("מה עם הגיבויים", "גיבויים"));
});
test("detector: short Hebrew questions and fillers", () => {
  assert.ok(detect("כמה זה עולה").isQuestion);
  assert.ok(detect("איך אני מחדש את הדומיין").isQuestion);
  assert.ok(!detect("כן").isQuestion);
  assert.ok(!detect("אוקיי רגע").isQuestion);
  assert.ok(!detect("מה שלומך היום").isQuestion);
});
test("guards block prices, dates and promises", () => {
  assert.equal(guard("זה עולה 500 ₪").ok, false);
  assert.equal(guard("נסיים עד יום חמישי").ok, false);
  assert.equal(guard("אני מבטיח שזה יעבוד").ok, false);
  assert.equal(guard("DNS מתעדכן בדרך כלל תוך כמה שעות").ok, true);
});
test("sanitize removes bidi overrides but keeps isolates", () => {
  assert.equal(sanitize("‮abc"), "abc");
  assert.equal(sanitize("⁧abc⁩"), "⁧abc⁩");
});
test("bank loads and matches a DNS question", () => {
  const bank = loadBank();
  assert.ok(bank.length >= 30);
  assert.ok(matchBank("תסביר לי איך DNS עובד", bank));
});
test("tag parser", () => {
  assert.deepEqual(parseTag("BANK dns-basics"), { kind: "BANK", bankId: "dns-basics" });
  assert.equal(parseTag("ANS").kind, "ANS");
  assert.equal(parseTag("whatever").kind, "SKIP");
});

// ---- Regression tests for earlier verification fixes (ids B6, D1... name the original findings) ----
import { speechEndWall } from "./providers/stt/types.ts";
import { parseReflex } from "./reflex.ts";
import { tokenVariants } from "./normalize.ts";

test("B6 guards: relative dates, number-word prices, free/discount, zero-downtime", () => {
  for (const t of [
    "נטפל בזה תוך שעה",
    "זה יהיה מוכן תוך יומיים",
    "נחזור בעוד שבוע",
    "נטפל בזה היום",
    "נסיים עוד היום",
    "זה עולה אלף שקל",
    'בערך מאתיים ש"ח',
    "חמש מאות דולר",
    "אפשר בחינם",
    "נעשה לכם הנחה",
    "ללא עלות",
    "אפס השבתה",
    "בלי סיכון",
  ]) {
    assert.equal(guard(t).ok, false, t);
  }
  assert.equal(guard("DNS מתעדכן בדרך כלל תוך כמה שעות").ok, true);
  assert.equal(guard("יש גרסה חינמית של התעודה").ok, true);
});
test("D1 detector: request/multi cues beat negative openers", () => {
  assert.ok(detect("האתר שלי קורס כל פעם ואני לא מבין מה קורה ... מה אפשר לעשות").isQuestion);
  assert.ok(detect("אני לא יודע, האתר איטי מה אפשר לעשות").isQuestion);
  assert.ok(detect("מה שלומך אתה יכול לבדוק את הגיבוי").isQuestion);
  assert.ok(!detect("אני ממש לא מבין למה זה קורה לי").isQuestion);
  assert.ok(!detect("מה שלומך היום").isQuestion);
  assert.ok(!detect("שאלתי את זה כבר את המתכנת").isQuestion);
});
test("D6 detector: elliptical cues, stall-bank override, problem statement with strong bank hit", () => {
  assert.ok(detect("זה אפשרי").isQuestion);
  assert.ok(detect("אתם עובדים עם וורדפרס").isQuestion);
  assert.ok(detect("עלות של האתר", { stall: true }).isQuestion);
  assert.equal(detect("האתר שלי קורס כל פעם", { bankScore: 2 }).reason, "problem:bank");
  assert.ok(!detect("האתר הישן היה ב Wix", { bankScore: 1 }).isQuestion);
});
test("D2 phrase match ignores possessives and fillers", () => {
  assert.ok(containsPhrase("האתר שלי נפל", "האתר נפל"));
  assert.ok(containsPhrase("האתר שלי לא עולה", "האתר לא עולה"));
});
test("D3 prefixes: Latin remainder, every strip length, no להעלות -> עלות", () => {
  assert.ok(containsPhrase("הPHP שלי ישן", "php"));
  assert.ok(containsPhrase("אני בWix", "wix"));
  assert.ok(containsPhrase("עברתי מוויקס", "וויקס"));
  assert.ok(!containsPhrase("רוצה להעלות תמונה", "עלות"));
  assert.ok(tokenVariants("לה").length === 1);
});
const B = () => loadBank();
const top = (t: string) => matchBank(t, B())?.card.id;
test("D4 bank: stall tier, single-token weight, new triggers", () => {
  assert.equal(top("איך מחדש את הדומיין"), "domain-renewal");
  assert.equal(top("כמה עולה לכם תחזוקה"), "stall-price");
  assert.equal(top("כמה זה עולה להעביר את האתר שלי אליכם"), "stall-price");
  assert.equal(top("כמה זמן ייקח להעביר"), "stall-timeline");
  assert.equal(top("מעבירים דומיין"), "domain-transfer");
  assert.equal(top("על שם מי רשום הדומיין"), "domain-owner");
});
test("D5 bank: missing triggers now hit", () => {
  assert.equal(top("האתר נטען ממש לאט"), "site-slow");
  assert.equal(top("נפרצו לנו"), "hacked-site");
  assert.equal(top("אתם עושים הנגשה"), "accessibility");
  assert.equal(top("בית סליקה זה מה"), "woo-payments");
  assert.equal(top("תעודת אבטחה פגה"), "ssl-basics");
  assert.equal(top("האתר שלי נפל"), "site-down");
});
test("bank is valid: unique ids, say <= 25 words, 2-3 facts of <= 8 words, no singular address", () => {
  const bank = B(); // loadBank throws on duplicate ids
  const ids = new Set(bank.map((c) => c.id));
  assert.equal(ids.size, bank.length);
  assert.ok(ids.has("domain-renewal"));
  for (const c of bank) {
    assert.ok(c.say.split(/\s+/).length <= 25, `${c.id} say too long`);
    assert.ok(c.facts.length >= 2 && c.facts.length <= 3, `${c.id} fact count`);
    for (const f of c.facts) assert.ok(f.split(/\s+/).length <= 8, `${c.id} fact too long: ${f}`);
    for (const t of [c.say, ...c.facts, ...(c.alts ?? [])]) assert.ok(!/(אליך|שלך|אצלך|עליך)(?![א-ת])/.test(t), `${c.id} singular address: ${t}`);
    assert.equal(guard(c.say).ok, true, `${c.id} say trips the guard: ${c.say}`);
  }
  assert.ok(!bank.some((c) => c.triggers.includes("בית סוכן")));
});
test("B1 reflex output parser: empty lines, markdown tag, facts, say-less reply", () => {
  assert.deepEqual(parseTag("**ANS**"), { kind: "ANS" });
  assert.deepEqual(parseTag("BANK: dns-basics"), { kind: "BANK", bankId: "dns-basics" });
  assert.deepEqual(parseTag("`bank` ssl-basics"), { kind: "BANK", bankId: "ssl-basics" });
  const p = parseReflex("ANS\n\nשלום עולם\n\n- עובדה אחת\n- עובדה שתיים\n", true);
  assert.equal(p.tagLine, "ANS");
  assert.equal(p.say, "שלום עולם");
  assert.deepEqual(p.facts, ["עובדה אחת", "עובדה שתיים"]);
  assert.equal(parseReflex("STALL", true).say, undefined);
  assert.equal(parseReflex("ANS\n- fact only\n", true).say, undefined);
  const mid = parseReflex("ANS\nחצי משפ", false);
  assert.equal(mid.say, "חצי משפ");
  assert.equal(mid.sayComplete, false);
});
test("B5 speechEndWall re-anchors per connection and falls back when implausible", () => {
  assert.equal(speechEndWall(10_000, 5.0, 4.5), 9_500); // 0.5 s of audio not yet transcribed
  assert.equal(speechEndWall(10_000, 1.0, 40), 9_600); // word end beyond what was sent -> fallback
  assert.equal(speechEndWall(10_000, 100, 1), 9_600); // stale anchor -> fallback
});
test("B2 stt send never throws and counts drops when the socket is not open", async () => {
  const { DeepgramStream: SttStream } = await import("./providers/stt/deepgram.ts");
  const s = new SttStream({ apiKey: "x", channel: "them" });
  assert.equal(s.send(Buffer.alloc(3200)), false);
  assert.equal(s.dropped, 1);
  assert.equal(s.audioSeconds, 0);
});

test("reflex parse: thinking out loud before the verdict never picks a card", () => {
  const ramble = "BANK sales-tell-me-about-yourself is not in the list; the question is technical. Interview mode: technical question → ANS.";
  const p = parseReflex(`${ramble}\n\nANS\nאחבר דרך ה-API של ה-CRM עם webhook\n- הרשאות לפי משתמש\n`, true);
  assert.equal(p.tagLine, "ANS");
  assert.equal(p.say, "אחבר דרך ה-API של ה-CRM עם webhook");
  assert.deepEqual(p.facts, ["הרשאות לפי משתמש"]);
  assert.equal(parseTag(parseReflex(ramble, true).tagLine!).kind, "SKIP"); // no real verdict: SKIP, never a guessed card
  assert.equal(parseReflex(`${ramble}\n`, false).tagLine, undefined); // streaming: wait for the real verdict
  assert.deepEqual(parseTag(parseReflex("BANK about-you\n", true).tagLine!), { kind: "BANK", bankId: "about-you" });
  assert.deepEqual(parseTag(parseReflex("**BANK salary**\n", true).tagLine!), { kind: "BANK", bankId: "salary" });
  assert.equal(parseReflex("BANK dns-basics: say this\n", true).say, "say this");
});

test("reflex parse: a labelled say-line shows only the words", () => {
  assert.equal(parseReflex('ANS\nSay: "I added a verifier step."\n- fact\n', true).say, "I added a verifier step.");
  assert.equal(parseReflex("ANS\nתגיד: חודש מקבלת הצעה\n", true).say, "חודש מקבלת הצעה");
  assert.equal(parseReflex("ANS\nSayings differ: keep this\n", true).say, "Sayings differ: keep this");
});

test("a question cut off mid-phrase waits for the rest", () => {
  assert.equal(detect("יש לך ניסיון עם").reason, "unfinished");
  assert.equal(detect("do you have experience with").isQuestion, false);
  assert.equal(detect("tell me about the").isQuestion, false);
  assert.equal(detect("יש לך ניסיון עם פייתון").isQuestion, true);
  assert.equal(detect("יש לך ניסיון עם?").isQuestion, true); // a "?" still counts
});
