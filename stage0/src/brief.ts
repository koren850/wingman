// Prepared start: a 1-minute briefing before the meeting. Loaded by run.ts at startup; also a small interactive CLI (below).
//   pnpm brief            asks 4 short questions and saves data/private/briefs/latest.yaml
//   pnpm call / start     (run.ts) loads a brief saved in the last 6 hours (or --brief <file>; --no-brief skips it)
// The brief becomes the user's notes for the AI, and its must-cover items become reminders during the call.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { DATA } from "./env.ts";
import { tokens } from "./normalize.ts";

/** What the user typed before the call. `mustCover` items are checked against the transcript with covered(). */
export type Brief = { planId?: string; title?: string; who?: string; goal?: string; notes?: string[]; mustCover?: string[]; createdAt?: string };
export const BRIEF_DIR = join(DATA, "private", "briefs");

const TERM_STOP = new Set(["hr", "call", "interview", "round", "meeting", "with", "and", "the", "of", "for", "team", "lead", "screen", "phone", "intro", "manager", "or", "a", "an", "to", "on", "in", "שיחה", "ראיון", "עם", "של", "פגישה", "ראש", "צוות", "מנהל", "מנהלת", "משאבי", "אנוש", "מגייסת", "מגייס"]);
/** Speech-to-text hints from the plan: names in "who" and "title" ("Dana Levi (Initech HR)" -> Dana, Levi, Initech). At most 10. */
export function briefTerms(b: Brief | undefined): string[] {
  if (!b) return [];
  const words = `${b.who ?? ""} ${b.title ?? ""}`.split(/[\s,()·:|/–—-]+/).map((w) => w.replace(/^[.'"]+|[.'"]+$/g, "")).filter(Boolean);
  const keep = words.filter((w) => w.length >= 2 && !TERM_STOP.has(w.toLowerCase()) && !/^\d+$/.test(w) && (/^[A-Z]/.test(w) || /[\u05d0-\u05ea]/.test(w)));
  return [...new Set(keep)].slice(0, 10);
}
export const LATEST_BRIEF = join(BRIEF_DIR, "latest.yaml");

/**
 * An explicit --brief file, or latest.yaml if written in the last maxAgeMs. latest.yaml is used ONCE: it is renamed
 * to used-<time>.yaml, so a brief for the 9:00 call never leaks into the 11:00 call. A broken file is reported, not fatal.
 */
export function loadBrief(file: string | undefined, maxAgeMs = 6 * 3600_000, consume = true): Brief | undefined {
  const f = file ?? LATEST_BRIEF;
  if (!existsSync(f)) return undefined;
  if (!file && Date.now() - statSync(f).mtimeMs > maxAgeMs) return undefined;   // an old "latest" is not for this call
  let b: Brief;
  try { b = (YAML.parse(readFileSync(f, "utf8")) ?? {}) as Brief; }
  catch (e) { console.error(`Brief ${f} is not valid YAML, ignored: ${(e as Error).message}`); return undefined; }
  if (!file && consume) { try { renameSync(f, join(BRIEF_DIR, `used-${new Date().toISOString().replace(/[:.]/g, "-")}.yaml`)); } catch { /* best effort */ } }
  return b;
}

/** Brief -> notes for the AI. */
export function briefNotes(b: Brief): string[] {
  const out: string[] = [];
  if (b.who) out.push(`On this call: ${b.who}`);
  if (b.goal) out.push(`Goal of the call: ${b.goal}`);
  for (const n of b.notes ?? []) if (!/^Prepared cards:/i.test(n)) out.push(n);   // a file path is not a note for the AI
  return out;
}

/** The plan's call kind ("Call kind: interview" note, written by the Plan store), lower case, or "". */
export function briefKind(b: Brief | undefined): string {
  const n = (b?.notes ?? []).find((x) => /^Call kind:\s*/i.test(x));
  return n ? n.replace(/^Call kind:\s*/i, "").trim().toLowerCase() : "";
}
/** A job interview plan: kind "interview" (or "ראיון"). Wingman then answers as the candidate's coach (reflex.ts INTERVIEW block). */
export const isInterview = (b: Brief | undefined): boolean => /^(interview|job interview|ראיון|ראיון עבודה)$/.test(briefKind(b));
/** The plan's own prepared cards: a "Prepared cards: <file.yaml>" note (bank format). They replace the agency bank for that call. */
export function briefCardsFile(b: Brief | undefined): string | undefined {
  const n = (b?.notes ?? []).find((x) => /^Prepared cards:\s*\S/i.test(x));
  return n ? n.replace(/^Prepared cards:\s*/i, "").trim() : undefined;
}

/**
 * Candidate base forms of a Hebrew word: as is, without a plural ending, without one or two glued prefix letters.
 * Crude on purpose (no real stemmer): a plural ending is cut only if 2+ letters remain; prefixes only on words of 4+ letters.
 * Input must already be normalized (final letters folded), so "ים" appears as "ימ".
 */
export function stems(w: string): Set<string> {
  const out = new Set<string>([w]);
  const noPlural = w.replace(/(יות|ימ|ים|ות)$/, (m) => (w.length - m.length >= 2 ? "" : m));
  for (const base of [w, noPlural]) {
    out.add(base);
    if (base.length >= 4 && /^[והבלמשכ]/.test(base)) { out.add(base.slice(1)); if (base.length >= 5 && base[1] === "ה") out.add(base.slice(2)); }
  }
  return out;
}

/**
 * A must-cover item counts as covered when at least 60% of its words (by stem) were said in the call.
 * Words of 4+ letters also match by prefix of each other ("תקציב" ~ "תקציבים"), since speech-to-text varies endings.
 */
export function covered(item: string, transcript: string): boolean {
  const want = tokens(item).filter((w) => w.length >= 2).map(stems);
  if (!want.length) return false;
  const said = new Set(tokens(transcript).flatMap((w) => [...stems(w)]));
  const hit = (cands: Set<string>) => [...cands].some((c) => said.has(c) || (c.length >= 4 && [...said].some((s) => s.length >= 4 && (s.startsWith(c) || c.startsWith(s)))));
  return want.filter(hit).length / want.length >= 0.6;
}

// CLI mode (pnpm brief): only when this file is run directly, not when run.ts imports it.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("Briefing for the next call (Enter skips a question).");
  const who = (await rl.question("Who is on the call (name, company)? ")).trim();
  const goal = (await rl.question("Goal of the call? ")).trim();
  const notes = (await rl.question("Notes for Wingman (separate with ;)? ")).split(";").map((s) => s.trim()).filter(Boolean);
  const mustCover = (await rl.question("Must cover (separate with ;), e.g. budget; timeline; hosting renewal? ")).split(";").map((s) => s.trim()).filter(Boolean);
  rl.close();
  const b: Brief = { who: who || undefined, goal: goal || undefined, notes, mustCover, createdAt: new Date().toISOString() };
  mkdirSync(BRIEF_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(LATEST_BRIEF, YAML.stringify(b), { mode: 0o600 });
  console.log(`Saved ${LATEST_BRIEF}. The Wingman app turns it into a prepared meeting the next time it looks (pick it there to start). Running pnpm call yourself uses it once, within 6 hours (--no-brief skips it).`);
}
