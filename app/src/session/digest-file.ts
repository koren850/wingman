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
  // A fact keeps the line of the pasted text it came from (digest.ts checked that it is really there). Shown next to the fact in the window.
  const facts = arr(r.facts).flatMap((x) => {
    const o = (x && typeof x === "object" ? x : {}) as { text?: unknown; source?: unknown; who?: unknown };
    const t = str(typeof x === "string" ? x : o.text, 300);
    if (!t) return [];
    const source = typeof x === "string" ? undefined : str(o.source, 300),
      who = typeof x === "string" ? undefined : str(o.who, 80);
    return [source || who ? { text: t, ...(who ? { who } : {}), ...(source ? { source } : {}) } : t];
  });
  // "Last time" facts (session/people.ts): plain strings and numbers only, at most 5.
  const past = arr(r.past).flatMap((x) => {
    const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const t = str(o.text, 300),
      who = str(o.who, 80);
    const at = typeof o.at === "number" && Number.isFinite(o.at) ? o.at : 0;
    return t && who ? [{ text: t, who, at, callId: str(o.callId, 60) ?? "", kind: o.kind === "promise" ? ("promise" as const) : ("topic" as const) }] : [];
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
    ...(past.length ? { past: past.slice(0, 5) } : {}),
  };
  return d.roster.length || d.agenda.length || d.facts.length || d.chunks.length || d.past?.length ? d : null;
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
