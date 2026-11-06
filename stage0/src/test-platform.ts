// Shared helpers for tests that only make sense on some platforms. Not a test file itself (the glob is src/*.test.ts).
import assert from "node:assert/strict";
import { statSync } from "node:fs";

/** Pass as the options argument of test(): `test("name", MAC, () => ...)` skips off macOS with a clear reason. */
export const MAC = { skip: process.platform !== "darwin" && "macOS only" } as const;
/** For tests that need POSIX file modes or Unix sockets (not Windows). */
export const POSIX = { skip: process.platform === "win32" && "POSIX file modes / Unix sockets (not on Windows)" } as const;
/** For tests that need bash (the install scripts). */
export const BASH = { skip: process.platform === "win32" && "needs bash (not on Windows)" } as const;

/** Asserts a file's permission bits; Windows has no POSIX modes, so there it checks only that the path exists. */
export function assertMode(path: string, expected: number, message?: string) {
  const st = statSync(path);
  if (process.platform === "win32") return;
  assert.equal(st.mode & 0o777, expected, message);
}

import bin from "../shared/bin.cjs";
import { ROOT } from "./env.ts";
/** [command, args] of the local tsx for spawn / spawnSync / execFile: `spawn(...tsx([file, ...args]), opts)`. Works on Windows too (node + the tsx CLI). */
export function tsx(args: string[]): [string, string[]] {
  const t = bin.binCommand("tsx", args, ROOT);
  return [t.cmd, t.args];
}
