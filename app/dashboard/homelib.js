"use strict";
// Pure helpers for Home, shared by the renderer (classic script) and the unit test (src/dashboard-home.test.ts).
// No DOM here: everything takes plain data (call state from the controller, settings rows from the catalog) and returns plain data.
(function (root) {
  // Texts come from the string catalogs through `t(key, vars)`. Without one (the unit test of the English window) the English catalog is used.
  const defaultT = (key, vars) =>
    typeof module !== "undefined" && module.exports ? require("./i18n.js").t("en", key, vars) : root.WingmanI18n.t("en", key, vars);
  const Ask = typeof module !== "undefined" && module.exports ? require("../shared/ask.js") : root.WingmanAsk;
  // Ask is the shared question-timer helper (shared/ask.js): require() under node, window.WingmanAsk in the page.
  /** The stop panel: what is happening now. `call.stopPhase` ("saving" -> "summary" -> "done") comes from run.ts through the controller; when it is empty, infer from the flags. */
  function stopSteps(call, t = defaultT) {
    const c = call || {},
      ph = c.stopPhase || "";
    let save, sum;
    if (ph === "saving") {
      save = "now";
      sum = "todo";
    } else if (ph === "summary") {
      save = "done";
      sum = "now";
    } else if (ph === "done") {
      save = "done";
      sum = "done";
    } else {
      save = c.endedCleanly ? "done" : "now";
      sum = c.summaryOk || c.endedCleanly ? "done" : "now";
    }
    if (c.summarySkipped) sum = "done";
    return [
      { key: "listening", label: t("stop.listening"), state: "done" },
      { key: "saving", label: t("stop.saving"), state: save },
      { key: "summary", label: c.summarySkipped ? t("stop.summarySkipped") : t("stop.summary"), state: sum },
    ];
  }

  /** "AI on · ..." line for the Start card, from the settings rows (catalog.describe: { key, value }). Nothing is guessed: missing rows are left out. */
  function aiMode(items, t = defaultT) {
    const v = {};
    for (const i of items || []) if (i && typeof i.key === "string") v[i.key] = i.value;
    if (!("run.noAi" in v)) return null;
    if (v["run.noAi"] === false) return { on: false, text: t("ai.off") }; // run.noAi is shown inverted: false = "Use the AI at all" is off
    const me = { always: t("ai.me.always"), hotkey: t("ai.me.hotkey"), off: t("ai.me.off") }[v["assist.answerMe"]];
    const them = v["reflex.allowAns"] === false ? t("ai.them.cardsOnly") : null;
    const parts = [t("ai.on"), me, them, v["cards.quiet"] === true ? t("ai.quiet") : null].filter(Boolean);
    return { on: true, text: parts.join(" · ") };
  }

  /** Calls recent enough to ask for a rating or a follow-up. Older ones stay in Calls and do not nag on Home. */
  const WAIT_DAYS = 14;
  /**
   * The rows of "Waiting for you": one row per call (never the same call twice), crashed calls left out, only calls from the last 14 days,
   * newest first, at most `max`. `more` is how many matching calls did not fit. pendingOf(c) = cards not rated yet.
   */
  function waitingCalls(calls, now, pendingOf, max = 3) {
    const seen = new Set();
    const rows = [];
    for (const c of calls || []) {
      if (!c || c.crashed || seen.has(c.id)) continue;
      seen.add(c.id);
      if (!(pendingOf(c) > 0 || c.hasSummary)) continue;
      if (!Number.isFinite(c.startedAt) || now - c.startedAt > WAIT_DAYS * 86400000) continue; // no usable date: not recent, so no nag
      rows.push(c);
    }
    rows.sort((a, b) => b.startedAt - a.startedAt);
    return { rows: rows.slice(0, max), more: Math.max(0, rows.length - max), total: rows.length };
  }

  /** The last readiness result when it says NOT READY (BUSY and "not checked" never block). */
  const blockedBy = (d) => (d && !d.ok && d.verdict === "NOT READY" ? d : null);

  /** Prepared meetings (shared/plans.js): require() under node, window.WingmanPlans in the page. */
  const Plans = typeof module !== "undefined" && module.exports ? require("../shared/plans.js") : root.WingmanPlans;

  /**
   * What the Start card shows for the prepared meetings (list from the main process, already ready ones only, soonest first):
   * { next, rows } where next is the "Next: <who> at 14:30" meeting (timed, not long past) or null, and each row has the texts of one line.
   */
  function startPaths(list, now, t = defaultT, lang = "en") {
    const ready = Plans.ready(list || [], now);
    const next = Plans.nextMeeting(ready, now);
    const rows = ready.map((m) => ({
      id: m.id,
      kind: typeof m.kind === "string" ? m.kind : "",
      name: Plans.label(m),
      sub: m.title ? m.who || m.goal || "" : m.who ? m.goal || "" : "",
      time: m.at ? formatWhen(m.at, now, t, lang) : "",
      timeShort: m.at
        ? formatWhen(m.at, now, t, lang) === t("when.today", { time: Plans.clock(m.at) })
          ? Plans.clock(m.at)
          : formatWhen(m.at, now, t, lang)
        : "",
      isNext: !!next && next.id === m.id,
      must: m.mustCount != null ? m.mustCount : (m.mustCover || []).length,
      files: m.files || 0,
      uses: m.uses || 0,
      pending: !!m.pending,
      startLabel: t("home.startNamed", { name: Plans.label(m).slice(0, 50) }),
    }));
    return { next: next ? rows.find((r) => r.id === next.id) : null, rows };
  }
  /** "Today 14:30", "Tomorrow 09:00", "Yesterday 16:00", else a short date and the time, in the window language. */
  function formatWhen(ms, now, t = defaultT, lang = "en") {
    if (!ms) return "";
    const d = new Date(ms),
      n = new Date(now);
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(d) - day(n)) / 86400000);
    const clock = Plans.clock(ms);
    if (diff === 0) return t("when.today", { time: clock });
    if (diff === 1) return t("when.tomorrow", { time: clock });
    if (diff === -1) return t("when.yesterday", { time: clock });
    let date;
    try {
      date = new Intl.DateTimeFormat(lang === "he" ? "he-IL" : "en-GB", { weekday: "short", day: "numeric", month: "short" }).format(d);
    } catch {
      date = Plans.formatAt(ms, now).replace(/ \d{2}:\d{2}$/, "");
    }
    return `${date} ${clock}`;
  }
  /** "Next: Dana at 14:30" */
  const nextText = (row, t = defaultT) =>
    row.time ? t("home.nextAt", { name: row.name, time: row.timeShort || row.time }) : t("home.next", { name: row.name });
  /** Practice uses the next prepared meeting (or the only one), as the app does; none = a plain practice. */
  const practiceTarget = (list, now) => Plans.practiceDefault(list || [], now);
  const practiceLabel = (m, t = defaultT) => (m ? t("home.practiceWith", { name: Plans.label(m).slice(0, 40) }) : t("home.practice"));

  /** The combined Note / Ask input: its label, button, placeholder and the line announced after sending. */
  const composer = (mode, t = defaultT) => {
    const k = mode === "ask" ? "ask" : "note";
    return { label: t(`compose.${k}.label`), button: t(`compose.${k}.button`), placeholder: t(`compose.${k}.placeholder`), sent: t(`compose.${k}.sent`) };
  };
  /** Status line while Ctrl+Opt+A (or the Listen button) is armed: the next thing said is a question. */
  const askStatus = (call, now, t = defaultT) => {
    if (!call || !call.askArmed) return "";
    const left = Ask.askClock(call.askUntil, now == null ? Date.now() : now);
    return t("ask.armed") + (left ? " " + t("ask.left", { time: left }) : "");
  };
  /** The "Skip summary" control shows while the summary is the step in progress (not before, not after, not twice). */
  const canSkipSummary = (call) => !!call && call.phase === "stopping" && call.stopPhase === "summary" && !call.summarySkipped && !call.summaryOk;

  /** Setting and variable names are for developers. Say what they are in plain words: "ANTHROPIC_API_KEY" is "the Anthropic key". Nothing user-facing may show an upper-case name with underscores. */
  const ENV_NAMES = {
    DEEPGRAM_API_KEY: "the Deepgram key",
    ANTHROPIC_API_KEY: "the Anthropic key",
    OPENAI_API_KEY: "the OpenAI key",
    GOOGLE_GENERATIVE_AI_API_KEY: "the Google key",
    MISTRAL_API_KEY: "the Mistral key",
    GROQ_API_KEY: "the Groq key",
    SONIOX_API_KEY: "the Soniox key",
    GLADIA_API_KEY: "the Gladia key",
  };
  const ENV_LIKE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
  function plainText(t) {
    const out = String(t || "")
      .replace(ENV_LIKE, (m) => ENV_NAMES[m] || (/_API_KEY$|_KEY$|_TOKEN$/.test(m) ? "a key" : "a setting"))
      .replace(/\bthe the\b/gi, "the");
    return /^\s*[A-Z][A-Z0-9]*_[A-Z0-9_]+/.test(String(t || "")) ? out.replace(/^\s*[a-z]/, (c) => c.toUpperCase()) : out;
  }
  /** Doctor lines are written for the command line. Say where things are now: keys in the Keychain (Settings, Keys), permissions for Wingman. */
  function niceFix(t) {
    return plainText(
      String(t || "")
        .replace(/add it to ~?\/?[\w./-]*keys\.env/gi, "add it in Settings, Keys")
        .replace(/~?\/?[\w./-]*keys\.env/gi, "Settings, Keys")
        .replace(/\b(your )?terminal( app)?\b/gi, "Wingman")
        .replace(/\bdoctor\b/gi, "readiness check"),
    );
  }
  /**
   * Hebrew wording for the readiness lines the first run shows (keys, microphone, system audio, ffmpeg, screens). The check itself writes English
   * (src/doctor.ts is not changed for this), so the window matches the line by its shape and says it in Hebrew. A line with no match stays as the
   * check wrote it (a known gap: the rare lines, such as a battery or disk warning).
   */
  const PROVIDER_HE = {
    DEEPGRAM_API_KEY: "Deepgram",
    ANTHROPIC_API_KEY: "Anthropic",
    OPENAI_API_KEY: "OpenAI",
    GOOGLE_GENERATIVE_AI_API_KEY: "Google",
    MISTRAL_API_KEY: "Mistral",
    GROQ_API_KEY: "Groq",
    SONIOX_API_KEY: "Soniox",
    GLADIA_API_KEY: "Gladia",
  };
  const HE_LINES = [
    [
      /^(\w+_API_KEY) missing \((.*?)\); that fallback cannot work/,
      (m) => `חסר מפתח ${PROVIDER_HE[m[1]] || "של ספק"} (${/STT|speech/i.test(m[2]) ? "תמלול" : "תשובות"}, גיבוי). הגיבוי לא יעבוד`,
    ],
    [/^(\w+_API_KEY) missing \((.*?)\)/, (m) => `חסר מפתח ${PROVIDER_HE[m[1]] || "של ספק"} (${/STT|speech/i.test(m[2]) ? "תמלול הדיבור" : "תשובות ה-AI"})`],
    [/^Wingman → Settings → Keys: paste the key/, () => "Wingman ← הגדרות ← מפתחות: הדבק את המפתח (הוא נשמר באחסון המפתחות המאובטח של המחשב)"],
    [/^no sound from the microphone/, () => "אין קול מהמיקרופון: נראה שהוא חסום"],
    [
      /^System Settings → Privacy & Security → Microphone/,
      () => "הגדרות המערכת ← פרטיות ואבטחה ← מיקרופון: אפשר ל-Wingman, ואז הפעל את Wingman מחדש (או בחר התקן אחר בהגדרות)",
    ],
    [/^mic is quiet/, () => "המיקרופון שקט: הוא עובד, אבל הקול היה חלש"],
    [/^speak normally during the check/, () => "דבר כרגיל במהלך הבדיקה, או התקרב למיקרופון"],
    [/^mic: /, () => "שגיאת מיקרופון: לא ניתן לפתוח את ההתקן"],
    [/^audio\.system\.source is off/, () => "שמע המערכת כבוי: אי אפשר לשמוע את הצד השני (רק התמלול שלך)"],
    [/^ffmpeg not found/, () => "ffmpeg לא נמצא"],
    [/^install ffmpeg/, () => "התקן את ffmpeg (brew install ffmpeg) והרץ שוב את הבדיקה"],
    [/^macOS ([\d.]+): system audio tap needs/, (m) => `macOS ${m[1]}: הקלטת שמע המערכת דורשת גרסה 14.2 ומעלה`],
    [/^only one (display|screen)/, () => "יש מסך אחד בלבד: חלון התשובות לא ייפתח (כדי שלא יופיע במסך משותף)"],
    [/^connect a second screen/, () => "חבר מסך שני לפני השיחה"],
    [/^settings invalid/, () => "ההגדרות לא תקינות"],
    [/^fix the setting above/, () => "תקן את ההגדרה שמוצגת ואז הרץ שוב את בדיקת המוכנות"],
    [/^Bluetooth mic drops/, () => "מיקרופון Bluetooth יורד לאיכות שמע נמוכה"],
    [/^use the Mac microphone/, () => "השתמש במיקרופון של ה-Mac או באוזניות עם חוט"],
    [/^leftover ffmpeg/, () => "נשאר תהליך ffmpeg או audiotee ישן"],
    [/^quit Wingman from the menu bar/, () => "צא מ-Wingman מסרגל התפריטים ופתח אותו שוב"],
  ];
  /** A readiness line (text or fix) in the window language: Hebrew for the lines above, otherwise the plain English of niceFix. */
  function issueText(t, lang) {
    const raw = String(t || "");
    if (lang === "he") {
      for (const [re, say] of HE_LINES) {
        const m = re.exec(raw);
        if (m) return say(m);
      }
    }
    return niceFix(raw);
  }
  /**
   * Can the person press Start now? { ready, disabled, why, code, raw }. `missing` = names of providers with no key. `doctor` = the last readiness result.
   * A key problem or a failed readiness check disables Start and gives the reason (plain words, from the first failing line) and a code for the Fix it button.
   * "Not checked yet" and "busy" never block. why is a catalog key when it needs no data; otherwise raw holds the plain text of the first problem.
   */
  function startState(doctor, missing, lang) {
    const miss = Array.isArray(missing) ? missing : [];
    if (miss.length)
      return { ready: false, disabled: true, why: "start.why.keys", code: "key-" + (/anthropic/i.test(miss[0]) ? "anthropic" : "deepgram"), raw: "" };
    const d = blockedBy(doctor);
    if (!d) return { ready: true, disabled: false, why: "", code: "", raw: "" };
    const first = (d.failing && d.failing[0]) || {};
    return {
      ready: false,
      disabled: true,
      why: "start.why.check",
      code: "",
      raw: issueText(first.text || "", lang),
      rawSource: String(first.text || "") + " " + String(first.fix || ""),
    };
  }
  /** A key name for the screen: symbols on macOS (control, option, return), words elsewhere. */
  const MAC_SYMS = { Ctrl: "⌃", Opt: "⌥", Cmd: "⌘", Shift: "⇧", Return: "↩", Esc: "⎋" };
  const keySym = (k, mac) => (mac && MAC_SYMS[k]) || k;
  /** The word for a key (the tooltip next to a symbol). */
  const KEY_NAMES = { Ctrl: "Control", Opt: "Option", Cmd: "Command", Return: "Return", Esc: "Escape" };
  const keyName = (k) => KEY_NAMES[k] || k;
  const keyRelated = (x) => /api_key|\bkeys?\b|deepgram|anthropic/i.test(String(x && x.text) + " " + String((x && x.fix) || ""));

  /** Keep keyboard focus across a re-render: remember the focused element by id (or data-fk) and its caret, give it back to the new element. */
  function focusKey(el) {
    return el ? el.id || (el.getAttribute && el.getAttribute("data-fk")) || "" : "";
  }

  const api = {
    waitingCalls,
    WAIT_DAYS,
    stopSteps,
    aiMode,
    blockedBy,
    startPaths,
    nextText,
    formatWhen,
    practiceTarget,
    practiceLabel,
    composer,
    askStatus,
    canSkipSummary,
    niceFix,
    issueText,
    plainText,
    startState,
    keySym,
    keyName,
    keyRelated,
    focusKey,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WingmanHome = api;
})(typeof window !== "undefined" ? window : globalThis);
