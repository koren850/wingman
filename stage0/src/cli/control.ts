// Commands that drive the RUNNING app through its control socket: start, stop, consent, quiet, client, note, ask, app.
// They never spawn an engine themselves.
import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { call, appStatus, needApp, NO_APP_HINT, appProcessRunning } from "./client.ts";
import { CliError, EXIT, parse, usage, mmss, type Ctx, type Result } from "./common.ts";

const APP_PATH = "/Applications/Wingman.app";
const PHASE_TEXT: Record<string, string> = {
  starting: "starting", waiting: "waiting for your OK to start listening", live: "live and listening", stopping: "stopping and saving", idle: "no call",
};

async function waitFor(ctx: Ctx, ok: (s: any) => boolean, ms: number) {
  const end = Date.now() + ms; let last: any = null;
  while (Date.now() < end) {
    last = await appStatus(ctx);
    if (last && ok(last.state)) return last;
    await ctx.sleep(400);
  }
  return last;
}

export async function start(ctx: Ctx, args: string[]): Promise<Result> {
  const { values } = parse(args, { practice: { type: "boolean" }, "no-ai": { type: "boolean" }, "no-wait": { type: "boolean" } });
  if (values.practice && values["no-ai"]) throw usage("--practice is always offline with scripted answers; --no-ai does not apply.");
  await needApp(ctx);
  await call(ctx, values.practice ? "practice" : "start", values.practice ? undefined : { noAi: !!values["no-ai"] });
  const s = values["no-wait"] ? await appStatus(ctx) : await waitFor(ctx, (st) => st.phase !== "starting", 20_000);
  const st = s?.state ?? {};
  const consentNeeded = st.phase === "waiting";
  return {
    data: { started: true, practice: !!values.practice, noAi: !!values["no-ai"], phase: st.phase, callId: st.callId || "", consentNeeded },
    text: `Call started (${PHASE_TEXT[st.phase] ?? st.phase}).${st.callId ? ` id ${st.callId}` : ""}` +
      (consentNeeded ? "\n\"Ask me before listening starts\" is on: it listens after Dan clicks Start listening in the app, or (only if Dan asked) `wingman confirm --yes`." : "") +
      (st.phase === "starting" ? "\nStill starting. Check: wingman status" : ""),
  };
}

export async function stop(ctx: Ctx, args: string[]): Promise<Result> {
  const { values } = parse(args, { delete: { type: "boolean" }, yes: { type: "boolean" }, "no-wait": { type: "boolean" } });
  if (values.delete && !values.yes) throw new CliError("needs_yes", "`stop --delete` erases the whole call (transcript, cards, summary). Add --yes to confirm.", EXIT.NEEDS_YES);
  const before = await needApp(ctx);
  const callId = before.state.callId || "";
  await call(ctx, values.delete ? "stop_delete" : "stop", values.delete ? { confirm: true } : undefined);
  let s = before;
  if (!values["no-wait"]) s = (await waitFor(ctx, (st) => !st.running, 40_000)) ?? before;
  const done = !s.state.running;
  return {
    data: { stopped: true, finished: done, deleted: !!values.delete, callId: values.delete ? "" : callId, summaryReady: !!s.summaryOk },
    text: values.delete ? (done ? "Call stopped and deleted." : "Stopping and deleting the call...") : `Call stopped${done ? " and saved" : " (still saving; check wingman status)"}.${callId ? ` id ${callId}` : ""}${s.summaryOk ? "\nSummary ready: wingman calls summary " + callId : ""}`,
  };
}

export async function consent(ctx: Ctx, args: string[]): Promise<Result> {
  const { values } = parse(args, { yes: { type: "boolean" } });
  if (!values.yes) throw new CliError("needs_yes", "This starts listening on the waiting call. Only do it when Dan asked; then add --yes.", EXIT.NEEDS_YES);
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

/** True when this checkout's run.ts understands the `ask <text>` stdin command (another agent adds it). */
function engineHasAsk(ctx: Ctx): boolean {
  try { return /function askTyped/.test(readFileSync(join(ctx.root, "src", "run.ts"), "utf8")); } catch { return false; }
}

export async function ask(ctx: Ctx, args: string[]): Promise<Result> {
  const { values, positionals } = parse(args, { listen: { type: "boolean" } });
  if (values.listen) {   // the Ctrl+Opt+A key: Dan's next spoken sentence is a question for Wingman
    if (positionals.length) throw usage("--listen takes no question; it arms the microphone for Dan's next sentence.");
    await call(ctx, "ask_listen");
    return { data: { sent: true, kind: "ask-listen" }, text: "Listening: Dan's next sentence (within a few seconds) is treated as a question for Wingman." };
  }
  const t = await text(ctx, positionals, "ask");
  await call(ctx, "ask", { text: t });
  const supported = engineHasAsk(ctx);
  return {
    data: { sent: true, kind: "ask", engineSupportsAsk: supported },
    text: "Question sent to the live call (the answer appears as a card; read it with: wingman live)." + (supported ? "" : "\nWarning: this version of the call engine has no `ask` command yet, so the question may be ignored."),
  };
}

export async function app(ctx: Ctx, args: string[]): Promise<Result> {
  const { positionals } = parse(args, {});
  const sub = positionals[0] || "status";
  if (sub === "status") {
    const s = await appStatus(ctx);
    const proc = s ? true : await appProcessRunning(ctx);
    const hint = s ? "" : proc ? "The app is running but has no control socket: it was started before the CLI existed. Dan: Quit Wingman from the menu bar and open it again." : NO_APP_HINT;
    return { data: { running: !!s, controlSocket: !!s, processRunning: proc ?? null, pid: s?.pid ?? null, version: s?.version ?? "", hint }, text: s ? `Wingman app is running (pid ${s.pid}, control socket ok).` : `${proc ? "Wingman app process found, but no control socket." : "Wingman app is not running."}\n${hint}`, exit: s ? EXIT.OK : EXIT.NO_APP };
  }
  if (sub === "open") {
    if (await appStatus(ctx)) return { data: { running: true, opened: false }, text: "The Wingman app is already running." };
    if (await appProcessRunning(ctx)) throw new CliError("no_socket", "The Wingman app is running but has no control socket (started before the CLI existed).", EXIT.NO_APP, "Dan: Quit Wingman from the menu bar, then run `wingman app open` again.");
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
