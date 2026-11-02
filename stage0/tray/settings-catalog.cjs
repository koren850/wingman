// The settings Dan can change in the Wingman window: plain words, real controls.
// Everything else stays in the "Advanced" list (read-only) and in ~/.config/wingman/settings.yaml.
// `invert`: the screen shows the opposite of the stored boolean. `scale`: the screen shows stored / scale (ms -> seconds).
const GROUPS = [
  { id: "call", title: "Call" },
  { id: "answers", title: "Answers" },
  { id: "after", title: "After the call" },
  { id: "money", title: "Money" },
  { id: "audio", title: "Audio and screens" },
];

const ITEMS = [
  { key: "stt.language", group: "call", label: "Language the call is heard in", kind: "select",
    help: "Mixed catches English words (WordPress, DNS, SSL) inside Hebrew sentences. Hebrew only is steadier on short Hebrew sentences and never invents text in other scripts. Pick it when nobody switches to English.",
    options: [["multi", "Hebrew and English mixed"], ["he", "Hebrew only"], ["en", "English only"]] },
  { key: "privacy.requireConsentAck", group: "call", label: "Ask me before listening starts", kind: "bool",
    help: "Off: a call starts listening straight away. On: it waits for your click before any audio is sent.",
  },
  { key: "budget.idleStopMin", group: "call", label: "Stop by itself after silence", kind: "int", min: 0, max: 240, step: 1, unit: "minutes",
    help: "If nobody speaks for this long, the call stops and the microphone is released. 0 means never." },

  { key: "assist.answerMe", group: "answers", label: "Answer my own questions", kind: "select",
    help: "When you ask Wingman something (a fact, a word, a sum), it answers you in a “For you” card. Always: Wingman works out whether you asked it or the other person. Only with the key: after you press Ctrl+Opt+A. Off: never, except after the key.",
    options: [["always", "Always"], ["hotkey", "Only when I press Ctrl+Opt+A"], ["off", "Off (the key still works)"]] },
  { key: "run.noAi", group: "answers", label: "AI-written answers", kind: "bool", invert: true,
    help: "On: the AI can write a short answer when the card bank has none. Off: ready-made bank cards only, no AI answers, live notes or summary, nothing goes to Anthropic." },
  { key: "reflex.allowAns", group: "answers", label: "AI may write new answers", kind: "bool",
    help: "On: when the other side asks, the AI can write a short answer, not only pick a bank card. Off: bank cards and “let me check” lines only, a safe choice for a first customer call. Your own questions use the setting above." },
  { key: "cards.maxPerMinute", group: "answers", label: "New cards per minute, at most", kind: "int", min: 1, max: 20, step: 1, unit: "cards",
    help: "Keeps the answer window calm. Price and guarantee cards are never held back by this limit." },
  { key: "cards.quiet", group: "answers", label: "Start every call in quiet mode", kind: "bool",
    help: "Cards are saved for the review but not shown on the answer window until you switch quiet off." },
  { key: "reflex.stallAfterMs", group: "answers", label: "Wait before “let me check”", kind: "number", scale: 1000, min: 0.8, max: 3.5, step: 0.1, unit: "seconds",
    help: "How long the AI has to find an answer before a holding line appears for you to say." },

  { key: "frame.enabled", group: "answers", label: "Work out what the call is about", kind: "bool",
    help: "Every minute or so the AI reads the last few minutes and shows the kind of call, its topic and a checklist at the top of the answer window. Answers and tips then fit the call." },
  { key: "frame.everyMs", group: "answers", label: "How often to re-check the call", kind: "number", scale: 1000, min: 10, max: 600, step: 10, unit: "seconds",
    help: "At most this often, and only after enough new words. A shorter time follows a changing conversation faster and costs slightly more." },
  { key: "tips.enabled", group: "answers", label: "Live tips", kind: "bool",
    help: "Now and then one small tip under the answer: a question to ask, something to pin down, a term explained. Never during quiet mode or right after an answer." },
  { key: "tips.minGapMs", group: "answers", label: "Time between tips, at least", kind: "number", scale: 1000, min: 10, max: 1800, step: 10, unit: "seconds",
    help: "Keeps the screen calm: never more than one tip in this time." },
  { key: "tips.talkRatio", group: "answers", label: "Tell me when I talk too much", kind: "bool",
    help: "A tip, with no AI involved, when you spoke more than three quarters of the last five minutes." },
  { key: "attachments.maxChars", group: "answers", label: "Background text the AI may read", kind: "int", min: 0, max: 40000, step: 1000, unit: "characters",
    help: "Files and pasted text from Plan a call are used as background. This is the most text used in total; 0 means ignore them." },

  { key: "summary.enabled", group: "after", label: "Write a summary when the call ends", kind: "bool",
    help: "A Hebrew summary, next steps and a draft follow-up email appear in the call's Follow-up tab. Costs about half a cent." },

  { key: "budget.maxUsdPerCall", group: "money", label: "Spend cap per call", kind: "number", min: 0, max: 50, step: 0.5, unit: "USD",
    help: "At the cap the AI stops and only bank cards are used for the rest of the call. Speech recognition cost is only warned about." },

  { key: "audio.warnBluetooth", group: "audio", label: "Warn me about AirPods and Bluetooth", kind: "bool",
    help: "Bluetooth headsets drop to phone quality and the transcript gets worse. You get a warning at the start of the call." },
  { key: "overlay.display", group: "audio", label: "Answer window goes to", kind: "select",
    help: "Second screen (recommended) keeps the answers out of anything you share. With one screen the window stays closed unless you allow the main screen.",
    options: [["secondary", "Second screen"], ["primary", "Main screen"]] },
  { key: "overlay.showLastLine", group: "audio", label: "Show what the other side just said", kind: "bool",
    help: "A thin line at the top of the answer window with the other side's last sentence, so you can see which question the card below answers." },
  { key: "overlay.contentProtection", group: "audio", label: "Show answer window in screen share", kind: "bool", invert: true,
    help: "Off (recommended): macOS hides the window from Zoom, Meet and screenshots. Not yet tested with Zoom, so also keep it on the second screen." },
];

const BY_KEY = new Map(ITEMS.map((i) => [i.key, i]));
const toDisplay = (item, stored) => (item.invert ? !stored : item.scale ? Math.round((stored / item.scale) * 1000) / 1000 : stored);

/** Screen value -> stored value; throws a plain-words Error when it is not allowed. */
function toStored(item, v) {
  if (item.kind === "bool") { if (typeof v !== "boolean") throw new Error("expected on or off"); return item.invert ? !v : v; }
  if (item.kind === "select") { if (typeof v !== "string" || !item.options.some((o) => o[0] === v)) throw new Error("not one of the choices"); return v; }
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error("expected a number");
  if (v < item.min || v > item.max) throw new Error(`must be between ${item.min} and ${item.max}`);
  if (item.kind === "int") { if (!Number.isInteger(v)) throw new Error("expected a whole number"); return v; }
  return item.scale ? Math.round(v * item.scale) : Math.round(v * 1000) / 1000;
}

/** The catalog filled with values from `settings-edit-cli read` (values/defaults flat maps, changed key list). */
function describe(state) {
  return ITEMS.map((i) => {
    const raw = state.values[i.key], def = state.defaults[i.key];
    return { ...i, toStored: undefined, value: toDisplay(i, raw), def: toDisplay(i, def), changed: state.changed.includes(i.key) };
  });
}

module.exports = { GROUPS, ITEMS, BY_KEY, toDisplay, toStored, describe };
