// One call controller, shared by the menu bar and the Wingman window.
// Spawns src/call.ts with WINGMAN_CONTROL=1, writes ONLY the fixed stdin commands below, reads "@@wingman {json}" lines.
// No electron import: it is unit-tested with a fake child process (src/controller.test.ts).
const nodeFs = require("node:fs");
const nodePath = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const defaultLib = require("./lib.cjs");
const Plans = require("../shared/plans.js");

/** The complete list of things that can ever be written to a call's stdin. Notes are cleaned and capped before they get here. */
const COMMANDS = Object.freeze(["consent", "quiet on", "quiet off", "client", "ask", "recap", "stop", "stop-delete", "stop-no-summary", "skip-summary"]);

/**
 * Builds the controller. o: { root, spawn (child_process.spawn-like), lib?, fs?, path?, bin?, logPath?, tmpDir?, env?, plans?,
 * notify?(title, body), onChange?(), setTimeout?, kill?, doctorTimeoutMs? } (fs/spawn/timers are injectable for tests).
 * State lives in lib.reduce; every change calls onChange so the tray and window can redraw. Only one call child at a time.
 * @param {any} o Options as listed above.
 * @returns {object} The controller API: getState, isRunning, start, practice, consent, setQuiet, askWingman, recap, confirmClient, note, ask, speaker, mode,
 *   stop, stopDelete, stopNoSummary, skipSummary, briefSaved, briefCleared, boot, refreshPlans, runDoctor, shutdown, logLine.
 */
const QUIT_GRACE_MS = 3000; // quit: a call asked to stop longer ago than this and still alive is killed at once
const MAX_LINE = 1024 * 1024; // longest stdout line the controller keeps while waiting for its newline

function createController(o) {
  const lib = o.lib || defaultLib,
    fs = o.fs || nodeFs,
    path = o.path || nodePath;
  const root = o.root;
  // [command, args] to run a local tool (tsx): .bin/tsx on macOS/Linux, node + the tsx CLI on Windows (shared/bin.cjs). o.bin (tests) replaces the path.
  const binCmd = (n, args) => (o.bin ? [o.bin(n), args] : (({ cmd, args: a }) => [cmd, a])(require("../shared/bin.cjs").binCommand(n, args, root)));
  const logPath = o.logPath,
    tmpDir = o.tmpDir || require("node:os").tmpdir();
  const st = o.setTimeout || setTimeout,
    killProc = o.kill || ((pid, sig) => process.kill(pid, sig));
  const logLine = (s) => {
    if (!logPath) return;
    try {
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${s}\n`, { mode: 0o600 });
    } catch {
      /* calls/ may not exist yet */
    }
  };
  // doctor/engine word permission hints for the installed app, not a terminal; captureEnv() = where the app's audio capture listens (tray/capture-bridge.cjs)
  const appEnv = () => (process.versions.electron ? { WINGMAN_APP: "1", ...(o.captureEnv ? o.captureEnv() : {}) } : {});
  const notify = o.notify || (() => {});
  const clock = o.now || Date.now;
  let stopSentAt = 0; // when the "stop" command last went to the engine (0 = never)
  let doctorProc;
  const DOCTOR_TIMEOUT_MS = o.doctorTimeoutMs || 90_000;
  const STDOUT_DRAIN_MS = 300; // how long a finished child may still be delivering its last stdout lines
  let child,
    lingering,
    state = lib.initialState();
  const finished = new WeakSet(); // children whose end ("ended" line or process exit) has been handled
  const change = () => {
    try {
      o.onChange && o.onChange();
    } catch {
      /* a listener must never break the call */
    }
  };
  const set = (ev) => {
    const before = state;
    state = lib.reduce(state, ev);
    return before;
  };

  /** The engine is done and call.ts only lingers to keep the answer window up: a new call replaces it (its overlay is closed now). */
  function dropLingering() {
    if (lingering) {
      const l = lingering;
      lingering = undefined;
      killGroup(l, "SIGTERM");
      st(() => killGroup(l, "SIGKILL"), 3000);
    }
  }
  /** Handles the end of call child c once (the "ended" line and the process exit can both arrive). Moves it to `lingering` and notifies on an unexpected non-zero exit. */
  function finish(c, code, signal) {
    if (finished.has(c)) return;
    finished.add(c);
    if (child === c) {
      child = undefined;
      lingering = c;
    }
    // Killed by a signal (SIGKILL, SIGSEGV, the out-of-memory killer): Node reports code null. That is a crash, not a clean end.
    if (code == null && signal) {
      code = 1;
      if (!state.endedCleanly) set({ ev: "stderr", text: `The call engine was killed (${signal}).` });
    }
    set({ ev: "exit", code });
    if (code && code !== 0 && !state.endedCleanly && !state.offReason)
      notify(
        "Wingman stopped unexpectedly",
        `${state.lastError ? state.lastError.slice(0, 120) : `Exit code ${code}`}. Start a new call when you are ready; Show log in the menu bar has the details.`,
      );
    change();
  }

  /** Spawns src/call.ts. Returns false if a call is already running. Reads its stdout "@@wingman" lines into state and notifications. */
  function startCall(extraArgs = [], extraEnv = {}, planId = "") {
    if (child) return false;
    dropLingering();
    set({ ev: "starting", practice: !!extraEnv.WINGMAN_STT_SCRIPT, noAi: extraArgs.includes("--no-ai"), planId });
    const env = { ...(o.env || process.env), WINGMAN_CONTROL: "1", FORCE_COLOR: "0", ...appEnv(), ...extraEnv };
    if (logPath)
      try {
        fs.writeFileSync(logPath, "", { mode: 0o600 });
        fs.chmodSync(logPath, 0o600);
      } catch {
        /* best effort */
      }
    // detached: call.ts leads its own process group, so a stuck call can be force-killed with everything under it.
    const [cmd, cargs] = binCmd("tsx", [path.join(root, "src", "call.ts"), ...extraArgs]);
    let c;
    const spawnFailed = (e) => {
      logLine("ERR spawn " + e.message);
      notify("Wingman could not start", `${e.message}. Quit Wingman from the menu bar and open it again; if it keeps happening, choose Show log.`);
      if (c && child === c) child = undefined;
      set({ ev: "stderr", text: e.message });
      if (c) finished.add(c);
      set({ ev: "exit", code: 1 });
      change();
    };
    try {
      c = o.spawn(cmd, cargs, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    } catch (e) {
      // A synchronous throw (EAGAIN, EMFILE) must not leave the state at "starting" with no process behind it.
      spawnFailed(e);
      return false;
    }
    child = c;
    stopSentAt = 0; // a new call: an earlier Stop must not make a quit kill this one at once
    c.on("error", spawnFailed);
    c.stdin.on("error", () => {
      /* the call already ended */
    });
    let buf = "",
      skipping = false; // a line longer than MAX_LINE is dropped up to its newline
    // A multi-byte letter (Hebrew is two bytes) can be cut between two pipe reads: decode with a stateful decoder, not chunk.toString().
    const outDec = new StringDecoder("utf8"),
      errDec = new StringDecoder("utf8");
    const handleLine = (line) => {
      const msg = lib.parseStatus(line);
      if (!msg) return;
      logLine(line.trim());
      const before = set(msg);
      // A real call is live: record it on the plan (nothing is deleted; a practice call never does). The plan counts as used when the call
      // saved its first memory ({ev:"memory"}, sent by the engine) or, for the engine without memory, when the call ends cleanly.
      if (msg.ev === "consented" && !state.practice && state.planId) usePlan("live");
      if ((msg.ev === "memory" || (msg.ev === "ended" && !msg.crashed)) && !state.practice && state.planId) usePlan("used");
      for (const n of lib.notifications(before, state, msg)) notify(n.title, n.body);
      change();
      if (msg.ev === "ended") finish(c, msg.crashed ? 1 : 0); // saved: Start is allowed again while call.ts lingers about 5 s for the answer window
    };
    c.stdout.on("data", (d) => {
      buf += outDec.write(d);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (skipping) skipping = false;
        else handleLine(line);
      }
      if (buf.length > MAX_LINE) {
        // No newline in a megabyte: not a status line. Drop it so the buffer cannot grow without bound.
        buf = "";
        skipping = true;
      }
    });
    c.stdout.on("end", () => {
      // The engine's last line may come without "\n" (it was killed or crashed while writing): parse it too.
      const rest = buf + outDec.end();
      buf = "";
      if (rest && !skipping) handleLine(rest);
    });
    c.stderr.on("data", (d) => {
      const text = errDec.write(d);
      if (!text) return;
      logLine("ERR " + text.trimEnd());
      set({ ev: "stderr", text });
      change();
    });
    c.on("exit", (code, signal) => {
      const end = () => {
        finish(c, code, signal);
        if (lingering === c) lingering = undefined; // (after finish: an exited process is not lingering)
      };
      // Node can report "exit" before the last stdout bytes (the "ended" line) are read. Wait for the pipe to end, but not for long:
      // a child process of the call may keep the pipe open. A stream without `readable` (a test double) is not waited for.
      if (!c.stdout || c.stdout.readable !== true || typeof c.stdout.once !== "function") return end();
      let fired = false;
      const once = () => {
        if (fired) return;
        fired = true;
        end();
      };
      c.stdout.once("end", once);
      c.stdout.once("close", once);
      st(once, STDOUT_DRAIN_MS);
    });
    change();
    return true;
  }

  /** Records on the live call's plan that the call went live ("live") or saved its first memory ("used"). The plan and its files are kept. Tells the menu and window. */
  function usePlan(step) {
    try {
      if (o.plans) step === "live" ? o.plans.markLive(state.planId, state.callId) : o.plans.confirmUsed(state.planId, state.callId);
    } catch {
      /* the call goes on */
    }
    api.refreshPlans();
  }

  /**
   * Practice call: a pretend client plays into the real call loop with scripted AI. File mode: no mic, no system audio, no network, no cost.
   * o2.planId: practise with that prepared meeting; o2.quick: with none; neither: the next prepared meeting (Plans.practiceDefault).
   * The meeting is passed with --brief and is NOT used up. False when a call runs, or when the named meeting is gone.
   */
  function practice(o2 = {}) {
    if (child) return false;
    const pid = o2.quick ? "" : o2.planId || (o.plans ? (o.plans.practiceDefault() || {}).id || "" : "");
    const exp = pid && o.plans ? o.plans.exportBrief(pid) : null;
    if (o2.planId && !exp) return false;
    dropLingering();
    const en = !!o.uiLanguage && o.uiLanguage() === "en"; // English interface: the English pretend call
    const script = path.join(root, "data", "demo", en ? "demo-call.en.json" : "demo-call.json"),
      gapMs = 4500;
    let lines = 16;
    try {
      lines = JSON.parse(fs.readFileSync(script, "utf8")).length;
    } catch {
      /* default */
    }
    // Own private folder per practice call: a fixed name in the shared temp folder could be replaced by another user or another run.
    let wavDir;
    try {
      wavDir = fs.mkdtempSync(path.join(tmpDir, "wingman-practice-"));
    } catch {
      return false;
    }
    const wav = path.join(wavDir, "practice.wav");
    lib.writeSilentWav(wav, Math.ceil((lines * gapMs) / 1000) + 12);
    const ok = startCall(
      ["--profile", en ? "demo-en" : "demo", "--file", wav, ...(exp ? ["--brief", exp.briefFile] : ["--no-brief"])],
      { WINGMAN_STT_SCRIPT: script, WINGMAN_SCRIPT_GAP_MS: String(gapMs), ...(exp ? { WINGMAN_ATTACH_DIR: exp.attachDir } : {}) },
      exp ? exp.meeting.id : "",
    );
    const drop = () => {
      try {
        fs.rmSync(wavDir, { recursive: true, force: true });
      } catch {
        /* a temp folder left behind is harmless */
      }
    };
    if (ok && child) {
      child.once("exit", drop);
      child.once("error", drop); // a spawn that fails (no exit event) must not leave the folder behind
    } else drop();
    if (ok)
      notify(
        "Practice call",
        `A pretend caller is talking${exp ? `, and your Plan "${Plans.label(exp.meeting).slice(0, 40)}" is in use` : ""}. Watch the answer window on your second screen. Nothing is sent anywhere.`,
      );
    return ok;
  }

  /** Writes one line to the call's stdin. Only the fixed COMMANDS, or "note"/"ask" plus one clean line of text, are allowed; anything else is refused. */
  function send(cmd) {
    if (!child) return false;
    // The call mode: a kind name or a custom mode id, nothing else on the line. The engine checks the name against the kinds and the pack.
    if (/^mode [a-z0-9][a-z0-9-]{0,23}$/.test(cmd)) return write(cmd);
    if (!COMMANDS.includes(cmd) && !/^(note|ask) [^\n\r]{1,300}$/.test(cmd) && !/^speaker (?:[1-9]|1[0-9]|20)(?: [^\n\r]{1,40})?$/.test(cmd)) return false;
    return write(cmd);
  }
  function write(cmd) {
    try {
      if (child.stdin.writable) {
        child.stdin.write(cmd + "\n");
        return true;
      }
    } catch {
      /* ended */
    }
    return false;
  }
  /** Signals the whole process group (negative pid; call.ts is detached and leads its group). Falls back to the single process. */
  function killGroup(c, sig) {
    try {
      killProc(-c.pid, sig);
    } catch {
      try {
        c.kill(sig);
      } catch {
        /* gone */
      }
    }
  }
  /** Asks the call to stop (and optionally delete or skip the summary), then escalates: SIGINT at 12 s, SIGKILL at 20 s if it is still the same child. */
  function stop(del = false, noSummary = false) {
    if (!child) return false;
    if (state.phase === "stopping") {
      // A plain Stop was pressed and the user now wants the call deleted: the engine takes that until the summary is written.
      if (!del) return false;
      send("stop-delete");
      set({ ev: "stopdelete" });
      change();
      return true;
    }
    const c = child;
    send(del ? "stop-delete" : noSummary ? "stop-no-summary" : "stop");
    stopSentAt = clock();
    if (del) set({ ev: "stopdelete" });
    else if (noSummary) set({ ev: "summaryskip" });
    set({ ev: "stopping" });
    change();
    st(() => {
      if (child === c || lingering === c) killGroup(c, "SIGINT"); // (after "ended" the call lingers about 5 s: a hung one is still ended)
    }, 12000); // call.ts: graceful stop
    st(() => {
      if (child === c || lingering === c) killGroup(c, "SIGKILL");
    }, 20000); // stuck: force everything off (mic included)
    return true;
  }

  const api = {
    /** A copy of the current state (phase, call id, health, doctor result, ...) plus `running`. */
    getState: () => ({ ...state, health: { ...state.health }, running: !!child }),
    /** True while a call child process exists. */
    isRunning: () => !!child,
    /** Stop and save, but do not write the summary (it can be written later from Calls or `wingman calls summary <id> --generate`). */
    stopNoSummary: () => stop(false, true),
    /** While a call is stopping and the summary has not finished: give it up. The call stays saved. */
    skipSummary: () =>
      !!child &&
      state.phase === "stopping" &&
      !state.summarySkipped &&
      state.stopPhase !== "done" &&
      send("skip-summary") &&
      (set({ ev: "summaryskip" }), change(), true),
    /**
     * Start a real call. o2.planId: with that prepared meeting (it must still be ready, else false); otherwise a quick call with NO Plan
     * (--no-brief), which never uses up or changes any prepared meeting. o2.noAi: Prepared cards only.
     */
    start: (o2 = {}) => {
      if (child) return false;
      const ai = o2.noAi ? ["--no-ai"] : [];
      if (!o2.planId) return startCall([...ai, "--no-brief"]);
      const exp = o.plans ? o.plans.exportBrief(o2.planId) : null;
      return exp ? startCall([...ai, "--brief", exp.briefFile], { WINGMAN_ATTACH_DIR: exp.attachDir }, exp.meeting.id) : false;
    },
    /** Starts a practice call (see `practice` above). */
    practice,
    /** Sends the listening consent while the call waits for it. Returns false in any other phase. */
    consent: () => !!child && state.phase === "waiting" && send("consent"),
    /** Turns quiet mode on or off during a live call. */
    setQuiet: (on) => !!child && state.phase === "live" && send(on ? "quiet on" : "quiet off"),
    /** "The next thing I say is for you": Ctrl+Opt+A. Works whenever the call is listening. */
    askWingman: () => !!child && state.phase === "live" && send("ask"),
    /** "Catch me up" (Ctrl+Opt+U, `wingman recap`): the engine writes the five-line recap sheet. Only while the call is live. */
    recap: () => !!child && state.phase === "live" && send("recap"),
    /** Confirms the client Wingman has proposed. False when nothing is proposed or one is already confirmed. */
    confirmClient: () => !!child && !!state.proposed && !state.client && send("client"),
    /** Adds a note (cleaned, at most 300 characters) to the live call. */
    note: (text) => {
      const t = lib.cleanText(text, 300);
      return !!child && state.phase !== "stopping" && !!t && send("note " + t);
    },
    /** A typed question for the live call (the CLI's `wingman ask`; the `ask <text>` stdin command in run.ts). */
    ask: (text) => {
      const t = lib.cleanText(text, 300);
      return !!child && state.phase === "live" && !!t && send("ask " + t);
    },
    /** Rename (or, with an empty name, clear) the other side's call-local speaker n (1-20): the `speaker <n> <name>` stdin command in run.ts. */
    speaker: (n, name) => {
      if (!Number.isInteger(n) || n < 1 || n > 20 || typeof name !== "string") return false;
      const t = lib.cleanText(name, 40);
      if (name.trim() && !t) return false;
      return !!child && state.phase !== "stopping" && send(t ? `speaker ${n} ${t}` : `speaker ${n}`);
    },
    /** The call mode: a built-in kind, a custom mode id from the pack, or "auto". Only while the call is live; the engine refuses an id it does not know. */
    mode: (kind) => typeof kind === "string" && /^[a-z0-9][a-z0-9-]{0,23}$/.test(kind) && !!child && state.phase === "live" && send("mode " + kind),
    /** Stops the call gracefully and saves it with its summary. */
    stop: () => stop(false),
    /** Stops the call and deletes it. Callers must ask the user first. */
    stopDelete: () => stop(true),
    /** Tells the state machine that a Plan was saved. */
    briefSaved: () => {
      set({ ev: "brief" });
      change();
    },
    /** Tells the state machine that the Plan was cleared. */
    briefCleared: () => {
      set({ ev: "boot", briefReady: false });
      change();
    },
    /** Sets the initial state at app start: whether a prepared meeting exists and the plans signature. */
    boot: (briefReady, plansKey) => {
      set({ ev: "boot", briefReady, plansKey });
      change();
    },
    /** Re-reads the prepared meetings (they change from the window, the CLI or by expiring); redraws only when the list changed. */
    refreshPlans: () => {
      if (!o.plans) return;
      let list = [];
      try {
        list = o.plans.list();
      } catch {
        return;
      }
      const key = Plans.signature(list);
      if (key !== state.plansKey || list.length > 0 !== state.briefReady) {
        set({ ev: "boot", briefReady: list.length > 0, plansKey: key });
        change();
      }
    },
    /** Full doctor (microphone, audio, Deepgram, Haiku). Refused while a call runs. Resolves to lib.doctorSummary. */
    runDoctor: (opts = {}) =>
      new Promise((resolve) => {
        if (child)
          return resolve({
            ran: false,
            ok: false,
            verdict: "BUSY",
            failing: [{ text: "A call is running. Check again after it ends.", fix: "" }],
            warnings: [],
            at: Date.now(),
          });
        if (state.doctorRunning) return resolve(state.doctor);
        const [dcmd, dargs] = binCmd("tsx", [path.join(root, "src", "doctor.ts"), ...(opts.offline ? ["--offline"] : [])]);
        const p = o.spawn(dcmd, dargs, { cwd: root, env: { ...(o.env || process.env), FORCE_COLOR: "0", ...appEnv() }, detached: true });
        doctorProc = p;
        let out = "";
        const dd = new StringDecoder("utf8"),
          de = new StringDecoder("utf8");
        p.stdout.on("data", (d) => (out += dd.write(d)));
        p.stderr.on("data", (d) => (out += de.write(d)));
        set({ ev: "doctor.start" });
        change();
        let done = false,
          timer;
        const fin = () => {
          if (done) return;
          done = true;
          if (timer) clearTimeout(timer);
          if (doctorProc === p) doctorProc = undefined;
          const r = lib.doctorSummary(out);
          set({ ev: "doctor.end", result: r });
          change();
          resolve(r);
        };
        // A hung doctor (mic prompt, dead network) must not leave "Checking…" forever.
        timer = st(() => {
          if (done) return;
          out += "\nDoctor timed out after " + Math.round(DOCTOR_TIMEOUT_MS / 1000) + " s.";
          killGroup(p, "SIGKILL");
          fin();
        }, DOCTOR_TIMEOUT_MS);
        p.on("error", fin);
        // Same as the call: the verdict line can still be in the pipe when "exit" arrives. Give it a moment to drain.
        p.on("exit", () => {
          if (!p.stdout || p.stdout.readable !== true || typeof p.stdout.once !== "function") return fin();
          p.stdout.once("end", fin);
          p.stdout.once("close", fin);
          st(fin, STDOUT_DRAIN_MS);
        });
      }),
    /** App is quitting. The timers below would never run (the app exits right after), so nothing may depend on them:
     *  a call that was already asked to stop more than QUIT_GRACE_MS ago and is still alive is wedged, and its whole process group gets SIGKILL now,
     *  synchronously (it is detached and would otherwise outlive the app with the mic open). A lingering call.ts (already saved) is killed at once.
     *  A call that was not asked yet gets the stop command; it also stops by itself when its control pipe closes with the app. */
    shutdown: () => {
      if (doctorProc) killGroup(doctorProc, "SIGKILL");
      if (lingering) {
        const l = lingering;
        lingering = undefined;
        killGroup(l, "SIGKILL");
      }
      if (!child) return;
      const c = child;
      if (stopSentAt && clock() - stopSentAt > QUIT_GRACE_MS) {
        killGroup(c, "SIGKILL");
        return;
      }
      send("stop");
      if (!stopSentAt) stopSentAt = clock();
      st(() => killGroup(c, "SIGKILL"), 8000);
    },
    /** Appends a timestamped line to the controller log (no-op without `logPath`). */
    logLine,
  };
  return api;
}

module.exports = { createController, COMMANDS };
