"use strict";
// Local control channel for the Wingman menu-bar app, used by the `wingman` CLI (src/cli/).
// A Unix socket in ~/.config/wingman/run/ (folder 700, socket 600, owner only). Newline-delimited JSON, ONE request per connection:
//   -> {"v":1,"cmd":"start","args":{"noAi":false}}\n      <- {"ok":true,...}\n   or  {"ok":false,"code":"...","error":"..."}\n
// Safety:
//  * fixed allowlist of commands, every argument validated (types, lengths, no unknown keys); nothing is ever executed or interpolated;
//  * the file system is the authentication: the folder is 700 and the socket 600 and both must belong to this user, or the server
//    refuses to listen. Node has no peer-credential call (SO_PEERCRED / LOCAL_PEERCRED), so the uid of the peer cannot be checked in-process;
//  * start / practice are rate limited (stop is not: a stop right after a start must always work);
//  * a call started from the command line asks for a native confirmation first (setting privacy.askBeforeCliStart, default on; `practice`
//    is exempt), and `stop_delete` ALWAYS asks, because any process of this user can reach the socket. The asking is done by o.confirm;
//    with no o.confirm, deleting is refused and starting is allowed only if o.askCliStart says the setting is off;
//  * call content (transcript, cards) never travels on this socket and nothing the CLI sends is written to tray.log except the command name;
//  * keys are not reachable: there is no command that reads, sets or moves a key.
// No electron import: unit-tested in src/cli.test.ts with a real controller driven by a fake child process.
const nodeFs = require("node:fs");
const nodePath = require("node:path");
const nodeOs = require("node:os");
const nodeNet = require("node:net");
const pipes = require("../shared/pipe.cjs");

const MAX_LINE = 4096;
const READ_TIMEOUT_MS = 5000;
const MAX_CLIENTS = 8;
const RATE = { minGapMs: 1500, perMinute: 6 };

/** The endpoint for a socket file path: the path itself on macOS/Linux; on Windows a pipe named after a hash of the path (tests, second profiles). */
function endpointFor(file, platform = process.platform) {
  if (!pipes.usesPipes(platform)) return nodePath.resolve(file);
  return pipes.pipeName("control-" + require("node:crypto").createHash("sha256").update(nodePath.resolve(file)).digest("hex").slice(0, 12));
}

/** WINGMAN_CONTROL_SOCKET (tests) or ~/.config/wingman/run/control.sock. On Windows: the named pipe \\.\pipe\wingman-<user>-control
 *  (with WINGMAN_CONTROL_SOCKET set, a pipe named after a hash of that path, so tests and second profiles stay apart). `platform` is injectable. */
function socketPath(env = process.env, os = nodeOs, platform = process.platform) {
  const e = env.WINGMAN_CONTROL_SOCKET;
  if (pipes.usesPipes(platform)) return e ? endpointFor(e, platform) : pipes.pipeName("control");
  return e ? nodePath.resolve(e) : nodePath.join(os.homedir(), ".config", "wingman", "run", "control.sock");
}

const err = (code, error) => ({ ok: false, code, error });
const isObj = (o) => o && typeof o === "object" && !Array.isArray(o);
/** Arg validator for commands that take none: throws unless args is absent or {}. */
function noArgs(a) {
  if (a === undefined) return {};
  if (!isObj(a) || Object.keys(a).length) throw new Error("this command takes no arguments");
  return {};
}
/** Arg validator: rejects unknown keys, checks required/type/length. fields: { key: {type:"boolean"|"string", required?, min?, max?} }. Returns a clean copy. */
function shape(a, fields) {
  if (a === undefined) a = {};
  if (!isObj(a)) throw new Error("args must be an object");
  for (const k of Object.keys(a)) if (!(k in fields)) throw new Error(`unknown argument "${k}"`);
  const out = {};
  for (const [k, spec] of Object.entries(fields)) {
    const v = a[k];
    if (v === undefined) {
      if (spec.required) throw new Error(`"${k}" is required`);
      continue;
    }
    if (spec.type === "boolean" && typeof v !== "boolean") throw new Error(`"${k}" must be true or false`);
    if (spec.type === "integer") {
      if (!Number.isInteger(v)) throw new Error(`"${k}" must be a whole number`);
      if (v < spec.min || v > spec.max) throw new Error(`"${k}" must be ${spec.min} to ${spec.max}`);
    }
    if (spec.type === "string") {
      if (typeof v !== "string") throw new Error(`"${k}" must be text`);
      if (v.length > (spec.max || 300) || v.length < (spec.min || 0)) throw new Error(`"${k}" must be ${spec.min || 0} to ${spec.max || 300} characters`);
    }
    out[k] = v;
  }
  return out;
}

/**
 * Builds the control server (does not listen until start()). Returns { start, stop, path, handle, COMMANDS }.
 * o.controller   tray/controller.cjs instance
 * o.lib          tray/lib.cjs
 * o.plans        prepared-meetings store (tray/plans.cjs): `start` and `practice` choose a meeting through it; brief_refresh re-reads it
 * o.info         () => extra fields for ping/status (version, pid)
 * o.askCliStart  async () => boolean: is "ask before a call started from the command line starts listening" on? (absent: off)
 * o.confirm      { start(), consent(), stopDelete() }: each Promise<boolean>, native dialogs (tray/lib.cjs confirmCliStart / confirmCliStopDelete)
 */
function createControlServer(o) {
  const fs = o.fs || nodeFs,
    path = o.path || nodePath,
    net = o.net || nodeNet;
  const ctl = o.controller;
  const now = o.now || Date.now;
  const platform = o.platform || process.platform;
  const onPipe = pipes.usesPipes(platform); // Windows: a named pipe, no folder, no file modes, no uid
  const sockPath = o.socketPath ? endpointFor(o.socketPath, platform) : socketPath(o.env, nodeOs, platform);
  const uid = o.uid !== undefined ? o.uid : process.getuid ? process.getuid() : -1;
  const log = o.log || (() => {});
  const Plans = require("../shared/plans.js");
  const plans = o.plans;
  const stamps = []; // timestamps of rate-limited commands (starts only)
  let server,
    clients = 0,
    asking = false;
  /** Runs one native confirmation at a time. Returns "" when the user agreed, else the refusal text. */
  async function ask(kind, fn) {
    if (!fn) return "This needs a confirmation in the Wingman app, which is not available here.";
    if (asking) return "Wingman is already waiting for your answer to another request from the command line.";
    asking = true;
    try {
      return (await fn()) === true
        ? ""
        : kind === "start"
          ? "Not started: it was not confirmed in the Wingman app."
          : kind === "consent"
            ? "Not started listening: it was not confirmed in the Wingman app."
            : "Not deleted: it was not confirmed in the Wingman app.";
    } catch {
      return "The confirmation could not be shown.";
    } finally {
      asking = false;
    }
  }

  /** Each handler returns {ok:true,...} or {ok:false,code,error}. */
  const refused = (error) => err("refused", error);
  const need = (cond, error) => (cond ? null : refused(error));
  const done = (ok, error) => (ok ? { ok: true, state: view() } : refused(error));
  /** Rate limit start/practice (never stop): checked AFTER the state checks, so a refused command does not use up the budget. */
  const paced = (fn) => {
    const m = limited();
    return m ? err("rate_limited", m) : fn();
  };
  /** The state fields the CLI may see. Whitelisted by hand so no call content (transcript, cards) can leak onto the socket. */
  const view = () => {
    const s = ctl.getState();
    return {
      running: !!s.running,
      phase: s.phase,
      callId: s.callId || "",
      practice: !!s.practice,
      quiet: !!s.quiet,
      startedAt: s.startedAt || 0,
      liveAt: s.liveAt || 0,
      client: s.client || "",
      proposed: s.proposed || "",
      notes: s.notes | 0,
      briefReady: !!s.briefReady,
      stopPhase: s.stopPhase || "",
      askArmed: !!s.askArmed,
      askUntil: s.askArmed ? Number(s.askUntil) || 0 : 0,
      summarySkipped: !!s.summarySkipped,
      noAi: !!s.noAi,
      planId: s.planId || "",
    };
  };

  /** The small public view of a meeting: id and names only, no notes or files. */
  const summary = (m) => (m ? { id: m.id, title: m.title, who: m.who, name: Plans.label(m), at: m.at || 0 } : null);
  /** Finds a ready meeting by id or unique prefix: { ok:true, meeting } or a coded refusal. */
  function findReady(idLike) {
    if (!plans) return err("not_found", "This app has no prepared meetings.");
    const r = plans.resolve(idLike);
    if (r.error === "ambiguous") return err("choose_plan", `That id matches more than one prepared meeting. ${listing()}`);
    if (!r.meeting) return err("not_found", `No such prepared meeting. ${listing()}`);
    if (r.meeting.status !== "ready") return refused("That prepared meeting was already used by a call. Prepare a new one or use --quick.");
    return { ok: true, meeting: r.meeting };
  }
  /** "Prepared meetings: id (name, time), ..." for hints. */
  function listing() {
    const l = plans ? plans.list() : [];
    if (!l.length) return "There are no prepared meetings.";
    return (
      "Prepared meetings: " +
      l
        .slice(0, 8)
        .map((m) => `${m.id} (${Plans.menuLabel(m, now())})`)
        .join("; ") +
      ". Use --quick for a call with no Plan, or --plan <id>."
    );
  }
  /**
   * Which Plan does a real start use? --quick: none. planId: that meeting. Neither (plain `wingman start`): no prepared meetings at all means a quick
   * call; exactly one meeting scheduled within 30 minutes of now is used; anything else is refused with the list ("choose_plan").
   */
  function resolveStart(a) {
    if (a.quick) return { ok: true, meeting: null, reason: "quick call requested" };
    if (a.planId) {
      const r = findReady(a.planId);
      return r.ok ? { ...r, reason: "chosen" } : r;
    }
    const all = plans ? plans.list() : [];
    if (!all.length) return { ok: true, meeting: null, reason: "no prepared meetings" };
    const due = plans.dueNow();
    if (due.length === 1) return { ok: true, meeting: due[0], reason: "the only meeting due within 30 minutes" };
    return err(
      "choose_plan",
      `${due.length ? "More than one prepared meeting is due now" : "A prepared meeting exists but none is due within 30 minutes"}, so Wingman will not guess. ${listing()}`,
    );
  }

  // Allowlist: each entry validates its args (`args`) and then runs (`run`). `long` marks commands that may take a while (doctor).
  const COMMANDS = {
    ping: { args: noArgs, run: () => ({ ok: true, app: "wingman", ...(o.info ? o.info() : {}) }) },
    status: {
      args: noArgs,
      run: () => {
        const s = ctl.getState();
        return {
          ok: true,
          app: "wingman",
          ...(o.info ? o.info() : {}),
          state: view(),
          health: Object.entries(s.health || {}).map(([id, h]) => ({ id, level: h.level, text: h.text })),
          overlayDown: s.overlayDown || "",
          offReason: s.offReason || "",
          doctorRunning: !!s.doctorRunning,
          doctor: s.doctor || null,
          lastError: s.lastError ? String(s.lastError).slice(0, 200) : "",
          endedCleanly: !!s.endedCleanly,
          summaryOk: !!s.summaryOk,
        };
      },
    },
    // start: quick (no Plan) or planId (a prepared meeting). With neither, the app decides safely (see resolveStart).
    start: {
      args: (a) => {
        const r = shape(a, { noAi: { type: "boolean" }, quick: { type: "boolean" }, planId: { type: "string", min: 1, max: 40 } });
        if (r.quick && r.planId) throw new Error('give either "quick" or "planId", not both');
        return r;
      },
      run: async (a) => {
        if (ctl.isRunning()) return refused("A call is already running. Stop it first (wingman stop).");
        const pick = resolveStart(a);
        if (!pick.ok) return pick;
        let must = true;
        try {
          must = o.askCliStart ? (await o.askCliStart()) !== false : false;
        } catch {
          must = true;
        }
        if (must) {
          const no = await ask("start", o.confirm && o.confirm.start);
          if (no) return refused(no);
          if (ctl.isRunning()) return refused("A call is already running. Stop it first (wingman stop).");
        }
        return paced(() => {
          const r = done(ctl.start({ noAi: !!a.noAi, planId: pick.meeting ? pick.meeting.id : "" }), "Could not start a call.");
          return r.ok ? { ...r, mode: pick.meeting ? "plan" : "quick", plan: summary(pick.meeting), reason: pick.reason } : r;
        });
      },
    },
    practice: {
      args: (a) => {
        const r = shape(a, { quick: { type: "boolean" }, planId: { type: "string", min: 1, max: 40 } });
        if (r.quick && r.planId) throw new Error('give either "quick" or "planId", not both');
        return r;
      },
      run: (a) => {
        if (ctl.isRunning()) return refused("A call is already running. Stop it first (wingman stop).");
        let m = null;
        if (a.planId) {
          const r = findReady(a.planId);
          if (!r.ok) return r;
          m = r.meeting;
        } else if (!a.quick && plans) m = plans.practiceDefault();
        return paced(() => {
          const r = done(ctl.practice(a.quick ? { quick: true } : m ? { planId: m.id } : { quick: true }), "Could not start a practice call.");
          return r.ok ? { ...r, mode: m ? "plan" : "quick", plan: summary(m) } : r;
        });
      },
    },
    consent: {
      args: noArgs,
      // A call is only in "waiting" when privacy.requireConsentAck is on, and this is the step that releases the audio. The socket is open to any
      // process of this user, so the acknowledgement must come from a human: it needs a native dialog in the Wingman app (a script cannot click it),
      // exactly like starting or deleting a call from the command line. The tray menu, the hotkey and the dashboard button do not go through here.
      run: async () => {
        const s = ctl.getState();
        const no =
          need(
            ctl.isRunning() && s.phase === "waiting",
            'No call is waiting to start listening. This only applies when "Ask me before listening starts" is on.',
          ) || (await ask("consent", o.confirm && o.confirm.consent));
        if (no) return typeof no === "string" ? refused(no) : no;
        return (
          need(ctl.isRunning() && ctl.getState().phase === "waiting", "The call is no longer waiting to start listening.") ||
          done(ctl.consent(), "Start listening was not accepted. Check wingman status.")
        );
      },
    },
    quiet: {
      args: (a) => shape(a, { on: { type: "boolean", required: true } }),
      run: (a) =>
        need(ctl.getState().phase === "live", "Quiet mode can only change while a call is live. Start a call first.") ||
        done(ctl.setQuiet(a.on), "Could not change quiet mode."),
    },
    client: {
      args: noArgs,
      run: () =>
        need(!!ctl.getState().proposed && !ctl.getState().client, "There is no proposed client to confirm. Wingman asks only after it spots one.") ||
        done(ctl.confirmClient(), "Could not confirm the client."),
    },
    note: {
      args: (a) => shape(a, { text: { type: "string", required: true, min: 1, max: 2000 } }),
      run: (a) =>
        need(ctl.isRunning() && ctl.getState().phase !== "stopping", "No call is running. Start one with wingman start.") ||
        done(ctl.note(a.text), "The note was empty or not accepted."),
    },
    speaker: {
      args: (a) => shape(a, { spk: { type: "integer", required: true, min: 1, max: 20 }, name: { type: "string", min: 0, max: 40 } }),
      run: (a) =>
        need(ctl.isRunning() && ctl.getState().phase !== "stopping", "No call is running. Start one with wingman start.") ||
        done(ctl.speaker(a.spk, a.name || ""), "The speaker number or name was not accepted."),
    },
    ask: {
      args: (a) => shape(a, { text: { type: "string", required: true, min: 1, max: 2000 } }),
      run: (a) =>
        need(ctl.getState().phase === "live", "A question can only be asked while a call is live (wingman status shows the phase).") ||
        done(ctl.ask(a.text), "The question was empty or not accepted."),
    },
    ask_listen: {
      args: noArgs,
      run: () => need(ctl.getState().phase === "live", "Only while a call is live.") || done(ctl.askWingman(), "Could not arm the ask window."),
    },
    stop: {
      args: (a) => shape(a, { noSummary: { type: "boolean" } }),
      run: (a) =>
        need(ctl.isRunning() && ctl.getState().phase !== "stopping", "No call is running (or it is already stopping).") ||
        (() => done(a.noSummary === true ? ctl.stopNoSummary() : ctl.stop(), "Could not stop the call."))(),
    },
    stop_delete: {
      args: (a) => shape(a, { confirm: { type: "boolean", required: true } }),
      run: async (a) => {
        const bad =
          need(a.confirm === true, "Deleting needs confirm:true.") ||
          need(ctl.isRunning() && ctl.getState().phase !== "stopping", "No call is running (or it is already stopping).");
        if (bad) return bad;
        const no = await ask("delete", o.confirm && o.confirm.stopDelete); // always asks: --yes on the command line is not enough
        if (no) return refused(no);
        return (
          need(ctl.isRunning() && ctl.getState().phase !== "stopping", "The call ended while the question was open.") ||
          done(ctl.stopDelete(), "Could not stop and delete the call.")
        );
      },
    },
    doctor: {
      long: true,
      args: (a) => shape(a, { offline: { type: "boolean" } }),
      run: async (a) => ({ ok: true, doctor: await ctl.runDoctor({ offline: !!a.offline }) }),
    },
    brief_refresh: {
      args: noArgs,
      run: () => {
        ctl.refreshPlans();
        return { ok: true };
      },
    }, // name kept for older CLIs: the prepared meetings changed on disk
  };

  /** Sliding 60 s window over start-type commands (start, practice). Returns "" and records the stamp if allowed, else a message. */
  function limited() {
    const t = now();
    while (stamps.length && t - stamps[0] > 60_000) stamps.shift();
    if (stamps.length && t - stamps[stamps.length - 1] < RATE.minGapMs) return `Too fast: wait ${Math.ceil(RATE.minGapMs / 1000)} s between start commands.`;
    if (stamps.length >= RATE.perMinute) return `Too many start commands (limit ${RATE.perMinute} per minute).`;
    stamps.push(t);
    return "";
  }

  /** One request line in, one response object out. Never throws. Exposed for tests. */
  async function handle(line) {
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      return err("bad_request", "Not valid JSON.");
    }
    if (!isObj(req) || req.v !== 1 || typeof req.cmd !== "string") return err("bad_request", 'Expected {"v":1,"cmd":"..."}.');
    for (const k of Object.keys(req)) if (!["v", "cmd", "args"].includes(k)) return err("bad_request", `Unknown field "${k}".`);
    const spec = Object.prototype.hasOwnProperty.call(COMMANDS, req.cmd) ? COMMANDS[req.cmd] : undefined;
    if (!spec) return err("unknown_command", "Not a Wingman control command.");
    let args;
    try {
      args = spec.args(req.args);
    } catch (e) {
      return err("bad_args", e.message);
    }
    try {
      const r = await spec.run(args);
      log(`cli ${req.cmd} ${r && r.ok ? "ok" : (r && r.code) || "failed"}`); // command name and result only, never arguments
      return r;
    } catch (e) {
      log(`cli ${req.cmd} error`);
      return err("internal", "The app could not run that command.");
    }
  }

  /** One request per connection: read up to the first newline, answer, close. Size, count and time limits stop a stuck or noisy client. */
  function onConnection(sock) {
    if (clients >= MAX_CLIENTS) {
      sock.end(JSON.stringify(err("busy", "Too many connections.")) + "\n");
      return;
    }
    clients++;
    let buf = "",
      got = false;
    const finish = () => {
      clients--;
    };
    sock.once("close", finish);
    sock.on("error", () => {
      /* peer went away */
    });
    sock.setEncoding("utf8");
    const timer = setTimeout(() => {
      if (!got) sock.destroy();
    }, READ_TIMEOUT_MS);
    sock.on("data", (d) => {
      if (got) return;
      buf += d;
      if (buf.length > MAX_LINE * 2) {
        got = true;
        sock.end(JSON.stringify(err("too_large", "Request too large.")) + "\n");
        return;
      }
      const i = buf.indexOf("\n");
      if (i < 0) return;
      got = true;
      clearTimeout(timer);
      const line = buf.slice(0, i);
      if (line.length > MAX_LINE * 2) {
        sock.end(JSON.stringify(err("too_large", "Request too large.")) + "\n");
        return;
      }
      handle(line).then((r) => {
        try {
          sock.end(JSON.stringify(r) + "\n");
        } catch {
          /* gone */
        }
      });
    });
  }

  /** The run folder and any old socket must be ours, or we do not listen at all. */
  function prepare() {
    if (onPipe) return; // the pipe name carries the user name; nothing on disk to check
    const dir = path.dirname(sockPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ds = fs.lstatSync(dir);
    if (!ds.isDirectory() || (uid >= 0 && ds.uid !== uid)) throw new Error("control folder is not owned by this user");
    if (ds.mode & 0o077) fs.chmodSync(dir, 0o700);
    // sun_path is about 104 bytes on macOS; longer paths fail to bind.
    if (sockPath.length > 100) throw new Error("socket path too long");
    let st;
    try {
      st = fs.lstatSync(sockPath);
    } catch {
      st = undefined;
    }
    if (st) {
      if (!st.isSocket() || (uid >= 0 && st.uid !== uid)) throw new Error("something else is at the control socket path");
      fs.rmSync(sockPath, { force: true }); // stale socket from a previous run (single instance lock is held by the caller)
    }
  }

  /** Prepares the folder, then listens. Resolves with the socket path; rejects if the folder or old socket is not ours. */
  function start() {
    return new Promise((resolve, reject) => {
      try {
        prepare();
      } catch (e) {
        return reject(e);
      }
      server = net.createServer(onConnection);
      server.on("error", reject);
      const prev = onPipe ? 0 : process.umask(0o177); // the socket is created 600 from the start, no window where others could connect
      server.listen(sockPath, () => {
        if (!onPipe) process.umask(prev);
        if (!onPipe)
          try {
            fs.chmodSync(sockPath, 0o600);
          } catch {
            /* best effort */
          }
        resolve(sockPath);
      });
      server.once("error", () => {
        try {
          if (!onPipe) process.umask(prev);
        } catch {
          /* done */
        }
      });
    });
  }
  /** Stops listening and removes the socket file. */
  function stop() {
    return new Promise((resolve) => {
      if (!server) return resolve();
      const s = server;
      server = undefined;
      s.close(() => resolve());
      if (!onPipe)
        try {
          fs.rmSync(sockPath, { force: true });
        } catch {
          /* gone */
        }
    });
  }
  return { start, stop, path: sockPath, handle, COMMANDS: Object.keys(COMMANDS) };
}

module.exports = { createControlServer, socketPath, endpointFor, MAX_LINE, RATE };
