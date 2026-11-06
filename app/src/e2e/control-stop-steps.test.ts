// End-to-end (subprocess): a real scripted engine run in control mode emits the mode and the stop steps in order, and call.json ends at phase "ended".
import "../test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ROOT } from "../env.ts";
import { tsx } from "../test-platform.ts";

const req = createRequire(import.meta.url);
const lib = req("../../tray/lib.cjs");

// ---- real engine run (offline, scripted, temp calls folder): statuses and call.json phases ----
test("engine: control-mode run emits mode + stop steps in order and call.json ends at phase ended", { timeout: 60_000 }, async () => {
  const { spawnSync } = await import("node:child_process");
  const { writeWav } = await import("../audio.ts");
  const { readdirSync } = await import("node:fs");
  const tmp = mkdtempSync(join(tmpdir(), "wingman-ux-run-")),
    calls = join(tmp, "calls"),
    wav = join(tmp, "silence.wav");
  await writeWav(wav, Buffer.alloc(16000 * 2 * 2 * 8), 2);
  const r = spawnSync(...tsx([join(ROOT, "src", "run.ts"), "--profile", "e2e", "--file", wav, "--no-brief"]), {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 50_000,
    input: "",
    env: {
      ...process.env,
      WINGMAN_CALLS_DIR: calls,
      WINGMAN_CONTROL: "1",
      WINGMAN_STT_SCRIPT: join(ROOT, "data", "test", "e2e-call.json"),
      WINGMAN_SCRIPT_GAP_MS: "800",
    },
  });
  const evs = r.stdout
    .split("\n")
    .filter((l) => l.startsWith("@@wingman "))
    .map((l) => JSON.parse(l.slice(10)));
  const names = evs.map((e) => e.ev);
  assert.ok(names.includes("mode") && evs.find((e) => e.ev === "mode").noAi === false, `mode event: ${names}`);
  const phases = evs.filter((e) => e.ev === "stopphase").map((e) => e.phase);
  assert.deepEqual(phases, ["saving", "summary", "done"]);
  assert.ok(names.indexOf("stopphase") < names.indexOf("ended") && names.lastIndexOf("stopphase") < names.indexOf("ended"));
  const id = readdirSync(calls).find((d) => d !== "latest")!;
  const meta = JSON.parse(readFileSync(join(calls, id, "call.json"), "utf8"));
  assert.equal(meta.phase, "ended");
  assert.ok(meta.endedAt);
  assert.ok(meta.liveAt > 0, "liveAt was written when listening started");
  // the reducer fed with the real stream ends with a clean stop
  let s = lib.initialState();
  for (const e of evs) s = lib.reduce(s, e);
  assert.equal(s.stopPhase, "done");
  assert.equal(s.phase, "stopping");
});
