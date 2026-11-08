// The `ctx` record that goes into cards.jsonl: what a model call saw, so any card can be explained later.
import { createHash } from "node:crypto";
import type { Role } from "./budget.ts";

export type CtxRecord = {
  role: Role;
  /** memory version (SessionMemory.ver) the call saw */
  memV: number;
  /** estimated input tokens: always the sum of `parts` */
  tokens: number;
  parts: Record<string, number>;
  /** budget steps that cut something, in order, for example "retrieved", "rawTail" */
  trimmed: string[];
  /** hash of block A + block B (the cached prefix) */
  hash: string;
  /** hash of block A alone (equal across roles for the same profile and brief) */
  aHash: string;
  /** ids of the background chunks that were added */
  chunks: string[];
  /** the same chunks with a short label of their source (the file name), for the "what this card saw" view */
  sources: { id: string; src: string }[];
  /** characters sent, by script (ASCII, Hebrew, other): the input of the token calibration (context/calibration.ts) */
  chars: { ascii: number; hebrew: number; other: number };
};

export const shortHash = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 12);

export function makeRecord(o: {
  role: Role;
  memV: number;
  parts: Record<string, number>;
  trimmed: string[];
  a: string;
  b: string;
  chunks: string[];
  sources?: { id: string; src: string }[];
  chars?: { ascii: number; hebrew: number; other: number };
}): CtxRecord {
  const tokens = Object.values(o.parts).reduce((x, y) => x + y, 0);
  return {
    role: o.role,
    memV: o.memV,
    tokens,
    parts: { ...o.parts },
    trimmed: o.trimmed.slice(),
    hash: shortHash(o.a + "\u0000" + o.b),
    aHash: shortHash(o.a),
    chunks: o.chunks.slice(),
    sources: (o.sources ?? o.chunks.map((id) => ({ id, src: "file" }))).map((x) => ({ id: x.id, src: x.src })),
    chars: o.chars ? { ...o.chars } : { ascii: 0, hebrew: 0, other: 0 },
  };
}
