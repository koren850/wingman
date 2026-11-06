// Menu-bar remote control (WINGMAN_CONTROL=1): commands on stdin, "@@wingman" status lines on stdout. Offline.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, readlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { ROOT, CALLS } from "./env.ts";
import { writeWav } from "./audio.ts";
import { tsx } from "./test-platform.ts";

const lib = createRequire(import.meta.url)("../tray/lib.cjs");

test("control mode: note, quiet, client confirm and stop work from stdin; statuses reach the menu bar", { timeout: 60_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "wingman-ctl-"));
  const wav = join(tmp, "silence.wav");
  await writeWav(wav, Buffer.alloc(16000 * 2 * 2 * 30), 2); // long file: the stop command must end the call, not the file
  const p = spawn(...tsx([join(ROOT, "src", "run.ts"), "--profile", "e2e", "--file", wav, "--no-brief"]), {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, WINGMAN_CONTROL: "1", WINGMAN_STT_SCRIPT: join(ROOT, "data", "test", "e2e-call.json"), WINGMAN_SCRIPT_GAP_MS: "1100" },
  });
  const statuses: any[] = [];
  let out = "";
  p.stdout.on("data", (d) => {
    out += d;
    for (const line of d.toString().split("\n")) {
      const m = lib.parseStatus(line);
      if (!m) continue;
      statuses.push(m);
      if (m.ev === "consented") {
        p.stdin.write("note שיחה על מעבר שרת\n");
        p.stdin.write("quiet on\n");
        p.stdin.write("quiet off\n");
      }
      if (m.ev === "propose") p.stdin.write("client\n");
      if (m.ev === "client") setTimeout(() => p.stdin.write("stop\n"), 4500); // let >20 words arrive: the scripted summary (e2e profile, minWords 20) runs before "ended"
    }
  });
  let err = "";
  p.stderr.on("data", (d) => (err += d));
  const code: number = await new Promise((res) => p.on("exit", (c) => res(c ?? -1)));
  const dir = join(CALLS, readlinkSync(join(CALLS, "latest")));
  try {
    assert.equal(code, 0, `exit ${code}\n${out.slice(-2000)}\n${err.slice(-2000)}`);
    const evs = statuses.map((s) => s.ev);
    for (const e of ["consented", "note", "quiet", "propose", "client", "summary", "ended"]) assert.ok(evs.includes(e), `status ${e} in ${evs.join(",")}`);
    const events = readFileSync(join(dir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.ok(
      events.some((e) => e.type === "context.note" && /מעבר שרת/.test(e.note)),
      "note reached the AI notes",
    );
    assert.ok(
      events.some((e) => e.type === "client.confirmed"),
      "client confirmed",
    );
    assert.ok(statuses.find((s) => s.ev === "summary")?.ok === true, "summary status ok");
    assert.ok(evs.indexOf("summary") < evs.indexOf("ended"), "summary status comes before ended");
    assert.equal(events.filter((e) => e.type === "quiet").length, 2, "quiet on, then off");
    // the menu-bar state machine ends idle after exit
    let s = lib.initialState();
    for (const m of statuses) s = lib.reduce(s, m);
    s = lib.reduce(s, { ev: "exit", code });
    assert.equal(s.phase, "idle");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(CALLS, "latest"), { force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("control mode: stop-delete removes the call folder", { timeout: 60_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "wingman-ctl-"));
  const wav = join(tmp, "silence.wav");
  await writeWav(wav, Buffer.alloc(16000 * 2 * 2 * 30), 2);
  const p = spawn(...tsx([join(ROOT, "src", "run.ts"), "--profile", "e2e", "--file", wav, "--no-brief"]), {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, WINGMAN_CONTROL: "1", WINGMAN_STT_SCRIPT: join(ROOT, "data", "test", "e2e-call.json"), WINGMAN_SCRIPT_GAP_MS: "1100" },
  });
  let id = "";
  p.stdout.on("data", (d) => {
    for (const line of d.toString().split("\n")) {
      const m = lib.parseStatus(line);
      if (m?.ev === "consented") {
        id = m.id;
        setTimeout(() => p.stdin.write("stop-delete\n"), 500);
      }
    }
  });
  const code: number = await new Promise((res) => p.on("exit", (c) => res(c ?? -1)));
  try {
    assert.equal(code, 0);
    assert.ok(id, "got the call id");
    assert.equal(existsSync(join(CALLS, id)), false, "call folder deleted");
  } finally {
    rmSync(join(CALLS, "latest"), { force: true });
    if (id) rmSync(join(CALLS, id), { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});
