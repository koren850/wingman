// Bank top-1 accuracy on held-out utterances (NOT copied from the card triggers). pnpm banktest
// right = expected card id; wrong = a different card; miss = no card (expected "-" means no card is correct).
import { loadBank, matchBank } from "./bank.ts";

const CASES: [string, string][] = [
  ["האתר שלי נטען ממש לאט בטלפון", "site-slow"],
  ["הדף הראשי לוקח נצח להיטען", "site-slow"],
  ["מאתמול האתר לא עולה בכלל", "site-down"],
  ["כשנכנסים לאתר רואים מסך לבן", "site-down"],
  ["נראה לי שפרצו לאתר שלי", "hacked-site"],
  ["יש וירוס באתר והגוגל מזהיר", "hacked-site"],
  ["המיילים שאני שולחת נוחתים בספאם", "email-spam"],
  ["מה זה SPF ו DKIM בכלל", "email-spam"],
  ["אני רוצה לחדש את הדומיין לפני שהוא פג", "domain-renewal"],
  ["צריך לחדש דומיין אצל GoDaddy", "domain-renewal"],
  ["אני רוצה להעביר את הדומיין לספק אחר", "domain-transfer"],
  ["יש לי קוד העברה מהספק, מה עושים איתו", "domain-transfer"],
  ["על שם מי רשום הדומיין שלי", "domain-owner"],
  ["כמה זה יעלה לבנות לי חנות", "stall-price"],
  ["מה עלות של תחזוקה חודשית", "stall-price"],
  ["כמה זמן ייקח לסיים את האתר החדש", "stall-timeline"],
  ["מתי זה יהיה מוכן", "stall-timeline"],
  ["אתם מתחייבים שהאתר לא יפול", "stall-guarantee"],
  ["יש לכם גיבוי אוטומטי של האתר", "backups"],
  ["אם משהו נשבר אפשר לשחזר מגיבוי", "backups"],
  ["האתר מציג שהוא לא מאובטח בדפדפן", "ssl-basics"],
  ["התעודת אבטחה של האתר פגה", "ssl-basics"],
  ["אני רוצה להעביר את האתר לאחסון אחר", "migration"],
  ["איך מחברים את הקארדקום לחנות", "woo-payments"],
  ["אנחנו צריכים לקבל תשלום בכרטיס אשראי באתר", "woo-payments"],
  ["אני צריך הנגשה לאתר לפי התקן", "accessibility"],
  ["צריך הצהרת נגישות באתר העסק", "accessibility"],
  ["מה עם באנר העוגיות והפרטיות", "gdpr-cookies"],
  ["אחרי העדכון התוסף שבר את האתר", "plugin-conflicts"],
  ["אני לא רואה את השינוי שעשיתי באתר", "caching"],
  ["מה זה Cloudflare ואיך זה עוזר", "cdn-cloudflare"],
  ["מה ההבדל בין ווקומרס לשופיפיי", "-"],
  ["כדאי לעבור מ Wix לוורדפרס", "builder-vs-wordpress"],
  ["הציון שלי ב PageSpeed נמוך", "site-speed-score"],
  ["הטופס באתר לא נשלח אלי למייל", "forms-not-arriving"],
  ["אפשר לשדרג את גרסת PHP", "php-version"],
  ["אני רוצה לבדוק שינוי ב staging לפני שעולים", "staging"],
  ["אנחנו צריכים עמוד נחיתה חדש לקמפיין", "add-page"],
  ["מה כלול במסלול תחזוקה אצלכם", "maintenance-plan"],
  ["יש אצלכם אימות דו שלבי לניהול", "two-factor"],
];

const bank = loadBank();
let right = 0, wrong = 0, miss = 0;
const lines: string[] = [];
for (const [text, want] of CASES) {
  const got = matchBank(text, bank)?.card.id ?? "-";
  if (got === want) right++;
  else if (got === "-") { miss++; lines.push(`MISS   want ${want}   ${text}`); }
  else { wrong++; lines.push(`WRONG  want ${want} got ${got}   ${text}`); }
}
const n = CASES.length;
console.log(`bank top-1: ${right}/${n} right (${((100 * right) / n).toFixed(0)}%), ${wrong} wrong-card (${((100 * wrong) / n).toFixed(0)}%), ${miss} no card (${((100 * miss) / n).toFixed(0)}%)`);
if (lines.length) console.log("\n" + lines.join("\n"));
process.exitCode = right / n >= 0.75 && wrong / n <= 0.05 ? 0 : 1;
