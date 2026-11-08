// Shared pieces of the `wingman` CLI: exit codes, errors, argument parsing, paths, and the existing CommonJS modules it reuses.
// Ctx carries the control socket path (tray/control-socket.cjs) and injectable hooks so tests never touch the real app.
import { createRequire } from "node:module";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { resolve } from "node:path";
import { ROOT, CALLS, BRIEFS } from "../env.ts";

const req = createRequire(import.meta.url);
export const trayLib = req("../../tray/lib.cjs");
export const dataLib = req("../../dashboard/lib.cjs");
export const feedLib = req("../../dashboard/livefeed.js");
export const attachments = req("../../tray/attachments.cjs");
export const plansLib = req("../../tray/plans.cjs");
export const Plans = req("../../shared/plans.js");
export const catalog = req("../../tray/settings-catalog.cjs");
export const controlSocket = req("../../tray/control-socket.cjs") as { socketPath(env?: NodeJS.ProcessEnv): string };

/** Exit codes. Documented in `wingman help`. */
export const EXIT = { OK: 0, FAIL: 1, USAGE: 2, NO_APP: 3, REFUSED: 4, NOT_FOUND: 5, NEEDS_YES: 6, NOT_READY: 7, RATE_LIMITED: 8, TIMEOUT: 9 } as const;

/** A failure with a stable `code` (for --json), an exit code and an optional next-step `hint`. */
export class CliError extends Error {
  constructor(
    public code: string,
    message: string,
    public exit: number,
    public hint = "",
  ) {
    super(message);
  }
}
export const usage = (m: string) => new CliError("usage", m, EXIT.USAGE, "Run: wingman help");

/** What a command returns: data for --json, text for humans, optional non-zero exit. data.streamed = output already written. */
export type Result = { data: Record<string, unknown>; text: string; exit?: number };

/** Everything a command needs from its environment. Paths honour WINGMAN_* env overrides (tests). */
export interface Ctx {
  env: NodeJS.ProcessEnv;
  json: boolean;
  out: (s: string) => void; // raw stdout line(s), used by streaming commands
  root: string;
  calls: string;
  briefs: string;
  socket: string;
  userSettings: string | undefined;
  sleep: (ms: number) => Promise<void>;
  stdin: () => Promise<string>;
  /** Tests inject these. */
  keychain?: unknown;
  /** Home folder for the attachment refusals; production leaves it unset (the passwd entry is used, never $HOME). */
  home?: string;
  openApp?: () => Promise<void>;
  /** Audio devices for `wingman diagnose`; tests inject a fixed list. */
  devices?: () => Promise<{ name: string; transport: string; defaultInput: boolean; defaultOutput: boolean }[]>;
  /** Tests inject these for `wingman lookup`: the fetch and the DNS lookup of the reader. Production leaves them unset. */
  lookupFetch?: typeof fetch;
  lookupDns?: (host: string, o: { all: true }) => Promise<{ address: string; family: number }[]>;
  spawnTsx?: (args: string[], timeoutMs: number) => Promise<{ code: number; out: string }>;
  signal?: AbortSignal;
}

/** Real-process Ctx; `over` replaces any field. */
export function makeCtx(env: NodeJS.ProcessEnv, over: Partial<Ctx> = {}): Ctx {
  return {
    env,
    json: false,
    out: (s) => process.stdout.write(s),
    root: ROOT,
    calls: env.WINGMAN_CALLS_DIR ? resolve(env.WINGMAN_CALLS_DIR) : CALLS,
    briefs: env.WINGMAN_BRIEFS_DIR ? resolve(env.WINGMAN_BRIEFS_DIR) : BRIEFS,
    socket: controlSocket.socketPath(env),
    userSettings: env.WINGMAN_USER_SETTINGS || undefined,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    // Reads all of stdin, stopping after about 400 KB so a runaway pipe cannot fill memory.
    stdin: async () => {
      let s = "";
      process.stdin.setEncoding("utf8");
      for await (const c of process.stdin) {
        s += c;
        if (s.length > 400_000) break;
      }
      return s;
    },
    ...over,
  };
}

/** Strict option parsing; any problem is a usage error (exit 2). */
export function parse<T extends ParseArgsConfig["options"]>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw usage((e as Error).message.replace(/\. To specify.*$/, ""));
  }
}

/** m:ss from ms (shared with the tray). */
export const mmss = (ms: number) => trayLib.mmss(ms) as string;
export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
export const ago = (ms: number) => {
  const m = Math.round(ms / 60000);
  return m < 1 ? "just now" : m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
};
