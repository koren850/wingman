// Prepared start (PLAN §0.6): a 1-minute briefing before the meeting.
//   pnpm brief            asks 4 short questions and saves data/private/briefs/latest.yaml
//   pnpm call / start     loads a brief saved in the last 6 hours (or --brief <file>; --no-brief skips it)
// The brief becomes Dan's notes for the AI, and its must-cover items become reminders during the call.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { DATA } from "./env.ts";
import { tokens } from "./normalize.ts";

export type Brief = { who?: string; goal?: string; notes?: string[]; mustCover?: string[]; createdAt?: string };
export const BRIEF_DIR = join(DATA, "private", "briefs");
export const LATEST_BRIEF = join(BRIEF_DIR, "latest.yaml");

export function loadBrief(file: string | undefined, maxAgeMs = 6 * 3600_000): Brief | undefined {
  const f = file ?? LATEST_BRIEF;
  if (!existsSync(f)) return undefined;
  if (!file && Date.now() - statSync(f).mtimeMs > maxAgeMs) return undefined;   // an old "latest" is not for this call
  return (YAML.parse(readFileSync(f, "utf8")) ?? {}) as Brief;
}

/** Brief -> notes for the AI. */
export function briefNotes(b: Brief): string[] {
  const out: string[] = [];
  if (b.who) out.push(`On this call: ${b.who}`);
  if (b.goal) out.push(`Goal of the call: ${b.goal}`);
  for (const n of b.notes ?? []) out.push(n);
  return out;
}

/** Rough Hebrew stem: drop one glued prefix letter and a plural ending ("גיבויים" ~ "גיבוי" ~ "והגיבוי"). */
export function stem(w: string): string {
  let t = w;
  if (t.length > 4 && /^[והבלמשכ]/.test(t)) t = t.slice(1);
  if (t.length > 4 && /^ה/.test(t)) t = t.slice(1);
  t = t.replace(/(יות|ים|ות)$/, (m) => (t.length - m.length >= 3 ? "" : m));
  return t;
}

/** A must-cover item counts as covered when most of its words (by stem) were said in the call. */
export function covered(item: string, transcript: string): boolean {
  const want = tokens(item).filter((w) => w.length > 2).map(stem);
  if (!want.length) return true;
  const said = tokens(transcript).map(stem);
  const hit = (w: string) => said.some((s) => s === w || (w.length >= 4 && s.length >= 4 && (s.startsWith(w) || w.startsWith(s))));
  return want.filter(hit).length / want.length >= 0.6;
}

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
  console.log(`Saved ${LATEST_BRIEF}. The next call in the next 6 hours uses it (pnpm call --no-brief to skip).`);
}
