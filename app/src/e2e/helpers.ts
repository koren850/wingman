// Shared pieces of the engine e2e tests: run src/run.ts as a child on the scripted providers, read the call folder it writes,
// and a fake `ffmpeg` on PATH so live mode runs without audio hardware. Nothing here touches the real calls folder, keys or devices.
import "../test-setup.ts";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../env.ts";
import { tsx } from "../test-platform.ts";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const until = async (f: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await sleep(20);
  }
};

// ---------------------------------------------------------------- engine runs (real run.ts, scripted STT + AI)
export const scriptFile = (dir: string, lines: unknown[]) => {
  const f = join(dir, "script.json");
  writeFileSync(f, JSON.stringify(lines));
  return f;
};
export const readRows = (dir: string, f: string) =>
  existsSync(join(dir, f))
    ? readFileSync(join(dir, f), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return {};
          }
        })
    : [];
export const callDir = (calls: string) => {
  const d = readdirSync(calls).filter((x) => x !== "latest");
  return d.length ? join(calls, d[0]) : "";
};
/** Runs src/run.ts as a child. The older e2e files pin the classic engine; WINGMAN_E2E_ENGINE=v2 plays the same files on the default v2 engine (round 2 gates). */
export function runEngine(args: string[], env: Record<string, string>, profile = "e2e") {
  const p = spawn(
    ...tsx([
      join(ROOT, "src", "run.ts"),
      "--profile",
      profile,
      "--no-brief",
      "--set",
      `moments.engine=${process.env.WINGMAN_E2E_ENGINE === "v2" ? "v2" : "legacy"}`,
      ...args,
    ]),
    {
      cwd: ROOT,
      env: { ...process.env, WINGMAN_CALL_APP: "none", ...env },
    },
  );
  let out = "";
  p.stdout.on("data", (b) => (out += b));
  p.stderr.on("data", (b) => (out += b));
  const done = new Promise<number | null>((res) => p.on("exit", (c) => res(c)));
  return { p, done, out: () => out };
}
export const Q = (speaker: string, text: string, atMs: number) => ({ speaker, text, atMs });

// ---- live mode with a fake ffmpeg on PATH (the real MicSource/SupervisedSource/run.ts wiring, no audio hardware)
export function fakeFfmpeg(tmp: string) {
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "ffmpeg"),
    `#!/usr/bin/env node
const fs = require("fs"); const a = process.argv.slice(2); const dev = a[a.indexOf("-i") + 1];
const dir = process.env.FAKE_FFMPEG_DIR; const kind = dev.includes("sys") ? "sys" : "mic";
const f = dir + "/" + kind + ".count"; let n = 0; try { n = +fs.readFileSync(f, "utf8"); } catch {} fs.writeFileSync(f, String(n + 1));
fs.appendFileSync(dir + "/launches.log", kind + " " + dev + " " + n + "\\n");
// mic: the first launch (or the first FAKE_MIC_DROPS launches) dies after 3 s (AirPods dropped). sys: first two launches cannot start (exit 1 at once).
if (kind === "sys" && n < (process.env.FAKE_SYS_FAILS === undefined ? 2 : Number(process.env.FAKE_SYS_FAILS))) { process.stderr.write("device not found\\n"); process.exit(1); }
const chunk = Buffer.alloc(3200); for (let i = 0; i < 1600; i++) chunk.writeInt16LE(Math.round(8000 * Math.sin(i / 8)), i * 2);
const t = setInterval(() => process.stdout.write(chunk), 100);
if (kind === "mic" && n < (Number(process.env.FAKE_MIC_DROPS) || 1) && !process.env.FAKE_MIC_STAYS) setTimeout(() => { clearInterval(t); process.exit(1); }, 3000);
process.on("SIGINT", () => process.exit(255)); process.on("SIGTERM", () => process.exit(255));
`,
  );
  chmodSync(join(bin, "ffmpeg"), 0o755);
  const settings = join(tmp, "user.yaml");
  writeFileSync(
    settings,
    `audio:\n  mic:\n    device: ":fakemic"\n  system:\n    source: device\n    device: ":fakesys"\nsystem:\n  caffeinate: false\nbudget:\n  idleStopMin: 1\n`,
  );
  return { bin, settings };
}
export const stopSoon = async (e: ReturnType<typeof runEngine>, afterMs: number) => {
  await sleep(afterMs);
  e.p.kill("SIGINT");
  return e.done;
};

// ---------------------------------------------------------------- golden meetings (testkit)
// Two ways to play a Golden meeting (src/testkit/golden-types.ts, `t` in seconds):
//  - replayOnVClock: in this process, on a virtual clock. For code that can run in-process (pacing, cadence, gates). 90 s of meeting take milliseconds.
//  - runGolden: the real engine (src/run.ts) as a child process on scripted STT and the policy fake model. The engine is one process per call and
//    keeps its own real clock, so the lines are played in real time, divided by `speed` (the engine's own timers, such as stall timers, are not scaled).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Golden } from "../testkit/golden-types.ts";
import type { VClock } from "../testkit/vclock.ts";
import { PolicyModel } from "../testkit/policy-model.ts";
import { writeWav } from "../audio.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- call-log rows are loose JSON, as in the other e2e tests
type Row = Record<string, any>;
type GLine = Golden["lines"][number];

/** Plays the lines of `g` on `vc`: each line's `feed` runs at its time; then time runs on for `tailMs`. Returns when the clock has reached the end. */
export async function replayOnVClock(vc: VClock, g: Pick<Golden, "lines">, feed: (line: GLine, atMs: number) => void | Promise<void>, tailMs = 5000) {
  const t0 = g.lines.length ? g.lines[0].t : 0;
  const base = vc.elapsed();
  let last = 0;
  for (const l of g.lines) {
    const at = Math.round((l.t - t0) * 1000);
    last = Math.max(last, at);
    vc.setTimeout(() => void feed(l, at), at - (vc.elapsed() - base));
  }
  await vc.advance(last + tailMs - (vc.elapsed() - base));
}

/** One card seen on screen. `msAfterLine` is the time from the end of its trigger line (the latest line that arrived before the card). */
export type CardEvent = { id: string; kind: string; text: string; badge: string; atMs: number; afterLine?: string; msAfterLine?: number };
const KIND_BY_BADGE: Record<string, string> = {
  ai: "answer",
  bank: "answer",
  me: "answer",
  stall: "answer",
  fact: "fact",
  note: "fact",
  tip: "prompt",
  check: "check",
  prompt: "prompt",
};

/**
 * The card timeline of a run: shown cards in order. `lineTimes` maps a golden line id to its time (ms since the call started); the card is tied to the last
 * line that started before it. Rows that only update an earlier card (same id) are merged, and the first row sets the time.
 */
export function collectCards(rows: Row[], startedAt: number, lineTimes: { id: string; atMs: number }[] = []): CardEvent[] {
  const seen = new Set<string>();
  const out: CardEvent[] = [];
  for (const c of rows) {
    if (c.type !== "card" || c.health || c.withdraw || c.badge === "info") continue;
    const id = String(c.id ?? c.turnId ?? out.length);
    if (seen.has(id)) continue;
    seen.add(id);
    const atMs = Math.round(Number(c.t) - startedAt);
    const line = [...lineTimes].reverse().find((l) => l.atMs <= atMs);
    out.push({
      id,
      kind: String(c.kind ?? KIND_BY_BADGE[c.badge] ?? "answer"),
      text: String(c.say ?? c.text ?? ""),
      badge: String(c.badge ?? ""),
      atMs,
      afterLine: line?.id,
      msAfterLine: line ? atMs - line.atMs : undefined,
    });
  }
  return out;
}

export type GoldenRun = {
  code: number | null;
  out: string;
  cards: CardEvent[];
  /** what the engine asked the fake model: role, last line, serving rule (-1 = no rule) */ modelCalls: Row[];
  rows: (f: string) => Row[];
  dir: string;
  cleanup: () => void;
};
/**
 * Runs the real engine over a golden meeting. The model is `policy` (a PolicyModel, written to a file for the child); profile `e2e-policy` uses it for the reflex.
 * `speed` 2 plays the meeting twice as fast. Returns the card timeline; call cleanup() when done.
 */
export async function runGolden(
  g: Pick<Golden, "lines">,
  o: { policy: PolicyModel; speed?: number; tailSeconds?: number; profile?: string; env?: Record<string, string>; args?: string[] },
): Promise<GoldenRun> {
  const speed = o.speed ?? 1,
    tmp = mkdtempSync(join(tmpdir(), "wingman-golden-")),
    calls = join(tmp, "calls");
  const t0 = g.lines[0]?.t ?? 0;
  const lead = 600; // ms before the first line
  const times = g.lines.map((l) => ({ id: l.id, atMs: lead + Math.round(((l.t - t0) * 1000) / speed) }));
  const script = g.lines.map((l, i) => ({ speaker: l.side, text: l.text, atMs: times[i].atMs, speechFinal: true }));
  const total = Math.ceil((times.at(-1)?.atMs ?? 0) / 1000 + (o.tailSeconds ?? 5));
  const wav = join(tmp, "silence.wav");
  await writeWav(wav, Buffer.alloc(16000 * 2 * 2 * total), 2);
  const policy = join(tmp, "policy.json");
  writeFileSync(policy, JSON.stringify(o.policy.toJSON()));
  const e = runEngine(
    ["--file", wav, ...(o.args ?? [])],
    {
      WINGMAN_STT_SCRIPT: scriptFile(tmp, script),
      WINGMAN_POLICY_FILE: policy,
      WINGMAN_POLICY_LOG: join(tmp, "policy-calls.jsonl"),
      WINGMAN_CALLS_DIR: calls,
      ...o.env,
    },
    o.profile ?? "e2e-policy",
  );
  const code = await e.done;
  const dir = existsSync(calls) ? callDir(calls) : "";
  const rows = (f: string) => (dir ? readRows(dir, f) : []);
  const startedAt = Number(rows("transcript.jsonl")[0]?.t ?? rows("cards.jsonl")[0]?.t ?? 0) - (times[0]?.atMs ?? 0);
  return {
    code,
    out: e.out(),
    modelCalls: readRows(tmp, "policy-calls.jsonl"),
    cards: collectCards(rows("cards.jsonl"), startedAt, times),
    rows,
    dir,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}
