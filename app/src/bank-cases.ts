// Held-out bank utterances (NOT copied from the card triggers) with the card each one should hit; "-" means no card is correct.
// Shared by `pnpm banktest` and `pnpm eval`.
export const BANK_CASES: [string, string][] = [
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
  ["לא מגיעות אלי הודעות מטופס יצירת הקשר", "forms-not-arriving"],
  ["מה כלול במסלול תחזוקה אצלכם", "maintenance-plan"],
  ["יש אצלכם אימות דו שלבי לניהול", "two-factor"],
];

// Paraphrases with no trigger in common with the card. The scorer must put the right card in its top 3 (the model then picks or says SKIP).
// Used by bank-paraphrase.test.ts. Invented sentences, not copied from card text.
export const BANK_PARAPHRASE_CASES: [string, string][] = [
  ["הדף הראשי לוקח נצח להיטען", "site-slow"],
  ["העמוד הראשי נפתח אחרי המון זמן", "site-slow"],
  ["למה הכל כל כך כבד באתר בימים האחרונים", "site-slow"],
  ["הלידים מהאתר לא נכנסים לתיבת הדואר", "forms-not-arriving"],
  ["אנשים משאירים פרטים באתר ולא מקבלים כלום במייל", "forms-not-arriving"],
  ["הטופס באתר לא נשלח אלי למייל", "forms-not-arriving"],
  ["לא מגיעות אלי הודעות מטופס יצירת הקשר", "forms-not-arriving"],
  // More paraphrases (Hebrew with glued prefixes, and English questions against Hebrew cards that have an English version).
  ["אנשים ממלאים טופס באתר ושום דבר לא מגיע לתיבה שלי", "forms-not-arriving"],
  ["המיילים שלנו מסומנים כזבל אצל הלקוחות", "email-spam"],
];
// Cross-language: an English question, a card written in Hebrew. The scorer reads the card's English version too. Top 3, then the model picks.
export const BANK_CROSS_CASES: [string, string][] = [
  ["the browser warns that the connection is not secure", "ssl-basics"],
  ["visitors send a message through the site but nothing arrives in my mailbox", "forms-not-arriving"],
  ["can you restore an older copy of the website", "backups"],
];
// Sentences that no bank card answers. The scorer must not turn them into a card.
export const BANK_NEGATIVE_CASES: string[] = [
  "טוב אז נדבר מחר בבוקר",
  "אני אחזור אליך עם הצעה בשבוע הבא",
  "המשפחה שלי גרה באילת כבר הרבה שנים",
  "התקציב של הרבעון הבא עדיין לא סגור",
  "we should schedule the next meeting for tuesday",
  "how was your weekend",
  "מה דעתך על הרעיון של הלקוח",
  "תודה רבה על הזמן שלך היום",
];
