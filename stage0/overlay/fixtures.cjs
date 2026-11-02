// Fixture builder for overlay snapshots: node fixtures.cjs <scenario> <callsDir>
// Writes <callsDir>/<id>/{cards,transcript}.jsonl and a calls/latest symlink, the layout main.cjs tails.
// Scenarios: empty, consent, full, overflow, quiet. Test/dev only; nothing here is read by the real app.
const fs = require("node:fs");
const path = require("node:path");

const now = Date.now();
const card = (o) => ({ type: "card", question: "", facts: [], at: now, ...o });
const side = (o) => card({ turnId: "side", ...o });
const health = (id, level, say) => card({ id: `health-${id}`, turnId: "health", badge: "warn", health: true, level, say });
const consent = card({ id: "consent", turnId: "start", badge: "info", question: "תחילת שיחה", say: "אני משתמש בכלי תמלול ועוזר AI שמעבדים את השיחה בענן, רק בשבילי כדי לסכם ולהזכיר לי נקודות. זה בסדר מבחינתך?", facts: ["להגיד את זה בתחילת השיחה", "הלקוח לא מסכים: Ctrl+C", "אחרי שהסכים: Enter"] });
const bank = card({ id: "q1-bank", turnId: "q1", badge: "bank", question: "כמה זמן לוקח להעביר את האתר לוורדפרס?", say: "בדרך כלל שלושה עד חמישה שבועות, תלוי בכמות התכנים.", facts: ["עיצוב: שבוע וחצי", "העברת תוכן ו-SEO redirects: שבוע", "בדיקות ועלייה לאוויר: 3 ימים"] });
const aiLong = card({ id: "q2-ai", turnId: "q2", badge: "ai", question: "אתם יכולים לחבר את זה ל-Salesforce ולשמור את הלידים שמגיעים מ-Facebook Ads?", say: "כן, אפשר לחבר את הטפסים ישירות ל-Salesforce דרך ה-API או Zapier, וכל ליד מ-Facebook Ads יגיע עם ה-UTM שלו. החיבור לוקח בערך יומיים עבודה ועולה כ-2,400 ₪ חד פעמי.", facts: ["עדיף webhook ישיר מ-Zapier (פחות נקודות כשל)", "צריך הרשאת admin ב-Salesforce"] });
const aiStream = card({ id: "q3-ai", turnId: "q3", badge: "ai", question: "ומה לגבי האחסון, מי אחראי על הגיבויים?", say: "אנחנו מארחים אצלנו בשרת ייעודי, גיבוי יומי ל-30 יום, ושחזור בתוך" });
const dimmed = card({ id: "q0-bank", turnId: "q0", badge: "bank", dim: true, question: "יש לכם ניסיון עם WooCommerce?", say: "כן, בנינו מעל עשרים חנויות WooCommerce, כולל חיבור לסליקה ולמלאי.", facts: [] });
const stall = card({ id: "q4-stall", turnId: "q4", badge: "stall", question: "כמה זה יעלה לי בסוף, כולל תחזוקה?", say: "שאלה טובה, תן לי שנייה לדייק לך את המספר.", facts: [] });
const factSsl = side({ id: "fact-d1", badge: "fact", say: "shop-example.co.il", warn: true, facts: ["תעודת SSL פגה בעוד 6 ימים (8 Nov)", "שרת: srv-demo1, PHP 8.1", "הלקוח: לוי אלקטרוניקה בע\"מ"] });
const factClient = side({ id: "fact-c1", badge: "fact", say: "לוי אלקטרוניקה", facts: ["אתר WooCommerce, תחזוקה חודשית 1,200 ₪", "איש קשר: דנה לוי, dana@example-electronics.co.il"] });
const propose = side({ id: "propose-client", badge: "info", say: "נראה שזו שיחה עם לוי אלקטרוניקה", facts: ["y בטרמינל = לאשר ולתת ל-AI את הפרטים"] });
const reminder = side({ id: "reminder-1", badge: "reminder", say: "עוד לא דיברתם על:", facts: ["לוח זמנים והשקה", "מי מאשר את העיצוב אצלם", "מחיר תחזוקה שנתי"] });
const notes = ["הלקוח רוצה השקה לפני חג המולד בחו\"ל", "תקציב משוער: 40-50 אלף ₪ + מע\"מ", "מתחרה: אתר של BUG, הם אהבו את ה-checkout שלהם"].map((n, i) => side({ id: `note-${i}`, badge: "note", say: n }));
const cap = (kind, value) => ({ type: "capture", ch: "them", kind, value, at: now });
const caps = [cap("phone", "052-0000000"), cap("email", "dana@example-electronics.co.il"), cap("domain", "shop-example.co.il")];
const lines = [
  { t: now - 24000, ch: "them", text: "אז בעצם אנחנו צריכים שהאתר יתחבר ל-Salesforce, ושכל ליד מ-Facebook Ads ייכנס אוטומטית." },
  { t: now - 17000, ch: "me", text: "כן, זה אפשרי, נעבור על זה בהצעה." },
  { t: now - 11000, ch: "them", text: "והאחסון? מי אחראי על הגיבויים אם משהו נופל בשבת?" },
  { t: now - 4000, ch: "them", text: "את המספר שלי תרשום, 052-0000000, ותשלח לי הצעה עד יום חמישי." },
];

const S = {
  empty: { cards: [], lines: [] },
  consent: { cards: [consent], lines: [] },
  full: { cards: [bank, health("stt-me", "red", "NOT HEARING THE CLIENT – אין שמע מהלקוח"), health("cost", "amber", "עלות AI $1.42 מתוך $2"), dimmed, aiLong, stall, factSsl, factClient, reminder, ...notes, ...caps, aiStream], lines },
  overflow: { cards: [bank, dimmed, aiLong, stall, aiStream, card({ ...bank, id: "q5-bank", turnId: "q5" }), card({ ...aiLong, id: "q6-ai", turnId: "q6" }), factSsl, factClient, propose, reminder, ...notes, ...caps], lines },
  quiet: { cards: [health("quiet", "info", "מצב שקט: הכרטיסים נרשמים אבל לא מוצגים (q לחזרה)"), factClient, reminder, ...caps.slice(0, 2)], lines },
};

const [, , name = "full", dir = "/tmp/wingman-fixture"] = process.argv;
const sc = S[name];
if (!sc) { console.error("unknown scenario " + name); process.exit(2); }
fs.rmSync(dir, { recursive: true, force: true });
const call = path.join(dir, "fixture-call");
fs.mkdirSync(call, { recursive: true });
fs.writeFileSync(path.join(call, "cards.jsonl"), sc.cards.map((c) => JSON.stringify(c)).join("\n") + (sc.cards.length ? "\n" : ""));
fs.writeFileSync(path.join(call, "transcript.jsonl"), sc.lines.map((c) => JSON.stringify(c)).join("\n") + (sc.lines.length ? "\n" : ""));
fs.symlinkSync(call, path.join(dir, "latest"));
