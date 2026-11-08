// Texts of the menu-bar menu and its quit confirmation, in English and Hebrew (the interface language setting, ui.language).
// Same idea as src/htext.ts: one table, both languages side by side. A test (src/tray-menu-text.test.ts) keeps the keys equal.
"use strict";

const T = {
  open: ["Open Wingman", "פתח את Wingman"],
  quick: ["Start quick call", "התחל שיחה מהירה"],
  prepared: ["Start prepared meeting", "התחל פגישה מוכנה"],
  noPrepared: ["No prepared meetings", "אין פגישות מוכנות"],
  quickNoAi: ["Start quick call without AI (Prepared cards only)", "התחל שיחה מהירה בלי AI (כרטיסים מוכנים בלבד)"],
  prepare: ["Prepare a meeting…", "הכן פגישה…"],
  practice: ["Try a practice call (offline, free)", "נסה שיחת תרגול (בלי רשת, בחינם)"],
  startListening: ["Start listening", "התחל להאזין"],
  confirmClient: ["Confirm client: {name}", "אשר לקוח: {name}"],
  askArmed: ["Listening for your question", "מאזין לשאלה שלך"],
  askLeft: ["{left} left", "נשארו {left}"],
  ask: ["Ask Wingman: my next sentence is for you", "שאל את Wingman: המשפט הבא שלי הוא אליו"],
  recap: ["Catch me up: where we are", "עדכן אותי: איפה אנחנו"],
  note: ["Add a note for the AI…", "הוסף הערה ל-AI…"],
  quiet: ["Quiet mode (hide cards in the answer window)", "מצב שקט (הסתר כרטיסים בחלון התשובות)"],
  stopping: ["Stopping…", "עוצר…"],
  stop: ["Stop call", "עצור שיחה"],
  stopDelete: ["Stop and delete this call…", "עצור ומחק את השיחה…"],
  checking: ["Checking…", "בודק…"],
  doctor: ["Run readiness check", "הרץ בדיקת מוכנות"],
  log: ["Show log", "הצג יומן"],
  quitRunning: ["Quit Wingman…", "צא מ-Wingman…"],
  quit: ["Quit Wingman", "צא מ-Wingman"],
  quitKeep: ["Keep the call running", "השאר את השיחה פועלת"],
  quitStop: ["Stop the call and quit", "עצור את השיחה וצא"],
  quitMessage: ["A call is running.", "יש שיחה פועלת."],
  quitDetail: [
    "Quitting stops the call first: it is saved and the summary is written (up to 20 seconds), then Wingman closes.",
    "יציאה עוצרת קודם את השיחה: היא נשמרת והסיכום נכתב (עד 20 שניות), ואז Wingman נסגר.",
  ],
};

/** Text for `key` in `lang` ("en" or "he"; anything else = Hebrew, like src/htext.ts). {name} style placeholders are filled from `p`. */
function tt(lang, key, p = {}) {
  const row = T[key];
  if (!row) return key;
  return row[lang === "en" ? 0 : 1].replace(/\{(\w+)\}/g, (_m, k) => (k in p ? String(p[k]) : ""));
}

module.exports = { tt, T };
