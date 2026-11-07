// The starter packs in data/starter-packs load, have every pack file, and pass the guards.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadBank, matchBank } from "./bank.ts";
import { guard } from "./guards.ts";
import { parseTopics, PACK_FILES } from "./pack.ts";
import { DATA } from "./env.ts";

const ROOT = join(DATA, "starter-packs");
const ids = readdirSync(ROOT).sort();
const HEBREW = /[\u0590-\u05ff]/;

test("starter packs: sales, support, interview and empty exist", () => {
  assert.deepEqual(ids, ["empty", "interview", "sales", "support"]);
});

for (const id of ids) {
  const dir = join(ROOT, id);
  test(`starter pack ${id}: has every pack file`, () => {
    for (const f of PACK_FILES) assert.ok(existsSync(join(dir, f)), f);
  });
  test(`starter pack ${id}: bank loads, every card is Hebrew with an English version, and passes the guards`, () => {
    const bank = loadBank(join(dir, "bank.yaml"));
    assert.ok(bank.some((c) => c.id === "stall"));
    if (id !== "empty") assert.ok(bank.length >= 14 && bank.length <= 24, `${bank.length} cards`);
    for (const c of bank) {
      assert.ok(c.en, `${c.id} has no English entry`);
      assert.match(c.say, HEBREW, `${id}/${c.id}: say is not Hebrew`);
      assert.doesNotMatch(c.en?.say ?? "", HEBREW, `${id}/${c.id}: English text has Hebrew letters`);
      for (const t of [c.say, ...c.facts, ...(c.alts ?? []), c.en?.say ?? ""]) assert.ok(guard(t).ok, `${id}/${c.id}: ${t}`);
      assert.ok(c.say.split(/\s+/).length <= 30, `${id}/${c.id}: say is too long`);
    }
    if (id !== "empty") {
      const own = bank.filter((c) => !c.id.startsWith("stall"));
      for (const c of own) assert.ok(c.triggers.length >= 3, `${id}/${c.id}: few triggers`);
    }
  });
  test(`starter pack ${id}: topics and keyterms parse`, () => {
    const t = parseTopics(readFileSync(join(dir, "topics.txt"), "utf8"));
    if (id !== "empty") assert.ok(t.loose);
    const terms = readFileSync(join(dir, "keyterms.txt"), "utf8")
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#"));
    if (id !== "empty") assert.ok(terms.length >= 10);
  });
}

test("starter packs: sample questions pick the expected cards", () => {
  const pick = (id: string, q: string) => matchBank(q, loadBank(join(ROOT, id, "bank.yaml")))?.card.id;
  assert.equal(pick("sales", "does it integrate with our CRM and slack"), "integrations");
  assert.equal(pick("sales", "how much does it cost"), "stall-price");
  assert.equal(pick("support", "I can't log in, I forgot my password"), "login");
  assert.equal(pick("interview", "tell me about a time you disagreed with a colleague"), "star-method");
  assert.equal(pick("interview", "what are your salary expectations"), "salary-practice");
});

test("starter packs: Hebrew sample questions pick the expected cards (also as speech to text writes them)", () => {
  const pick = (id: string, q: string) => matchBank(q, loadBank(join(ROOT, id, "bank.yaml")))?.card.id;
  assert.equal(pick("sales", "האם זה מתחבר גם ל-CRM וגם לסלאק"), "integrations");
  assert.equal(pick("sales", "האם זה מתחבר לסי אר אם שלנו"), "integrations");
  assert.equal(pick("sales", "האם זה עובד עם סי אר אם"), "integrations");
  assert.equal(pick("sales", "כמה זה עולה לנו בחודש"), "stall-price");
  assert.equal(pick("sales", "מתי אפשר להתחיל"), "stall-timeline");
  assert.equal(pick("sales", "אתם מתחייבים על זמינות"), "stall-guarantee");
  assert.equal(pick("sales", "יש לכם אס אס או"), "sso");
  assert.equal(pick("sales", "אפשר לעשות פיילוט קטן קודם"), "pilot");
  assert.equal(pick("sales", "איפה הנתונים שלנו נשמרים, מה לגבי גידיפיאר"), "privacy-gdpr");
  assert.equal(pick("support", "אני לא מצליח להתחבר, שכחתי סיסמה"), "login");
  assert.equal(pick("support", "הקוד לא מגיע אליי, החלפתי טלפון חדש"), "two-factor");
  assert.equal(pick("support", "האפליקציה נטענת לאט ונתקעת"), "slow");
  assert.equal(pick("support", "חויבתי פעמיים החודש"), "billing");
  assert.equal(pick("support", "אני רוצה לדבר עם מנהל, זה לא מקובל"), "escalate");
  assert.equal(pick("interview", "ספר לי על מקרה שבו לא הסכמת עם עמית"), "star-method");
  assert.equal(pick("interview", "מה ציפיות השכר שלך"), "salary-practice");
  assert.equal(pick("interview", "איפה אתה רואה את עצמך בעוד חמש שנים"), "career-goals");
  assert.equal(pick("interview", "מה החולשה שלך"), "weakness");
  assert.equal(pick("empty", "כמה זה יעלה"), "stall-price");
  assert.equal(pick("empty", "אתם יכולים להתחייב על זה בכתב"), "stall-guarantee");
});
