"use strict";
// Snapshot-only fixture for the live conversation view (WINGMAN_DASHBOARD_FAKE_CALL=live|live-warn|stopping). Invented data. Nothing is read from a real call.
const feedLib = require("./livefeed.js");

/** Build one live-view payload ({ callId, reset: true, lines, cards, frame }) from invented rows; liveAt is the fake call start (ms). */
function build(liveAt, callId, lang) {
  if (lang === "en") return buildEn(liveAt, callId);
  const at = (m, s) => liveAt + (m * 60 + s) * 1000;
  const lines = [
    { t: at(5, 2), ch: "me", text: "בטח, אני רושם. אז האתר נטען לאט בעיקר בדף הבית?" },
    { t: at(5, 11), ch: "them", text: "כן, בעיקר בדף הבית ובדף המוצרים. בנייד זה ממש נורא, לוקח כמעט עשר שניות." },
    { t: at(5, 24), ch: "me", text: "הבנתי. נבדוק את זה אצלנו בשרת." },
    { t: at(5, 40), ch: "them", text: "ועוד שאלה, אתם יכולים לחבר את הטפסים ל-Monday ולשמור שם את הלידים?" },
    { t: at(6, 15), ch: "me", text: "כן, זה אפשרי, ניתן לך מחיר בהצעה." },
    { t: at(6, 52), ch: "them", text: "כמה זמן לוקח להעביר את האתר לוורדפרס, ויש לנו גם חנות WooCommerce קטנה?" },
    { t: at(7, 31), ch: "them", text: "אה, וגם צריך שהאתר יעבוד עם Cloudflare ושיהיה עם SSL, זה אפשרי?" },
    { t: at(7, 44), ch: "me", text: "בהחלט." },
    { t: at(8, 2), ch: "them", text: "ומה לגבי אחסון, מי אחראי על הגיבויים אם משהו נופל בשבת?" },
  ];
  // "side-1" has turnId "side" and must be filtered out by livefeed (it is the check that side cards stay hidden).
  /** @type {any[]} */
  const cards = [
    {
      type: "card",
      id: "q1-ai",
      turnId: "q1",
      badge: "ai",
      t: at(5, 14),
      question: "ועוד שאלה, אתם יכולים לחבר את הטפסים ל-Monday ולשמור שם את הלידים?",
      say: "כן, אפשר לחבר את הטפסים ל-Monday דרך webhook, וכל ליד נכנס ללוח עם המקור שלו. לוקח בערך יום עבודה.",
    },
    { type: "card", id: "q2-stall", turnId: "q2", badge: "stall", t: at(7, 35), question: "", say: "שאלה טובה, תן לי שנייה לוודא שאני נותן לך מספר מדויק." },
    {
      type: "card",
      id: "q3-bank",
      turnId: "q3",
      badge: "bank",
      t: at(6, 55),
      question: "כמה זמן לוקח להעביר את האתר לוורדפרס, ויש לנו גם חנות WooCommerce קטנה?",
      say: "בדרך כלל שלושה עד חמישה שבועות, תלוי בכמות התכנים. חנות קטנה מוסיפה בערך שבוע.",
    },
    {
      type: "card",
      id: "q4-bank",
      turnId: "q4",
      badge: "bank",
      t: at(8, 5),
      question: "ומה לגבי אחסון, מי אחראי על הגיבויים אם משהו נופל בשבת?",
      say: "גיבוי יומי ל-30 יום על שרת ייעודי, ושחזור בתוך שעתיים גם בשבת.",
    },
    { type: "card", id: "side-1", turnId: "side", badge: "fact", t: at(5, 0), say: "should never show" },
  ];
  // Invented call frame and tips (snapshot only).
  cards.push({
    type: "card",
    id: "tip-1",
    turnId: "tips",
    badge: "tip",
    tipType: "ask",
    t: at(6, 20),
    say: "שאל איזה כלי CRM משתמשים אצלם היום, כדי לדעת אם Monday באמת מתאים.",
  });
  cards.push({
    type: "card",
    id: "tip-2",
    turnId: "tips",
    badge: "tip",
    tipType: "clarify",
    t: at(8, 8),
    say: "הם אמרו 'אם משהו נופל בשבת': כדאי לברר אם צריך תמיכה גם בסוף שבוע.",
  });
  const frame = {
    type: "frame",
    frame: {
      kind: "client",
      topic: "אתר איטי, מעבר לוורדפרס וגיבויים",
      goal: "להבין את הצרכים ולהכין הצעה",
      people: [{ who: "דנה", role: "לקוחה" }],
      entities: ["Monday", "WooCommerce", "Cloudflare"],
      checklist: [
        { item: "להבין למה האתר איטי", done: true, must: true },
        { item: "תקציב וטווח זמן להשקה", done: false, must: true },
        { item: "חיבור הטפסים ל-Monday", done: true, must: false },
        { item: "גיבויים ומי אחראי בסופ״ש", done: true, must: true },
        { item: "מי מאשר את העיצוב אצלם", done: false, must: false },
        { item: "הצעד הבא ומועד לחזרה", done: false, must: true },
      ],
    },
  };
  const feed = feedLib.create();
  feed.addLines(lines);
  feed.addCards(cards);
  feed.addFrameRows([frame]);
  return { callId, reset: true, ...feed.snapshot() };
}

/** The same call in English, for the English window (screenshots in the docs): English call text, an English tip, one client spelling. Invented. */
function buildEn(liveAt, callId) {
  const at = (m, s) => liveAt + (m * 60 + s) * 1000;
  const lines = [
    { t: at(5, 2), ch: "me", text: "Sure, I am noting it down. So the site is slow mostly on the home page?" },
    { t: at(5, 11), ch: "them", text: "Yes, mostly the home page and the product pages. On mobile it is really bad, almost ten seconds." },
    { t: at(5, 24), ch: "me", text: "Got it. We will check the server." },
    { t: at(5, 40), ch: "them", text: "One more thing, can you connect the forms to Monday and keep the leads there?" },
    { t: at(6, 15), ch: "me", text: "Yes, that is possible. We will put a price in the offer." },
    { t: at(6, 52), ch: "them", text: "How long does it take to move the site to WordPress? We also have a small WooCommerce shop." },
    { t: at(7, 31), ch: "them", text: "Oh, and the site must work with Cloudflare and have SSL. Is that possible?" },
    { t: at(7, 44), ch: "me", text: "Of course." },
    { t: at(8, 2), ch: "them", text: "What about hosting? Who looks after the backups if something breaks on a Saturday?" },
  ];
  /** @type {any[]} */
  const cards = [
    {
      type: "card",
      id: "q1-ai",
      turnId: "q1",
      badge: "ai",
      t: at(5, 14),
      question: "One more thing, can you connect the forms to Monday and keep the leads there?",
      say: "Yes. A webhook sends each form to a Monday board with its source. It takes about one working day.",
    },
    {
      type: "card",
      id: "q3-bank",
      turnId: "q3",
      badge: "bank",
      t: at(6, 55),
      question: "How long does it take to move the site to WordPress? We also have a small WooCommerce shop.",
      say: "Usually three to five weeks, depending on the content. A small shop adds about a week.",
    },
    {
      type: "card",
      id: "q4-bank",
      turnId: "q4",
      badge: "bank",
      t: at(8, 5),
      question: "What about hosting? Who looks after the backups if something breaks on a Saturday?",
      say: "Daily backups kept for 30 days on a dedicated server, and a restore within two hours, also on Saturday.",
    },
    { type: "card", id: "side-1", turnId: "side", badge: "fact", t: at(5, 0), say: "should never show" },
    {
      type: "card",
      id: "tip-1",
      turnId: "tips",
      badge: "tip",
      tipType: "ask",
      t: at(6, 20),
      say: "Ask which CRM they use today, so you know if Monday really fits.",
    },
    {
      type: "card",
      id: "tip-2",
      turnId: "tips",
      badge: "tip",
      tipType: "clarify",
      t: at(8, 8),
      say: "They said 'if something breaks on a Saturday'. Check if they need weekend support too.",
    },
  ];
  const frame = {
    type: "frame",
    frame: {
      kind: "client",
      topic: "Slow site, move to WordPress and backups",
      goal: "Understand the needs and prepare an offer",
      people: [{ who: "Dana", role: "client" }],
      entities: ["Monday", "WooCommerce", "Cloudflare"],
      checklist: [
        { item: "Understand why the site is slow", done: true, must: true },
        { item: "Budget and launch window", done: false, must: true },
        { item: "Connect the forms to Monday", done: true, must: false },
        { item: "Backups and who owns the weekend", done: true, must: true },
        { item: "Who approves the design", done: false, must: false },
        { item: "Next step and follow-up date", done: false, must: true },
      ],
    },
  };
  const feed = feedLib.create();
  feed.addLines(lines);
  feed.addCards(cards);
  feed.addFrameRows([frame]);
  return { callId, reset: true, ...feed.snapshot() };
}

module.exports = { build };
