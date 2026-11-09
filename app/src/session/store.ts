// Saves and loads calls/<id>/session.json.
//   - Atomic: write a temp file in the same folder, then rename over session.json. A kill mid-write leaves the old file whole.
//   - Mode 600 (the file holds what was said on a call).
//   - The last good file is kept as session.prev.json. A file that fails the schema check is moved to session.bad and the
//     load falls back to prev, then to an empty memory. A call never fails to start because of this file.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, openSync, fsyncSync, closeSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CAPS } from "./caps.ts";
import { emptyMemory, KINDS, type SessionMemory } from "./types.ts";

export const SESSION_FILE = "session.json";
const PREV = "session.prev.json";
const BAD = "session.bad";

export type LoadResult = { mem: SessionMemory; status: "ok" | "missing" | "recovered" | "corrupt"; detail?: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => typeof v === "string";
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const optStr = (v: unknown) => v === undefined || str(v);
const ID = /^[a-z][1-9]\d{0,5}$/;

/** Schema check of a parsed file. Returns the memory (as is) or a reason. Strict about types, lenient about extra keys. */
export function checkMemory(raw: unknown): { ok: true; mem: SessionMemory } | { ok: false; reason: string } {
  if (!isObj(raw)) return { ok: false, reason: "not an object" };
  if (raw.v !== 1) return { ok: false, reason: "unknown version" };
  if (!num(raw.updatedAt) || !num(raw.ver)) return { ok: false, reason: "bad updatedAt or ver" };
  if (!(KINDS as readonly string[]).includes(raw.kind as string)) return { ok: false, reason: "bad kind" };
  if (raw.kindLocked !== undefined && typeof raw.kindLocked !== "boolean") return { ok: false, reason: "bad kindLocked" };
  if (raw.modeId !== undefined && (!str(raw.modeId) || (raw.modeId as string).length > 24)) return { ok: false, reason: "bad modeId" };
  if (!isObj(raw.topic) || !str(raw.topic.now) || !Array.isArray(raw.topic.history)) return { ok: false, reason: "bad topic" };
  for (const h of raw.topic.history) if (!isObj(h) || !str(h.label) || !num(h.from)) return { ok: false, reason: "bad topic history" };
  if (!str(raw.summary)) return { ok: false, reason: "bad summary" };
  const lists: [string, (it: Record<string, unknown>) => boolean, number][] = [
    ["roster", (i) => str(i.name) && (i.side === "me" || i.side === "them") && optStr(i.role) && optStr(i.stance), CAPS.roster],
    ["facts", (i) => str(i.text) && optStr(i.who) && num(i.at) && (i.src === "brief" || i.src === "call" || i.src === "user" || i.src === "past"), CAPS.facts],
    ["numbers", (i) => str(i.what) && str(i.value) && optStr(i.who) && num(i.at), CAPS.numbers],
    ["commitments", (i) => str(i.who) && str(i.what) && optStr(i.due) && num(i.at) && (i.status === "open" || i.status === "done"), CAPS.commitments],
    [
      "openQuestions",
      (i) => str(i.asker) && optStr(i.to) && str(i.text) && num(i.at) && ["open", "answered", "dropped"].includes(i.status as string),
      CAPS.openQuestions,
    ],
    ["decisions", (i) => str(i.text) && num(i.at), CAPS.decisions],
    ["objections", (i) => str(i.who) && str(i.text) && num(i.at) && typeof i.handled === "boolean", CAPS.objections],
    ["mustCover", (i) => str(i.text) && typeof i.done === "boolean", CAPS.mustCover],
  ];
  for (const [name, ok, cap] of lists) {
    const a = raw[name];
    if (!Array.isArray(a)) return { ok: false, reason: `${name} is not an array` };
    if (a.length > cap) return { ok: false, reason: `${name} is over its cap` };
    const ids = new Set<string>();
    for (const it of a) {
      if (!isObj(it) || !str(it.id) || !ID.test(it.id) || ids.has(it.id) || !ok(it)) return { ok: false, reason: `bad item in ${name}` };
      ids.add(it.id);
    }
  }
  if (raw.seq !== undefined && (!isObj(raw.seq) || Object.values(raw.seq).some((n) => !Number.isInteger(n) || (n as number) < 0 || (n as number) > 999990)))
    return { ok: false, reason: "bad seq" };
  if (raw.vetoed !== undefined && (!Array.isArray(raw.vetoed) || raw.vetoed.length > 40 || raw.vetoed.some((x) => !str(x))))
    return { ok: false, reason: "bad vetoed" };
  return { ok: true, mem: raw as unknown as SessionMemory };
}

/** The file ops the store uses, replaceable in tests (to simulate a crash between the write and the rename). */
export type Fs = { write: (p: string, data: string) => void; rename: (a: string, b: string) => void };
const realFs: Fs = {
  write(p, data) {
    writeFileSync(p, data, { mode: 0o600 });
    const fd = openSync(p, "r+"); // Windows refuses fsync on a read-only handle (EPERM)
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  rename: renameSync,
};

let counter = 0;
/** Writes the memory atomically. Throws on a real I/O error (the caller logs it; the call goes on). */
export function saveMemory(callDir: string, mem: SessionMemory, fs: Fs = realFs): void {
  mkdirSync(callDir, { recursive: true, mode: 0o700 });
  const file = join(callDir, SESSION_FILE);
  const tmp = join(callDir, `${SESSION_FILE}.${process.pid}-${++counter}.tmp`);
  try {
    fs.write(tmp, JSON.stringify(mem));
    if (existsSync(file)) {
      try {
        copyFileSync(file, join(callDir, PREV));
      } catch {}
    }
    fs.rename(tmp, file);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    throw e;
  }
}

const tryRead = (f: string): { mem?: SessionMemory; reason?: string } => {
  let txt: string;
  try {
    txt = readFileSync(f, "utf8");
  } catch (e) {
    return { reason: (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : `unreadable: ${(e as Error).message}` };
  }
  try {
    const c = checkMemory(JSON.parse(txt));
    return c.ok ? { mem: c.mem } : { reason: c.reason };
  } catch (e) {
    return { reason: `not JSON: ${(e as Error).message}` };
  }
};

/** Removes temp files that a killed write left behind. */
function sweepTmp(callDir: string): void {
  try {
    for (const n of readdirSync(callDir)) if (n.startsWith(SESSION_FILE + ".") && n.endsWith(".tmp")) rmSync(join(callDir, n), { force: true });
  } catch {}
}

/** Loads the memory. Never throws. A corrupt file is moved to session.bad; the last good copy is used, else an empty memory. */
export function loadMemory(callDir: string, now = 0): LoadResult {
  sweepTmp(callDir);
  const file = join(callDir, SESSION_FILE);
  const main = tryRead(file);
  if (main.mem) return { mem: main.mem, status: "ok" };
  if (main.reason === "missing") {
    const prev = tryRead(join(callDir, PREV));
    if (prev.mem) return { mem: prev.mem, status: "recovered", detail: "session.json missing, used the previous copy" };
    return { mem: emptyMemory(now), status: "missing" };
  }
  try {
    renameSync(file, join(callDir, BAD));
  } catch {}
  const prev = tryRead(join(callDir, PREV));
  if (prev.mem) return { mem: prev.mem, status: "recovered", detail: `session.json was bad (${main.reason}), used the previous copy` };
  return { mem: emptyMemory(now), status: "corrupt", detail: main.reason };
}
