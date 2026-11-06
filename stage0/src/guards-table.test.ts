// Table-driven coverage for the card guards: English and Hebrew prices, dates, promises and interview salary figures.
// A false hit only costs a stall line, but ordinary technical talk must still pass.
import test from "node:test";
import assert from "node:assert/strict";
import { guard, guardInterview } from "./guards.ts";

const BLOCKED: [string, "price" | "date" | "promise"][] = [
  // prices
  ["It's £500 a month", "price"], ["That is 500 ILS", "price"], ["USD 500 upfront", "price"], ["GBP 200 per day", "price"],
  ["around 5 grand", "price"], ["roughly 1.2K", "price"], ["about 5K a month", "price"], ["we charge a flat 300", "price"],
  ["35 thousand shekels", "price"], ["thirty five thousand", "price"], ["it is €250", "price"], ["NIS 1200", "price"],
  ["800 EUR plus tax", "price"], ["a couple of grand", "price"], ["התעריף 300 לשעה", "price"], ["300 לשעה", "price"],
  ["זה חמש מאות", "price"], ["אלף וחמש מאות", "price"], ["מאתיים ושלושים", "price"], ["1200 ש''ח", "price"],
  ["שלושים אלף", "price"],
  // dates
  ["We ship Nov 12", "date"], ["by March 5th", "date"], ["probably in November", "date"], ["the 12th of May", "date"],
  ["let's meet this Thursday", "date"], ["see you Thursday", "date"], ["I will send it next Monday", "date"],
  ["within two weeks", "date"], ["in a fortnight", "date"], ["by end of month", "date"], ["tomorrow morning", "date"],
  ["we deliver next week", "date"], ["on the 15th", "date"], ["it lands in Q4", "date"], ["in ninety days", "date"],
  ["later today", "date"], ["by Dec", "date"], ["שבוע הבא נחזור אליך", "date"], ["בקרוב מאוד", "date"],
  ["תוך שלושים יום", "date"], ["תוך 30 יום", "date"], ["ביום ה' בבוקר", "date"], ["הערב נשלח", "date"], ["ב-5.11 נפגש", "date"],
  // promises
  ["You have my word", "promise"], ["We'll make sure it works", "promise"], ["I guarantee it", "promise"], ["it is guaranteed", "promise"],
  ["I promise", "promise"], ["No problem, it will be done by the weekend", "promise"], ["consider it done", "promise"],
  ["I'll definitely get it done", "promise"], ["we are committed to that", "promise"], ["rest assured", "promise"],
  ["אני מבטיח לך", "promise"], ["מבטיחים שזה יעבוד", "promise"], ["נדאג שזה יהיה מוכן", "promise"], ["יש לך את המילה שלי", "promise"],
  ["בהחלט נעשה את זה", "promise"], ["אני אעשה את זה", "promise"], ["הבטחה", "promise"],
];
const ALLOWED = [
  "I have 4 years experience", "version 2.0", "we have 30 sites", "the meeting is about pricing pages", "Python 3.12 is supported",
  "it took 4.5 years", "we use k8s in production", "the page has 12 sections", "I can't promise anything", "I cannot guarantee that",
  "we don't promise results", "I'm not sure about that", "let me check and come back", "I may need to check", "the march of progress",
  "we have two teams", "a grand opening", "there are hundreds of options", "SLA is a document defined in a contract",
  "יש לנו 30 אתרים", "אני לא מבטיח, אבדוק", "אי אפשר להבטיח זמינות", "גרסה 2.0", "יש לי ארבע שנות ניסיון", "הפגישה עוסקת בתמחור",
  "אני לא בטוח", "מה השאלה", "נשמח לעזור",
];
test("guards table: prices, dates and promises in English and Hebrew are blocked with the right rule", () => {
  assert.ok(BLOCKED.length >= 40, `table size ${BLOCKED.length}`);
  const bad = BLOCKED.filter(([text, rule]) => guard(text).rule !== rule).map(([t, r]) => `${t} (want ${r}, got ${guard(t).rule})`);
  assert.deepEqual(bad, []);
});
test("guards table: ordinary sentences, versions, counts and hedges pass", () => {
  assert.ok(ALLOWED.length >= 20);
  assert.deepEqual(ALLOWED.filter((t) => !guard(t).ok), []);
});

const SALARY_BLOCKED = ["I expect 25k a month", "I'm looking for 30K", "$120k", "120k USD", "I want 35 thousand", "about thirty-five thousand shekels", "שלושים אלף", "my number is 25 K", "אני רוצה 30 אלף", "around 1.2K", "forty grand", "ארבעים וחמישה אלף"];
const SALARY_ALLOWED = ["Agent platform: 2,100+ tasks in 4 days, lead dev since 2023", "about $0.10 per million input tokens", "we serve 30 thousand requests a day", "I have 4 years experience", "version 2.0", "המערכת מטפלת ב-30 אלף בקשות"];
test("guardInterview table: salary figures in k form, spelled-out and Hebrew are blocked; technical counts pass", () => {
  assert.deepEqual(SALARY_BLOCKED.filter((t) => guardInterview(t).ok), []);
  assert.deepEqual(SALARY_ALLOWED.filter((t) => !guardInterview(t).ok), []);
});
