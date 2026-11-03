// wingman <command>: command line for Wingman. See help.ts for the agent-facing manual.
// Dispatches to the command modules. Commands that act on a call talk to the running tray app over its owner-only control
// socket (tray/control-socket.cjs, via client.ts); plan, live, calls and settings read and write files directly.
//   pnpm wingman <command>    or    scripts/wingman-cli.sh <command>
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { CliError, EXIT, makeCtx, usage, type Ctx, type Result } from "./common.ts";
import { HELP } from "./help.ts";
import { start, stop, consent, quiet, client, note, speaker, ask, app } from "./control.ts";
import { status, doctor, keys } from "./status.ts";
import { plan } from "./plan.ts";
import { calls } from "./calls.ts";
import { settings } from "./settings-cmd.ts";
import { live } from "./live.ts";

type Cmd = (ctx: Ctx, args: string[]) => Promise<Result>;
const COMMANDS: Record<string, Cmd> = {
  status, doctor, plan, prepare: plan, start, stop, consent, confirm: consent, client, quiet, note, speaker, ask, live, calls, settings, keys, app,
  help: async (_c, a) => ({ data: { help: HELP }, text: HELP.trimEnd() + (a.length ? "" : "") }),
};

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");

/** Runs one command line. Returns the exit code. `out`/`err` receive finished lines. */
export async function main(argv: string[], over: Partial<Ctx> & { err?: (s: string) => void; env?: NodeJS.ProcessEnv } = {}): Promise<number> {
  const err = over.err ?? ((s: string) => process.stderr.write(s));
  const json = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");
  const ctx = makeCtx(over.env ?? process.env, { ...over, json });
  const fail = (e: CliError) => {
    if (json) ctx.out(JSON.stringify({ ok: false, error: { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) } }) + "\n");
    else err(`wingman: ${e.message}\n${e.hint ? e.hint + "\n" : ""}`);
    return e.exit;
  };
  try {
    let name = args[0];
    if (!name || name === "-h" || name === "--help") name = "help";
    const cmd = Object.prototype.hasOwnProperty.call(COMMANDS, name) ? COMMANDS[name] : undefined;
    if (!cmd) throw usage(`Unknown command "${stripAnsi(name).slice(0, 40)}".`);
    const rest = args[0] === name ? args.slice(1) : [];
    // `wingman <cmd> --help` prints the manual instead of running the command.
    if (name !== "help" && (rest.includes("-h") || rest.includes("--help"))) return (await main(["help", ...(json ? ["--json"] : [])], over), 0);
    const r = await cmd(ctx, rest);
    // Streaming commands (live --follow) already wrote their output through ctx.out.
    if (!r.data.streamed) ctx.out(json ? JSON.stringify({ ok: !r.exit, ...(r.exit ? { exit: r.exit } : {}), ...r.data }) + "\n" : r.text + "\n");
    return r.exit ?? EXIT.OK;
  } catch (e) {
    if (e instanceof CliError) return fail(e);
    return fail(new CliError("internal", `Unexpected error: ${stripAnsi(String((e as Error).message || e)).slice(0, 200)}`, EXIT.FAIL));
  }
}

// Run only when executed directly (the file is also imported by tests). realpath so a symlinked launcher still counts.
const isMain = (() => { try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  const ac = new AbortController();
  process.on("SIGINT", () => ac.abort());
  process.on("SIGTERM", () => ac.abort());
  main(process.argv.slice(2), { signal: ac.signal }).then((c) => { process.exitCode = c; }, (e) => { console.error(e); process.exitCode = 1; });
}
