// The settings a user can change in the Wingman window: plain words, real controls. Each key is a dotted path into config/defaults.yaml.
// Everything else stays in the "Advanced" list (read-only) and in ~/.config/wingman/settings.yaml.
// main: true = one of the few choices shown by default; everything else sits under the Advanced fold.
// kind: bool | select (options [[value, label]]) | int | number (min/max/step/unit are enforced by toStored). help/label are shown as written.
// `invert`: the screen shows the opposite of the stored boolean. `scale`: the screen shows stored / scale (ms -> seconds).
const GROUPS = [
  { id: "call", title: "Call" },
  { id: "answers", title: "Answers" },
  { id: "after", title: "After the call" },
  { id: "money", title: "Money" },
  { id: "audio", title: "Audio and screens" },
  { id: "tune", title: "Fine-tuning" },
];

/** The editable settings, in display order within each group. */
const ITEMS = [
  {
    key: "stt.language",
    main: true,
    group: "call",
    label: "Language the call is heard in",
    kind: "select",
    help: "Mixed catches English words (WordPress, DNS, SSL) inside Hebrew sentences. Hebrew only is steadier on short Hebrew sentences and never invents text in other scripts. Pick it when nobody switches to English.",
    options: [
      ["multi", "Hebrew and English mixed"],
      ["he", "Hebrew only"],
      ["en", "English only"],
    ],
  },
  {
    key: "privacy.requireConsentAck",
    main: true,
    group: "call",
    label: "Ask me before listening starts",
    kind: "bool",
    help: "Off: a call starts listening straight away. On: it waits for your click on Start listening (or Ctrl+Opt+Return) before any audio is sent.",
  },
  {
    key: "stt.deepgram.mipOptOut",
    group: "call",
    label: "Keep my audio out of Deepgram's model training",
    kind: "bool",
    help: "On: Deepgram is asked not to use your call audio to improve its models. Deepgram does not publish a price for this, and some users report a higher rate. Off: Deepgram may use the audio.",
  },
  {
    key: "privacy.askBeforeCliStart",
    group: "call",
    label: "Ask before a call started from the command line starts listening",
    kind: "bool",
    help: "On: if a program or script runs the wingman command to start a call, a window asks you first. Practice calls never ask. Stopping and deleting a call from the command line always asks.",
  },
  {
    key: "budget.idleStopMin",
    group: "call",
    label: "Stop by itself after silence",
    kind: "int",
    min: 0,
    max: 240,
    step: 1,
    unit: "minutes",
    help: "If nobody speaks for this long, the call stops and the microphone is released. 0 means never.",
  },

  {
    key: "assist.answerMe",
    group: "answers",
    label: "AI answers to my own questions",
    kind: "select",
    help: "When you ask Wingman something (a fact, a word, a sum), it answers in a “For you” card. Always: it works out who asked. Only with the key: after Ctrl+Opt+A. Off: never, except after the key.",
    options: [
      ["always", "Always"],
      ["hotkey", "Only when I press Ctrl+Opt+A"],
      ["off", "Off (the key still works)"],
    ],
  },
  {
    key: "run.noAi",
    main: true,
    group: "answers",
    label: "Use the AI at all",
    kind: "bool",
    invert: true,
    help: "The master switch. On: the AI can write answers, tips and the summary. Off: Prepared cards only, no AI answers, live notes or summary, and nothing goes to Anthropic.",
  },
  {
    key: "reflex.allowAns",
    group: "answers",
    label: "AI answers to the other side's questions",
    kind: "bool",
    help: "On: when the other side asks, the AI can write a short answer, not only pick a Prepared card. Off: Prepared cards and “Buy time” lines only. Your own questions use the setting above.",
  },
  {
    key: "cards.focus",
    group: "call",
    label: "Important cards only",
    kind: "bool",
    help: "On: a card only for clear questions to you (a question mark, a direct request, your name), at most 2 every 2 minutes. Price and date cards and the cards about what you said always show. Off: every likely question gets a card (cards.maxPerMinute).",
  },
  {
    key: "cards.quiet",
    main: true,
    group: "answers",
    label: "Start every call in quiet mode",
    kind: "bool",
    help: "Cards are saved for the review but not shown on the answer window until you switch quiet off.",
  },
  {
    key: "moments.engine",
    advanced: true,
    group: "answers",
    label: "Help engine",
    kind: "select",
    help: "Live reading (default): the AI reads the whole call and decides when a card helps, also for objections, numbers and promises. Classic (rollback): the older question gate. Use it only if live reading misbehaves. Takes effect on the next call.",
    options: [
      ["v2", "Live reading (default)"],
      ["legacy", "Classic (rollback)"],
    ],
  },
  {
    key: "moments.earlyStart",
    advanced: true,
    group: "answers",
    label: "Start early on a stable question",
    kind: "bool",
    help: "Off by default. On: a question from the other side starts the AI when the live text stops changing, before the end mark. The card can come about half a second sooner, with a few extra AI calls. Takes effect on the next call.",
  },
  {
    key: "memory.enabled",
    group: "answers",
    label: "Keep a memory of the call",
    kind: "bool",
    help: "Wingman keeps a short memory of the call (topic, numbers, promises, open questions) that every AI call reads. It is saved with the call. Used by live reading.",
  },
  {
    key: "reflex.stall",
    group: "answers",
    label: "“Buy time” lines",
    kind: "bool",
    help: "On: when no answer is ready in time, show a line like “Let me check and get back to you”. Off (default): nothing until a real answer is ready. Price, timeline and guarantee cards show either way.",
  },

  {
    key: "tips.enabled",
    group: "answers",
    label: "Live tips",
    kind: "bool",
    help: "Now and then one small tip under the answer: a question to ask, something to pin down, a term explained. Never during quiet mode or right after an answer.",
  },
  {
    key: "tips.minGapMs",
    group: "tune",
    label: "Time between tips, at least",
    kind: "number",
    scale: 1000,
    min: 10,
    max: 1800,
    step: 10,
    unit: "seconds",
    help: "Keeps the screen calm: never more than one tip in this time.",
  },
  {
    key: "tips.talkRatio",
    group: "answers",
    label: "Tell me when I talk too much",
    kind: "bool",
    help: "A tip, with no AI involved, when you spoke more than three quarters of the last five minutes.",
  },
  {
    key: "coach.nudges",
    group: "call",
    label: "Live nudges about how I talk",
    kind: "bool",
    help: "Off by default. On: a thin line, not a card, at most one every 5 minutes, when you talk fast, talk most of the time or talk over the other side. No AI call. Never while a check card is up. Next call.",
  },
  {
    key: "coach.talkShareMax",
    group: "tune",
    label: "Nudge when I talk more than",
    kind: "int",
    min: 50,
    max: 95,
    step: 5,
    unit: "percent",
    help: "Your share of the speaking time over the last 5 minutes. Used only when live nudges are on.",
  },
  {
    key: "coach.paceMax",
    group: "tune",
    label: "Nudge when I talk faster than",
    kind: "int",
    min: 120,
    max: 260,
    step: 10,
    unit: "words a minute",
    help: "Your pace over the last minute. Used only when live nudges are on.",
  },
  {
    key: "lookup.enabled",
    group: "answers",
    label: "Look a term up on the web (Ask tab and wingman lookup)",
    kind: "bool",
    help: "Off by default. On: the Ask tab and wingman lookup may read one public web page per use (https only, no private address) and show its address and the exact sentence. Never by itself during a call.",
  },
  {
    key: "lookup.maxUsdPerCall",
    group: "money",
    label: "Most one lookup may cost",
    kind: "number",
    min: 0,
    max: 5,
    step: 0.01,
    unit: "USD",
    help: "Only when the AI shortens the sentence of a lookup. The sentence itself costs nothing and is the default answer. 0 means never use the AI for a lookup.",
  },
  {
    key: "selfCheck.careful",
    group: "call",
    label: "Warn me when I commit to a price, date or promise",
    kind: "bool",
    help: "An amber card with a hedge you can use, when you say a price, a date or a promise. No AI involved.",
  },
  {
    key: "selfCheck.fix",
    group: "call",
    label: "Correct me when I contradict the meeting background",
    kind: "bool",
    help: "A red card with the right fact when something you said clearly differs from the prepared meeting and its files. Needs a prepared meeting.",
  },
  {
    key: "attachments.maxChars",
    group: "tune",
    label: "Background text the AI may read",
    kind: "int",
    min: 0,
    max: 40000,
    step: 1000,
    unit: "characters",
    help: "Files and pasted text from your Plan are used as background. This is the most text used in total; 0 means ignore them.",
  },

  {
    key: "context.calendarUrl",
    group: "call",
    label: "My calendar address",
    kind: "text",
    maxLen: 600,
    placeholder: "https://...ics",
    help: "The private .ics address from your calendar settings. Plan a call then offers Use my next calendar event and asks before using the meeting. Keep it private. Empty means off.",
  },
  {
    key: "context.pastCalls",
    group: "call",
    label: "Remember people from earlier calls",
    kind: "bool",
    help: "A new call can start with up to 5 notes about people you met before: what was promised and the last topic. They come from your own saved calls on this Mac. No AI call.",
  },

  {
    key: "summary.enabled",
    main: true,
    group: "after",
    label: "Write a summary when the call ends",
    kind: "bool",
    help: "A summary in the language of the call, next steps and a draft follow-up email appear in the call's Follow-up tab. Costs about half a cent.",
  },

  {
    key: "budget.maxUsdPerCall",
    main: true,
    group: "money",
    label: "Spend cap per call",
    kind: "number",
    min: 0,
    max: 50,
    step: 0.5,
    unit: "USD",
    help: "At the cap the AI stops and only Prepared cards are used for the rest of the call. Speech recognition cost is only warned about.",
  },
  {
    key: "budget.maxLlmUsdPerHour",
    group: "money",
    label: "Soft AI spend cap per hour",
    kind: "number",
    min: 0,
    max: 20,
    step: 0.05,
    unit: "USD",
    help: "Typical use costs about 0.09 USD an hour. Near this amount the cheapest jobs stop first (memory clean-up, then live reading). At the cap the AI pauses. 0 = no hourly cap.",
  },
  {
    key: "budget.warnUsdPerCall",
    group: "money",
    label: "Warn when a call costs more than",
    kind: "number",
    min: 0,
    max: 100,
    step: 0.5,
    unit: "USD",
    help: "One amber warning when AI plus speech recognition passes this amount. Nothing is stopped. 0 = no warning.",
  },

  {
    key: "audio.warnBluetooth",
    group: "audio",
    label: "Warn me about AirPods and Bluetooth",
    kind: "bool",
    help: "Bluetooth headsets drop to phone quality and the transcript gets worse. You get a warning at the start of the call.",
  },
  {
    key: "overlay.display",
    main: true,
    group: "audio",
    label: "Answer window goes to",
    kind: "select",
    help: "Second screen (recommended) keeps the answers out of anything you share. With one screen the window stays closed unless you allow the main screen.",
    options: [
      ["secondary", "Second screen"],
      ["primary", "Main screen"],
    ],
  },
  {
    key: "ui.language",
    main: true,
    group: "audio",
    label: "Answer window language",
    kind: "select",
    help: "Automatic uses Hebrew, unless the call language is English only. Only the answer window labels change (status, badges, hotkey bar). The Wingman window has its own setting above (Window language). The answers themselves keep the language of the call.",
    options: [
      ["auto", "Automatic"],
      ["he", "Hebrew"],
      ["en", "English"],
    ],
  },
  {
    key: "overlay.layout",
    main: true,
    group: "audio",
    label: "Answer window layout",
    kind: "select",
    help: "Focus (recommended) shows what they said and one big answer. Notes, checklist and captured details wait behind a small More strip. Full shows everything at once.",
    options: [
      ["focus", "Focus"],
      ["full", "Full"],
    ],
  },
  {
    key: "overlay.showLastLine",
    group: "audio",
    label: "Show what the other side just said",
    kind: "bool",
    help: "A strip at the top of the answer window with the latest sentence (yours or the other side's, labelled), so you can see which question the card below answers.",
  },
  {
    key: "overlay.liveTextPt",
    group: "audio",
    label: "Size of the live text",
    kind: "int",
    min: 14,
    max: 40,
    step: 1,
    unit: "pt",
    help: "Font size of the live strip with the latest sentence. 22 reads well on a second screen.",
  },
  {
    key: "overlay.contentProtection",
    group: "audio",
    label: "Show answer window in screen share",
    kind: "bool",
    invert: true,
    help: "Off (recommended): macOS hides the window from Zoom, Meet and screenshots. Not yet tested with Zoom, so also keep it on the second screen.",
  },
];

/** key -> item, for validating a change that comes from the window. */
const BY_KEY = new Map(ITEMS.map((i) => [i.key, i]));
/** Stored value -> what the screen shows (applies `invert` / `scale`). */
const toDisplay = (item, stored) => (item.invert ? !stored : item.scale ? Math.round((stored / item.scale) * 1000) / 1000 : stored);

/** Screen value -> stored value; throws a plain-words Error when it is not allowed. */
function toStored(item, v) {
  if (item.kind === "bool") {
    if (typeof v !== "boolean") throw new Error("expected on or off");
    return item.invert ? !v : v;
  }
  if (item.kind === "text") {
    if (typeof v !== "string") throw new Error("expected text");
    const t = v.trim().replace(/^webcals?:\/\//i, "https://"); // calendar apps hand out webcal:// addresses; they are https underneath
    if (t.length > item.maxLen) throw new Error(`at most ${item.maxLen} characters`);
    if (/[\u0000-\u001f\u007f\s]/.test(t)) throw new Error("no spaces or line breaks");
    if (t && !/^https:\/\/\S+$/i.test(t)) throw new Error("must start with https://");
    return t;
  }
  if (item.kind === "select") {
    if (typeof v !== "string" || !item.options.some((o) => o[0] === v)) throw new Error("not one of the choices");
    return v;
  }
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error("expected a number");
  if (v < item.min || v > item.max) throw new Error(`must be between ${item.min} and ${item.max}`);
  if (item.kind === "int") {
    if (!Number.isInteger(v)) throw new Error("expected a whole number");
    return v;
  }
  return item.scale ? Math.round(v * item.scale) : Math.round(v * 1000) / 1000;
}

/** The catalog filled with values from `settings-edit-cli read` (values/defaults flat maps, changed key list). */
function describe(state) {
  return ITEMS.map((i) => {
    const raw = state.values[i.key],
      def = state.defaults[i.key];
    return { ...i, toStored: undefined, value: toDisplay(i, raw), def: toDisplay(i, def), changed: state.changed.includes(i.key) };
  });
}

module.exports = { GROUPS, ITEMS, BY_KEY, toDisplay, toStored, describe };
