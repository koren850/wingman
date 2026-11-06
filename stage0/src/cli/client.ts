// Client for the app's control socket (tray/control-socket.cjs). One JSON line out, one JSON line back.
// The socket is owner-only (mode 600); ownSocket() below also checks that the file is a socket owned by this user
// before connecting, so a planted file at that path is never trusted.
import net from "node:net";
import { lstatSync } from "node:fs";
import { execFile } from "node:child_process";
import { CliError, EXIT, type Ctx } from "./common.ts";

export const NO_APP_MESSAGE = "The Wingman app is not running (or has not been restarted since the CLI was added).";
export const NO_APP_HINT = "Ask the user to open the Wingman app, or run `wingman app open` (it opens /Applications/Wingman.app; the CLI never does that by itself).";

/** Is a Wingman app process alive? Only checked when the socket is the default one (tests set their own socket). */
export function appProcessRunning(ctx: Ctx): Promise<boolean | undefined> {
  if (ctx.env.WINGMAN_CONTROL_SOCKET) return Promise.resolve(undefined);
  return new Promise((res) => execFile("pgrep", ["-f", "Wingman.app/Contents/MacOS/Wingman"], { timeout: 3000 }, (e, out) => res(e ? ((e as { code?: unknown }).code === 1 ? false : undefined) : String(out).trim().length > 0)));
}

// True only for a real socket owned by the current user.
function ownSocket(path: string) {
  let st; try { st = lstatSync(path); } catch { return false; }
  return st.isSocket() && (!process.getuid || st.uid === process.getuid());
}

/** The app's answer. ok=false carries `code` and `error` (refused, rate_limited, bad_args...). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the app's JSON reply: extra fields differ per command and are read by the callers that know them
export type Reply = { ok: boolean; code?: string; error?: string; [k: string]: any };

/** Raw request. Rejects with CliError(NO_APP) when nothing listens. A refusal from the app comes back as a normal reply with ok:false. */
export function request(ctx: Ctx, cmd: string, args?: Record<string, unknown>, timeoutMs = 10_000): Promise<Reply> {
  return new Promise((resolve, reject) => {
    if (!ownSocket(ctx.socket)) return reject(new CliError("app_not_running", NO_APP_MESSAGE, EXIT.NO_APP, NO_APP_HINT));
    const s = net.createConnection(ctx.socket);
    let buf = "", settled = false;
    const fail = (e: CliError) => { if (!settled) { settled = true; s.destroy(); reject(e); } };
    const timer = setTimeout(() => fail(new CliError("timeout", `The app did not answer ${cmd} in ${Math.round(timeoutMs / 1000)} s.`, EXIT.TIMEOUT)), timeoutMs);
    s.setEncoding("utf8");
    s.on("connect", () => s.write(JSON.stringify({ v: 1, cmd, ...(args ? { args } : {}) }) + "\n"));
    s.on("data", (d) => { buf += d; });
    s.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (e.code === "ENOENT" || e.code === "ECONNREFUSED") fail(new CliError("app_not_running", NO_APP_MESSAGE, EXIT.NO_APP, NO_APP_HINT));
      else fail(new CliError("socket_error", `Cannot talk to the app: ${e.code || e.message}`, EXIT.FAIL));
    });
    s.on("close", () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      try { resolve(JSON.parse(buf.split("\n")[0])); } catch { reject(new CliError("bad_reply", "The app sent an unreadable answer.", EXIT.FAIL)); }
    });
  });
}

// App refusal code -> CLI exit code.
const REPLY_EXIT: Record<string, number> = { refused: EXIT.REFUSED, rate_limited: EXIT.RATE_LIMITED, bad_args: EXIT.USAGE, bad_request: EXIT.USAGE, choose_plan: EXIT.USAGE, not_found: EXIT.NOT_FOUND, unknown_command: EXIT.FAIL };

/** request() that turns a refusal into a CliError with the right exit code. */
export async function call(ctx: Ctx, cmd: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<Reply> {
  const r = await request(ctx, cmd, args, timeoutMs);
  if (!r.ok) throw new CliError(r.code || "failed", r.error || "The app refused the command.", REPLY_EXIT[r.code || ""] ?? EXIT.FAIL, r.code === "choose_plan" ? "Pick one: wingman start --quick (no Plan) or wingman start --plan <id> (wingman plan list shows the ids)." : "");
  return r;
}

/** App status, or null when the app is not running. */
export async function appStatus(ctx: Ctx): Promise<Reply | null> {
  try { return await call(ctx, "status"); } catch (e) { if (e instanceof CliError && e.code === "app_not_running") return null; throw e; }
}
/** Like appStatus() but throws NO_APP when the app is not running. */
export async function needApp(ctx: Ctx): Promise<Reply> {
  const s = await appStatus(ctx);
  if (!s) throw new CliError("app_not_running", NO_APP_MESSAGE, EXIT.NO_APP, NO_APP_HINT);
  return s;
}
