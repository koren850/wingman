// Scenarios for the answer window v2 (run by snap2.cjs, listed by snapshot.sh as v2-*). All people, companies and numbers are invented.
// A scenario is { rows, lines?, steps?, phase?, frame? }. rows reach the page on the "card" channel exactly as main.cjs would send them:
//   v2 card rows (kind, value, why, more, closes, ...), view rows ({ type: "view", ... }) and legacy rows (no v2 fields).
// steps run in the page after the rows: { click: "css selector" } | { wait: ms } | { key: "recap" } (fires the recap event).
const now = Date.now();
const row = (o) => ({ type: "card", question: "", facts: [], at: now, ...o });

/** Call content in the language of the UI, so a Hebrew run looks like a Hebrew call. */
const TXT = {
  en: {
    ask: "Can you connect it to Salesforce?",
    answer: "Yes, through the API. About two days of work.",
    answerWhy: "They asked about the CRM link, and the brief lists the API",
    answerMore: ["Needs an admin user in Salesforce", "Zapier works too, but a direct webhook has fewer points of failure", "Price from the brief: 2,400 once"],
    prompt: "Ask who approves the design on their side.",
    promptWhy: "Not covered yet, and the launch date depends on it",
    check: "You said Friday. The brief says the launch is Monday.",
    checkWhy: "You promised a date that conflicts with the plan",
    checkMore: ["You said: we finish by Friday", "Brief: launch Monday 10 Nov"],
    fact: "Their site runs WooCommerce 8.2",
    long: "Yes, we can connect the forms straight to the CRM through the API, keep every UTM tag from the ad campaigns, and send a test lead to prove it works before the launch date. Setup takes about two working days and is a one time fee.",
    longMore: ["Needs admin permission in the CRM", "A direct webhook beats Zapier"],
    mixed: "Yes: the WooCommerce site on shop.example-shop.com moves in 3-5 weeks, about 12,000 + VAT.",
    topic: "Moving the shop to the new host",
    open: ["Who approves the design?", "Is the SSL certificate renewed?", "What is the yearly maintenance price?"],
    promises: ["Send the quote by Thursday", "Check the redirects list"],
    cover: ["Schedule and launch", "Yearly maintenance price"],
    line: "So basically we need the site to connect to the CRM, and every lead should come in by itself.",
    recap: {
      where: "Talking about the move to the new host and the CRM link.",
      decided: ["Launch after the holidays", "Use a direct webhook"],
      open: ["Who approves the design?", "Yearly maintenance price"],
      promised: ["Send the quote by Thursday"],
      asked: ["A list of redirects", "The server access details"],
    },
    demoted: ["How long do backups stay?", "Do you support Hebrew search?", "What is the SLA?"],
  },
  he: {
    ask: "אתם יכולים לחבר את זה ל-Salesforce?",
    answer: "כן, דרך ה-API. בערך יומיים עבודה.",
    answerWhy: "שאלו על החיבור ל-CRM, וב-brief כתוב שיש API",
    answerMore: ["צריך משתמש אדמין ב-Salesforce", "גם Zapier עובד, אבל webhook ישיר פחות נשבר", "מחיר מה-brief: 2,400 ₪ חד פעמי"],
    prompt: "תשאל מי מאשר את העיצוב אצלם.",
    promptWhy: "עוד לא כיסיתם את זה, ותאריך ההשקה תלוי בזה",
    check: "אמרת יום שישי. לפי התוכנית ההשקה ביום שני.",
    checkWhy: "התחייבת לתאריך שסותר את התוכנית",
    checkMore: ["אמרת: נסיים עד יום שישי", "תוכנית: השקה ביום שני 10 בנובמבר"],
    fact: "האתר שלהם רץ על WooCommerce 8.2",
    long: "כן, אפשר לחבר את הטפסים ישירות ל-CRM דרך ה-API, לשמור כל תג UTM מקמפייני הפרסום, ולשלוח ליד לדוגמה שמוכיח שהכול עובד עוד לפני תאריך ההשקה. ההקמה לוקחת בערך יומיים עבודה ועולה תשלום חד פעמי.",
    longMore: ["צריך הרשאת אדמין ב-CRM", "webhook ישיר עדיף על Zapier"],
    mixed: "כן: האתר ב-WooCommerce בכתובת shop.example-shop.com עובר תוך 3-5 שבועות, בערך 12,000 ₪ + מע״מ.",
    topic: "העברת החנות לשרת החדש",
    open: ["מי מאשר את העיצוב?", "האם תעודת ה-SSL חודשה?", "מה מחיר התחזוקה השנתי?"],
    promises: ["לשלוח הצעת מחיר עד יום חמישי", "לבדוק את רשימת ההפניות"],
    cover: ["לוח זמנים והשקה", "מחיר תחזוקה שנתי"],
    line: "אז בעצם אנחנו צריכים שהאתר יתחבר ל-CRM, וכל ליד יכנס לבד.",
    recap: {
      where: "מדברים על ההעברה לשרת החדש ועל החיבור ל-CRM.",
      decided: ["השקה אחרי החגים", "משתמשים ב-webhook ישיר"],
      open: ["מי מאשר את העיצוב?", "מחיר תחזוקה שנתי"],
      promised: ["לשלוח הצעת מחיר עד יום חמישי"],
      asked: ["רשימת הפניות", "פרטי הגישה לשרת"],
    },
    demoted: ["כמה זמן נשמרים הגיבויים?", "יש תמיכה בחיפוש בעברית?", "מה ה-SLA?"],
  },
};

const view = (T, extra = {}) => ({
  type: "view",
  at: now,
  now: T.topic,
  kind: "client",
  open: T.open,
  promises: T.promises,
  cover: T.cover,
  recap: T.recap,
  ...extra,
});
const answer = (T, o = {}) =>
  row({ id: "a1", turnId: "t1", badge: "ai", kind: "answer", value: 3, question: T.ask, say: T.answer, why: T.answerWhy, more: T.answerMore, ...o });
const check = (T, o = {}) => row({ id: "c1", turnId: "t2", badge: "careful", kind: "check", value: 3, say: T.check, why: T.checkWhy, more: T.checkMore, ...o });
const lines = (T) => [{ t: now - 2000, ch: "them", text: T.line }];
const legacy = (T) => [
  row({ id: "l1", turnId: "q1", badge: "bank", question: T.ask, say: T.answer, facts: T.answerMore.slice(0, 2) }),
  row({ id: "l2", turnId: "q2", badge: "ai", question: T.ask, say: T.long }),
];

/** name -> (T) => scenario. */
const SCENARIOS = {
  "v2-answer": (T) => ({ rows: [view(T), answer(T)], lines: lines(T) }),
  "v2-prompt": (T) => ({
    rows: [view(T), row({ id: "p1", turnId: "t3", badge: "tip", kind: "prompt", value: 2, say: T.prompt, why: T.promptWhy })],
    lines: lines(T),
  }),
  "v2-check": (T) => ({ rows: [view(T), check(T)], lines: lines(T) }),
  "v2-fact": (T) => ({ rows: [view(T), row({ id: "f1", turnId: "t4", badge: "info", kind: "fact", value: 1, say: T.fact })], lines: lines(T) }),
  "v2-more": (T) => ({ rows: [view(T), answer(T)], lines: lines(T), steps: [{ click: ".hctl .b.more" }] }),
  "v2-long": (T) => ({ rows: [view(T), answer(T, { say: T.long, more: T.longMore })], lines: lines(T) }),
  "v2-mixed": (T) => ({ rows: [view(T), answer(T, { say: T.mixed })], lines: lines(T) }),
  "v2-rtl": (T) => ({ rows: [view(T), answer(T, { question: T.ask })], lines: lines(T), forceContent: "he" }),
  "v2-chips4": (T) => ({
    rows: [view(T), row({ id: "w1", turnId: "t5", badge: "ai", kind: "answer", value: 1, say: T.demoted[0], at: now - 30000 }), answer(T, { at: now - 5000 })],
    lines: lines(T),
  }),
  "v2-chipsopen": (T) => ({ rows: [view(T), answer(T)], lines: lines(T), steps: [{ click: ".chip.count.open" }] }),
  "v2-replace": (T) => ({
    rows: [view(T), row({ id: "w1", turnId: "t5", badge: "ai", kind: "answer", value: 1, say: T.demoted[0], at: now - 8000 }), check(T, { at: now })],
    lines: lines(T),
  }),
  "v2-manychips": (T) => ({
    rows: [
      view(T),
      ...T.demoted.map((s, i) => row({ id: "w" + i, turnId: "t" + i, badge: "ai", kind: "answer", value: 1, say: s, at: now - 20000 + i * 1000 })),
      row({ id: "f1", turnId: "t9", badge: "info", kind: "fact", value: 1, say: T.fact, at: now - 3000 }),
      answer(T, { at: now }),
    ],
    lines: lines(T),
  }),
  "v2-controls": (T) => ({
    rows: [view(T), answer(T)],
    lines: lines(T),
    // pin, Useful, Useful again (clears), Not useful, Copy, Dismiss: snap2.cjs records what main.cjs would receive
    steps: [
      { click: ".hctl .b.pin" },
      { click: ".hctl .b.up" },
      { click: ".hctl .b.up" },
      { click: ".hctl .b.down" },
      { click: ".hctl .b.copy" },
      { click: ".hctl .b.x" },
    ],
  }),
  "v2-recap": (T) => ({ rows: [view(T), answer(T)], lines: lines(T), steps: [{ key: "recap" }] }),
  "v2-idle": (T) => ({ rows: [view(T, { open: T.open.slice(0, 2) })], lines: [] }),
  "v2-idle-empty": () => ({ rows: [], lines: [], frame: { kind: "client", topic: "", checklist: [] } }),
  "v2-dim": (T) => ({ rows: [view(T), answer(T), { type: "card", id: "a1", closes: "answered", at: now }], lines: lines(T) }),
  "v2-topic": (T) => ({ rows: [view(T), answer(T), { type: "card", id: "a1", closes: "topic", at: now }], lines: [] }),
  "v2-offline": (T) => ({ rows: [view(T, { ai: "offline" }), ...legacy(T)], lines: lines(T) }),
  "v2-aipaused": (T) => ({ rows: [view(T, { ai: "paused" }), answer(T)], lines: lines(T) }),
  "v2-legacy": (T) => ({ rows: legacy(T), lines: lines(T) }),
  "v2-firstrun": () => ({ rows: [], lines: [], phase: "starting" }),
  "v2-nolines": (T) => ({ rows: [view(T), answer(T)], lines: [] }),
};
// ---- live-shaped scenarios: rows from a golden meeting run (src/testkit/live-golden.ts writes the JSON; a test keeps it current) ----
const liveSet = () => {
  try {
    return require("../src/testkit/fixtures/live-golden.json");
  } catch {
    return null;
  }
};
/** The golden run for this UI language, with times moved so the newest card is 3 s old. */
function liveRun(lang, until) {
  const set = liveSet();
  const f = set && set[lang === "he" ? "dev-support-he" : "dev-support-en"];
  if (!f) return null;
  let cards = f.cards;
  if (until) {
    const i = cards.findIndex((c) => c.kind === until);
    cards = cards.slice(0, i + 1);
  }
  const last = Math.max(...cards.map((c) => c.at));
  const shift = now - 3000 - last;
  const rows = [{ ...f.view, at: now }, ...cards.map((c) => ({ ...c, at: c.at + shift }))];
  const text = (r) =>
    [
      "WHERE: " + (r.where || (lang === "he" ? "מחיר החידוש והגיבויים" : "Renewal price and backups")),
      "DECIDED: " + r.decided.join(" | "),
      "OPEN: " + r.open.join(" | "),
      "PROMISED: " + r.promised.join(" | "),
      "ASKED: " + r.asked.join(" | "),
    ].join("\n");
  return { rows, lines: f.lines.slice(-2).map((l, i) => ({ ...l, t: now - 4000 + i * 1000 })), recapText: text(f.recap) };
}
const live = (name, f) => {
  SCENARIOS[name] = (T, lang) => {
    const r = liveRun(lang);
    if (!r) return { rows: [], lines: [] };
    return f(r, lang);
  };
};
live("v2-live", (r) => ({ rows: r.rows, lines: r.lines }));
SCENARIOS["v2-live-check"] = (T, lang) => {
  const r = liveRun(lang, "check");
  return r ? { rows: r.rows, lines: r.lines } : { rows: [], lines: [] };
};
SCENARIOS["v2-live-prompt"] = (T, lang) => {
  const r = liveRun(lang, "prompt");
  return r ? { rows: r.rows, lines: r.lines } : { rows: [], lines: [] };
};
SCENARIOS["v2-live-fact"] = (T, lang) => {
  const r = liveRun(lang, "fact");
  return r ? { rows: r.rows, lines: r.lines } : { rows: [], lines: [] };
};
live("v2-live-stream", (r) => ({
  rows: r.rows,
  lines: r.lines,
  steps: [
    { send: ["recap", { phase: "start", text: "", recap: null, offline: false, notes: false }] },
    { send: ["recap", { phase: "delta", text: r.recapText.split("\n").slice(0, 3).join("\n"), recap: null, offline: false, notes: false }] },
  ],
}));
live("v2-live-recapdone", (r) => ({
  rows: r.rows,
  lines: r.lines,
  steps: [{ send: ["recap", { phase: "done", text: r.recapText, recap: null, offline: false, notes: false }] }],
}));
live("v2-live-recapnotes", (r) => ({
  rows: r.rows,
  lines: r.lines,
  steps: [{ send: ["recap", { phase: "done", text: "", recap: null, offline: true, notes: true }] }],
}));
live("v2-live-recaperror", (r) => ({
  rows: r.rows,
  lines: r.lines,
  steps: [{ send: ["recap", { phase: "error", text: "", recap: null, offline: false, notes: false }] }],
}));
// the keyboard path: the global keys reach the hero as "ctl" events (the window never takes focus), and the recap key as a "recap" event with no payload
live("v2-live-keys", (r) => ({
  rows: r.rows,
  lines: r.lines,
  steps: [
    { send: ["ctl", { name: "more" }] },
    { send: ["ctl", { name: "pin" }] },
    { send: ["ctl", { name: "useful" }] },
    { send: ["ctl", { name: "notuseful" }] },
    { send: ["ctl", { name: "bogus" }] },
    { key: "recap" },
  ],
}));
live("v2-live-aipaused", (r) => ({ rows: [{ ...r.rows[0], ai: "paused" }, ...r.rows.slice(1)], lines: r.lines }));
const ALL = Object.keys(SCENARIOS);
/** Build a scenario for a UI language ("en" | "he"). */
function build(name, lang) {
  const f = SCENARIOS[name];
  if (!f) throw new Error("unknown v2 scenario " + name);
  const sc = f(TXT[lang] || TXT.en, lang);
  return sc.forceContent ? f(TXT[sc.forceContent], sc.forceContent) : sc; // forceContent: the call is in another language than the window (RTL text in an English window)
}
module.exports = { ALL, build, SCENARIOS, TXT };
