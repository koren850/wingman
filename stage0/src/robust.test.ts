// Robustness fixes (pre-meeting hardening): STT outage retry, monologue vs dead tap, disk failures, orphan overlay, linger/Start, doctor timeout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./env.ts";
import { writeWav } from "./audio.ts";
import { HealthSupervisor } from "./health.ts";
import { SttChannel } from "./providers/stt/channel.ts";
import { ProviderError } from "./providers/errors.ts";
import { loadSettings } from "./settings.ts";
import type { SttProvider, SttStreamLike } from "./providers/stt/types.ts";

const { createController } = createRequire(import.meta.url)("../tray/controller.cjs");
const tsx = join(ROOT, "node_modules", ".bin", "tsx");

// ---- 1. short STT outage with no fallback: the channel can reopen the same provider ----
class Fake extends EventEmitter implements SttStreamLike {
  dropped = 0; sent = 0; isOpen = true; closed = false;
  constructor(private fail?: () => Error | undefined) { super(); }
  async open() { const e = this.fail?.(); if (e) throw e; }
  send(b: Buffer) { this.sent += b.length; return true; }
  async close() { this.closed = true; this.isOpen = false; }
  get audioSeconds() { return this.sent / 32000; }
}
test("stt: with no fallback, exhausted is retryable and reopen() recovers the channel (wifi drop)", async () => {
  const streams: Fake[] = []; let down = false;
  const p: SttProvider = { id: "deepgram" as any, experimental: false, capabilities: { keyterms: true, diarize: false, interim: true, maxKeyterms: 100 },
    create: () => { const s = new Fake(() => (down ? new ProviderError("network", "deepgram", "ENOTFOUND") : undefined)); streams.push(s); return s; }, probe: async () => ({ ok: true }) };
  const now = { t: 0 };
  const ch = new SttChannel({ channel: "them", chain: [p], keyOf: () => "k", base: {}, circuit: { failures: 3, windowMs: 10_000 }, now: () => now.t });
  await ch.open();
  const ex = new Promise<ProviderError>((r) => ch.once("exhausted", r));
  down = true;
  for (let i = 0; i < 3; i++) streams[0].emit("disconnected", { channel: "them", error: new ProviderError("network", "deepgram", "net") });
  const e = await ex;
  assert.equal(e.retryable, true, "a network outage is retryable: run.ts keeps retrying instead of ending the call");
  await assert.rejects(ch.reopen(), (x: any) => x.kind === "network", "still down");
  down = false;
  const rec = new Promise((r) => ch.once("reconnected", r));
  await ch.reopen(); await rec;
  assert.equal(streams[0].closed, true, "the dead stream is closed");
  assert.equal(ch.isOpen, true);
  assert.equal(ch.send(Buffer.alloc(320)), true);
  // auth/quota stay non-retryable: run.ts treats those as fatal with a clear message.
  const auth = new ProviderError("auth", "deepgram", "401"); assert.equal(auth.retryable, false);
});

// ---- 2. monologue never sets themDead; real recovery is fast ----
test("health: themDead recovers within ~2 s of the other side returning, not recoverStableMs", () => {
  const now = { t: 0 };
  const s = new HealthSupervisor({ tickMs: 1000, recoverStableMs: 60_000, slowMs: 1500, slowSttMs: 1500, minSamples: 3 }, () => now.t);
  s.set({ themDead: true }); s.tick(); assert.equal(s.rung, 4); assert.equal(s.caps.detect, false);
  now.t += 5000; s.set({ themDead: false });
  now.t += 1000; s.tick(); assert.equal(s.rung, 4, "not yet");
  now.t += 1500; s.tick(); assert.equal(s.rung, 0); assert.equal(s.caps.detect, true);
});
test("health: other recoveries still need the stable minute", () => {
  const now = { t: 0 };
  const s = new HealthSupervisor({ tickMs: 1000, recoverStableMs: 60_000, slowMs: 1500, slowSttMs: 1500, minSamples: 3 }, () => now.t);
  s.set({ llmDown: true, themDead: true }); s.tick(); s.set({ themDead: false }); now.t += 10_000; s.tick(); assert.equal(s.rung, 3, "llmDown keeps rung 3 and recovery waits");
  s.set({ llmDown: false }); now.t += 30_000; s.tick(); assert.equal(s.rung, 3);
});
test("run.ts: the silent-while-talking heuristic never sets themDead (source check)", () => {
  const src = readFileSync(join(ROOT, "src", "run.ts"), "utf8");
  const calm = src.slice(src.indexOf('log.write("events", { type: "watchdog.silent-them"'), src.indexOf('}, 2000).unref();', src.indexOf('watchdog.silent-them')));
  assert.ok(calm.includes('"only-you"') && !/themDead/.test(calm), "calm branch must not touch themDead");
});

// ---- 3. disk failures ----
test("log: write failures are counted, warned once, and never throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wm-log-"));
  const r = spawnSync(tsx, ["-e", `
    import { CallLog } from ${JSON.stringify(join(ROOT, "src", "log.ts"))};
    import { rmSync } from "node:fs";
    const log = new CallLog({ a: 1 }); let warned = 0; log.onWriteFail = () => warned++;
    log.write("events", { ok: 1 }); rmSync(log.dir, { recursive: true });
    for (let i = 0; i < 5; i++) log.write("events", { i });
    log.update({ endedAt: "x" });
    console.log(JSON.stringify({ failures: log.writeFailures, warned }));
  `], { cwd: ROOT, encoding: "utf8", env: { ...process.env, WINGMAN_CALLS_DIR: dir } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split("\n").pop()!), { failures: 5, warned: 1 });
  rmSync(dir, { recursive: true, force: true });
});
test("run.ts: unusable calls folder = one clear line and exit 2, no stack trace", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "wm-nodisk-"));
  const wav = join(tmp, "s.wav"); await writeWav(wav, Buffer.alloc(16000 * 4 * 2), 2);
  writeFileSync(join(tmp, "afile"), "x");
  const r = spawnSync(tsx, [join(ROOT, "src", "run.ts"), "--profile", "e2e", "--file", wav, "--no-brief"], {
    cwd: ROOT, encoding: "utf8", timeout: 40_000,
    env: { ...process.env, WINGMAN_CALLS_DIR: join(tmp, "afile", "calls"), WINGMAN_STT_SCRIPT: join(ROOT, "data", "test", "e2e-call.json") },
  });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /cannot create the calls folder/);
  assert.ok(!/\n\s+at /.test(r.stderr), "no stack trace");
  rmSync(tmp, { recursive: true, force: true });
});

// ---- 8. notes cap, WINGMAN_USER_SETTINGS ----
test("run.ts: typed notes are capped (last 20 notes) in the context sent to the AI", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "wm-notes-")), calls = join(tmp, "calls");
  const wav = join(tmp, "s.wav"); await writeWav(wav, Buffer.alloc(16000 * 4 * 12), 2);
  const c = spawn(tsx, [join(ROOT, "src", "run.ts"), "--profile", "e2e", "--file", wav, "--no-brief"], {
    cwd: ROOT, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, WINGMAN_CONTROL: "1", WINGMAN_CALLS_DIR: calls, WINGMAN_STT_SCRIPT: join(ROOT, "data", "test", "e2e-call.json"), WINGMAN_SCRIPT_GAP_MS: "1500" },
  });
  let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
  await new Promise<void>((res) => { const t = setInterval(() => { if (/@@wingman .*"waiting"|@@wingman .*"consented"/.test(out)) { clearInterval(t); res(); } }, 100); });
  for (let i = 0; i < 30; i++) c.stdin.write(`note note-number-${i}\n`);
  const code = await new Promise<number | null>((res) => c.on("exit", res));
  try {
    assert.equal(code, 0, out);
    const dir = join(calls, readdirSync(calls).find((d) => d !== "latest")!);
    const ev = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const snap = ev.find((e) => e.type === "context.snapshot");
    const typed = (snap.contextNotes as string[]).filter((n) => /^note-number-/.test(n));
    assert.equal(typed.length, 20); assert.equal(typed[0], "note-number-10"); assert.equal(typed.at(-1), "note-number-29");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
test("settings: WINGMAN_USER_SETTINGS is honoured by the engine loader", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wm-us-")), f = join(tmp, "s.yaml");
  writeFileSync(f, "v: 1\ncards:\n  maxOnScreen: 7\n");
  const l = loadSettings({ env: { WINGMAN_USER_SETTINGS: f }, createStarter: false });
  assert.equal(l.settings.cards.maxOnScreen, 7);
  rmSync(tmp, { recursive: true, force: true });
});

// ---- 6/7. overlay orphan guard, linger, doctor ----
test("overlay: spawned with a stdin pipe + parent watch; main.cjs quits when the parent goes away", () => {
  const o = readFileSync(join(ROOT, "src", "overlay.ts"), "utf8"), m = readFileSync(join(ROOT, "overlay", "main.cjs"), "utf8");
  assert.match(o, /stdio: \["pipe"/); assert.match(o, /WINGMAN_WATCH_PARENT/);
  assert.match(m, /WINGMAN_WATCH_PARENT/); assert.match(m, /process\.stdin\.on\("end"/); assert.match(m, /process\.kill\(parent, 0\)/);
  const c = readFileSync(join(ROOT, "src", "call.ts"), "utf8");
  assert.match(c, /SIGKILL/, "call.ts escalates to SIGKILL for a hung overlay");
});

function fakeCtl(extra: any = {}) {
  const spawned: any[] = [], kills: any[] = [], timers: { fn: () => void; ms: number; cleared?: boolean }[] = [];
  const spawnFn = (_c: string, args: string[], opts: any) => {
    const c: any = new EventEmitter(); c.pid = 100 + spawned.length; c.args = args; c.opts = opts;
    c.stdin = Object.assign(new EventEmitter(), { writable: true, write: () => true });
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = (s: string) => kills.push(["child", c.pid, s]);
    c.say = (ev: string, data: object = {}) => c.stdout.emit("data", Buffer.from(`\n@@wingman ${JSON.stringify({ ev, ...data })}\n`));
    spawned.push(c); return c;
  };
  const ctl = createController({ spawn: spawnFn, root: ROOT, tmpDir: tmpdir(), setTimeout: (fn: () => void, ms: number) => { const t = { fn, ms }; timers.push(t); return t; }, kill: (pid: number, sig: string) => kills.push([pid, sig]), notify: () => {}, env: {}, ...extra });
  return { ctl, spawned, kills, timers };
}
test("controller: Start works as soon as the call has ended, while call.ts lingers; the old window is closed", () => {
  const { ctl, spawned, kills } = fakeCtl();
  ctl.start({}); const a = spawned[0]; a.say("waiting", { id: "1" }); a.say("consented");
  ctl.stop(); a.say("ended", { id: "1", crashed: false });
  assert.equal(ctl.isRunning(), false, "engine ended: idle");
  assert.equal(ctl.getState().phase, "idle");
  assert.equal(ctl.start({}), true, "new call allowed during the 5 s linger");
  assert.ok(kills.some((k) => k[0] === -a.pid && k[1] === "SIGTERM"), "lingering call.ts told to close its window");
  a.emit("exit", 0);   // the old process finally exits: must not disturb the new call
  assert.equal(ctl.isRunning(), true); assert.equal(ctl.getState().phase, "starting");
});
test("controller: doctor has a timeout (kills it) and is killed on quit", async () => {
  const { ctl, spawned, kills, timers } = fakeCtl({ doctorTimeoutMs: 5000 });
  const p = ctl.runDoctor(); const d = spawned[0];
  assert.equal(d.opts.detached, true);
  const t = timers.find((x) => x.ms === 5000)!; assert.ok(t, "timeout armed"); t.fn();
  const r = await p; assert.ok(r);
  assert.ok(kills.some((k) => k[0] === -d.pid && k[1] === "SIGKILL"));
  const f2 = fakeCtl(); void f2.ctl.runDoctor(); f2.ctl.shutdown();
  assert.ok(f2.kills.some((k) => k[0] === -f2.spawned[0].pid && k[1] === "SIGKILL"), "quit kills the doctor");
});

// ---- initial open: mock server refusing the first connects ----
test("stt: initial open survives a server that refuses the first 2 connects (mock), via the run.ts retry policy", async () => {
  const { createServer } = await import("node:http");
  const { WebSocketServer } = await import("ws");
  const { SonioxStream } = await import("./providers/stt/soniox.ts");
  let attempts = 0;
  const http = createServer(); const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, sock, head) => {
    if (++attempts <= 2) { sock.write("HTTP/1.1 503 X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); sock.destroy(); return; }
    wss.handleUpgrade(req, sock, head, () => {});
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  const port = (http.address() as any).port;
  const p: SttProvider = { id: "soniox" as any, experimental: false, capabilities: { keyterms: false, diarize: false, interim: true, maxKeyterms: 0 }, create: (o: any) => new SonioxStream({ ...o, baseUrl: `ws://127.0.0.1:${port}` }), probe: async () => ({ ok: true }) };
  const ch = new SttChannel({ channel: "them", chain: [p], keyOf: () => "k", base: {}, circuit: { failures: 3, windowMs: 10_000 } });
  // same policy as run.ts openChannel (transient -> backoff retry; fast here)
  let n = 0;
  for (;; n++) { try { await ch.open(); break; } catch (e: any) { assert.equal(e.retryable, true, `transient: ${e.kind}`); if (n > 5) throw e; await new Promise((r) => setTimeout(r, 20)); } }
  assert.equal(n, 2); assert.equal(ch.isOpen, true);
  await ch.close(); http.close();
  const src = readFileSync(join(ROOT, "src", "run.ts"), "utf8");
  assert.match(src, /Promise\.allSettled\(\[openChannel\(me/); assert.match(src, /30_000\) \{[\s\S]*sttRetryLoop/);
});
