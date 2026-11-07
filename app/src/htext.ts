// User-visible status texts of the engine (health bars, ladder, watchdogs) in Hebrew and English.
// The language is ui.language (resolveUiLanguage in settings.ts). Log events and reasons stay English; only what the user reads is translated here.
export type UiLang = "he" | "en";
type P = Record<string, string | number>;
type Msg = { he: (p: P) => string; en: (p: P) => string };
const m = (he: string | ((p: P) => string), en: string | ((p: P) => string)): Msg => ({
  he: typeof he === "string" ? () => he : he,
  en: typeof en === "string" ? () => en : en,
});

const M = {
  // ladder bar (describeRung); {why} is the reason list, already in the right language
  "rung.1": m(
    (p) => `ה-AI איטי${p.why}. התשובות ממשיכות; תשובה שמגיעה מאוחר מדי לא תוצג. אם זה נמשך, בדוק חיבור לאינטרנט`,
    (p) => `AI is slow${p.why}. Answers keep coming; an answer that arrives too late is not shown. If it continues, check your internet connection`,
  ),
  "rung.2": m(
    (p) => `עברנו לספק גיבוי${p.why}. אין צורך לעשות כלום; אחרי השיחה בדוק את המפתח ב-Settings`,
    (p) => `Switched to a backup provider${p.why}. Nothing to do now; after the call, check the key in Settings`,
  ),
  "rung.3.user": m(
    "רק כרטיסים מוכנים מראש (בלי AI). להפעלת AI התחל שיחה חדשה בלי הבחירה הזו",
    "Prepared cards only (no AI). To use AI, start a new call without this choice",
  ),
  "rung.3": m(
    (p) => `רק כרטיסים מוכנים מראש: ה-AI לא זמין${p.why}. בדוק חיבור לאינטרנט ומפתח ב-Settings`,
    (p) => `Prepared cards only: AI is not available${p.why}. Check your internet connection and the key in Settings`,
  ),
  "rung.4": m(
    (p) => `אין כרטיסים לצד השני${p.why}. תשובות אליך (Ctrl+Opt+A) עדיין פועלות; בדוק חיבור לאינטרנט`,
    (p) => `No cards for the other side${p.why}. Answers for you (Ctrl+Opt+A) still work; check your internet connection`,
  ),
  "rung.5": m(
    (p) => `Wingman כבוי${p.why}. פתח את חלון Wingman ופתח שיחה חדשה`,
    (p) => `Wingman is off${p.why}. Open the Wingman window and start a new call`,
  ),
  // reasons shown inside the ladder bar (the English key is the log token)
  "why.other side not heard": m("הצד השני לא נשמע", "other side not heard"),
  "why.other side's transcription is down": m("תמלול הצד השני לא עובד", "other side's transcription is down"),
  "why.bank or detector failed": m("הבנק או הזיהוי נכשלו", "bank or detector failed"),
  "why.AI off (--no-ai)": m("AI כבוי (--no-ai)", "AI off (--no-ai)"),
  "why.no LLM provider usable": m("אין ספק AI זמין", "no AI provider usable"),
  "why.LLM budget cap reached": m("הגעת לתקרת העלות של ה-AI", "AI budget cap reached"),
  "why.reflex on fallback model": m("מודל גיבוי", "backup model"),
  "why.STT on fallback provider": m("תמלול אצל ספק גיבוי", "transcription on a backup provider"),
  "why.AI slow": m("AI איטי", "AI slow"),
  "why.AI rate-limited/overloaded": m("עומס או הגבלת קצב אצל ספק ה-AI", "AI rate-limited or overloaded"),
  "why.STT slow": m("תמלול איטי", "transcription slow"),
  // AI errors
  "ai.hard": m(
    (p) => `AI ${p.err}${p.bankOnly ? ". בנק בלבד" : ""}`,
    (p) => `AI ${p.err}${p.bankOnly ? ". Prepared cards only" : ""}`,
  ),
  "ai.silent": m(
    "AI לא עונה: מוצגים רק כרטיסים מוכנים מראש. בדוק חיבור לאינטרנט ומפתח ב-Settings",
    "AI is not answering: only prepared cards are shown. Check your internet connection and the key in Settings",
  ),
  // watchdogs
  "mic.never": m(
    "המיקרופון לא קולט. בדוק הרשאת מיקרופון ב-Settings ובחירת מיקרופון, ואז הרץ בדיקת מוכנות",
    "The microphone is not picking up sound. Check microphone permission and selection in Settings, then run the readiness check",
  ),
  "mic.long": m("לא שמעתי אותך כמה דקות. אם דיברת, בדוק את המיקרופון", "I have not heard you for a few minutes. If you spoke, check the microphone"),
  "mic.down": m(
    "המיקרופון נפל. מנסה להתחבר מחדש לבד (אם האוזניות נותקו, עובר למיקרופון המק). אם זה נמשך: חבר מיקרופון או בחר אחר ב-Settings",
    "The microphone dropped. Reconnecting by itself (if the headset was unplugged, switching to the Mac microphone). If it continues: plug in a microphone or pick another in Settings",
  ),
  "sys.down": m(
    "לא שומעים את הצד השני. מנסה להתחבר מחדש לבד. אם זה נמשך: בדוק את הרשאת הקלטת המסך/שמע המערכת והרץ בדיקת מוכנות",
    "Cannot hear the other side. Reconnecting by itself. If it continues: check the screen and system audio recording permission and run the readiness check",
  ),
  "tap.dead": m(
    "אין שמע מהצד השני (ערוץ השמע של המערכת לא שולח כלום). התשובות אליך עדיין פועלות. בדוק שהשמע של השיחה מופעל ושהווליום למעלה",
    "No audio from the other side (the system audio channel sends nothing). Answers for you still work. Check that the call audio is on and the volume is up",
  ),
  "only.you": m(
    "אני שומע רק אותך. כדי לקבל תשובות גם לצד השני, הצטרף לשיחה או הפעל את השמע שלה. אפשר לשאול אותי כל דבר: Ctrl+Opt+A",
    "I hear only you. To get answers for the other side too, join the call or play its audio. You can ask me anything: Ctrl+Opt+A",
  ),
  // STT channels
  "ch.me": m("(המיקרופון שלך)", "(your microphone)"),
  "ch.them": m("(הצד השני)", "(the other side)"),
  "stt.refused": m(
    (p) => `תמלול ${p.ch} – ${p.err}. בדוק את המפתח והקרדיט ב-Settings. מנסה שוב כל ${p.sec} שניות`,
    (p) => `Transcription ${p.ch}: ${p.err}. Check the key and credit in Settings. Retrying every ${p.sec} seconds`,
  ),
  "stt.noconn": m(
    (p) => `תמלול ${p.ch} אין חיבור – ${p.err}. מנסה שוב ושוב עד שיחזור. בדוק חיבור לאינטרנט`,
    (p) => `Transcription ${p.ch} has no connection: ${p.err}. Retrying until it returns. Check your internet connection`,
  ),
  "stt.connecting": m(
    (p) => `מתחבר לשירות התמלול (${p.name})…`,
    (p) => `Connecting to the transcription service (${p.name})…`,
  ),
  "stt.disconnected": m(
    (p) => `תמלול ${p.ch} התנתק – מנסה להתחבר מחדש. בדוק את חיבור האינטרנט`,
    (p) => `Transcription ${p.ch} disconnected. Reconnecting. Check your internet connection`,
  ),
  "stt.switched": m(
    (p) => `תמלול ${p.ch}: עברנו מ-${p.from} ל-${p.to}`,
    (p) => `Transcription ${p.ch}: switched from ${p.from} to ${p.to}`,
  ),
  // call-level notices
  "disk.write": m(
    "לא ניתן לשמור את השיחה בדיסק (אין מקום?). השיחה ממשיכה, אבל ההקלטה והסיכום עלולים להיות חלקיים. פנה מקום בדיסק",
    "The call cannot be saved to disk (no space?). The call goes on, but the recording and summary may be incomplete. Free some disk space",
  ),
  "disk.red": m(
    (p) => `כמעט אין מקום בדיסק (${p.mb} MB פנויים). השיחה עלולה לא להישמר. פנה מקום בדיסק עכשיו`,
    (p) => `Almost no disk space (${p.mb} MB free). The call may not be saved. Free some disk space now`,
  ),
  "disk.amber": m(
    (p) => `מעט מקום בדיסק (${p.mb} MB פנויים). פנה מקום כדי שהשיחה והסיכום יישמרו`,
    (p) => `Low disk space (${p.mb} MB free). Free some space so the call and summary can be saved`,
  ),
  sleep: m(
    (p) => `המחשב נרדם ל-${p.sec} שניות. חלק מהשיחה לא נשמע. אם פספסת משהו, בקש שיחזרו עליו`,
    (p) => `The computer slept for ${p.sec} seconds. Part of the call was not heard. If you missed something, ask them to repeat it`,
  ),
  idle: m(
    (p) => `אף אחד לא דיבר ${p.min} דקות. השיחה תיעצר לבד בעוד כ-2 דקות`,
    (p) => `Nobody has spoken for ${p.min} minutes. The call will stop by itself in about 2 minutes`,
  ),
  "cost.ai": m(
    (p) => `עלות AI ${p.line}. אפשר להמשיך; לעצירה לחץ Stop call`,
    (p) => `AI cost ${p.line}. You can continue; to stop, click Stop call`,
  ),
  "cost.total": m(
    (p) => `עלות השיחה עברה $${p.limit} (${p.line}). אפשר להמשיך; לעצירה לחץ Stop call`,
    (p) => `This call has cost more than $${p.limit} (${p.line}). You can continue; to stop, click Stop call`,
  ),
  minutes: m(
    (p) => `השיחה רצה ${p.min} דקות. אם היא הסתיימה, לחץ Stop call`,
    (p) => `The call has been running ${p.min} minutes. If it is over, click Stop call`,
  ),
  quiet: m(
    "מצב שקט: הכרטיסים נשמרים אבל לא מוצגים. לחזרה כבה את Quiet mode בתפריט",
    "Quiet mode: cards are saved but not shown. To go back, turn off Quiet mode in the menu",
  ),
  orphan: m(
    (p) => `אפליקציית Wingman בתפריט נסגרה. השיחה ממשיכה, ותיעצר לבד אחרי ${p.min} דקות בלי דיבור`,
    (p) => `The Wingman menu app was closed. The call continues and will stop by itself after ${p.min} minutes without speech`,
  ),
  strays: m("שגיאות פנימיות חוזרות. השיחה עדיין נשמרת.", "Internal errors are repeating. The call is still being recorded."),
  "bt.mic": m(
    (p) => `${p.dev} הוא המיקרופון: איכות התמלול יורדת. עדיף מיקרופון המק או אוזניות חוטיות`,
    (p) => `${p.dev} is the microphone: transcription quality drops. A Mac microphone or wired headphones are better`,
  ),
  "bt.out": m(
    (p) => `${p.dev} ברמקולים: אם המיקרופון שלהן ייפתח, האיכות תרד`,
    (p) => `${p.dev} is the speaker: if its microphone opens, quality will drop`,
  ),
  // language not supported
  "lang.unsupported": m("השפה הזו עדיין לא נתמכת. Wingman מבין אנגלית ועברית.", "This language is not supported yet. Wingman understands English and Hebrew."),
} satisfies Record<string, Msg>;

export type HKey = keyof typeof M;
/** All message keys (tests check that each has both languages). */
export const HKEYS = Object.keys(M) as HKey[];

/** Text for `key` in `lang` (unknown language = Hebrew, the default UI language). */
export function ht(lang: UiLang | undefined, key: HKey, p: P = {}): string {
  return M[key][lang === "en" ? "en" : "he"](p);
}
/** Ladder reason (English log token) in the UI language; unknown reasons (a fatal text) pass through unchanged. */
export function reasonText(lang: UiLang | undefined, reason: string): string {
  const k = `why.${reason}` as HKey;
  return k in M ? ht(lang, k) : reason;
}
