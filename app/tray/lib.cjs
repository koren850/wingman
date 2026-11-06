// Pure helpers for the menu-bar app (unit-tested in src/tray.test.ts): call-state reducer, notifications, menu text,
// Plan (brief) file I/O, doctor output parsing, global-key and confirm-dialog logic. No Electron import: Electron objects are injected.
// Used by controller.cjs, control-socket.cjs, main.cjs and the dashboard.
const fs = require("node:fs");
const path = require("node:path");

const { askClock } = require("../shared/ask.js");
const Plans = require("../shared/plans.js");
const PREFIX = "@@wingman ";
const STOP_PHASES = ["saving", "summary", "done"];

/** Fresh call state. Every field the reducer, menu and CLI `status` read must exist here. */
function initialState() {
  return {
    offReason: "",
    phase: "idle",
    startedAt: 0,
    liveAt: 0,
    quiet: false,
    proposed: "",
    client: "",
    notes: 0,
    health: {},
    briefReady: false,
    plansKey: "",
    planId: "",
    doctorRunning: false,
    endedCleanly: false,
    lastError: "",
    callId: "",
    deleted: false,
    summaryOk: false,
    practice: false,
    stopPhase: "",
    askArmed: false,
    askUntil: 0,
    summarySkipped: false,
    noAi: false,
    overlayDown: "",
    doctor: null,
  };
}

/** A status line from the engine (stdout line "@@wingman {json}", see PREFIX), or undefined. The prefix may follow log noise on the same line. */
function parseStatus(line) {
  const i = line.indexOf(PREFIX);
  if (i < 0) return undefined;
  try {
    const m = JSON.parse(line.slice(i + PREFIX.length));
    return m && typeof m.ev === "string" ? m : undefined;
  } catch {
    return undefined;
  }
}

/** Pure state reducer: (state, event m from run.ts or the controller) -> new state. Unknown events leave the state unchanged. */
function reduce(s, m) {
  const n = { ...s, health: { ...s.health } };
  switch (m.ev) {
    case "boot":
      n.briefReady = !!m.briefReady;
      n.plansKey = typeof m.plansKey === "string" ? m.plansKey : s.plansKey;
      break; // briefReady = at least one prepared meeting is waiting; plansKey changes when the list does
    case "starting":
      Object.assign(n, initialState(), {
        phase: "starting",
        startedAt: Date.now(),
        briefReady: s.briefReady,
        plansKey: s.plansKey,
        planId: typeof m.planId === "string" ? m.planId : "",
        doctor: s.doctor,
        practice: !!m.practice,
        noAi: !!m.noAi,
      });
      break;
    case "waiting":
      n.phase = "waiting";
      n.callId = m.id || "";
      break;
    case "consented":
      n.phase = "live";
      n.liveAt = Date.now();
      if (m.id) n.callId = String(m.id);
      break; // the controller marks the call's prepared meeting used (a practice call never does); file/practice calls never pass "waiting": the id comes here
    case "propose":
      n.proposed = String(m.title || "");
      break;
    case "client":
      n.client = String(m.title || "");
      break;
    case "quiet":
      n.quiet = !!m.on;
      break;
    case "note":
      n.notes = m.count | 0;
      break;
    case "health":
      if (m.level === "red" || m.level === "amber") n.health[m.id] = { level: m.level, text: String(m.text || "") };
      break;
    case "health.clear":
      delete n.health[m.id];
      break;
    case "stopping":
      n.phase = "stopping";
      n.askArmed = false;
      n.askUntil = 0;
      break;
    case "stopphase":
      if (STOP_PHASES.includes(m.phase)) n.stopPhase = m.phase;
      break; // saving -> summary -> done (from run.ts)
    case "ask":
      n.askArmed = !!m.on;
      n.askUntil = m.on ? Number(m.until) || 0 : 0;
      break; // Ctrl+Opt+A armed / question taken / timed out
    case "mode":
      n.noAi = !!m.noAi;
      break; // effective AI mode of this call
    case "ended":
      n.endedCleanly = !m.crashed;
      n.phase = "stopping";
      if (m.id) n.callId = String(m.id);
      if (m.deleted) n.deleted = true;
      break;
    case "stopdelete":
      n.deleted = true;
      break;
    case "summary":
      n.summaryOk = !!m.ok;
      if (m.skipped) n.summarySkipped = true;
      break;
    case "summaryskip":
      n.summarySkipped = true;
      break; // Skip summary pressed (optimistic; run.ts confirms with summary skipped)
    case "overlay":
      n.overlayDown = m.restarting ? "" : m.reason || "closed";
      break;
    case "off":
      n.offReason = (m.reasons || []).join(", ") || "health";
      break;
    case "stderr": {
      const t = String(m.text || "")
        .split("\n")
        .map((x) => x.trim())
        .filter((x) => x && !/^\d{4}-\d\d-\d\d [\d:.]+ Electron\[\d+:\d+\]/.test(x))
        .pop();
      if (t) n.lastError = t;
      break;
    } // macOS Electron chatter (ApplePersistenceIgnoreState...) is not an error
    case "exit":
      n.phase = "idle";
      n.stopPhase = "";
      n.askArmed = false;
      n.askUntil = 0;
      n.health = {};
      n.overlayDown = "";
      n.proposed = "";
      n.client = "";
      n.quiet = false;
      break;
    case "brief":
      n.briefReady = true;
      break;
    case "doctor.start":
      n.doctorRunning = true;
      break;
    case "doctor.end":
      n.doctorRunning = false;
      if (m.result) n.doctor = m.result;
      break;
  }
  return n;
}

/** Notifications to show for the state change before -> after caused by event m. Returns [{title, body}]. */
function notifications(before, after, m) {
  const out = [];
  if (m.ev === "waiting")
    out.push({
      title: "Wingman is ready",
      body: "Waiting for you to start listening. Press Ctrl+Opt+Return or choose Start listening in the menu bar. Nothing is sent before that.",
    });
  if (m.ev === "propose" && !before.proposed)
    out.push({ title: "Client spotted", body: `Looks like ${after.proposed}. Confirm it in the Wingman window or the menu bar.` });
  if (m.ev === "overlay" && !m.restarting)
    out.push({
      title: "Answer window is not showing",
      body:
        m.reason === "one-screen"
          ? "Only one screen, so the answer window stays closed and never shows in a screen share. Still listening; cards are saved. Connect a second screen before the next call."
          : "It closed. Still listening; cards are saved. Open the Wingman window to see them.",
    });
  if (m.ev === "summary" && m.skipped) {
    /* the user skipped it: no notification */
  } else if (m.ev === "summary")
    out.push(
      m.ok
        ? { title: "Call summary ready", body: "Summary, next steps and a draft follow-up email: click here to open the Follow-up tab." }
        : { title: "No call summary", body: "It could not be written. Open the call in Wingman and try again, or run: pnpm summary latest" },
    );
  if (m.ev === "off")
    out.push({
      title: "Wingman turned itself off",
      body: `Not listening any more (${(m.reasons || []).join(", ") || "health"}). Check the Wingman window, then start a new call.`,
    });
  if (m.ev === "health" && m.level === "red" && !before.health[m.id]) out.push({ title: "Wingman problem", body: String(m.text || "") });
  return out;
}

/** Milliseconds -> "m:ss". */
const mmss = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** What the menu bar shows. */
function view(s, now) {
  const red = Object.values(s.health).some((h) => h.level === "red");
  const amber = Object.values(s.health).some((h) => h.level === "amber");
  const mark = red ? "🔴" : amber ? "🟠" : "";
  let title = "",
    status = "Wingman · no call";
  if (s.phase === "starting") {
    title = " …";
    status = "Starting…";
  }
  if (s.phase === "waiting") {
    title = " start?";
    status = "Waiting for you to start listening: nothing is sent yet";
  }
  const askT = s.askArmed ? askClock(s.askUntil, now) : null;
  if (s.phase === "live") {
    title = ` ${mark}${s.practice ? "◌ practice " : "● "}${mmss(now - s.liveAt)}${s.quiet ? " quiet" : ""}${s.askArmed ? " ask" + (askT ? " " + askT.replace(" s", "s") : "") : ""}`;
    status = `${s.askArmed ? "Listening for your question" + (askT ? ` · ${askT} left` : "") + " · " : ""}${s.practice ? "Practice call (pretend caller) · " : ""}Listening${s.client ? ` · ${s.client}` : ""}${s.notes ? ` · ${s.notes} notes` : ""}`;
  }
  if (s.phase === "stopping") {
    title = " saving…";
    status = s.summarySkipped ? "Saving the call (summary skipped)…" : "Saving the call and writing the summary…";
  }
  const healthLines = [
    ...(s.overlayDown ? [s.overlayDown === "one-screen" ? "🟠 No answer window (only one screen): cards are saved" : "🟠 Answer window closed"] : []),
    ...Object.values(s.health).map((h) => `${h.level === "red" ? "🔴" : "🟠"} ${h.text}`.slice(0, 90)),
  ];
  return { title, statusLine: status, healthLines, tooltip: status };
}

/** Plain one-line text: no control characters, trimmed, capped. */
function cleanText(t, max) {
  if (typeof t !== "string") return "";
  return t
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
/** Splits Plan form text on ";" or newlines into up to 12 clean items of at most 200 chars. */
const list = (t) =>
  (typeof t === "string" ? t : "")
    .split(/[;\n]/)
    .map((x) => cleanText(x, 200))
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 12);

/** Plan form -> plan object (same shape as `pnpm brief`). */
function briefFrom(d) {
  if (!d || typeof d !== "object") return undefined;
  const b = {
    who: cleanText(d.who, 120) || undefined,
    goal: cleanText(d.goal, 200) || undefined,
    notes: list(d.notes),
    mustCover: list(d.mustCover),
    createdAt: new Date().toISOString(),
  };
  return b.who || b.goal || b.notes.length || b.mustCover.length ? b : undefined;
}
/** Writes the Plan as dir/latest.yaml (mode 600). Values are JSON strings, which are valid YAML scalars, so no YAML escaping is needed. */
function writeBrief(dir, b) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const y = (v) => JSON.stringify(v); // JSON strings are valid YAML scalars
  const lines = [];
  if (b.who) lines.push(`who: ${y(b.who)}`);
  if (b.goal) lines.push(`goal: ${y(b.goal)}`);
  lines.push(`notes: ${y(b.notes)}`, `mustCover: ${y(b.mustCover)}`, `createdAt: ${y(b.createdAt)}`);
  fs.writeFileSync(path.join(dir, "latest.yaml"), lines.join("\n") + "\n", { mode: 0o600 });
}
/** True if the Plan file exists and is newer than maxAgeMs (default 6 h, same expiry as attachments). */
function briefReady(file, maxAgeMs = 6 * 3600_000) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs < maxAgeMs;
  } catch {
    return false;
  }
}

/** The saved Plan if it is still fresh (6 h from the file time): {who, goal, notes[], mustCover[], expiresInMs}. */
function readBrief(file, now = Date.now(), maxAgeMs = 6 * 3600_000) {
  try {
    const age = now - fs.statSync(file).mtimeMs;
    if (age >= maxAgeMs) return null;
    const o = require("yaml").parse(fs.readFileSync(file, "utf8")) || {};
    const strs = (a) =>
      (Array.isArray(a) ? a : [])
        .filter((x) => typeof x === "string")
        .map((x) => cleanText(x, 200))
        .filter(Boolean)
        .slice(0, 12);
    return {
      who: cleanText(o.who, 120),
      goal: cleanText(o.goal, 200),
      notes: strs(o.notes),
      mustCover: strs(o.mustCover),
      expiresInMs: Math.max(0, maxAgeMs - age),
    };
  } catch {
    return null;
  }
}
/** Deletes dir/latest.yaml if present. */
function clearBrief(dir) {
  try {
    fs.rmSync(path.join(dir, "latest.yaml"), { force: true });
  } catch {
    /* nothing to clear */
  }
}

/** Simple pass/fail from doctor output text. */
function doctorVerdict(out) {
  const ok = /\bREADY\b/.test(out) && !/NOT READY/.test(out);
  return { ok };
}
/** doctor output -> what the user sees: verdict plus failing checks and warnings with their fix line. */
function doctorSummary(out) {
  const text = String(out).replace(/\u001b\[[0-9;]*m/g, "");
  const failing = [],
    warnings = [],
    lines = text.split("\n");
  let verdict = "";
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i],
      m = /^\s+(❌|⚠️|⚠)\s+(.*)$/.exec(l);
    if (m) {
      const f = /^\s+fix:\s*(.*)$/.exec(lines[i + 1] || "");
      const item = { text: cleanText(m[2], 220), fix: f ? cleanText(f[1], 200) : "" };
      (m[1] === "❌" ? failing : warnings).push(item);
    }
    const v = /^(NOT READY|READY WITH WARNINGS|READY)\b/.exec(l.trim());
    if (v) verdict = v[1];
  }
  const ran = !!verdict;
  return {
    ran,
    ok: ran && verdict !== "NOT READY",
    verdict: verdict || "NO RESULT",
    failing: failing.slice(0, 8),
    warnings: warnings.slice(0, 8),
    at: Date.now(),
  };
}
/** Last n characters of s (with a leading ellipsis if cut), colour codes removed. */
const tail = (s, n) => (s.length > n ? "…" + s.slice(-n) : s).replace(/\u001b\[[0-9;]*m/g, "");

/** Menu items depend only on these fields: rebuild the menu when they change, not every second. */
function menuKey(s, running, now = 0) {
  return JSON.stringify([
    running,
    askClock(s.askUntil, now),
    s.overlayDown,
    s.phase,
    s.proposed,
    s.client,
    s.quiet,
    s.askArmed,
    s.briefReady,
    s.plansKey,
    s.doctorRunning,
    Object.keys(s.health).sort(),
    Object.values(s.health).map((h) => h.text),
  ]);
}

/** The "Start prepared meeting" submenu: [{ planId, label }], soonest first. Only meetings that can start a call; [] when none. `list` comes from tray/plans.cjs. */
function planMenu(list, now) {
  return Plans.ready(list, now).map((m) => ({ planId: m.id, label: Plans.menuLabel(m, now) }));
}

/** 16 kHz stereo 16-bit silence: the clock for a practice call in file mode. */
function writeSilentWav(file, seconds) {
  const data = 16000 * 2 * 2 * seconds;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(16000 * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data, 40);
  fs.writeFileSync(file, Buffer.concat([h, Buffer.alloc(data)]), { mode: 0o600 });
}

// ---- Global keys and confirmations (pure: Electron objects are injected so these are unit-tested) ----

/** Keys the menu-bar app owns. The answer window owns Ctrl+Opt+C/P/R/K/L and Ctrl+Opt+1-3 (copy capture chip 1-3): never register those here. */
const KEYS = { consent: "Control+Alt+Return", note: "Control+Alt+N", ask: "Control+Alt+A" };
const OVERLAY_KEYS = ["Control+Alt+C", "Control+Alt+P", "Control+Alt+R", "Control+Alt+K", "Control+Alt+L", "Control+Alt+1", "Control+Alt+2", "Control+Alt+3"];

/** The Start listening key exists only while a call is waiting. sync(true/false) registers or unregisters it; it never throws. */
function createStartKey(o) {
  let on = false;
  return {
    isOn: () => on,
    sync(waiting) {
      if (!!waiting === on) return on;
      if (waiting) {
        let ok = false;
        try {
          ok = !!o.globalShortcut.register(o.key, o.onPress);
        } catch {
          ok = false;
        }
        if (!ok) {
          o.log && o.log(`could not register ${o.key}`);
          return on;
        }
        on = true;
      } else {
        try {
          o.globalShortcut.unregister(o.key);
        } catch {
          /* already gone */
        }
        on = false;
      }
      return on;
    },
  };
}

/** Native confirmation before a call is erased. Cancel is the default and the Escape action. Returns true when the call was stopped and deleted. */
function confirmStopDelete(o) {
  const args = [
    {
      type: "warning",
      buttons: ["Cancel", "Stop and delete"],
      defaultId: 0,
      cancelId: 0,
      message: "Stop this call and delete it?",
      detail: "The recording, transcript, cards and summary of this call are erased for good. This cannot be undone.",
    },
  ];
  if (o.win) args.unshift(o.win); // the dashboard passes its window so the dialog sits on it
  const r = o.dialog.showMessageBoxSync(...args);
  if (r !== 1) return false;
  o.stopDelete();
  return true;
}

/** How long a command-line request waits for the user's click before it counts as "no". The CLI waits a little longer (src/cli/control.ts). */
const CLI_CONFIRM_MS = 45_000;

/** Native question for a call started from the command line. Resolves true only on a click on "Start". Cancel is the default; no answer in 45 s is "no". */
function confirmCliStart(o) {
  return askNative(o, {
    type: "question",
    buttons: ["Cancel", "Start the call"],
    defaultId: 0,
    cancelId: 0,
    message: "A program on this Mac wants to start a Wingman call.",
    detail:
      "It used the wingman command. Starting means Wingman listens to the microphone and sends the audio for transcription. Only start if you asked for this.",
  });
}
/** Native question for stop-and-delete from the command line. Resolves true only on a click on "Stop and delete". */
function confirmCliStopDelete(o) {
  return askNative(o, {
    type: "warning",
    buttons: ["Cancel", "Stop and delete"],
    defaultId: 0,
    cancelId: 0,
    message: "A program on this Mac wants to stop this call and delete it.",
    detail: "It used the wingman command. The recording, transcript, cards and summary are erased for good. Only continue if you asked for this.",
  });
}
function askNative(o, box) {
  const st = o.setTimeout || setTimeout,
    ct = o.clearTimeout || clearTimeout;
  return new Promise((resolve) => {
    let over = false;
    // On timeout the dialog is closed through an AbortSignal (Electron: the box then behaves as cancelled), so a late click on "Start the call"
    // cannot look like it did something, and the next request does not stack a second dialog. (Electron ignores the signal for a macOS box without
    // a parent window; the answer is still "no" there.)
    // Known limitation, left as is on purpose: the only way to make it close is a parent window, and a hidden parent never shows a macOS sheet
    // (the user could not answer at all), while a visible one would pop up a blank window. A late click is ignored (over is true), so the
    // worst case is a leftover dialog that does nothing when clicked.
    const ac = new AbortController();
    const t = st(() => {
      over = true;
      resolve(false);
      try {
        ac.abort();
      } catch {
        /* ignore */
      }
      if (o.dismiss)
        try {
          o.dismiss();
        } catch {
          /* ignore */
        }
    }, o.timeoutMs || CLI_CONFIRM_MS);
    Promise.resolve(o.dialog.showMessageBox({ ...box, signal: ac.signal })).then(
      (r) => {
        ct(t);
        if (!over) resolve(!!r && r.response === 1);
      },
      () => {
        ct(t);
        resolve(false);
      },
    );
  });
}

/** () => Promise of the settings state JSON (src/settings-edit-cli.ts read), or null. The child gets a bare environment: it never needs a key. */
function settingsReader(o) {
  const env = { HOME: process.env.HOME || "", PATH: process.env.PATH || "/usr/bin:/bin", TMPDIR: process.env.TMPDIR || "", NO_COLOR: "1", FORCE_COLOR: "0" };
  // Windows needs a few system variables to start any process (and %APPDATA% to find the data folder); none of them is a secret.
  if ((o.platform || process.platform) === "win32")
    for (const k of ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "SystemDrive", "TEMP", "TMP", "ComSpec", "PATHEXT", "WINGMAN_DATA_DIR"])
      if (process.env[k]) env[k] = process.env[k];
  // o.tsx (tests) replaces the tool path; otherwise shared/bin.cjs picks .bin/tsx or, on Windows, node + the tsx CLI.
  const t = o.tsx ? { cmd: o.tsx, args: [] } : require("../shared/bin.cjs").binCommand("tsx", [], o.root);
  return () =>
    new Promise((resolve) =>
      o.execFile(t.cmd, [...t.args, "src/settings-edit-cli.ts", "read"], { cwd: o.root, timeout: 20_000, maxBuffer: 2_000_000, env }, (e, out) => {
        try {
          resolve(
            JSON.parse(
              String(out || "")
                .trim()
                .split("\n")
                .filter(Boolean)
                .pop(),
            ),
          );
        } catch {
          resolve(null);
        }
      }),
    );
}

/**
 * Reads the setting "Ask before a call started from the command line starts listening" (default on). Anything unreadable counts as ON.
 * o.run(): Promise of the settings state JSON ({values}) from src/settings-edit-cli.ts read.
 */
async function askBeforeCliStart(o) {
  try {
    const r = await o.run();
    return !(r && r.ok && r.values && r.values["privacy.askBeforeCliStart"] === false);
  } catch {
    return true;
  }
}

/** Poll until pred() is true or ms passed. Resolves true when pred became true. */
function waitUntil(pred, ms, o = {}) {
  const st = o.setTimeout || setTimeout,
    now = o.now || Date.now,
    every = o.every || 250,
    end = now() + ms;
  return new Promise((resolve) => {
    const tick = () => {
      if (pred()) return resolve(true);
      if (now() >= end) return resolve(false);
      st(tick, every);
    };
    tick();
  });
}

/** Quit Wingman. With a call running it asks first (Keep is the default), then stops the call so it is saved and summarized, and quits when it is done. */
async function requestQuit(o) {
  if (!o.isRunning()) {
    o.quit();
    return "quit";
  }
  const r = o.dialog.showMessageBoxSync({
    type: "warning",
    buttons: ["Keep the call running", "Stop the call and quit"],
    defaultId: 0,
    cancelId: 0,
    message: "A call is running.",
    detail: "Quitting stops the call first: it is saved and the summary is written (up to 20 seconds), then Wingman closes.",
  });
  if (r !== 1) return "kept";
  o.stop();
  await o.whenStopped();
  o.quit();
  return "quit";
}

module.exports = {
  confirmCliStart,
  confirmCliStopDelete,
  askBeforeCliStart,
  settingsReader,
  CLI_CONFIRM_MS,
  planMenu,
  KEYS,
  OVERLAY_KEYS,
  createStartKey,
  confirmStopDelete,
  waitUntil,
  requestQuit,
  writeSilentWav,
  menuKey,
  PREFIX,
  initialState,
  parseStatus,
  reduce,
  notifications,
  view,
  cleanText,
  briefFrom,
  writeBrief,
  briefReady,
  readBrief,
  clearBrief,
  doctorVerdict,
  doctorSummary,
  tail,
  mmss,
};
