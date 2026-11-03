"use strict";
// Local control channel for the Wingman menu-bar app, used by the `wingman` CLI (src/cli/).
// A Unix socket in ~/.config/wingman/run/ (folder 700, socket 600, owner only). Newline-delimited JSON, ONE request per connection:
//   -> {"v":1,"cmd":"start","args":{"noAi":false}}\n      <- {"ok":true,...}\n   or  {"ok":false,"code":"...","error":"..."}\n
// Safety:
//  * fixed allowlist of commands, every argument validated (types, lengths, no unknown keys); nothing is ever executed or interpolated;
//  * the file system is the authentication: the folder is 700 and the socket 600 and both must belong to this user, or the server
//    refuses to listen. Node has no peer-credential call (SO_PEERCRED / LOCAL_PEERCRED), so the uid of the peer cannot be checked in-process;
//  * start / practice / stop are rate limited;
//  * call content (transcript, cards) never travels on this socket and nothing the CLI sends is written to tray.log except the command name;
//  * keys are not reachable: there is no command that reads, sets or moves a key.
// No electron import: unit-tested in src/cli.test.ts with a real controller driven by a fake child process.
const nodeFs = require("node:fs");
const nodePath = require("node:path");
const nodeOs = require("node:os");
const nodeNet = require("node:net");

const MAX_LINE = 4096;
const READ_TIMEOUT_MS = 5000;
const MAX_CLIENTS = 8;
const RATE = { minGapMs: 1500, perMinute: 6 };

/** WINGMAN_CONTROL_SOCKET (tests) or ~/.config/wingman/run/control.sock */
function socketPath(env = process.env, os = nodeOs) {
  const e = env.WINGMAN_CONTROL_SOCKET;
  return e ? nodePath.resolve(e) : nodePath.join(os.homedir(), ".config", "wingman", "run", "control.sock");
}

const err = (code, error) => ({ ok: false, code, error });
const isObj = (o) => o && typeof o === "object" && !Array.isArray(o);
/** Arg validator for commands that take none: throws unless args is absent or {}. */
function noArgs(a) { if (a === undefined) return {}; if (!isObj(a) || Object.keys(a).length) throw new Error("this command takes no arguments"); return {}; }
/** Arg validator: rejects unknown keys, checks required/type/length. fields: { key: {type:"boolean"|"string", required?, min?, max?} }. Returns a clean copy. */
function shape(a, fields) {
  if (a === undefined) a = {};
  if (!isObj(a)) throw new Error("args must be an object");
  for (const k of Object.keys(a)) if (!(k in fields)) throw new Error(`unknown argument "${k}"`);
  const out = {};
  for (const [k, spec] of Object.entries(fields)) {
    const v = a[k];
    if (v === undefined) { if (spec.required) throw new Error(`"${k}" is required`); continue; }
    if (spec.type === "boolean" && typeof v !== "boolean") throw new Error(`"${k}" must be true or false`);
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
 * o.briefFile    path of latest.yaml (brief_refresh)
 * o.info         () => extra fields for ping/status (version, pid)
 */
function createControlServer(o) {
  const fs = o.fs || nodeFs, path = o.path || nodePath, net = o.net || nodeNet;
  const ctl = o.controller, lib = o.lib;
  const now = o.now || Date.now;
  const sockPath = o.socketPath || socketPath(o.env);
  const uid = o.uid !== undefined ? o.uid : (process.getuid ? process.getuid() : -1);
  const log = o.log || (() => {});
  const stamps = [];            // timestamps of rate-limited commands
  let server, clients = 0;

  /** Each handler returns {ok:true,...} or {ok:false,code,error}. */
  const refused = (error) => err("refused", error);
  const need = (cond, error) => (cond ? null : refused(error));
  const done = (ok, error) => (ok ? { ok: true, state: view() } : refused(error));
  /** Rate limit start/practice/stop: checked AFTER the state checks, so a refused command does not use up the budget. */
  const paced = (fn) => { const m = limited(); return m ? err("rate_limited", m) : fn(); };
  /** The state fields the CLI may see. Whitelisted by hand so no call content (transcript, cards) can leak onto the socket. */
  const view = () => {
    const s = ctl.getState();
    return { running: !!s.running, phase: s.phase, callId: s.callId || "", practice: !!s.practice, quiet: !!s.quiet, startedAt: s.startedAt || 0, liveAt: s.liveAt || 0, client: s.client || "", proposed: s.proposed || "", notes: s.notes | 0, briefReady: !!s.briefReady, stopPhase: s.stopPhase || "", askArmed: !!s.askArmed, askUntil: s.askArmed ? Number(s.askUntil) || 0 : 0, summarySkipped: !!s.summarySkipped, noAi: !!s.noAi };
  };

  // Allowlist: each entry validates its args (`args`) and then runs (`run`). `long` marks commands that may take a while (doctor).
  const COMMANDS = {
    ping: { args: noArgs, run: () => ({ ok: true, app: "wingman", ...(o.info ? o.info() : {}) }) },
    status: {
      args: noArgs,
      run: () => {
        const s = ctl.getState();
        return { ok: true, app: "wingman", ...(o.info ? o.info() : {}), state: view(), health: Object.entries(s.health || {}).map(([id, h]) => ({ id, level: h.level, text: h.text })), overlayDown: s.overlayDown || "", offReason: s.offReason || "", doctorRunning: !!s.doctorRunning, doctor: s.doctor || null, lastError: s.lastError ? String(s.lastError).slice(0, 200) : "", endedCleanly: !!s.endedCleanly, summaryOk: !!s.summaryOk };
      },
    },
    start: {
      args: (a) => shape(a, { noAi: { type: "boolean" } }),
      run: (a) => (ctl.isRunning() ? refused("A call is already running. Stop it first (wingman stop).") : paced(() => done(ctl.start({ noAi: !!a.noAi }), "Could not start a call."))),
    },
    practice: {
      args: noArgs,
      run: () => (ctl.isRunning() ? refused("A call is already running. Stop it first (wingman stop).") : paced(() => done(ctl.practice(), "Could not start a practice call."))),
    },
    consent: { args: noArgs, run: () => { const s = ctl.getState(); return need(ctl.isRunning() && s.phase === "waiting", "No call is waiting to start listening. This only applies when \"Ask me before listening starts\" is on.") || done(ctl.consent(), "Start listening was not accepted. Check wingman status."); } },
    quiet: { args: (a) => shape(a, { on: { type: "boolean", required: true } }), run: (a) => need(ctl.getState().phase === "live", "Quiet mode can only change while a call is live. Start a call first.") || done(ctl.setQuiet(a.on), "Could not change quiet mode.") },
    client: { args: noArgs, run: () => need(!!ctl.getState().proposed && !ctl.getState().client, "There is no proposed client to confirm. Wingman asks only after it spots one.") || done(ctl.confirmClient(), "Could not confirm the client.") },
    note: { args: (a) => shape(a, { text: { type: "string", required: true, min: 1, max: 2000 } }), run: (a) => need(ctl.isRunning() && ctl.getState().phase !== "stopping", "No call is running. Start one with wingman start.") || done(ctl.note(a.text), "The note was empty or not accepted.") },
    ask: { args: (a) => shape(a, { text: { type: "string", required: true, min: 1, max: 2000 } }), run: (a) => need(ctl.getState().phase === "live", "A question can only be asked while a call is live (wingman status shows the phase).") || done(ctl.ask(a.text), "The question was empty or not accepted.") },
    ask_listen: { args: noArgs, run: () => need(ctl.getState().phase === "live", "Only while a call is live.") || done(ctl.askWingman(), "Could not arm the ask window.") },
    stop: { args: (a) => shape(a, { noSummary: { type: "boolean" } }), run: (a) => need(ctl.isRunning() && ctl.getState().phase !== "stopping", "No call is running (or it is already stopping).") || paced(() => done(a.noSummary === true ? ctl.stopNoSummary() : ctl.stop(), "Could not stop the call.")) },
    stop_delete: {
      args: (a) => shape(a, { confirm: { type: "boolean", required: true } }),
      run: (a) => need(a.confirm === true, "Deleting needs confirm:true.") || need(ctl.isRunning() && ctl.getState().phase !== "stopping", "No call is running (or it is already stopping).") || paced(() => done(ctl.stopDelete(), "Could not stop and delete the call.")),
    },
    doctor: { long: true, args: (a) => shape(a, { offline: { type: "boolean" } }), run: async (a) => ({ ok: true, doctor: await ctl.runDoctor({ offline: !!a.offline }) }) },
    brief_refresh: { args: noArgs, run: () => { if (!ctl.isRunning()) ctl.boot(lib.briefReady(o.briefFile)); return { ok: true }; } },
  };

  /** Sliding 60 s window over start/stop-type commands. Returns "" and records the stamp if allowed, else a message. */
  function limited() {
    const t = now();
    while (stamps.length && t - stamps[0] > 60_000) stamps.shift();
    if (stamps.length && t - stamps[stamps.length - 1] < RATE.minGapMs) return `Too fast: wait ${Math.ceil(RATE.minGapMs / 1000)} s between start/stop commands.`;
    if (stamps.length >= RATE.perMinute) return `Too many start/stop commands (limit ${RATE.perMinute} per minute).`;
    stamps.push(t);
    return "";
  }

  /** One request line in, one response object out. Never throws. Exposed for tests. */
  async function handle(line) {
    let req;
    try { req = JSON.parse(line); } catch { return err("bad_request", "Not valid JSON."); }
    if (!isObj(req) || req.v !== 1 || typeof req.cmd !== "string") return err("bad_request", 'Expected {"v":1,"cmd":"..."}.');
    for (const k of Object.keys(req)) if (!["v", "cmd", "args"].includes(k)) return err("bad_request", `Unknown field "${k}".`);
    const spec = Object.prototype.hasOwnProperty.call(COMMANDS, req.cmd) ? COMMANDS[req.cmd] : undefined;
    if (!spec) return err("unknown_command", "Not a Wingman control command.");
    let args;
    try { args = spec.args(req.args); } catch (e) { return err("bad_args", e.message); }
    try {
      const r = await spec.run(args);
      log(`cli ${req.cmd} ${r && r.ok ? "ok" : (r && r.code) || "failed"}`);   // command name and result only, never arguments
      return r;
    } catch (e) { log(`cli ${req.cmd} error`); return err("internal", "The app could not run that command."); }
  }

  /** One request per connection: read up to the first newline, answer, close. Size, count and time limits stop a stuck or noisy client. */
  function onConnection(sock) {
    if (clients >= MAX_CLIENTS) { sock.end(JSON.stringify(err("busy", "Too many connections.")) + "\n"); return; }
    clients++;
    let buf = "", got = false;
    const finish = () => { clients--; };
    sock.once("close", finish);
    sock.on("error", () => { /* peer went away */ });
    sock.setEncoding("utf8");
    const timer = setTimeout(() => { if (!got) sock.destroy(); }, READ_TIMEOUT_MS);
    sock.on("data", (d) => {
      if (got) return;
      buf += d;
      if (buf.length > MAX_LINE * 2) { got = true; sock.end(JSON.stringify(err("too_large", "Request too large.")) + "\n"); return; }
      const i = buf.indexOf("\n");
      if (i < 0) return;
      got = true; clearTimeout(timer);
      const line = buf.slice(0, i);
      if (line.length > MAX_LINE * 2) { sock.end(JSON.stringify(err("too_large", "Request too large.")) + "\n"); return; }
      handle(line).then((r) => { try { sock.end(JSON.stringify(r) + "\n"); } catch { /* gone */ } });
    });
  }

  /** The run folder and any old socket must be ours, or we do not listen at all. */
  function prepare() {
    const dir = path.dirname(sockPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ds = fs.lstatSync(dir);
    if (!ds.isDirectory() || (uid >= 0 && ds.uid !== uid)) throw new Error("control folder is not owned by this user");
    if (ds.mode & 0o077) fs.chmodSync(dir, 0o700);
    // sun_path is about 104 bytes on macOS; longer paths fail to bind.
    if (sockPath.length > 100) throw new Error("socket path too long");
    let st; try { st = fs.lstatSync(sockPath); } catch { st = undefined; }
    if (st) {
      if (!st.isSocket() || (uid >= 0 && st.uid !== uid)) throw new Error("something else is at the control socket path");
      fs.rmSync(sockPath, { force: true });   // stale socket from a previous run (single instance lock is held by the caller)
    }
  }

  /** Prepares the folder, then listens. Resolves with the socket path; rejects if the folder or old socket is not ours. */
  function start() {
    return new Promise((resolve, reject) => {
      try { prepare(); } catch (e) { return reject(e); }
      server = net.createServer(onConnection);
      server.on("error", reject);
      const prev = process.umask(0o177);   // the socket is created 600 from the start, no window where others could connect
      server.listen(sockPath, () => {
        process.umask(prev);
        try { fs.chmodSync(sockPath, 0o600); } catch { /* best effort */ }
        resolve(sockPath);
      });
      server.once("error", () => { try { process.umask(prev); } catch { /* done */ } });
    });
  }
  /** Stops listening and removes the socket file. */
  function stop() {
    return new Promise((resolve) => {
      if (!server) return resolve();
      const s = server; server = undefined;
      s.close(() => resolve());
      try { fs.rmSync(sockPath, { force: true }); } catch { /* gone */ }
    });
  }
  return { start, stop, path: sockPath, handle, COMMANDS: Object.keys(COMMANDS) };
}

module.exports = { createControlServer, socketPath, MAX_LINE, RATE };
