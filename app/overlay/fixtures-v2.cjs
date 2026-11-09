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
    prompt: "Who approves the design on your side?",
    answerLabel: "CRM link",
    answerAbout: "Salesforce connection",
    factVal: "WooCommerce 8.2",
    factVal2: "30 days",
    factLabel2: "Backups kept",
    cut: "Yes, we can connect the forms straight to the CRM through the API, keep every UTM tag from the ad campaigns, and send a test lead to prove it works before the launch date, but",
    chips8: [
      ["answer", "CRM link"],
      ["answer", "Backup time"],
      ["prompt", "Design approval"],
      ["answer", "Hebrew search"],
      ["answer", "SLA terms"],
      ["fact", "Their stack"],
      ["answer", "Price range"],
      ["answer", "Launch date"],
    ],
    checkLabel: "Launch date",
    promptLabel: "Design approval",
    factLabel: "Their stack",
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
    busy: [
      { kind: "answer", say: "Yes, a direct webhook works and avoids the Zapier fees.", label: "Webhook option" },
      { kind: "answer", say: "Backups stay for 30 days, then they are deleted.", label: "Backup retention" },
      { kind: "check", say: "You said Friday. The brief says Monday.", label: "Launch date", ref: "date" },
      { kind: "check", say: "You said 2,400. The brief says 2,800.", label: "Price mismatch", ref: "price" },
      { kind: "check", say: "You said Friday again. The brief still says Monday.", label: "Launch date", ref: "date" },
      { kind: "prompt", say: "Who approves the design on your side?", label: "Design approval" },
      { kind: "fact", say: "Their site runs WooCommerce 8.2", label: "Their stack", src: "brief" },
      { kind: "fact", say: "They renewed the plan in March", label: "Renewal", src: "past" },
      {
        kind: "answer",
        say: "We can connect the forms straight to the CRM through the API, keep every UTM tag, and send a test lead before launch.",
        label: "",
      },
      { kind: "answer", say: "Hebrew search is supported since version 3.", label: "Hebrew search" },
      { kind: "answer", say: "The SLA is 99.9 percent per month.", label: "SLA terms" },
    ],
    me: "I will send the quote by Thursday, and a list of the redirects.",
  },
  he: {
    ask: "אתם יכולים לחבר את זה ל-Salesforce?",
    answer: "כן, דרך ה-API. בערך יומיים עבודה.",
    answerWhy: "שאלו על החיבור ל-CRM, וב-brief כתוב שיש API",
    answerMore: ["צריך משתמש אדמין ב-Salesforce", "גם Zapier עובד, אבל webhook ישיר פחות נשבר", "מחיר מה-brief: 2,400 ₪ חד פעמי"],
    prompt: "מי מאשר את העיצוב אצלכם?",
    answerLabel: "חיבור ל-CRM",
    answerAbout: "חיבור ל-Salesforce",
    factVal: "WooCommerce 8.2",
    factVal2: "30 יום",
    factLabel2: "שמירת גיבויים",
    cut: "כן, אפשר לחבר את הטפסים ישירות ל-CRM דרך ה-API, לשמור כל תג UTM מקמפייני הפרסום, ולשלוח ליד לדוגמה שמוכיח שהכול עובד עוד לפני תאריך ההשקה, אבל",
    chips8: [
      ["answer", "חיבור ל-CRM"],
      ["answer", "זמן גיבוי"],
      ["prompt", "אישור עיצוב"],
      ["answer", "חיפוש בעברית"],
      ["answer", "תנאי SLA"],
      ["fact", "הטכנולוגיה שלהם"],
      ["answer", "טווח מחירים"],
      ["answer", "תאריך השקה"],
    ],
    checkLabel: "תאריך השקה",
    promptLabel: "אישור עיצוב",
    factLabel: "הטכנולוגיה שלהם",
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
    busy: [
      { kind: "answer", say: "כן, webhook ישיר עובד וחוסך את העלות של Zapier.", label: "אפשרות webhook" },
      { kind: "answer", say: "הגיבויים נשמרים 30 יום ואז נמחקים.", label: "שמירת גיבויים" },
      { kind: "check", say: "אמרת יום שישי. לפי התוכנית יום שני.", label: "תאריך השקה", ref: "date" },
      { kind: "check", say: "אמרת 2,400. לפי התוכנית 2,800.", label: "פער במחיר", ref: "price" },
      { kind: "check", say: "אמרת שוב יום שישי. התוכנית עדיין אומרת יום שני.", label: "תאריך השקה", ref: "date" },
      { kind: "prompt", say: "מי מאשר את העיצוב אצלכם?", label: "אישור עיצוב" },
      { kind: "fact", say: "האתר שלהם רץ על WooCommerce 8.2", label: "הטכנולוגיה שלהם", src: "brief" },
      { kind: "fact", say: "הם חידשו את החבילה במרץ", label: "חידוש", src: "past" },
      { kind: "answer", say: "אפשר לחבר את הטפסים ישירות ל-CRM דרך ה-API, לשמור כל תג UTM, ולשלוח ליד לדוגמה לפני ההשקה.", label: "" },
      { kind: "answer", say: "חיפוש בעברית נתמך מגרסה 3.", label: "חיפוש בעברית" },
      { kind: "answer", say: "ה-SLA הוא 99.9 אחוז בחודש.", label: "תנאי SLA" },
    ],
    me: "אני אשלח את הצעת המחיר עד יום חמישי, ורשימה של ההפניות.",
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
  row({
    id: "a1",
    turnId: "t1",
    badge: "ai",
    kind: "answer",
    value: 3,
    question: T.ask,
    say: T.answer,
    label: T.answerLabel,
    about: T.answerAbout,
    why: T.answerWhy,
    more: T.answerMore,
    ...o,
  });
const check = (T, o = {}) =>
  row({ id: "c1", turnId: "t2", badge: "careful", kind: "check", value: 3, say: T.check, label: T.checkLabel, why: T.checkWhy, more: T.checkMore, ...o });
const lines = (T) => [{ t: now - 2000, ch: "them", text: T.line }];
const legacy = (T) => [
  row({ id: "l1", turnId: "q1", badge: "bank", question: T.ask, say: T.answer, facts: T.answerMore.slice(0, 2) }),
  row({ id: "l2", turnId: "q2", badge: "ai", question: T.ask, say: T.long }),
];

/** name -> (T) => scenario. */
const SCENARIOS = {
  "v2-answer": (T) => ({ rows: [view(T), answer(T)], lines: lines(T) }),
  "v2-prompt": (T) => ({
    rows: [view(T), row({ id: "p1", turnId: "t3", badge: "tip", kind: "prompt", value: 2, say: T.prompt, label: T.promptLabel, why: T.promptWhy })],
    lines: lines(T),
  }),
  "v2-check": (T) => ({ rows: [view(T), check(T)], lines: lines(T) }),
  "v2-fact": (T) => ({
    rows: [view(T), row({ id: "f1", turnId: "t4", badge: "info", kind: "fact", value: 1, say: T.fact, label: T.factLabel, src: "brief" })],
    lines: lines(T),
  }),
  "v2-more": (T) => ({ rows: [view(T), answer(T)], lines: lines(T), steps: [{ click: ".hcard" }] }),
  "v2-long": (T) => ({ rows: [view(T), answer(T, { say: T.long, more: T.longMore })], lines: lines(T) }),
  "v2-mixed": (T) => ({ rows: [view(T), answer(T, { say: T.mixed })], lines: lines(T) }),
  "v2-rtl": (T) => ({ rows: [view(T), answer(T, { question: T.ask })], lines: lines(T), forceContent: "he" }),
  "v2-chips4": (T) => ({
    rows: [view(T), row({ id: "w1", turnId: "t5", badge: "ai", kind: "answer", value: 1, say: T.demoted[0], at: now - 30000 }), answer(T, { at: now - 5000 })],
    lines: lines(T),
  }),
  "v2-chipsopen": (T) => ({ rows: [view(T), answer(T)], lines: lines(T), steps: [{ click: ".chip.ctxbtn" }] }),
  "v2-replace": (T) => ({
    rows: [view(T), row({ id: "w1", turnId: "t5", badge: "ai", kind: "answer", value: 1, say: T.demoted[0], at: now - 8000 }), check(T, { at: now })],
    lines: lines(T),
  }),
  "v2-manychips": (T) => ({
    rows: [
      view(T),
      ...T.demoted.map((s, i) => row({ id: "w" + i, turnId: "t" + i, badge: "ai", kind: "answer", value: 1, say: s, at: now - 20000 + i * 1000 })),
      row({ id: "f1", turnId: "t9", badge: "info", kind: "fact", value: 1, say: T.fact, label: T.factLabel, src: "brief", at: now - 3000 }),
      answer(T, { at: now }),
    ],
    lines: lines(T),
  }),
  "v2-controls": (T) => ({
    rows: [view(T), answer(T)],
    lines: lines(T),
    // pin, Useful, Useful again (clears), Not useful, Copy, Dismiss: snap2.cjs records what main.cjs would receive
    steps: [
      { click: ".hcard .b.pin" },
      { click: ".hcard .b.up" },
      { click: ".hcard .b.up" },
      { click: ".hcard .b.down" },
      { click: ".hcard .b.copy" },
      { click: ".hcard .b.x" },
    ],
  }),
  "v2-recap": (T) => ({ rows: [view(T), answer(T)], lines: lines(T), steps: [{ key: "recap" }] }),
  "v2-idle": (T) => ({ rows: [view(T, { open: T.open.slice(0, 2) })], lines: [] }),
  "v2-idle-empty": () => ({ rows: [], lines: [], frame: { kind: "client", topic: "", checklist: [] } }),
  "v2-dim": (T) => ({ rows: [view(T), answer(T), { type: "card", id: "a1", closes: "answered", at: now }], lines: lines(T) }),
  "v2-topic": (T) => ({ rows: [view(T), answer(T), { type: "card", id: "a1", closes: "topic", at: now }], lines: [] }),
  // AI offline: only prepared (local) cards. A card marked "AI, unverified" next to the "AI offline" bar would contradict it.
  "v2-offline": (T) => ({ rows: [view(T, { ai: "offline" }), legacy(T)[0]], lines: lines(T) }),
  "v2-aipaused": (T) => ({ rows: [view(T, { ai: "paused" }), answer(T)], lines: lines(T) }),
  "v2-legacy": (T) => ({ rows: legacy(T), lines: lines(T) }),
  // the kind of call as a read-only pill: a guess (auto) and a locked kind; no pill when the engine sent no kind
  "v2-mode-auto": (T) => ({ rows: [view(T, { kind: "support", kindLocked: false }), answer(T)], lines: lines(T) }),
  "v2-mode-locked": (T) => ({ rows: [view(T, { kind: "interview", kindLocked: true }), answer(T)], lines: lines(T) }),
  "v2-mode-none": (T) => ({ rows: [view(T, { kind: "" }), answer(T)], lines: lines(T) }),
  // a live nudge: a thin line under the top bar; a Check on screen holds it back
  "v2-nudge": (T) => ({
    rows: [view(T, { kind: "client", kindLocked: true }), answer(T)],
    lines: lines(T),
    steps: [{ send: ["nudge", { kind: "pace", value: 196, limit: 180 }] }],
  }),
  "v2-nudge-share": (T) => ({ rows: [view(T), answer(T)], lines: lines(T), steps: [{ send: ["nudge", { kind: "share", value: 78, limit: 70 }] }] }),
  "v2-nudge-held": (T) => ({ rows: [view(T), check(T)], lines: lines(T), steps: [{ send: ["nudge", { kind: "interrupt", value: 3, limit: 3 }] }] }),
  "v2-firstrun": () => ({ rows: [], lines: [], phase: "starting" }),
  "v2-nolines": (T) => ({ rows: [view(T), answer(T)], lines: [] }),
};
Object.assign(SCENARIOS, {
  // ---- more scenarios ----
  // a busy call: 11 rows (two checks about the same date merge into one), Hebrew or English labels, one row with no label, a long line
  "v2-busy": (T) => ({
    rows: [
      view(T),
      ...T.busy.map((b, i) =>
        row({
          id: "b" + i,
          turnId: "t" + i,
          badge: b.kind === "check" ? "careful" : "ai",
          kind: b.kind,
          value: b.kind === "answer" ? 1 + (i % 3) : 2,
          say: b.say,
          label: b.label,
          ref: b.ref,
          src: b.src,
          why: i === 4 ? T.checkWhy : "",
          at: now - (40 - i * 3) * 1000,
        }),
      ),
    ],
    lines: lines(T),
    steps: [],
  }),
  "v2-busy-open": (T) => ({
    rows: SCENARIOS["v2-busy"](T).rows,
    lines: lines(T),
    steps: [{ click: ".chip.morecards" }],
  }),
  // an old hero (6 minutes): faded; and a chip that was seen vs one that is new
  // an answer 6 minutes old is only a chip (with what it was about); the newer prompt holds the hero seat
  "v2-aged": (T) => ({
    rows: [
      view(T),
      answer(T, { at: now - 6.5 * 60000 }),
      row({ id: "p1", turnId: "t3", badge: "tip", kind: "prompt", value: 2, say: T.prompt, label: T.promptLabel, at: now - 40000 }),
    ],
    lines: lines(T),
  }),
  // ---- answer window v3 scenarios ----
  // the line was cut by the engine (fit false): the hero clamps to 3 lines and offers More
  "v2-fitfalse": (T) => ({ rows: [view(T), answer(T, { say: T.cut, fit: false, more: T.longMore })], lines: lines(T) }),
  // a very long line with no detail: the hero clamps to 3 lines and More opens the rest
  "v2-overflow": (T) => ({ rows: [view(T), answer(T, { say: T.long + " " + T.long, more: [] })], lines: lines(T) }),
  "v2-fitfalse-open": (T) => ({
    rows: [view(T), answer(T, { say: T.cut, fit: false, more: T.longMore })],
    lines: lines(T),
    steps: [{ click: ".hcard .b.more" }],
  }),
  // eight waiting cards with labels: three on the rail, the rest behind +N
  "v2-chips8": (T) => ({
    rows: [
      view(T),
      ...T.chips8.map(([kind, label], i) =>
        row({
          id: "k" + i,
          turnId: "t" + i,
          badge: "ai",
          kind,
          value: 1 + (i % 2),
          say: T.demoted[i % 3],
          label,
          src: kind === "fact" ? "brief" : undefined,
          val: kind === "fact" ? T.factVal : undefined,
          at: now - (80 - i * 9) * 1000,
        }),
      ),
    ],
    lines: lines(T),
  }),
  // a card with no label reads as its kind word, never the first words of the line
  "v2-nolabel": (T) => ({
    rows: [
      view(T),
      row({ id: "n1", turnId: "t1", badge: "ai", kind: "answer", value: 1, say: T.demoted[0], at: now - 30000 }),
      row({ id: "n2", turnId: "t2", badge: "ai", kind: "answer", value: 1, say: T.demoted[1], at: now - 20000 }),
      row({ id: "n3", turnId: "t3", badge: "info", kind: "fact", value: 1, say: T.fact, at: now - 10000 }),
      answer(T, { at: now - 2000 }),
    ],
    lines: lines(T),
  }),
  // fact chips show "label: value"
  "v2-factvals": (T) => ({
    rows: [
      view(T),
      row({ id: "f1", turnId: "t4", badge: "info", kind: "fact", value: 1, say: T.fact, label: T.factLabel, val: T.factVal, src: "brief", at: now - 20000 }),
      row({
        id: "f2",
        turnId: "t5",
        badge: "info",
        kind: "fact",
        value: 1,
        say: T.demoted[0],
        label: T.factLabel2,
        val: T.factVal2,
        src: "past",
        at: now - 10000,
      }),
      answer(T, { at: now - 3000 }),
    ],
    lines: lines(T),
  }),
  // 3 minutes: faded text, the age in the warning colour, the about tag
  "v2-stale3": (T) => ({ rows: [view(T), answer(T, { at: now - 200000 })], lines: lines(T) }),
  // a check arrives while an answer is on screen: amber flash, the answer moves to the rail
  "v2-check-arrive": (T) => ({
    rows: [view(T), answer(T, { at: now - 20000 })],
    lines: lines(T),
    steps: [{ send: ["card", check(T, { at: Date.now() })] }],
  }),
  "v2-context": (T) => ({
    rows: [
      view(T),
      answer(T),
      row({ id: "p1", turnId: "t3", badge: "ai", kind: "answer", value: 1, say: T.demoted[0], label: "x", at: now - 9000 }),
      { type: "card", id: "p1", closes: "dismissed", at: now },
    ],
    lines: lines(T),
    steps: [{ click: ".chip.ctxbtn" }],
  }),
  // keyboard: Tab lands on the card; the focus ring shows
  "v2-focus": (T) => ({ rows: [view(T), answer(T)], lines: lines(T), steps: [{ focus: ".hcard" }] }),
  "v2-focus-btn": (T) => ({ rows: [view(T), answer(T)], lines: lines(T), steps: [{ focus: ".hcard .b.up" }] }),
  // keyboard path: the card has the focus; Enter opens More, P pins, 1 and 2 rate, Esc dismisses
  "v2-key-flow": (T) => ({
    rows: [view(T), answer(T)],
    lines: lines(T),
    steps: [{ focus: ".hcard" }, { press: "Enter" }, { press: "p" }, { press: "1" }, { press: "2" }, { press: "Escape" }],
  }),
  // "Fewer like this" in the menu: a rating "fewer" and a dismiss go to main
  "v2-fewer": (T) => ({ rows: [view(T), answer(T)], lines: lines(T), steps: [{ click: ".hcard .b.fewer" }] }),
  "v2-menu": (T) => ({ rows: [view(T), answer(T)], lines: lines(T), steps: [{ click: ".hcard .b.menu" }] }),
  "v2-both": (T) => ({
    rows: [view(T), answer(T)],
    lines: [...lines(T), { t: now - 800, ch: "me", text: T.me }],
  }),
  "v2-note": (T) => ({
    rows: [view(T), answer(T)],
    lines: lines(T),
    steps: [
      {
        send: [
          "note",
          {
            kind: "hotkey",
            text: require("./strings.js").t(T === TXT.he ? "he" : "en", "note.keyTaken", {
              key: "Ctrl+Opt+S",
              name: require("./strings.js").t(T === TXT.he ? "he" : "en", "hk.pin"),
            }),
          },
        ],
      },
    ],
  }),
  // dismiss the hero, then bring it back with the restore key
  "v2-restore": (T) => ({ rows: [view(T), answer(T)], lines: lines(T), steps: [{ click: ".hcard .b.x" }, { key: "restore" }] }),
  "v2-fit-idle": (T) => ({ rows: [view(T)], lines: lines(T) }),
  "v2-fit-empty": () => ({ rows: [], lines: [], frame: { kind: "client", topic: "", checklist: [] } }),
  "v2-fit-answer": (T) => ({ rows: [view(T), answer(T)], lines: lines(T) }),
  "v2-fit-recap": (T) => ({ rows: [view(T), answer(T)], lines: lines(T), steps: [{ key: "recap" }] }),
});
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
    { key: "recap" }, // the sheet opens only for a recap the user asked for
    { send: ["recap", { phase: "start", text: "", recap: null, offline: false, notes: false }] },
    { send: ["recap", { phase: "delta", text: r.recapText.split("\n").slice(0, 3).join("\n"), recap: null, offline: false, notes: false }] },
  ],
}));
live("v2-live-recapdone", (r) => ({
  rows: r.rows,
  lines: r.lines,
  steps: [{ key: "recap" }, { send: ["recap", { phase: "done", text: r.recapText, recap: null, offline: false, notes: false }] }],
}));
live("v2-live-recapnotes", (r) => ({
  rows: r.rows,
  lines: r.lines,
  steps: [{ key: "recap" }, { send: ["recap", { phase: "done", text: "", recap: null, offline: true, notes: true }] }],
}));
live("v2-live-recaperror", (r) => ({
  rows: r.rows,
  lines: r.lines,
  steps: [{ key: "recap" }, { send: ["recap", { phase: "error", text: "", recap: null, offline: false, notes: false }] }],
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
// ---- sequences (round 16): each one replays an order of events that used to go wrong; src/overlay-ux.test.ts reads the probe ----
const mePartial = (text) => ({ t: now, ch: "me", text, spk: undefined, name: undefined });
const tipRow = (id, say) => row({ id, turnId: "tips", badge: "tip", tipType: "ask", say });
const recapRows = (T) => ({
  start: { phase: "start", text: "", recap: null, offline: false, notes: false },
  delta: { phase: "delta", text: "WHERE: " + T.recap.where, recap: null, offline: false, notes: false },
  done: { phase: "done", text: "", recap: T.recap, offline: false, notes: false },
});
// the user closes the sheet while it streams; the next delta, and then the done row, must not open it again
SCENARIOS["v2-seq-recap-closed"] = (T) => ({
  rows: [view(T), answer(T)],
  lines: lines(T),
  steps: [
    { key: "recap" },
    { send: ["recap", recapRows(T).start] },
    { click: "#recap .b.x" },
    { send: ["recap", recapRows(T).delta] },
    { send: ["recap", recapRows(T).done] },
  ],
});
// a recap row nobody asked for (a replay after a reload, or a new call) does not open the sheet
SCENARIOS["v2-seq-recap-replayed"] = (T) => ({
  rows: [view(T), answer(T)],
  lines: lines(T),
  steps: [{ send: ["recap", recapRows(T).start] }, { send: ["recap", recapRows(T).delta] }, { send: ["recap", recapRows(T).done] }],
});
// a late recap row after the call ended leaves the ended screen alone
SCENARIOS["v2-seq-recap-ended"] = (T) => ({
  rows: [view(T), answer(T)],
  lines: lines(T),
  steps: [{ key: "recap" }, { key: "ended" }, { send: ["recap", recapRows(T).done] }],
});
// the sheet stays open through card rows and chip ticks, and its timer is set once (the page reports it)
SCENARIOS["v2-seq-recap-stays"] = (T) => ({
  rows: [view(T), answer(T)],
  lines: lines(T),
  steps: [
    { key: "recap" },
    { send: ["recap", recapRows(T).start] },
    { send: ["recap", recapRows(T).done] },
    { send: ["card", row({ id: "b2", turnId: "t9", badge: "ai", kind: "answer", value: 2, say: T.answer, label: T.answerLabel })] },
  ],
});
// rewind and recap are two sheets of one value: the last one opened wins, the other closes
SCENARIOS["v2-seq-sheets"] = (T) => ({ rows: [view(T), answer(T)], lines: lines(T), steps: [{ key: "rewind" }, { key: "recap" }] });
SCENARIOS["v2-seq-sheets-back"] = (T) => ({ rows: [view(T), answer(T)], lines: lines(T), steps: [{ key: "recap" }, { key: "rewind" }] });
// pause at the end of call A, then call B starts: B must not start paused
SCENARIOS["v2-seq-pause-next-call"] = (T) => ({
  rows: [view(T), answer(T)],
  lines: lines(T),
  steps: [
    { send: ["pause", { paused: true, callId: "a" }] },
    { key: "ended" },
    { key: "reset" },
    { send: ["phase", { phase: "live", liveAt: Date.now() - 5000 }] },
    { send: ["card", row({ id: "b1", turnId: "t1", badge: "ai", kind: "answer", value: 2, say: T.answer, label: T.answerLabel })] },
  ],
});
// main sends the whole pause state: pause on, a repeated "on" stays on, then off
SCENARIOS["v2-seq-pause-state"] = (T) => ({
  rows: [view(T), answer(T)],
  lines: lines(T),
  steps: [{ send: ["pause", { paused: true, callId: "a" }] }, { send: ["pause", { paused: true, callId: "a" }] }],
});
SCENARIOS["v2-seq-pause-off"] = (T) => ({
  rows: [view(T), answer(T)],
  lines: lines(T),
  steps: [{ send: ["pause", { paused: true, callId: "a" }] }, { send: ["pause", { paused: false, callId: "a" }] }],
});
// a cards.jsonl row that reaches the page after the call ended (main keeps reading the file) changes nothing
SCENARIOS["v2-seq-late-ended"] = (T) => ({
  rows: [view(T), answer(T)],
  lines: lines(T),
  steps: [
    { key: "ended" },
    { send: ["frame", { kind: "client", topic: T.topic, checklist: [{ item: "x", done: false }] }] },
    { send: ["addressed", { who: "Dana", text: T.ask }] },
    { send: ["nudge", { kind: "pace", value: 200, limit: 160 }] },
    { send: ["ask", { on: true, until: Date.now() + 60000 }] },
    { send: ["card", tipRow("late-tip", T.ask)] },
    { send: ["line", { t: Date.now(), ch: "them", text: T.ask }] },
  ],
});
// The 90 s tip timers are caught by the page script below and run by hand: window.__tipTimers keeps every one of them, in order, even after clearTimeout.
const catchTipTimers =
  "const st = window.setTimeout, ct = window.clearTimeout; window.__live = new Map(); window.__tipTimers = []; let n = 1e6; " +
  "window.setTimeout = (f, ms, ...a) => (ms === 90000 ? (window.__tipTimers.push(f), window.__live.set(++n, f), n) : st(f, ms, ...a)); " +
  "window.clearTimeout = (id) => (window.__live.delete(id) ? undefined : ct(id))";
// the same tip id comes back after it was pushed out (limit of two): the first tip's timer fires late and must not delete the new tip
SCENARIOS["v2-seq-tip-reuse"] = () => ({
  rows: [],
  lines: [],
  steps: [
    { eval: catchTipTimers },
    { send: ["card", tipRow("t1", "one")] },
    { send: ["card", tipRow("t2", "two")] },
    { send: ["card", tipRow("t3", "three")] },
    { send: ["card", tipRow("t1", "one again")] },
    { eval: "window.__tipTimers[0]()" },
  ],
});
// a tip from call A is gone after the reset, and A's timer must not touch call B's tip with the same id
SCENARIOS["v2-seq-tip-next-call"] = () => ({
  rows: [],
  lines: [],
  steps: [
    { eval: catchTipTimers },
    { send: ["card", tipRow("t1", "call A")] },
    { key: "reset" },
    { send: ["card", tipRow("t1", "call B")] },
    { eval: "window.__tipTimers[0]()" },
  ],
});
// an empty partial from your own voice must not hide the other side's line
SCENARIOS["v2-seq-strips"] = (T) => ({
  rows: [],
  lines: [{ t: now - 1000, ch: "them", text: T.ask }],
  steps: [{ send: ["partial", mePartial("")] }],
});
// the pinned card is closed by the engine, then the user unpins it: it dims then (the close was kept)
SCENARIOS["v2-seq-pin-closed"] = (T) => ({
  rows: [view(T), answer(T)],
  lines: lines(T),
  steps: [{ click: ".hcard .b.pin" }, { send: ["card", answer(T, { closes: "answered" })] }, { wait: 300 }],
});
SCENARIOS["v2-seq-pin-closed-unpin"] = (T) => ({
  rows: [view(T), answer(T)],
  lines: lines(T),
  steps: [{ click: ".hcard .b.pin" }, { send: ["card", answer(T, { closes: "answered" })] }, { click: ".hcard .b.pin" }],
});
// after a page reload main sends the pins first: the replayed close dims nothing that is pinned
SCENARIOS["v2-seq-pin-replay"] = (T) => ({
  rows: [],
  lines: [],
  steps: [{ send: ["pins", ["a1"]] }, { send: ["card", answer(T)] }, { send: ["card", answer(T, { closes: "topic" })] }],
});
// the sequence scenarios (v2-seq-*) are run by src/overlay-states.test.ts, with probes; the "every scenario" checks and snapshot.sh skip them to stay fast
const ALL = Object.keys(SCENARIOS).filter((n) => !n.startsWith("v2-seq-"));
/** Build a scenario for a UI language ("en" | "he"). */
function build(name, lang) {
  const f = SCENARIOS[name];
  if (!f) throw new Error("unknown v2 scenario " + name);
  const sc = f(TXT[lang] || TXT.en, lang);
  return sc.forceContent ? f(TXT[sc.forceContent], sc.forceContent) : sc; // forceContent: the call is in another language than the window (RTL text in an English window)
}
module.exports = { ALL, build, SCENARIOS, TXT };
