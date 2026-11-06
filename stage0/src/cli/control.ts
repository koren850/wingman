// Commands that drive the RUNNING app through its control socket: start, stop, consent, quiet, client, note, speaker, ask, app.
// They never spawn an engine themselves. Each sends one command over the owner-only control socket (tray/control-socket.cjs,
// through client.ts); the tray app owns the engine and applies its own checks and rate limits.
import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { call, appStatus, needApp, NO_APP_HINT, appProcessRunning } from "./client.ts";
import { CliError, EXIT, parse, usage, mmss, type Ctx, type Result } from "./common.ts";

const APP_PATH = "/Applications/Wingman.app";
const PHASE_TEXT: Record<string, string> = {
  starting: "starting", waiting: "waiting for your OK to start listening", live: "live and listening", stopping: "stopping and saving", idle: "no call",
};

/** A real start and a delete wait for the user's click in the app (the app gives up after 45 s). */
const CONFIRM_MS = 60_000;
const STOP_TEXT: Record<string, string> = { saving: "saving the call", summary: "writing the summary", done: "finishing" };

/** Polls the app status every 400 ms until ok(state) or `ms` passes. Returns the last status (null if the app vanished). */
async function waitFor(ctx: Ctx, ok: (s: any) => boolean, ms: number) {
  const end = Date.now() + ms; let last: any = null;
  while (Date.now() < end) {
    last = await appStatus(ctx);
    if (last && ok(last.state)) return last;
    await ctx.sleep(400);
  }
  return last;
}

/**
 * wingman start [--quick | --plan <id>] [--practice] [--no-ai] [--no-wait]
 * --quick: a call with NO Plan (never uses up a prepared meeting). --plan <id>: with that prepared meeting (used up when the call goes live).
 * Neither: the app decides safely. No prepared meetings = a quick call; exactly one meeting scheduled within 30 minutes of now = that one;
 * anything else is refused (exit 2) with the list, so a Plan is never picked by guesswork. --practice: offline pretend client; it uses the
 * given meeting, the next one when none is given, or none with --quick; it never uses a meeting up.
 */
export async function start(ctx: Ctx, args: string[]): Promise<Result> {
  const { values } = parse(args, { practice: { type: "boolean" }, "no-ai": { type: "boolean" }, "no-wait": { type: "boolean" }, quick: { type: "boolean" }, plan: { type: "string" } });
  if (values.practice && values["no-ai"]) throw usage("--practice is always offline with scripted answers; --no-ai does not apply.");
  if (values.quick && values.plan) throw usage("Choose one: --quick (no Plan) or --plan <id>.");
  if (values.plan !== undefined && !/^[A-Za-z0-9]{1,40}$/.test(values.plan)) throw usage("--plan needs a prepared meeting id (wingman plan list).");
  await needApp(ctx);
  const pick = { ...(values.quick ? { quick: true } : {}), ...(values.plan ? { planId: values.plan } : {}) };
  const reply = await call(ctx, values.practice ? "practice" : "start", values.practice ? (Object.keys(pick).length ? pick : undefined) : { noAi: !!values["no-ai"], ...pick }, values.practice ? undefined : CONFIRM_MS);
  const s = values["no-wait"] ? await appStatus(ctx) : await waitFor(ctx, (st) => st.phase !== "starting", 20_000);
  const st = s?.state ?? {};
  const consentNeeded = st.phase === "waiting";
  const plan = reply.plan ?? null, mode: string = reply.mode ?? (plan ? "plan" : "quick");
  return {
    data: { started: true, practice: !!values.practice, noAi: !!values["no-ai"], mode, plan, reason: reply.reason ?? "", phase: st.phase, callId: st.callId || "", consentNeeded },
    text: `Call started (${PHASE_TEXT[st.phase] ?? st.phase}).${st.callId ? ` id ${st.callId}` : ""}\n${plan ? `Plan: ${plan.name} [${plan.id}]` : "Quick call: no Plan."}` +
      (consentNeeded ? "\n\"Ask me before listening starts\" is on: it listens after the user clicks Start listening in the app, or (only if the user asked) `wingman confirm --yes`." : "") +
      (st.phase === "starting" ? "\nStill starting. Check: wingman status" : ""),
  };
}

export async function stop(ctx: Ctx, args: string[]): Promise<Result> {
  const { values } = parse(args, { delete: { type: "boolean" }, yes: { type: "boolean" }, "no-wait": { type: "boolean" }, "no-summary": { type: "boolean" } });
  if (values.delete && values["no-summary"]) throw usage("`--delete` already erases the call; --no-summary only makes sense for a call you keep.");
  if (values.delete && !values.yes) throw new CliError("needs_yes", "`stop --delete` erases the whole call (transcript, cards, summary). Add --yes to confirm.", EXIT.NEEDS_YES);
  const before = await needApp(ctx);
  const callId = before.state.callId || "";
  await call(ctx, values.delete ? "stop_delete" : "stop", values.delete ? { confirm: true } : values["no-summary"] ? { noSummary: true } : undefined, values.delete ? CONFIRM_MS : undefined);
  let s = before;
  if (!values["no-wait"]) s = (await waitFor(ctx, (st) => !st.running, 40_000)) ?? before;
  const done = !s.state.running;
  return {
    data: { stopped: true, finished: done, stopPhase: s.state.stopPhase || "", deleted: !!values.delete, callId: values.delete ? "" : callId, summaryReady: !!s.summaryOk, summarySkipped: !!values["no-summary"] },
    text: values.delete ? (done ? "Call stopped and deleted." : "Stopping and deleting the call...") : `Call stopped${done ? " and saved" : ` (still ${STOP_TEXT[s.state.stopPhase] ?? "saving"}; check wingman status)`}.${callId ? ` id ${callId}` : ""}${s.summaryOk ? "\nSummary ready: wingman calls summary " + callId : values["no-summary"] && callId ? "\nNo summary written. Later: wingman calls summary " + callId + " --generate" : ""}`,
  };
}

export async function consent(ctx: Ctx, args: string[]): Promise<Result> {
  const { values } = parse(args, { yes: { type: "boolean" } });
  if (!values.yes) throw new CliError("needs_yes", "This starts listening on the waiting call. Only do it when the user asked; then add --yes.", EXIT.NEEDS_YES);
  await call(ctx, "consent");
  return { data: { consented: true }, text: "Listening started." };
}

export async function quiet(ctx: Ctx, args: string[]): Promise<Result> {
  const { positionals } = parse(args, {});
  if (positionals.length !== 1 || !/^(on|off)$/.test(positionals[0])) throw usage("Usage: wingman quiet on|off");
  const on = positionals[0] === "on";
  await call(ctx, "quiet", { on });
  return { data: { quiet: on }, text: `Quiet mode ${on ? "on: cards are saved but not shown" : "off"}.` };
}

export async function client(ctx: Ctx, args: string[]): Promise<Result> {
  parse(args, {});
  const r = await call(ctx, "client");
  return { data: { confirmed: true, client: r.state?.proposed || "" }, text: `Client confirmed${r.state?.proposed ? `: ${r.state.proposed}` : ""}. The AI may now use their details.` };
}

async function text(ctx: Ctx, positionals: string[], what: string): Promise<string> {
  let t = positionals.join(" ");
  if (t === "-") t = await ctx.stdin();
  t = t.replace(/\s+/g, " ").trim();
  if (!t) throw usage(`Usage: wingman ${what} "<text>"   (or - to read it from stdin)`);
  if (t.length > 300) throw usage(`Too long (${t.length} characters): the limit is 300.`);
  return t;
}

export async function note(ctx: Ctx, args: string[]): Promise<Result> {
  const { positionals } = parse(args, {});
  const t = await text(ctx, positionals, "note");
  await call(ctx, "note", { text: t });
  return { data: { sent: true, kind: "note" }, text: "Note added for the AI." };
}

export async function speaker(ctx: Ctx, args: string[]): Promise<Result> {
  const { values, positionals } = parse(args, { clear: { type: "boolean" } });
  const bad = () => usage('Usage: wingman speaker <n> "<name>"   or   wingman speaker <n> --clear   (n = 1-20, as shown in the live view)');
  const [num, ...rest] = positionals;
  if (!num || !/^\d{1,2}$/.test(num)) throw bad();
  const n = Number(num);
  if (n < 1 || n > 20) throw bad();
  const name = rest.join(" ").replace(/\s+/g, " ").trim();
  if (values.clear ? !!name : !name) throw bad();
  if (name.length > 40) throw usage(`Name too long (${name.length} characters): the limit is 40.`);
  await call(ctx, "speaker", { spk: n, name });
  return { data: { sent: true, kind: "speaker", spk: n, name }, text: name ? `Speaker ${n} is now called ${name}.` : `Speaker ${n} name cleared.` };
}

/**
 * Compatibility check: does this checkout's call engine know the `ask <text>` stdin command? An older engine only knows bare
 * `ask` (the hotkey) and would ignore the text. Looks for askTyped() in the engine source (src/engine/me.ts; src/run.ts in older
 * checkouts). False if no file can be read.
 */
function engineHasAsk(ctx: Ctx): boolean {
  for (const f of ["engine/me.ts", "run.ts"]) {
    try { if (/function askTyped/.test(readFileSync(join(ctx.root, "src", f), "utf8"))) return true; } catch { /* not in this checkout: try the next file */ }
  }
  return false;
}

export async function ask(ctx: Ctx, args: string[]): Promise<Result> {
  const { values, positionals } = parse(args, { listen: { type: "boolean" } });
  if (values.listen) {   // the Ctrl+Opt+A key: the user's next spoken sentence is a question for Wingman
    if (positionals.length) throw usage("--listen takes no question; it arms the microphone for the user's next sentence.");
    await call(ctx, "ask_listen");
    return { data: { sent: true, kind: "ask-listen" }, text: "Listening: the user's next sentence (within a few seconds) is treated as a question for Wingman." };
  }
  const t = await text(ctx, positionals, "ask");
  await call(ctx, "ask", { text: t });
  const supported = engineHasAsk(ctx);
  return {
    data: { sent: true, kind: "ask", engineSupportsAsk: supported },
    text: "Question sent to the live call (the answer appears as a card; read it with: wingman live)." + (supported ? "" : "\nWarning: this version of the call engine has no `ask` command yet, so the question may be ignored."),
  };
}

/** wingman app status | open. `open` only runs when the user types it; the CLI never opens the app on its own. */
export async function app(ctx: Ctx, args: string[]): Promise<Result> {
  const { positionals } = parse(args, {});
  const sub = positionals[0] || "status";
  if (sub === "status") {
    const s = await appStatus(ctx);
    const proc = s ? true : await appProcessRunning(ctx);
    const hint = s ? "" : proc ? "The app is running but has no control socket: it was started before the CLI existed. User: quit Wingman from the menu bar and open it again." : NO_APP_HINT;
    return { data: { running: !!s, controlSocket: !!s, processRunning: proc ?? null, pid: s?.pid ?? null, version: s?.version ?? "", hint }, text: s ? `Wingman app is running (pid ${s.pid}, control socket ok).` : `${proc ? "Wingman app process found, but no control socket." : "Wingman app is not running."}\n${hint}`, exit: s ? EXIT.OK : EXIT.NO_APP };
  }
  if (sub === "open") {
    if (await appStatus(ctx)) return { data: { running: true, opened: false }, text: "The Wingman app is already running." };
    if (await appProcessRunning(ctx)) throw new CliError("no_socket", "The Wingman app is running but has no control socket (started before the CLI existed).", EXIT.NO_APP, "User: quit Wingman from the menu bar, then run `wingman app open` again.");
    const opener = ctx.openApp ?? (() => new Promise<void>((res, rej) => {
      if (!existsSync(APP_PATH)) return rej(new CliError("not_installed", `${APP_PATH} does not exist.`, EXIT.NOT_FOUND, "Run: pnpm make-app, then copy it to /Applications."));
      execFile("/usr/bin/open", [APP_PATH], { timeout: 10_000 }, (e) => (e ? rej(new CliError("open_failed", `Could not open the app: ${e.message}`, EXIT.FAIL)) : res()));
    }));
    await opener();
    for (let i = 0; i < 40; i++) { if (await appStatus(ctx)) return { data: { running: true, opened: true }, text: "Wingman app opened and ready." }; await ctx.sleep(500); }
    throw new CliError("timeout", "The app was opened but its control socket did not appear within 20 s.", EXIT.TIMEOUT, "Check wingman app status in a moment.");
  }
  throw usage("Usage: wingman app [status|open]");
}
