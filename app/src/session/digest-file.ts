// The digest of a prepared meeting, kept next to the plan's brief.yaml as digest.json (mode 600).
//   The Wingman window's "Prepare" writes it (src/prepare-cli.ts). The engine reads it at the start of a call (readDigestNear(briefFile)) and seeds the memory.
//   Reading is strict and never throws: a missing, huge or broken file is "no digest", and the call starts with an empty memory as before.
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanText } from "./patch.ts";
import type { Digest } from "./seed.ts";

export const DIGEST_FILE = "digest.json";
const MAX_BYTES = 400_000;

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, n: number) => cleanText(v, n);

/** A digest from unknown JSON: only known fields, plain clipped strings, caps. Null when nothing useful is left. */
export function cleanDigest(raw: unknown): Digest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const roster = arr(r.roster).flatMap((p) => {
    const o = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
    const name = str(o.name, 80);
    if (!name) return [];
    const role = str(o.role, 80),
      stance = str(o.stance, 120);
    return [{ name, side: o.side === "me" ? ("me" as const) : ("them" as const), ...(role ? { role } : {}), ...(stance ? { stance } : {}) }];
  });
  const agenda = arr(r.agenda).flatMap((x) => str(typeof x === "string" ? x : (x as { text?: unknown } | null)?.text, 200) ?? []);
  const facts = arr(r.facts).flatMap((x) => {
    const t = str(typeof x === "string" ? x : (x as { text?: unknown } | null)?.text, 300);
    return t ? [t] : [];
  });
  const likelyQuestions = arr(r.likelyQuestions).flatMap((x) => {
    const q = str(typeof x === "string" ? x : (x as { q?: unknown } | null)?.q, 200);
    return q ? [{ q }] : [];
  });
  const chunks = arr(r.chunks).flatMap((x) => {
    const t = str(typeof x === "string" ? x : (x as { text?: unknown } | null)?.text, 4000);
    return t ? [{ text: t }] : [];
  });
  const d: Digest = {
    roster: roster.slice(0, 20),
    agenda: agenda.slice(0, 20),
    facts: facts.slice(0, 30),
    likelyQuestions: likelyQuestions.slice(0, 20),
    chunks: chunks.slice(0, 40),
  };
  return d.roster.length || d.agenda.length || d.facts.length || d.chunks.length ? d : null;
}

export const digestFileNear = (briefFile: string): string => join(dirname(briefFile), DIGEST_FILE);

/** The digest saved next to a brief file, or undefined. */
export function readDigestNear(briefFile: string | undefined): Digest | undefined {
  if (!briefFile) return undefined;
  try {
    const f = digestFileNear(briefFile);
    if (!existsSync(f) || statSync(f).size > MAX_BYTES) return undefined;
    return cleanDigest(JSON.parse(readFileSync(f, "utf8"))) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Atomic write. Throws on an I/O error. */
export function writeDigestFile(file: string, d: Digest): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(d), { mode: 0o600 });
  renameSync(tmp, file);
}
