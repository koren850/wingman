// What the cassettes hold and how much of a play they cover.  pnpm cassette:status [--cassette a.json[,b.json]] [--suite dev] [--no-play] [--limit n]
//   Without --cassette it lists every data/cassettes/*.cassette.json. For each file: entries by role, model and source (recorded or authored), and how many have no
//   prompt hash (recorded before round 12: they cannot be told stale from missing).
//   Coverage: with --cassette and no --no-play it plays the dev meetings against the file (no network, the policy-free replay of qa eval --cassette) and counts for each
//   model call: found, STALE (an entry exists but was recorded with another prompt text or model: re-record) or MISSING (no entry at all).
//   Held-out suites are never played here.
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cassette, summarizeCassette, type CassetteSummary } from "../src/providers/cassette.ts";
import { loadSplit } from "../qa/golden-load.ts";
import { v2Meetings } from "../qa/eval-v2.ts";
import { runMeeting, pool, type MeetingRun } from "../src/e2e/v2-kit.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CASSETTE_DIR = join(ROOT, "data", "cassettes");
export type Coverage = { meetings: number; calls: number; found: number; stale: number; missing: number; pct: number };
export type Deps = { log: (line: string) => void; run?: typeof runMeeting; dir?: string };

export function coverageOf(runs: Pick<MeetingRun, "roleCalls" | "cassetteMisses" | "cassetteStale">[]): Coverage {
  const calls = runs.reduce((a, r) => a + Object.values(r.roleCalls ?? {}).reduce((x, y) => x + y, 0), 0);
  const miss = runs.reduce((a, r) => a + (r.cassetteMisses ?? 0), 0);
  const stale = runs.reduce((a, r) => a + (r.cassetteStale ?? 0), 0);
  return {
    meetings: runs.length,
    calls,
    found: Math.max(0, calls - miss),
    stale,
    missing: Math.max(0, miss - stale),
    pct: calls ? Math.max(0, calls - miss) / calls : 1,
  };
}
export function formatSummary(file: string, s: CassetteSummary): string {
  const roles = Object.entries(s.byRole)
    .sort((a, b) => b[1].entries - a[1].entries)
    .map(
      ([r, v]) =>
        `    ${r.padEnd(10)} ${String(v.entries).padStart(5)} entries  ${v.models.join(", ")}${v.unhashed ? `  (${v.unhashed} without a prompt hash)` : ""}`,
    );
  return [
    `${basename(file)}: ${s.entries} entries (${
      Object.entries(s.bySource)
        .map(([k, n]) => `${n} ${k}`)
        .join(", ") || "empty"
    })`,
    ...roles,
  ].join("\n");
}
export function formatCoverage(c: Coverage): string {
  return `  coverage on dev: ${c.meetings} meetings, ${c.calls} model calls, ${c.found} found (${(c.pct * 100).toFixed(1)}%), ${c.stale} STALE (recorded with an older prompt or model: re-record), ${c.missing} missing (no entry at all)`;
}

export async function main(argv: string[], deps: Deps): Promise<number> {
  const get = (f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const dir = deps.dir ?? CASSETTE_DIR;
  const given = get("--cassette")?.split(",");
  const files =
    given ??
    (existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith(".cassette.json") && !f.endsWith(".part.json"))
          .map((f) => join(dir, f))
      : []);
  if (!files.length) return (deps.log(`No cassettes in ${dir}. Record them with: pnpm morning --cap 5 (owner only).`), 0);
  for (const f of files) if (!existsSync(f)) return (deps.log(`cassette:status: no such file ${f}`), 2);
  for (const f of files) deps.log(formatSummary(f, summarizeCassette(new Cassette(f))));
  if (given && !argv.includes("--no-play")) {
    const limit = get("--limit") === undefined ? undefined : Number(get("--limit"));
    let meetings = v2Meetings(loadSplit("dev"));
    if (limit) meetings = meetings.slice(0, limit);
    const run = deps.run ?? runMeeting;
    const runs = await pool(meetings, 4, (g) => run(g.id, { split: "dev", asks: false, replay: { cassette: given.join(",") } }, 600_000));
    deps.log(formatCoverage(coverageOf(runs)));
  } else if (!given) deps.log("  (pass --cassette <file> to play dev against a file and print coverage)");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2), { log: (l) => console.log(l) });
}
