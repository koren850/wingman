// Stage 0b helpers: echo filter and mic gate (echo.ts), spoken digits/phones/emails (capture.ts),
// client and domain spotting (entities.ts), call notes and brief coverage. All fixtures are made-up data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EchoFilter, MicGate, overlap } from "./echo.ts";
import { extract, digitWords, spokenToSymbols } from "./capture.ts";

test("echo: overlap counts the mic line's words found in the client line", () => {
  assert.equal(overlap("כמה עולה האחסון", "כמה עולה האחסון אצלכם"), 1);
  assert.equal(overlap("אני חושב שזה בסדר", "כמה עולה האחסון"), 0);
});
test("echo filter drops a repeat of the client within the window, keeps Dan's own words", () => {
  const f = new EchoFilter({ windowMs: 2500, threshold: 0.8 });
  f.noteThem("כמה עולה האחסון אצלכם לחודש", 1000);
  assert.ok(f.isEcho("כמה עולה האחסון אצלכם", 2000).echo);
  assert.ok(!f.isEcho("זה תלוי בגודל האתר", 2000).echo);
  assert.ok(!f.isEcho("כמה עולה האחסון אצלכם", 5000).echo, "outside the window");
  assert.ok(!f.isEcho("אתה שואל כמה עולה אחסון", 2000).echo, "Dan repeating the question back is kept");
  f.noteThem("כן", 1500);
  assert.ok(!f.isEcho("כן", 1600).echo, "short lines are never dropped");
});
test("mic gate closes while the client is voiced, plus the hangover", () => {
  const g = new MicGate({ hangoverMs: 400, peak: 0.02 });
  assert.ok(!g.closed(0));
  g.noteThemPeak(0.01, 100); assert.ok(!g.closed(150), "below the peak");
  g.noteThemPeak(0.3, 200); assert.ok(g.closed(300)); assert.ok(g.closed(599)); assert.ok(!g.closed(601));
});

test("capture: Hebrew digit words become digits", () => {
  assert.equal(digitWords("המספר שלי אפס חמש ארבע אחת שתיים שלוש ארבע חמש שש שבע"), "המספר שלי 0541234567");
  assert.equal(digitWords("אפס חמש שתיים 123 4567"), "0521234567");
});
test("capture: spoken @ and dot", () => {
  assert.match(spokenToSymbols("דן שטרודל ג'ימייל נקודה קום"), /\u0001\s+gmail\s+\u0002\s+com/);
});
test("capture: phones (digits, words, +972), emails and domains", () => {
  const v = (t: string) => extract(t).map((c) => `${c.kind}:${c.value}`);
  assert.deepEqual(v("תתקשר אליי ל 054-1234567"), ["phone:054-1234567"]);
  assert.deepEqual(v("אפס חמש ארבע אחת שתיים שלוש ארבע חמש שש שבע"), ["phone:054-1234567"]);
  assert.deepEqual(v("+972 54 123 4567"), ["phone:054-1234567"]);
  assert.deepEqual(v("המשרד 03-6123456"), ["phone:03-6123456"]);
  assert.deepEqual(v("תשלח ל dana@acme.co.il בבקשה"), ["email:dana@acme.co.il"]);
  assert.deepEqual(v("dana שטרודל gmail נקודה com"), ["email:dana@gmail.com"]);
  assert.deepEqual(v("האתר הוא shop.example.co.il והוא איטי"), ["domain:shop.example.co.il"]);
  assert.deepEqual(v("www.example.co.il"), ["domain:example.co.il"]);
  assert.deepEqual(v("acme נקודה קו נקודה איל"), ["domain:acme.co.il"]);
});
test("capture: no false hits on plain talk, prices or short numbers", () => {
  assert.deepEqual(extract("זה יעלה בערך 1500 שקל לחודש"), []);
  assert.deepEqual(extract("יש לי שתי שאלות על האתר"), []);
  assert.deepEqual(extract("גרסה 5.5 של וורדפרס"), []);
  assert.deepEqual(extract("שבע שנים אנחנו איתכם"), []);
  assert.deepEqual(extract("meet at shop.co.il tomorrow").map((c) => c.kind), ["domain"], "English 'at' is not an email");
  assert.deepEqual(extract("אני משתמש ב ChatGPT. AI זה טוב"), [], "a full stop is not a domain dot");
  assert.deepEqual(extract("ok. me and you"), []);
  assert.deepEqual(extract("7770541234567"), [], "no phone inside a longer number");
  assert.deepEqual(extract("4500 8000 2000"), [], "prices are not a phone");
  assert.deepEqual(extract("5 0 8 1 2 3 4 5 6 7"), [], "a spaced ID is not a phone");
});

import { EntitySpotter, daysUntil } from "./entities.ts";
import { parseNotes, dedupeNotes } from "./notes.ts";
import { covered, briefNotes } from "./brief.ts";

const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
const snap = {
  clients: [
    { id: 1, name: "אקמה בע\"מ", aliases: ["אקמה", "acme"] },
    { id: 2, name: "ica", aliases: ["ica"] },
  ],
  domains: [
    { domain: "acme.co.il", clientId: 1, server: "s1", cms: "wordpress", cmsVersion: "6.8", php: "8.2", sslExpires: soon },
    { domain: "example-b.co.il", clientId: null, server: "s2", cms: null, php: "8.1", sslExpires: "2027-06-01" },
  ],
};
test("facts: client by alias (Hebrew prefix), domain by name or base word, SSL warning", () => {
  const s = new EntitySpotter(snap as any, { sslWarnDays: 30, minAliasLen: 4 });
  const f = s.spot("אני מתקשר מאקמה לגבי האתר");
  assert.equal(f.length, 1); assert.equal(f[0].kind, "client"); assert.ok(f[0].warn);
  assert.match(f[0].lines[0], /acme\.co\.il · wordpress 6\.8 · PHP 8\.2 · ⚠ SSL פג בעוד \d+ ימים/);
  const d = s.spot("יש בעיה באתר example-b");
  assert.equal(d[0].key, "d:example-b.co.il"); assert.ok(!d[0].warn);
  assert.equal(s.spot("כן, acme.co.il").length, 1, "domain of a spotted client is folded into the client card");
  assert.deepEqual(s.spot("ica"), [], "aliases shorter than minAliasLen never match");
  assert.deepEqual(s.spot("שלום מה שלומך"), []);
  assert.ok(daysUntil(soon) <= 10);
});
test("notes: parse, NONE, dedupe", () => {
  assert.deepEqual(parseNotes("NONE"), []);
  assert.deepEqual(parseNotes("- תקציב בערך 20 אלף\n- רוצים לפני פסח\nסתם שורה"), ["תקציב בערך 20 אלף", "רוצים לפני פסח"]);
  assert.equal(parseNotes("- הערה אחת\n- הערה שתיים\n- הערה שלוש").length, 2, "at most 2 per round");
  assert.deepEqual(dedupeNotes(["תקציב בערך 20 אלף שקל", "האתר על וויקס"], ["תקציב בערך 20 אלף"]), ["האתר על וויקס"]);
});
test("brief: notes and must-cover coverage", () => {
  assert.deepEqual(briefNotes({ who: "דנה מאקמה", goal: "הצעת מחיר לחנות", notes: ["לקוחה חדשה"] }), ["On this call: דנה מאקמה", "Goal of the call: הצעת מחיר לחנות", "לקוחה חדשה"]);
  assert.ok(covered("תקציב", "ומה התקציב שלכם לפרויקט"));
  assert.ok(covered("חידוש אחסון", "צריך לדבר על חידוש האחסון בדצמבר"));
  assert.ok(!covered("לוח זמנים", "דיברנו על התקציב"));
  assert.ok(covered("גיבויים", "אני רוצה לדעת אם יש לכם גיבוי של האתר"));
  assert.ok(!covered("גיבויים", "האתר איטי"));
  assert.ok(covered("מחירים", "מה המחיר של זה"));
  assert.ok(covered("שרתים", "על איזה שרת האתר"));
  assert.ok(!covered("UX", "דיברנו על התקציב"), "short items are not auto-covered");
  assert.ok(covered("UX", "ה UX של האתר"));
});
import { domainBase, aliasMatch } from "./entities.ts";
test("facts: domain base and exact alias matching", () => {
  assert.equal(domainBase("staging.example-c.com"), "example-c");
  assert.equal(domainBase("tender.example-b.co.il"), "example-b");
  assert.ok(aliasMatch("אני מתקשר מסייפלט", "סייפלט"));
  assert.ok(!aliasMatch("CDN שמגן על האתר", "המגן"), "no prefix stripping on the alias side");
});
