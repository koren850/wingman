// The user edits "What Wingman knows": change a line, remove a line, add a line. Pure apply plus a small file queue.
//   - The window validates the edit (shared/memedit.cjs), appends it to calls/<id>/user-edits.jsonl and never touches session.json.
//   - The engine (the one writer of session.json) drains that queue with `drainUserEdits`, applies each edit with `applyUserEdit`, saves.
//   - A removed line goes on a veto list, so the memory updater cannot add the same line back (applyPatch checks it).
//   - Edits are re-validated here. A bad row in the file is skipped, never fatal.
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, fstatSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { CAPS, enforceCaps } from "./caps.ts";
import { vetoKey } from "./patch.ts";
import type { AddList, SessionMemory } from "./types.ts";
import type { UserEdit } from "../../shared/memedit.d.cts";

const memedit = createRequire(import.meta.url)("../../shared/memedit.cjs") as typeof import("../../shared/memedit.d.cts");
export type { UserEdit };
export const USER_EDITS_FILE = "user-edits.jsonl";
const MAX_VETO = 40;

type Rec = Record<string, unknown> & { id: string };
const LIST_OF: Record<string, keyof SessionMemory> = {
  f: "facts",
  n: "numbers",
  c: "commitments",
  q: "openQuestions",
  d: "decisions",
  o: "objections",
  m: "mustCover",
  p: "roster",
};
/** The text field of each list: the one the user sees and edits. */
const TEXT_FIELD: Record<string, string> = { f: "text", n: "value", c: "what", q: "text", d: "text", o: "text", m: "text", p: "name" };
const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export type UserEditResult = { mem: SessionMemory; applied: boolean; reason?: string };

/** Applies one validated-again edit. Pure: the input memory is never changed; an edit that cannot apply returns the same object and a reason. */
export function applyUserEdit(mem: SessionMemory, raw: unknown, now: number): UserEditResult {
  const chk = memedit.validateEdit(raw);
  if (!chk.ok) return { mem, applied: false, reason: chk.reason };
  const e = chk.edit;
  const next = structuredClone(mem);
  const seq: Record<string, number> = { ...(mem.seq ?? {}) };
  if (e.op === "add") {
    const [prefix, listName] = (
      {
        facts: ["f", "facts"],
        decisions: ["d", "decisions"],
        openQuestions: ["q", "openQuestions"],
        commitments: ["c", "commitments"],
        mustCover: ["m", "mustCover"],
      } as const
    )[e.list];
    const arr = next[listName] as unknown as Rec[];
    const field = TEXT_FIELD[prefix];
    if (arr.some((it) => norm(String(it[field])) === norm(e.text))) return { mem, applied: false, reason: "already there" };
    const maxNow = arr.reduce((m, it) => Math.max(m, Number(it.id.slice(1)) || 0), 0);
    const id = `${prefix}${Math.max(seq[prefix] ?? 0, maxNow) + 1}`;
    seq[prefix] = Number(id.slice(1));
    const item: Record<string, unknown> =
      prefix === "f"
        ? { id, text: e.text, at: now, src: "user" }
        : prefix === "d"
          ? { id, text: e.text, at: now }
          : prefix === "q"
            ? { id, asker: "me", text: e.text, at: now, status: "open" }
            : prefix === "c"
              ? { id, who: "me", what: e.text, at: now, status: "open" }
              : { id, text: e.text, done: false };
    arr.push(item as Rec);
    const cap = (CAPS as Record<string, number>)[listName as string];
    if (arr.length > cap) return { mem, applied: false, reason: "list is full" };
  } else {
    const prefix = e.id[0];
    const arr = next[LIST_OF[prefix]] as unknown as Rec[];
    const i = arr.findIndex((it) => it.id === e.id);
    if (i < 0) return { mem, applied: false, reason: "unknown id" };
    if (e.op === "edit") {
      const field = TEXT_FIELD[prefix];
      if (String(arr[i][field]) === e.text) return { mem, applied: false, reason: "nothing to change" };
      // the old wording is what the user rejected: the updater must not bring it back as a second line
      if (["f", "d", "c", "q", "o", "n"].includes(prefix)) {
        const list = LIST_OF[prefix] as AddList;
        const k = vetoKey(list, arr[i]);
        next.vetoed = [...(mem.vetoed ?? []).filter((x) => x !== k), k].slice(-MAX_VETO);
      }
      arr[i][field] = e.text;
      if (prefix === "f") arr[i].src = "user";
    } else {
      const [gone] = arr.splice(i, 1);
      if (["f", "d", "c", "q", "o", "n"].includes(prefix)) {
        const list = LIST_OF[prefix] as AddList;
        const k = vetoKey(list, gone);
        next.vetoed = [...(mem.vetoed ?? []).filter((x) => x !== k), k].slice(-MAX_VETO);
      }
    }
  }
  const capped = enforceCaps(next);
  capped.seq = seq;
  capped.vetoed = next.vetoed ?? mem.vetoed;
  if (capped.vetoed === undefined) delete capped.vetoed;
  capped.ver = mem.ver + 1;
  capped.updatedAt = now;
  return { mem: capped, applied: true };
}

/** Window side: append one validated edit to the call's queue. Throws on a bad edit or an I/O error (the caller turns it into a message). */
export function queueUserEdit(callDir: string, raw: unknown, now = Date.now()): UserEdit {
  const chk = memedit.validateEdit(raw);
  if (!chk.ok) throw new Error(chk.reason);
  mkdirSync(callDir, { recursive: true, mode: 0o700 });
  appendFileSync(join(callDir, USER_EDITS_FILE), JSON.stringify({ at: now, edit: chk.edit }) + "\n", { mode: 0o600 });
  return chk.edit;
}

/** Engine side. Remembers how far it has read. `drain` returns the memory with every new edit applied (the same object when there is none). */
export class UserEditQueue {
  private off = 0;
  private carry: Buffer = Buffer.alloc(0);
  constructor(private callDir: string) {}
  drain(mem: SessionMemory, now: number): { mem: SessionMemory; applied: number; skipped: number } {
    let applied = 0,
      skipped = 0,
      cur = mem;
    for (const raw of this.readNew()) {
      let row: unknown;
      try {
        row = JSON.parse(raw);
      } catch {
        skipped++;
        continue;
      }
      const r = applyUserEdit(cur, row && typeof row === "object" ? (row as { edit?: unknown }).edit : null, now);
      if (r.applied) {
        cur = r.mem;
        applied++;
      } else skipped++;
    }
    return { mem: cur, applied, skipped };
  }
  private readNew(): string[] {
    let fd: number | undefined;
    try {
      fd = openSync(join(this.callDir, USER_EDITS_FILE), "r");
      const size = fstatSync(fd).size;
      if (size < this.off) {
        this.off = 0;
        this.carry = Buffer.alloc(0);
      }
      const n = Math.min(size - this.off, 256 * 1024);
      if (n <= 0) return [];
      const buf = Buffer.alloc(n);
      const got = readSync(fd, buf, 0, n, this.off);
      this.off += got;
      // cut at the last newline in bytes, so a character split across two reads is never decoded in halves
      const data = Buffer.concat([this.carry, buf.subarray(0, got)]);
      const nl = data.lastIndexOf(10);
      if (nl < 0) {
        this.carry = data.length > 20000 ? Buffer.alloc(0) : data;
        return [];
      }
      this.carry = data.subarray(nl + 1);
      return data
        .subarray(0, nl)
        .toString("utf8")
        .split("\n")
        .filter((l) => l.trim() && l.length < 20000);
    } catch {
      return [];
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}
