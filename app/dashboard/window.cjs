// The Wingman window (home, calls, settings). Hosted by the menu-bar process (tray/main.cjs) so the menu and the
// window drive ONE call controller. Every IPC handler checks the sender and validates its arguments; the window can
// only ask the controller for the fixed commands, it never writes arbitrary text to a call's stdin.
// Data comes from lib.cjs (saved calls), livetail.cjs (running call), keys-ipc.cjs (keys); preload.cjs is the page-side bridge.
// WINGMAN_DASHBOARD_* env vars are snapshot/test aids (screenshots, fake call states); they spawn and touch nothing real.
const path = require("node:path");
const fs = require("node:fs");
const { execFile } = require("node:child_process");
const lib = require("../tray/lib.cjs");
const catalog = require("../tray/settings-catalog.cjs");
const data = require("./lib.cjs");
const { createLiveTail } = require("./livetail.cjs");
const memLib = require("./memlib.cjs");
const prepareLib = require("./prepare.cjs");
const liveFixture = require("./livefixture.cjs");
const attachments = require("../tray/attachments.cjs");
const inputs = require("../shared/inputs.cjs");
const Plans = require("../shared/plans.js");
const features = require("./featureslib.cjs");

const ROOT = path.join(__dirname, "..");
const BRAND_ICON = path.join(ROOT, "..", "brand", "png", "icon-512.png");
const userPaths = require("../shared/paths.cjs");
const CALLS = userPaths.callsDir();
const BRIEFS = userPaths.briefsDir();
const binCommand = require("../shared/bin.cjs").binCommand;
/** execFile of a TypeScript tool through tsx (.bin/tsx on macOS/Linux; node + the tsx CLI on Windows). */
const execTsx = (args, opts, cb) => {
  const t = binCommand("tsx", args, ROOT);
  return execFile(t.cmd, t.args, opts, cb);
};
const BG = { dark: "#120E0B", light: "#FEF7EC" };
const SNAP = process.env.WINGMAN_DASHBOARD_SNAPSHOT || "";
const SIZE = /^(\d{3,4})x(\d{3,4})$/.test(process.env.WINGMAN_DASHBOARD_SIZE || "") ? String(process.env.WINGMAN_DASHBOARD_SIZE).split("x").map(Number) : null;

/** Snapshot-only fake call states (WINGMAN_DASHBOARD_FAKE_CALL=waiting|live|live-ask|live-warn|stopping|stopping-summary|ended). Nothing is spawned. */
function fakeCall(kind, now = Date.now()) {
  if (!kind) return null;
  const ev = (s, e) => lib.reduce(s, e);
  let s = ev(lib.initialState(), { ev: "boot", briefReady: true });
  s = ev(s, { ev: "starting" });
  s = ev(s, { ev: "waiting", id: "01JTESTDEMOSUMMARYCALL0001" });
  if (kind === "waiting") return { ...s, running: true, startedAt: now - 18000 };
  if (kind === "ended") {
    s = ev(s, { ev: "consented" });
    s = ev(s, { ev: "summary", ok: true });
    s = ev(s, { ev: "ended", id: "01JTESTDEMOSUMMARYCALL0001" });
    s = ev(s, { ev: "exit", code: 0 });
    return { ...s, running: false };
  }
  s = ev(s, { ev: "consented" });
  s = ev(s, { ev: "propose", title: "Dana Levi · Levi Studio" });
  s = ev(s, { ev: "note", count: 2 });
  if (kind === "live-warn") {
    s = ev(s, { ev: "health", id: "stt", level: "red", text: "Speech service is not answering" });
    s = ev(s, { ev: "health", id: "bt", level: "amber", text: "AirPods are the microphone: transcript quality drops" });
    s = ev(s, { ev: "overlay", ok: false, reason: "one-screen" });
  }
  if (kind === "live-ask") s = ev(s, { ev: "ask", on: true, until: now + 8000 });
  if (kind === "stopping" || kind === "stopping-summary") s = ev(s, { ev: "stopping" });
  if (kind === "stopping-summary") s = { ...s, stopPhase: "summary" };
  return { ...s, running: true, startedAt: now - 9 * 60000, liveAt: now - (8 * 60000 + 14000) };
}
/** Canned readiness results for snapshots (WINGMAN_DASHBOARD_FAKE_DOCTOR=ready|notready). */
const FAKE_DOCTOR = {
  ready: {
    ran: true,
    ok: true,
    verdict: "READY",
    failing: [],
    warnings: [{ text: "only one screen: the answer window will NOT open", fix: "connect the second screen before the call" }],
    at: 0,
  },
  notready: {
    ran: true,
    ok: false,
    verdict: "NOT READY",
    failing: [
      { text: "DEEPGRAM_API_KEY missing (speech to text)", fix: "Wingman → Settings → Keys: paste the key (it is stored in the macOS Keychain)" },
      { text: "no sound from the microphone: it looks blocked", fix: "System Settings → Privacy & Security → Microphone: allow Wingman, then restart Wingman" },
    ],
    warnings: [],
    at: 0,
  },
};

/** The sender must be the dashboard window's MAIN frame, still showing our own local page (not a sub-frame, not another window). */
function isDashboardSender(e, win) {
  if (!win || win.isDestroyed() || !e || e.sender !== win.webContents) return false;
  const f = e.senderFrame;
  if (!f || f !== win.webContents.mainFrame) return false;
  return typeof f.url === "string" && f.url.startsWith("file://") && /\/dashboard\/index\.html(\?|#|$)/.test(f.url);
}

/**
 * Build the window host. ctx: electron pieces + `controller` (the shared call controller from tray/main.cjs).
 * Registers every ipcMain handler used by preload.cjs. Returns { open(o), push(), live, win, isOpen() }.
 */
function create(ctx) {
  const { app, BrowserWindow, ipcMain, dialog, screen, clipboard, nativeTheme, shell, controller, plans, systemPreferences } = ctx; // plans: the prepared-meetings store (tray/plans.cjs)
  let win,
    fake = fakeCall(process.env.WINGMAN_DASHBOARD_FAKE_CALL),
    fakeDoc = FAKE_DOCTOR[process.env.WINGMAN_DASHBOARD_FAKE_DOCTOR] || null;
  if (fakeDoc) fakeDoc = { ...fakeDoc, at: Date.now() - 4 * 60000 };
  const bgNow = () => (nativeTheme.shouldUseDarkColors ? BG.dark : BG.light);
  const mine = (e) => isDashboardSender(e, win);
  // One listener for the life of the host (open() runs every time the window is opened; adding it there leaked one per open).
  nativeTheme.on("updated", () => {
    if (win && !win.isDestroyed()) win.setBackgroundColor(bgNow());
  });
  // All handlers go through here: reject any caller that is not our own page, and pass only the args (not the event) on.
  const handle = (name, fn) =>
    ipcMain.handle(name, (e, ...a) => {
      if (!mine(e)) throw new Error("denied");
      return fn(...a);
    });
  // State sent to the page: controller state + the readiness result + a clock. `now` is the main-process clock at send time.
  const view = () => {
    const s = fake || controller.getState();
    return { ...s, doctor: fakeDoc || s.doctor, now: Date.now(), fake: !!fake };
  };

  // Live conversation: tails the running call's transcript.jsonl / cards.jsonl (never the @@wingman status lines). Not used for fake/snapshot states.
  const live = createLiveTail({
    callsDir: CALLS,
    send: (p) => {
      if (win && !win.isDestroyed()) win.webContents.send("live:update", p);
    },
  });

  // Hidden from screenshots and screen share only while a call runs (live conversation on screen). Between calls the
  // window captures normally, so a screenshot of it is not a black box.
  let protectedNow;
  function protect() {
    if (!win || win.isDestroyed()) return;
    const s = fake || controller.getState();
    const on = process.env.WINGMAN_DASHBOARD_SHOW_IN_CAPTURE !== "1" && !!s && s.phase && s.phase !== "idle";
    if (on !== protectedNow) {
      protectedNow = on;
      win.setContentProtection(on);
    }
  }

  /** Push the controller state to the window. Never shows or focuses the window. */
  function push() {
    if (!fake && !SNAP) {
      try {
        live.sync(controller.getState());
      } catch {
        /* the feed must never break the state push */
      }
    }
    protect();
    if (win && !win.isDestroyed()) win.webContents.send("call:state", view());
  }

  /** Open (or focus) the window. Only called from a user action: a menu click, a second launch, or `pnpm dashboard`. */
  function open(o = {}) {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      win.webContents.send("nav", { view: o.view || "home", id: o.id, tab: o.tab, focus: o.focus });
      return win;
    }
    if (/^(light|dark)$/.test(process.env.WINGMAN_DASHBOARD_THEME || "")) nativeTheme.themeSource = process.env.WINGMAN_DASHBOARD_THEME;
    const d = screen.getPrimaryDisplay();
    if (!SNAP && process.platform === "darwin" && app.dock) {
      try {
        app.dock.show();
        if (fs.existsSync(BRAND_ICON)) app.dock.setIcon(BRAND_ICON);
      } catch {
        /* no dock */
      }
    }
    win = new BrowserWindow({
      x: d.workArea.x + Math.max(0, Math.round((d.workArea.width - 1200) / 2)),
      y: d.workArea.y + 30,
      width: SIZE ? SIZE[0] : Math.min(1200, d.workArea.width),
      height: SIZE ? SIZE[1] : Math.min(820, d.workArea.height - 40),
      minWidth: 560,
      minHeight: 480,
      backgroundColor: bgNow(),
      title: "Wingman",
      // Snapshot mode (tests/docs): render hidden, save a PNG, quit. Never steals focus from the user's screen.
      show: !SNAP,
      ...(SNAP && SIZE ? { enableLargerThanScreen: true } : {}), // a tall picture for the docs is not cut at the screen edge
      paintWhenInitiallyHidden: true,
      icon: BRAND_ICON,
      webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    protectedNow = undefined;
    protect(); // hidden from capture only during a call (see protect())
    // The window only ever shows the local page: no popups, no navigation away (a stray link cannot load remote content).
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.on("closed", () => {
      win = undefined;
      if (!SNAP && app.dock) {
        try {
          app.dock.hide();
        } catch {
          /* no dock */
        }
      }
    });
    // Snapshot aids: WINGMAN_DASHBOARD_OPEN="<callId>:<tab>[:extra]", _THEME, _VIEW=home|inbox|settings|system, _FOCUS=plan.
    const [call, tab, extra] = String(process.env.WINGMAN_DASHBOARD_OPEN || "").split(":");
    const query = {};
    if (call) {
      query.call = call;
      query.tab = tab || "";
      if (extra) query.x = extra;
    }
    if (/^(light|dark)$/.test(process.env.WINGMAN_DASHBOARD_THEME || "")) query.theme = process.env.WINGMAN_DASHBOARD_THEME;
    const v = SNAP ? process.env.WINGMAN_DASHBOARD_VIEW : o.view;
    if (/^(home|calls|inbox|settings|system)$/.test(v || "")) query.view = v;
    if (SNAP && /^(he|en)$/.test(process.env.WINGMAN_DASHBOARD_LANG || "")) query.lang = process.env.WINGMAN_DASHBOARD_LANG; // window language for screenshots
    if (/^(plan|edit|advanced|keys|review|tab-[a-z]+)$/.test((SNAP ? process.env.WINGMAN_DASHBOARD_FOCUS : o.focus) || ""))
      query.focus = SNAP ? process.env.WINGMAN_DASHBOARD_FOCUS : o.focus;
    if (!SNAP && o.id) {
      query.call = o.id;
      query.tab = o.tab || "";
    }
    win.loadFile(path.join(__dirname, "index.html"), Object.keys(query).length ? { query } : undefined);
    if (SNAP)
      win.webContents.once("did-finish-load", async () => {
        // The page sets body[data-ready=1] once its first view is drawn; wait for that (max 15 s) instead of a fixed delay.
        for (let i = 0; i < 100; i++) {
          const ready = await win.webContents.executeJavaScript("document.body.dataset.ready === '1'").catch(() => false);
          if (ready) break;
          await new Promise((r) => setTimeout(r, 150));
        }
        await new Promise((r) => setTimeout(r, 600));
        // Snapshot aid: WINGMAN_DASHBOARD_SCROLL=<pixels>|bottom scrolls the page before the picture.
        const sc = process.env.WINGMAN_DASHBOARD_SCROLL;
        if (/^(\d{1,5}|bottom)$/.test(sc || "")) {
          await win.webContents
            .executeJavaScript(sc === "bottom" ? "window.scrollTo(0, document.body.scrollHeight)" : `window.scrollTo(0, ${sc})`)
            .catch(() => {});
          await new Promise((r) => setTimeout(r, 300));
        }
        // Snapshot aid: WINGMAN_DASHBOARD_EVAL=<file.js> runs a script in the page and writes its JSON result to <snapshot>.json (used by the clickable audit).
        if (process.env.WINGMAN_DASHBOARD_EVAL) {
          try {
            const r = await win.webContents.executeJavaScript(fs.readFileSync(process.env.WINGMAN_DASHBOARD_EVAL, "utf8"));
            fs.writeFileSync(SNAP + ".json", JSON.stringify(r, null, 1));
          } catch (e) {
            fs.writeFileSync(SNAP + ".json", JSON.stringify({ error: String(e) }));
          }
        }
        fs.writeFileSync(SNAP, (await win.webContents.capturePage()).toPNG());
        app.quit();
      });
    return win;
  }

  // ---- calls (review) ----
  handle("calls:list", () => data.listCallsAsync(CALLS));
  // The user's own names (profile), so the after-call notes can tell "my promises" from "theirs". Read once a minute at most; no profile = roster and the word "me" only.
  /** @type {{ at: number, names: string[] }} */
  let meCache = { at: 0, names: [] };
  const meNames = async () => {
    if (fake || SNAP) return ["Dan", "דן"]; // the invented user of the snapshot fixtures
    if (Date.now() - meCache.at < 60_000) return meCache.names;
    /** @type {string[]} */
    let names = [];
    try {
      const r = await spawnTool(["src/profile-edit-cli.ts", "read"]);
      if (r && r.ok && r.profile)
        names = [r.profile.name, ...(Array.isArray(r.profile.spellings) ? r.profile.spellings : [])].filter((x) => typeof x === "string" && x);
    } catch {
      /* no profile */
    }
    meCache = { at: Date.now(), names };
    return names;
  };
  handle("calls:get", async (id) => {
    const d = data.getCall(CALLS, id);
    if (d && d.memory) d.memory = memLib.afterCall(CALLS, id, { meNames: await meNames() });
    if (d) d.held = features.readHeld(CALLS, id); // ratings of held-back moments (Review), { key: "wanted" | "fine" }
    return d;
  });
  // "Write summary" for a saved call that has none: the same tool as `wingman calls summary <id> --generate` (one small AI call, up to 3 min). Output is dropped: it contains call content.
  const writing = new Set();
  handle(
    "calls:writeSummary",
    (id) =>
      new Promise((resolve) => {
        data.callDir(CALLS, id); // validates the id
        if (fake || SNAP) return resolve({ ok: false, error: "preview" });
        const st = controller.getState();
        if (st.running && st.callId === id) return resolve({ ok: false, error: "This call is still running." });
        if (writing.has(id)) return resolve({ ok: false, error: "Already writing it." });
        writing.add(id);
        execTsx(
          [path.join(ROOT, "src", "summary.ts"), id],
          { cwd: ROOT, timeout: 180_000, maxBuffer: 4_000_000, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" } },
          (err) => {
            writing.delete(id);
            resolve(
              err
                ? { ok: false, error: "The summary could not be written (missing key, no transcript, or the model failed). Check Settings → Keys." }
                : { ok: true },
            );
          },
        );
      }),
  );
  handle("calls:search", (q) => data.searchCalls(CALLS, q));
  handle("calls:setTag", (id, cardId, useful) => data.setTag(CALLS, id, cardId, useful));
  handle("calls:delete", async (id) => {
    data.callDir(CALLS, id); // validates before the dialog
    const refusal = data.deleteRefusal(controller.getState(), id); // the running call has its own path: Stop and delete
    if (refusal) throw new Error(refusal);
    const { response: r } = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: ["Cancel", "Delete"],
      defaultId: 0,
      cancelId: 0,
      title: "Delete call",
      message: `Delete call ${id}?`,
      detail: "The transcript, cards and ratings of this call are removed permanently.",
    });
    if (r !== 1) return false;
    data.deleteCall(CALLS, id);
    return true;
  });
  // Export of one saved call (Markdown or JSON): the user picks the file in a save dialog, a child process (src/export-cli.ts) writes it. The page never sees the text.
  handle("calls:export", async (id, fmt) => {
    data.callDir(CALLS, id); // validates the id
    if (fmt !== "md" && fmt !== "json") throw new Error("bad format");
    if (fake || SNAP) return { ok: false, error: "preview" };
    const pick = await dialog.showSaveDialog(win, {
      defaultPath: `wingman-call-${id}.${fmt}`,
      filters: [fmt === "md" ? { name: "Markdown", extensions: ["md"] } : { name: "JSON", extensions: ["json"] }],
    });
    if (pick.canceled || !pick.filePath) return { ok: false, error: "cancelled" };
    const r = await spawnTool(["src/export-cli.ts"], JSON.stringify({ id, fmt, out: pick.filePath }));
    return r && r.ok ? { ok: true, path: path.basename(pick.filePath) } : { ok: false, error: r && r.reason === "no-export" ? "unavailable" : "failed" };
  });
  handle("clipboard:write", (text) => {
    if (typeof text !== "string" || !text || text.length > 20000) throw new Error("bad text");
    clipboard.writeText(text);
    return true;
  });

  // ---- the live call: fixed commands only ----
  handle("call:state", () => view());
  handle("live:get", (id) => {
    if (typeof id !== "string" || id.length > 60) throw new Error("bad id");
    if (fake) {
      const f =
        fake.running && fake.callId === id
          ? liveFixture.build(fake.liveAt || fake.startedAt, id, SNAP && process.env.WINGMAN_DASHBOARD_LANG === "en" ? "en" : "he")
          : null;
      return f || { callId: "", reset: true, lines: [], cards: [] };
    }
    return live.snapshot(id);
  });
  const planArg = (v) => {
    if (v === undefined || v === null || v === "") return "";
    if (typeof v !== "string" || !/^m[0-9a-z]{6,12}$/.test(v)) throw new Error("bad meeting id");
    return v;
  };
  handle("call:cmd", async (name, arg) => {
    if (typeof name !== "string") throw new Error("bad command");
    if (fake || SNAP) return { ok: false, error: "preview" }; // snapshot/preview states never touch a call
    switch (name) {
      // start / startNoAi: arg is a prepared meeting's id, or nothing for a quick call (no Plan). practice: arg is { planId } or { quick: true }, nothing = the next meeting.
      case "start":
        return { ok: controller.start({ noAi: false, planId: planArg(arg) }) };
      case "startNoAi":
        return { ok: controller.start({ noAi: true, planId: planArg(arg) }) };
      case "practice": {
        const a = arg && typeof arg === "object" ? arg : {};
        return { ok: controller.practice({ quick: a.quick === true, planId: planArg(a.planId) }) };
      }
      case "consent":
        return { ok: controller.consent() };
      case "quiet":
        if (typeof arg !== "boolean") throw new Error("bad argument");
        return { ok: controller.setQuiet(arg) };
      case "speaker": {
        if (
          !arg ||
          typeof arg !== "object" ||
          !Number.isInteger(arg.spk) ||
          arg.spk < 1 ||
          arg.spk > 20 ||
          typeof arg.name !== "string" ||
          arg.name.length > 40
        )
          throw new Error("bad argument");
        return { ok: controller.speaker(arg.spk, arg.name) };
      }
      case "client":
        return { ok: controller.confirmClient() };
      case "note":
        if (typeof arg !== "string" || arg.length > 2000) throw new Error("bad argument");
        return { ok: controller.note(arg) };
      case "ask":
        if (typeof arg !== "string" || !arg.trim() || arg.length > 2000) throw new Error("bad argument");
        return { ok: controller.ask(arg) }; // a typed question for Wingman
      case "askWingman":
        return { ok: controller.askWingman() }; // same as Ctrl+Opt+A
      case "mode": {
        // the call mode for the running call: "auto" | a kind | a custom mode id. The controller sends it down the control socket; the engine applies it.
        if (typeof arg !== "string") throw new Error("bad argument");
        return features.setMode(controller, arg, (await customModes()) || []);
      }
      case "stop":
        return { ok: controller.stop() };
      case "skipSummary":
        return { ok: controller.skipSummary() }; // fixed command "skip-summary" to the running call
      case "stopDelete": {
        const done = await lib.confirmStopDelete({ dialog, win, stopDelete: () => controller.stopDelete() }); // the same confirmation as the tray
        return { ok: done, cancelled: !done };
      }
      default:
        throw new Error("unknown command");
    }
  });

  // ---- r3 features: mode picker, card trust, held-back ratings, learning, earlier calls, lookup ----
  // They run the TypeScript parts in a child process (src/features-cli.ts); a missing or failing child is a plain "unavailable" result, never a crash.
  const feat = async (op, extra) => {
    const r = await spawnTool(["src/features-cli.ts"], JSON.stringify({ op, ...extra }));
    return r && typeof r === "object" ? r : { ok: false, reason: "failed" };
  };
  /** @type {{ at: number, list: { id: string, label: string }[] } | null} */
  let modesCache = null;
  const customModes = async () => {
    if (fake || SNAP) return process.env.WINGMAN_SNAP_MODES === "none" ? [] : [{ id: "standup", label: "Standup" }];
    if (!modesCache || Date.now() - modesCache.at > 60_000) {
      const r = await feat("modes.list");
      modesCache = { at: Date.now(), list: r && r.ok && Array.isArray(r.modes) ? r.modes : [] };
    }
    return modesCache.list;
  };
  handle("modes:list", async () => ({ ok: true, modes: await customModes() }));
  // A prepared meeting stores its mode (its `kind`); empty = auto. A locked kind is the user's choice for the call that starts from it.
  handle("plans:setKind", async (id, kind) => {
    const pid = planArg(id);
    const k = features.modeArg(kind, await customModes());
    if (!pid || !k) throw new Error("bad argument");
    if (fake || SNAP) return { ok: false, error: "preview" };
    const r = plans.update(pid, { kind: k === "auto" ? "" : k });
    if (!r.ok) return { ok: false, error: r.error };
    controller.refreshPlans();
    return { ok: true, plan: meetingOut(r.meeting) };
  });
  // Held-back moments (call review): the rating is stored next to the call; "I wanted this" also tells learn.ts about that kind of card, once per moment.
  handle("held:rate", async (id, key, rating) => {
    data.callDir(CALLS, id); // validates the id
    if (fake || SNAP) return { ok: false, error: "preview" };
    const r = features.rateHeld(CALLS, id, key, rating);
    if (r.ok && r.learnTag) await feat("learn.wanted", { tag: r.learnTag });
    return r.ok ? { ok: true, ratings: r.ratings } : { ok: false, error: r.error };
  });
  handle("learn:summary", async () => {
    if (fake || SNAP) return { ok: true, calls: 7, raised: ["NOTE"], watching: { NOTE: { neg: 4, calls: 3 }, PROMPT: { neg: 1, calls: 1 } } };
    return feat("learn.summary");
  });
  handle("learn:reset", async () => (fake || SNAP ? { ok: false, error: "preview" } : feat("learn.reset")));
  // Earlier calls: search (offline answer with call date and source), the stored "Last time" facts per person, and the recap of a recurring meeting.
  handle("past:search", async (q) => {
    if (typeof q !== "string" || !q.trim() || q.length > 300) throw new Error("bad query");
    if (fake || SNAP) return { ok: true, found: true, offline: true, text: "AI offline: from notes", hits: require("./snapshot-fixtures.cjs").PAST_HITS };
    return feat("past.search", { q });
  });
  handle("past:list", async () => {
    if (fake || SNAP) return { ok: true, people: require("./snapshot-fixtures.cjs").PAST_PEOPLE };
    return feat("past.list");
  });
  handle("past:forget", async (key, callId) => {
    if (typeof key !== "string" || !key || key.length > 100 || (callId && !/^[0-9A-Za-z_-]{1,60}$/.test(callId))) throw new Error("bad argument");
    if (fake || SNAP) return { ok: false, error: "preview" };
    return feat("past.forget", { key, callId: callId || "" });
  });
  handle("past:recap", async (m) => {
    if (!m || typeof m !== "object") throw new Error("bad meeting");
    if (fake || SNAP) return { ok: true, by: "topic", person: "Dana Levi", facts: require("./snapshot-fixtures.cjs").PAST_RECAP };
    return feat("past.recap", { title: m.title, who: m.who, topic: m.topic, goal: m.goal });
  });
  // Lookup runs only when the setting says so (the child checks it again): one public page, the address and the exact sentence.
  handle("lookup:run", async (term) => {
    if (typeof term !== "string" || !term.trim() || term.length > 200) throw new Error("bad term");
    if (fake || SNAP) return { ok: false, reason: "off", message: "preview" };
    return feat("lookup", { term });
  });

  // ---- prepared meetings ("Plan"): several can wait; a call uses one only when it is started with it ----
  // The page gets names, times, counts and the plan fields it edits; background file CONTENT never leaves the main process.
  const meetingOut = (m) => ({
    id: m.id,
    title: m.title,
    who: m.who,
    goal: m.goal,
    kind: m.kind,
    topic: m.topic,
    notes: m.notes.join("\n"),
    mustCover: m.mustCover.join("\n"),
    mustCount: m.mustCover.length,
    at: m.at,
    atInput: Plans.toInputValue(m.at),
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    liveAt: m.liveAt,
    usedAt: m.usedAt,
    uses: m.uses,
    pending: !!m.pending,
    status: m.status,
    files: m.files,
    fileList: m.fileList,
    contextChars: m.contextChars,
    preview: m.preview,
  });
  handle("plans:list", () => plans.list().map(meetingOut));
  // The pasted Meeting context text of one plan (kept out of the list so the list stays small).
  handle("plans:context", (id) => {
    const pid = planArg(id);
    return pid ? plans.getContext(pid) : "";
  });
  // Prepare: the digest of the meeting context (one small model call in a child process, src/prepare-cli.ts). The result is kept next to the plan's brief as digest.json
  // (the engine reads it at the start of a call). With no digest module, no key or a model error the text stays plain background and the page says so.
  const digestFileOf = (pid) => {
    const eb = plans.exportBrief(pid);
    return eb ? { file: path.join(path.dirname(eb.briefFile), "digest.json"), attachDir: eb.attachDir, meeting: eb.meeting } : null;
  };
  const preparing = new Set();
  handle("plans:prepare", async (id, lang) => {
    const pid = planArg(id);
    const m = pid ? plans.get(pid) : null;
    const chars = m ? m.contextChars + m.fileChars : 0;
    if (!pid || !m) return { ok: true, digest: false, reason: "empty", id: pid, chars };
    if (fake || SNAP) return { ok: true, digest: false, reason: "no-digest", id: pid, chars };
    if (preparing.has(pid)) return { ok: true, digest: false, reason: "busy", id: pid, chars };
    const d = digestFileOf(pid);
    if (!d) return { ok: true, digest: false, reason: "empty", id: pid, chars };
    preparing.add(pid);
    try {
      const r = await prepareLib.runPrepare({
        exec: execTsx,
        cwd: ROOT,
        env: process.env,
        plan: d.meeting,
        attachDir: d.attachDir,
        out: d.file,
        lang: lang === "he" ? "he" : "en",
      });
      const model = r.digest ? prepareLib.readDigestModel(d.file) : null;
      return { ...r, digest: !!model, ...(r.digest && !model ? { reason: "raw" } : {}), id: pid, chars, model };
    } finally {
      preparing.delete(pid);
    }
  });
  // "What Wingman knows": before a call, from the saved digest of the plan; during a call, from the call memory (session.json); in previews, a fixture.
  handle("knows:get", (mode, lang, planId) => {
    if (mode !== "before" && mode !== "live") throw new Error("bad mode");
    const K = require("./knowslib.js");
    const L = lang === "he" ? "he" : "en";
    if (fake || SNAP) {
      // previews: the golden-run memory when WINGMAN_DASHBOARD_KNOWS says so (golden | golden-paused | golden-offline | empty), else the small fixture
      const kind = process.env.WINGMAN_DASHBOARD_KNOWS || "";
      if (mode === "live" && /^(golden|golden-paused|golden-offline|empty)$/.test(kind))
        return { ok: true, ...require("./snapshot-fixtures.cjs").knowsFixture(kind, L) };
      // docs: the small fixture as a live model with no "Sample" badge, for the pictures in docs/ux (never shown as sample data)
      if (mode === "live" && kind === "docs") return { ok: true, model: { ...K.fixture("live", L), source: "memory" }, ai: "ok" };
      if (mode === "before" && kind === "conflict") return { ok: true, model: K.fixtureConflict(L), ai: "ok" };
      return { ok: true, model: K.fixture(mode, L), ai: "ok" };
    }
    if (mode === "before") {
      const pid = planArg(planId);
      const d = pid && plans.get(pid) ? digestFileOf(pid) : null;
      return { ok: true, model: d ? prepareLib.readDigestModel(d.file) : null, ai: "ok" };
    }
    const id = live.active;
    if (!id) return { ok: true, model: null, ai: "ok" };
    /** @type {any} */
    const snap = live.snapshot(id);
    const r = memLib.knowsLive(CALLS, id);
    return { ok: true, model: r.model, ver: r.ver, ai: (snap.memory && snap.memory.ai) || "ok" };
  });
  // The user changes what Wingman knows during a call: edit, remove or add one line. Validated here (shared/memedit.cjs) and again by the engine, which is the only writer of session.json.
  handle("knows:edit", (edit) => {
    if (fake || SNAP) return { ok: false, error: "preview" };
    const id = live.active;
    if (!id) return { ok: false, error: "no call" };
    return memLib.editMemory(CALLS, id, edit);
  });
  // Recent plans (same private folder, owner-only file): so a repeat call can reuse the text of an earlier one.
  const RECENT = path.join(BRIEFS, "recent.json");
  const readRecent = () => {
    try {
      return data.recentClean(JSON.parse(fs.readFileSync(RECENT, "utf8")));
    } catch {
      return [];
    }
  };
  const writeRecent = (list) => {
    fs.mkdirSync(BRIEFS, { recursive: true, mode: 0o700 });
    fs.writeFileSync(RECENT, JSON.stringify(list), { mode: 0o600 });
  };
  handle("brief:recent", () => readRecent());
  handle("brief:forgetRecent", () => {
    try {
      fs.rmSync(RECENT, { force: true });
    } catch {
      /* nothing to forget */
    }
    return [];
  });
  // Save: d.id empty = a new meeting (the unsaved draft's background files move in), else an edit of that meeting.
  handle("plans:save", (d) => {
    if (!d || typeof d !== "object") throw new Error("bad plan");
    for (const k of ["title", "who", "goal", "notes", "mustCover", "at"])
      if (d[k] !== undefined && (typeof d[k] !== "string" || d[k].length > 1500)) throw new Error("bad plan field " + k);
    if (d.context !== undefined && (typeof d.context !== "string" || d.context.length > 200000)) throw new Error("bad plan field context");
    if (d.id !== "" && !(typeof d.id === "string" && /^m[0-9a-z]{6,12}$/.test(d.id))) throw new Error("bad meeting id");
    if (fake || SNAP) return { ok: false, error: "preview" };
    const f = {};
    for (const k of ["title", "who", "goal", "notes", "mustCover", "at", "context"]) if (d[k] !== undefined) f[k] = d[k];
    const r = d.id ? plans.update(d.id, f) : plans.create(f, { adoptDraft: true });
    if (!r.ok) return { ok: false, error: r.error };
    try {
      // the saved text may have changed: an old digest of it is stale (Prepare makes a new one)
      const dg = digestFileOf(r.meeting.id);
      if (dg) fs.rmSync(dg.file, { force: true });
    } catch {
      /* nothing to remove */
    }
    try {
      writeRecent(data.recentAdd(readRecent(), { title: "", at: "", who: "", goal: "", notes: "", mustCover: "", ...d }));
    } catch {
      /* the plan itself is saved; the recent list is a convenience */
    }
    controller.refreshPlans();
    return { ok: true, plan: meetingOut(r.meeting), warning: r.warning || "" };
  });
  handle("plans:delete", async (id) => {
    if (typeof id !== "string" || !/^m[0-9a-z]{6,12}$/.test(id)) throw new Error("bad meeting id");
    if (fake || SNAP) return { ok: false, error: "preview" };
    const m = plans.get(id);
    if (!m) return { ok: false, error: "No such prepared meeting." };
    const { response: r } = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: ["Cancel", "Delete"],
      defaultId: 0,
      cancelId: 0,
      title: "Delete meeting",
      message: `Delete "${Plans.label(m).slice(0, 60)}"?`,
      detail: "Its meeting context and files are removed permanently.",
    });
    if (r !== 1) return { ok: false, cancelled: true };
    const x = plans.remove(id);
    controller.refreshPlans();
    return { ok: !!x.ok };
  });
  handle("plans:discardDraft", () => {
    if (!fake && !SNAP) plans.discardDraft();
    return true;
  });

  // ---- background files for a plan (.txt .md, .pdf when pdftotext exists, pasted text): validated in tray/attachments.cjs ----
  // id "" = the plan being written and not saved yet. Content is never logged or sent back to the page: the list only has names and sizes.
  const planId = (id) => {
    if (id === "") return "";
    if (typeof id !== "string" || !/^m[0-9a-z]{6,12}$/.test(id)) throw new Error("bad meeting id");
    return id;
  };
  const attState = (id) => {
    const st = plans.files(id);
    return st ? st.list() : { files: [], maxChars: attachments.MAX_CHARS, pdf: false };
  };
  handle("attach:list", (id) => attState(planId(id)));
  handle("attach:add", async (id, name, bytes) => {
    planId(id);
    if (typeof name !== "string" || name.length > 300) throw new Error("bad file name");
    if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) throw new Error("bad file");
    if (fake || SNAP) return { ok: false, error: "preview", state: attState(id) };
    const st = plans.files(id);
    if (!st) return { ok: false, error: "No such prepared meeting.", state: attState("") };
    const r = await st.addFile(name, bytes);
    controller.refreshPlans();
    return { ok: !!r.ok, error: r.error, truncated: !!r.truncated, chunks: r.chunks || 0, fields: r.fields || null, state: attState(id) };
  });
  handle("attach:paste", (id, text) => {
    planId(id);
    if (typeof text !== "string" || text.length > 200000) throw new Error("bad text");
    if (fake || SNAP) return { ok: false, error: "preview", state: attState(id) };
    const st = plans.files(id);
    if (!st) return { ok: false, error: "No such prepared meeting.", state: attState("") };
    const r = st.addPaste(text);
    controller.refreshPlans();
    return { ok: !!r.ok, error: r.error, truncated: !!r.truncated, state: attState(id) };
  });
  handle("attach:remove", (id, fileId) => {
    planId(id);
    if (typeof fileId !== "string" || fileId.length > 30) throw new Error("bad id");
    if (!fake && !SNAP) {
      const st = plans.files(id);
      if (st) st.remove(fileId);
      controller.refreshPlans();
    }
    return attState(id);
  });

  // ---- more ways to give context: a web page address and the next calendar event (shared/inputs.cjs; the page can only send an address, never a path) ----
  // A web page the user typed is read at once and kept as a background file. The calendar address is private and comes from the settings
  // (context.calendarUrl): "cal:preview" reads it and only SHOWS the nearest meeting; nothing is stored until the user says yes ("cal:use").
  const plain = (e) => String((e && e.message) || "That did not work.").slice(0, 300);
  /** @type {{ text: string, label: string, fields: object, when: number, at: number } | null} */
  let calCache = null;
  handle("ctx:url", async (id, url) => {
    planId(id);
    if (typeof url !== "string" || url.length > 2000) throw new Error("bad address");
    if (fake || SNAP) return { ok: false, error: "preview", state: attState(id) };
    const st = plans.files(id);
    if (!st) return { ok: false, error: "No such prepared meeting.", state: attState("") };
    try {
      const r = await inputs.readSource({ type: "url", url });
      const a = st.addText(r.label, r.text);
      controller.refreshPlans();
      return { ok: !!a.ok, error: a.error, name: r.label, truncated: !!(a.truncated || r.truncated), chunks: a.chunks || 0, state: attState(id) };
    } catch (e) {
      return { ok: false, error: plain(e), state: attState(id) };
    }
  });
  handle("ctx:calPreview", async () => {
    if (fake || SNAP) return { ok: false, error: "preview" };
    const s = await readSettings();
    const url = ((s.items || []).find((i) => i.key === "context.calendarUrl") || {}).value || "";
    if (!url) return { ok: false, code: "nourl", error: "No calendar address yet." };
    try {
      const r = await inputs.readCalendarUrl(url, {});
      calCache = { text: r.text, label: r.label, fields: r.fields, when: r.when, at: Date.now() };
      return { ok: true, title: r.label, when: r.when, who: r.fields.who, events: r.events };
    } catch (e) {
      calCache = null;
      return { ok: false, error: plain(e) };
    }
  });
  handle("ctx:calUse", (id) => {
    planId(id);
    if (fake || SNAP) return { ok: false, error: "preview", state: attState(id) };
    const c = calCache;
    calCache = null;
    if (!c || Date.now() - c.at > 10 * 60_000) return { ok: false, error: "Look up the meeting again.", state: attState(id) };
    const st = plans.files(id);
    if (!st) return { ok: false, error: "No such prepared meeting.", state: attState("") };
    const a = st.addText(c.label, c.text);
    controller.refreshPlans();
    return { ok: !!a.ok, error: a.error, name: c.label, fields: c.fields, state: attState(id) };
  });
  handle("ctx:calSave", async (url) => {
    if (typeof url !== "string" || url.length > 700) throw new Error("bad address");
    if (fake || SNAP) return { ok: false, message: "preview" };
    return setSetting("context.calendarUrl", url.trim());
  });

  // ---- readiness (doctor) ----
  handle("doctor:run", async (offline) => {
    if (fakeDoc) return { ...fakeDoc, at: Date.now() };
    if (SNAP) return null;
    return controller.runDoctor({ offline: offline === true }); // offline = free quick check (no speech or AI test)
  });

  // ---- settings ----
  // Settings read/write run the TypeScript tools as child processes; child() expects one JSON line on stdout (the last one wins).
  const settingsEnv = () => ({ ...require("../src/keychain.cjs").childEnv(process.env), NO_COLOR: "1", FORCE_COLOR: "0" }); // the settings tools never need API keys
  // Writes go one at a time: each write child reads the file, edits it and renames it over the original, so two at once lose an update.
  // Reads are not queued (but settings:set reads again only after its own write, so the page shows the saved state).
  const writes = require("./serial.cjs").createQueue();
  const child = (args, input) => (args.includes("write") ? writes(() => spawnTool(args, input)) : spawnTool(args, input));
  const spawnTool = (args, input) =>
    new Promise((resolve) => {
      const p = execTsx(args, { cwd: ROOT, timeout: 30_000, maxBuffer: 2_000_000, env: settingsEnv() }, (err, stdout) => {
        const line =
          String(stdout || "")
            .trim()
            .split("\n")
            .filter(Boolean)
            .pop() || "";
        try {
          resolve(JSON.parse(line));
        } catch {
          resolve({ ok: false, message: err ? String(err.message).slice(0, 300) : "no answer from the settings tool" });
        }
      });
      if (input != null) {
        p.stdin?.on("error", () => {});
        p.stdin?.end(input);
      }
    });
  const readSettings = async () => {
    const r = await child(["src/settings-edit-cli.ts", "read"]);
    if (!r.ok) return { ok: false, message: String(r.message || "unknown error").slice(0, 600) };
    return {
      ok: true,
      items: catalog.describe(r),
      groups: catalog.GROUPS,
      userFile: String(r.userFile),
      keysFile: String(r.keysFile),
      keys: r.keys,
      keyVars: r.keyVars,
      changed: r.changed.length,
    };
  };
  handle("settings:get", readSettings);
  const setSetting = async (key, value) => {
    const item = typeof key === "string" && catalog.BY_KEY.get(key);
    if (!item) throw new Error("unknown setting");
    let stored;
    try {
      stored = value === null ? null : catalog.toStored(item, value);
    } catch (e) {
      return { ok: false, message: `${item.label}: ${e.message}` };
    }
    const r = await child(["src/settings-edit-cli.ts", "write"], JSON.stringify({ [key]: stored }));
    if (!r.ok) return { ok: false, message: String(r.message || "not saved").slice(0, 400) };
    return { ok: true, state: await readSettings() };
  };
  handle("settings:set", setSetting);
  handle("settings:reveal", (what) => {
    if (what !== "keys" && what !== "settings") throw new Error("bad target");
    return readSettings().then((s) => {
      const f = what === "keys" ? s.keysFile : s.userFile;
      if (!f) return false;
      const p = f.startsWith("~/") ? path.join(require("node:os").homedir(), f.slice(2)) : f;
      shell.showItemInFolder(p);
      return true;
    });
  });
  // Advanced (read-only) list for debugging.
  handle(
    "tools:settings",
    () =>
      new Promise((resolve) =>
        execTsx(["src/settings-cli.ts"], { cwd: ROOT, timeout: 60_000, maxBuffer: 2_000_000, env: settingsEnv() }, (err, stdout, stderr) =>
          resolve({ ok: !err, text: String(stdout || "") + (stderr ? "\n" + String(stderr) : "") || (err ? String(err.message) : "") }),
        ),
      ),
  );

  // ---- keys: Keychain storage, write-only input. All logic in keys-ipc.cjs (main process only). ----
  require("./keys-ipc.cjs").register({
    handle,
    getWin: () => win,
    dialog,
    fake: process.env.WINGMAN_DASHBOARD_FAKE_KEYS || (SNAP ? "missing" : ""), // snapshots never touch the real Keychain
    keysFile: async () => {
      if (process.env.WINGMAN_KEYS_FILE) return process.env.WINGMAN_KEYS_FILE;
      const s = await readSettings();
      const f = s.ok && s.keysFile;
      return f
        ? f.startsWith("~/")
          ? path.join(require("node:os").homedir(), f.slice(2))
          : f
        : path.join(require("node:os").homedir(), ".config", "wingman", "keys.env");
    },
  });

  // ---- guided setup and "About you": profile, permissions, microphone, screens, pack. All logic in setup-ipc.cjs. ----
  require("./setup-ipc.cjs").register({ handle, child, listMics: ctx.listMics, root: ROOT, systemPreferences, shell, screen, preview: !!(fake || SNAP) });

  return {
    open,
    push,
    live,
    get win() {
      return win;
    },
    isOpen: () => !!win && !win.isDestroyed(),
  };
}

module.exports = { create, fakeCall, isDashboardSender };
