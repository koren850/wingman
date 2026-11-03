// Fixture builder for overlay snapshots (run by snapshot.sh): node fixtures.cjs <scenario> <callsDir>
// All people, companies and numbers below are invented sample data.
// Writes <callsDir>/<id>/{cards,transcript}.jsonl and a calls/latest symlink, the layout main.cjs tails.
// Scenarios: empty (starting), listening (live, no cards yet), waiting (start approval), nophase (old call.json), consent, full, overflow, quiet, frame, foryou, onlyyou, stale, ended, starting. Test/dev only; nothing here is read by the real app.
const fs = require("node:fs");
const path = require("node:path");

const now = Date.now();
const card = (o) => ({ type: "card", question: "", facts: [], at: now, ...o });
const side = (o) => card({ turnId: "side", ...o });
const health = (id, level, say) => card({ id: `health-${id}`, turnId: "health", badge: "warn", health: true, level, say });
const consent = card({ id: "consent", turnId: "start", badge: "info", question: "תחילת שיחה", say: "אני משתמש בכלי תמלול ועוזר AI שמעבדים את השיחה בענן, רק בשבילי כדי לסכם ולהזכיר לי נקודות. זה בסדר מבחינתך?", facts: ["אפשר להגיד את זה בתחילת השיחה", "לא רוצים להקליט: Ctrl+C", "להתחלת האזנה: Enter"] });
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
// Call frame + tips (invented): a vendor negotiation, 3 of 6 checklist items covered.
const frameRow = { type: "frame", at: now, frame: { kind: "vendor", topic: "חידוש חוזה אחסון שנתי", goal: "לסגור תנאים טובים יותר ולוודא גיבויים וזמינות", people: [{ who: "רועי", role: "נציג מכירות" }], entities: ["HostCo"], checklist: [
  { item: "תנאי החידוש ותקופת ההתחייבות", done: true, must: true }, { item: "זמינות (SLA) ופיצוי על השבתה", done: true, must: true }, { item: "מדיניות גיבויים ושחזור", done: true, must: false },
  { item: "תנאי ביטול ומעבר לספק אחר", done: false, must: true }, { item: "תמיכה בשעות לא שגרתיות", done: false, must: false }, { item: "לוח זמנים להחלטה", done: false, must: true }] } };
const tip1 = card({ id: "tip-1", turnId: "tips", badge: "tip", tipType: "ask", say: "שאל מה תנאי הביטול אם עוברים לספק אחר באמצע התקופה." });
const tip2 = card({ id: "tip-2", turnId: "tips", badge: "tip", tipType: "term", say: "SLA: מה הספק מתחייב לזמינות, ומה הפיצוי כשלא עומדים בזה." });
const vendorHero = card({ id: "q7-ai", turnId: "q7", badge: "ai", question: "אנחנו יכולים להציע שרת ייעודי עם גיבוי יומי, מתאים לך?", say: "שרת ייעודי עם גיבוי יומי נשמע מתאים. כדאי לברר כמה זמן הגיבויים נשמרים ואיפה.", facts: ["לבקש לראות את מדיניות השחזור"] });
const cap = (kind, value) => ({ type: "capture", ch: "them", kind, value, at: now });
const caps = [cap("phone", "052-0000000"), cap("email", "dana@example-electronics.co.il"), cap("domain", "shop-example.co.il")];
const lines = [
  { t: now - 24000, ch: "them", text: "אז בעצם אנחנו צריכים שהאתר יתחבר ל-Salesforce, ושכל ליד מ-Facebook Ads ייכנס אוטומטית." },
  { t: now - 17000, ch: "me", text: "כן, זה אפשרי, נעבור על זה בהצעה." },
  { t: now - 11000, ch: "them", text: "והאחסון? מי אחראי על הגיבויים אם משהו נופל בשבת?" },
  { t: now - 4000, ch: "them", text: "את המספר שלי תרשום, 052-0000000, ותשלח לי הצעה עד יום חמישי." },
];

// Answers for the user himself ("For you") and the calm "only you" state (invented).
const meCalc = card({ id: "m1-me", turnId: "m1", badge: "me", forMe: true, source: "calc", question: "כמה זה 36 ועוד 42?", say: "\u206636 + 42 = 78\u2069", at: now - 9000 });
const meAi = card({ id: "m2-me", turnId: "m2", badge: "me", forMe: true, source: "ai", question: "מה ההבדל בין CDN ל-DNS?", say: "CDN מפיץ עותקים של האתר לשרתים קרובים לגולש, ו-DNS רק מתרגם שם דומיין לכתובת השרת.", facts: ["CDN משפר מהירות", "DNS קובע לאן הדומיין מצביע"], at: now - 2000 });
const onlyYou = health("only-you", "info", "I only hear you. To get answers for the other side, join the call or play its audio. Ask me anything: Ctrl+Opt+A.");
const askOn = { type: "ask", on: true, until: now + 10 * 60_000, at: now };
const S = {
  foryou: { cards: [bank, meCalc, meAi, askOn], lines: [{ t: now - 24000, ch: "them", text: "והאחסון? מי אחראי על הגיבויים אם משהו נופל בשבת?" }, { t: now - 9500, ch: "me", text: "כמה זה 36 ועוד 42?" }, { t: now - 3000, ch: "me", text: "מה ההבדל בין CDN ל-DNS?" }] },
  onlyyou: { cards: [onlyYou, meCalc], lines: [{ t: now - 9500, ch: "me", text: "כמה זה 36 ועוד 42?" }] },
  empty: { cards: [], lines: [] },
  consent: { cards: [consent], lines: [] },
  full: { cards: [bank, health("them-silent", "red", "אין שמע מהצד השני (ערוץ השמע של המערכת לא שולח כלום). התשובות אליך עדיין פועלות"), health("cost", "amber", "עלות AI $1.42 מתוך $2"), dimmed, aiLong, stall, factSsl, factClient, reminder, ...notes, ...caps, aiStream], lines },
  overflow: { cards: [bank, dimmed, aiLong, stall, aiStream, card({ ...bank, id: "q5-bank", turnId: "q5" }), card({ ...aiLong, id: "q6-ai", turnId: "q6" }), factSsl, factClient, propose, reminder, ...notes, ...caps], lines },
  frame: { cards: [frameRow, vendorHero, tip1, tip2], lines: [{ t: now - 6000, ch: "them", text: "אנחנו יכולים להציע שרת ייעודי עם גיבוי יומי, מתאים לך?" }] },
  quiet: { cards: [health("quiet", "info", "מצב שקט: הכרטיסים נרשמים אבל לא מוצגים "), factClient, reminder, ...caps.slice(0, 2)], lines },
};

// Older answers (2 and 5 minutes old) and a call that has ended.
const old = (c, ago) => ({ ...c, at: now - ago });
S.stale = { cards: [old(bank, 300000), old(aiLong, 130000), old(stall, 70000), old(dimmed, 50000), card({ ...aiStream, at: now - 50000 })], lines };
S.ended = { cards: [bank, aiLong, ...caps], lines, ended: true };
S.starting = { cards: [], lines: [], nolatest: true };
// call.json phase (the contract overlay/lib.cjs callPhase reads): empty = starting, listening = live with no cards yet, waiting = start approval, nophase = timer fallback.
S.empty.phase = "starting"; S.consent.phase = "waiting";
S.listening = { cards: [], lines: [], phase: "live", liveAt: now - 95000 };
S.waiting = { cards: [], lines: [], phase: "waiting" };
S.nophase = { cards: [], lines: [], phase: "" };

const [, , name = "full", dir = "/tmp/wingman-fixture"] = process.argv;
const sc = S[name];
if (!sc) { console.error("unknown scenario " + name); process.exit(2); }
fs.rmSync(dir, { recursive: true, force: true });
const call = path.join(dir, "fixture-call");
fs.mkdirSync(call, { recursive: true });
fs.writeFileSync(path.join(call, "cards.jsonl"), sc.cards.map((c) => JSON.stringify(c)).join("\n") + (sc.cards.length ? "\n" : ""));
fs.writeFileSync(path.join(call, "transcript.jsonl"), sc.lines.map((c) => JSON.stringify(c)).join("\n") + (sc.lines.length ? "\n" : ""));
const meta = { id: "fixture-call" };
if (sc.ended) meta.endedAt = new Date().toISOString();
else { const ph = sc.phase === undefined ? "live" : sc.phase; if (ph) meta.phase = ph; if (ph === "live") meta.liveAt = sc.liveAt || now - 600000; }
fs.writeFileSync(path.join(call, "call.json"), JSON.stringify(meta));
if (!sc.nolatest) fs.symlinkSync(call, path.join(dir, "latest"));
