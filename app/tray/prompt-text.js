// Texts of the small note window (prompt.html), English and Hebrew, in one table. Classic script in the page (window.WingmanPromptText), require() in tests.
// A test (src/app-ux.test.ts) keeps both languages complete.
(function (root) {
  const T = {
    "note.title": ["Note for the AI", "הערה ל-AI"],
    "note.help": [
      'What is the call about? For example: "This is a shop client, we talk about a server move."',
      'על מה השיחה? למשל: "זה לקוח של החנות, מדברים על מעבר שרת"',
    ],
    add: ["Add", "הוסף"],
    cancel: ["Cancel", "ביטול"],
    save: ["Save", "שמור"],
    "brief.title": ["Brief for the next call", "תדריך לשיחה הבאה"],
    "brief.help": [
      "One minute. You can skip any field. It is kept for the next call, for 6 hours.",
      "דקה אחת. אפשר לדלג על כל שדה. נשמר לשיחה הבאה ב-6 השעות הקרובות.",
    ],
    "brief.who": ["Who is on the call?", "מי בשיחה?"],
    "brief.goal": ["What is the goal of the call?", "מטרת השיחה?"],
    "brief.notes": ["Notes for the AI (separate with ;)", "הערות ל-AI (מופרדות ב-;)"],
    "brief.must": ["Must cover (separate with ;), for example: budget; timeline", "חייב לכסות (מופרד ב-;) למשל: תקציב; לוח זמנים"],
    window: ["Wingman · note for the AI", "Wingman · הערה ל-AI"],
  };
  /** Text for a key in "en" or "he" (anything else is English). Unknown key: the key itself. */
  const pt = (lang, key) => (T[key] ? T[key][lang === "he" ? 1 : 0] : key);
  const api = { T, pt };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WingmanPromptText = api;
})(globalThis);
