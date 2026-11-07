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
export function runEngine(args: string[], env: Record<string, string>) {
  const p = spawn(...tsx([join(ROOT, "src", "run.ts"), "--profile", "e2e", "--no-brief", ...args]), {
    cwd: ROOT,
    env: { ...process.env, WINGMAN_CALL_APP: "none", ...env },
  });
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
