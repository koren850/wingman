// The `wingman` CLI and the app's control socket. Offline: temp socket, temp calls/briefs/settings dirs, a fake child process
// (or the scripted engine in file mode), invented data only. No app, no mic, no network, no window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./env.ts";
import { writeWav } from "./audio.ts";
import { main } from "./cli/index.ts";
import { HELP } from "./cli/help.ts";

const req = createRequire(import.meta.url);
const { createController } = req("../tray/controller.cjs");
const { createControlServer } = req("../tray/control-socket.cjs");
const trayLib = req("../tray/lib.cjs");

const tmp = (n: string) => mkdtempSync(join(tmpdir(), `wm-cli-${n}-`));

function fakeSpawn() {
  const spawned: any[] = [];
  const spawnFn = (_cmd: string, args: string[], opts: any) => {
    const c: any = new EventEmitter();
    c.pid = 4242; c.args = args; c.opts = opts; c.written = [] as string[];
    c.stdin = Object.assign(new EventEmitter(), { writable: true, write: (s: string) => { c.written.push(s); return true; } });
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {};
    c.say = (ev: string, data: object = {}) => c.stdout.emit("data", Buffer.from(`\n@@wingman ${JSON.stringify({ ev, ...data })}\n`));
    spawned.push(c); return c;
  };
  return { spawnFn, spawned };
}

async function rig(opts: { now?: () => number; spawn?: any; callsDir?: string } = {}) {
  const dir = tmp("rig");
  const sock = join(dir, "run", "control.sock");
  const logs: string[] = [];
  let clock = 5_000_000;   // each rate-limit check advances 2 s unless a test passes its own clock
  const f = fakeSpawn();
  const ctl = createController({ spawn: opts.spawn ?? f.spawnFn, root: ROOT, tmpDir: dir, setTimeout: () => 0, kill: () => {}, logPath: "" });
  const env = { ...process.env, WINGMAN_CONTROL_SOCKET: sock, WINGMAN_CALLS_DIR: opts.callsDir ?? join(dir, "calls"), WINGMAN_BRIEFS_DIR: join(dir, "briefs"), WINGMAN_USER_SETTINGS: join(dir, "settings.yaml") };
  mkdirSync(opts.callsDir ?? join(dir, "calls"), { recursive: true });
  const server = createControlServer({ controller: ctl, lib: trayLib, briefFile: join(dir, "briefs", "latest.yaml"), socketPath: sock, log: (s: string) => logs.push(s), now: opts.now ?? (() => (clock += 2000)), info: () => ({ pid: 1, version: "t" }) });
  await server.start();
  const run = async (...argv: string[]) => {
    let out = "", err = "";
    const code = await main(argv, { env, out: (s) => { out += s; }, err: (s) => { err += s; }, sleep: (ms: number) => new Promise((res) => setTimeout(res, Math.min(ms, 30))), stdin: async () => "from stdin" });
    return { code, out, err, json: (() => { try { return JSON.parse(out.trim().split("\n")[0]); } catch { return undefined; } })() };
  };
  const raw = (line: string) => new Promise<any>((res) => { const s = net.createConnection(sock); let b = ""; s.on("connect", () => s.write(line)); s.on("data", (d) => (b += d)); s.on("close", () => res(JSON.parse(b))); });
  return { dir, sock, ctl, server, logs, f, env, run, raw, done: async () => { await server.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test("socket: owner-only permissions (folder 700, socket 600)", async () => {
  const r = await rig();
  try {
    assert.equal(statSync(r.sock).mode & 0o777, 0o600);
    assert.equal(statSync(join(r.dir, "run")).mode & 0o777, 0o700);
  } finally { await r.done(); }
});

test("socket: only the fixed allowlist, strict argument schema, no arbitrary exec", async () => {
  const r = await rig();
  try {
    assert.equal((await r.raw('{"v":1,"cmd":"ping"}\n')).ok, true);
    for (const cmd of ["exec", "shell", "__proto__", "constructor", "toString", "keys", "settings", "purge"]) assert.equal((await r.raw(JSON.stringify({ v: 1, cmd }) + "\n")).code, "unknown_command", cmd);
    assert.equal((await r.raw("not json\n")).code, "bad_request");
    assert.equal((await r.raw('{"v":2,"cmd":"ping"}\n')).code, "bad_request");
    assert.equal((await r.raw('{"v":1,"cmd":"ping","extra":1}\n')).code, "bad_request");
    assert.equal((await r.raw('{"v":1,"cmd":"ping","args":{"x":1}}\n')).code, "bad_args");
    assert.equal((await r.raw('{"v":1,"cmd":"note","args":{}}\n')).code, "bad_args");
    assert.equal((await r.raw('{"v":1,"cmd":"note","args":{"text":5}}\n')).code, "bad_args");
    assert.equal((await r.raw('{"v":1,"cmd":"note","args":{"text":"a","cmd":"rm"}}\n')).code, "bad_args");
    assert.equal((await r.raw(JSON.stringify({ v: 1, cmd: "note", args: { text: "x".repeat(2001) } }) + "\n")).code, "bad_args");
    assert.equal((await r.raw(JSON.stringify({ v: 1, cmd: "ping", args: {}, pad: "x".repeat(20000) }) + "\n")).code, "too_large");
    assert.equal((await r.raw('{"v":1,"cmd":"stop_delete","args":{"confirm":false}}\n')).code, "refused");
  } finally { await r.done(); }
});

test("socket: start/stop drive the app's controller (one call, no second engine), ask reaches the call as 'ask <text>'", async () => {
  const r = await rig();
  try {
    const a = await r.run("status", "--json");
    assert.equal(a.code, 0); assert.equal(a.json.app.running, true); assert.equal(a.json.call.phase, "idle");
    const s = await r.run("start", "--json", "--no-wait");
    assert.equal(s.code, 0, s.out + s.err); assert.equal(r.f.spawned.length, 1);
    assert.ok(r.f.spawned[0].args[0].endsWith("call.ts"));
    assert.equal(r.f.spawned[0].opts.env.WINGMAN_CONTROL, "1");
    const again = await r.run("start", "--json", "--no-wait");
    assert.equal(again.code, 4, "second start refused");
    assert.equal(r.f.spawned.length, 1, "never a second engine");
    const c = r.f.spawned[0];
    c.say("waiting", { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });
    assert.equal((await r.run("status", "--json")).json.call.phase, "waiting");
    assert.equal((await r.run("ask", "מה המחיר", "--json")).code, 4, "ask needs a live call");
    assert.equal((await r.run("consent", "--json")).code, 6, "consent needs --yes");
    assert.equal((await r.run("consent", "--yes", "--json")).code, 0);
    assert.deepEqual(c.written, ["consent\n"]);
    c.say("consented");
    const q = await r.run("ask", "what", "is", "the", "price?", "--json");
    assert.equal(q.code, 0, q.out); assert.equal(typeof q.json.engineSupportsAsk, "boolean");
    assert.equal((await r.run("note", "she is the owner", "--json")).code, 0);
    assert.equal((await r.run("note", "x".repeat(301), "--json")).code, 2);
    assert.equal((await r.run("ask", "-", "--json")).code, 0, "stdin text");
    assert.equal((await r.run("ask", "--listen", "--json")).code, 0);
    assert.deepEqual(c.written.slice(1), ["ask what is the price?\n", "note she is the owner\n", "ask from stdin\n", "ask\n"]);
    assert.equal((await r.run("quiet", "on", "--json")).code, 0);
    assert.equal((await r.run("quiet", "maybe", "--json")).code, 2);
    assert.equal((await r.run("stop", "--delete", "--json")).code, 6, "delete needs --yes");
    assert.equal(c.written.includes("stop-delete\n"), false);
    const st = await r.run("stop", "--json", "--no-wait");
    assert.equal(st.code, 0, st.out); assert.ok(c.written.includes("stop\n"));
    c.emit("exit", 0);
    assert.equal((await r.run("status", "--json")).json.call.phase, "idle");
    assert.equal((await r.run("stop", "--json")).code, 4, "nothing to stop");
  } finally { await r.done(); }
});

test("socket: practice, stop --delete --yes, rate limit on start/stop, no call content in the log", async () => {
  let t = 1_000_000;
  const r = await rig({ now: () => t });
  try {
    assert.equal((await r.run("start", "--practice", "--no-wait", "--json")).code, 0);
    assert.equal(r.f.spawned[0].opts.env.WINGMAN_STT_SCRIPT !== undefined, true, "practice uses scripted STT");
    t += 100;
    const fast = await r.run("stop", "--json", "--no-wait");
    assert.equal(fast.code, 8, "second start/stop within 1.5 s is rate limited");
    t += 2000;
    r.f.spawned[0].say("consented");
    assert.equal((await r.run("ask", "secret question about invoice 12345", "--json")).code, 0);
    assert.equal((await r.run("stop", "--delete", "--yes", "--no-wait", "--json")).code, 0);
    assert.ok(r.f.spawned[0].written.includes("stop-delete\n"));
    r.f.spawned[0].emit("exit", 0);
    for (let i = 0; i < 8; i++) { t += 2000; await r.run("start", "--no-wait", "--json"); r.f.spawned.at(-1).emit("exit", 0); }
    t += 2000;
    assert.equal((await r.run("start", "--no-wait", "--json")).code, 8, "6 per minute");
    t += 61_000;
    assert.equal((await r.run("start", "--no-wait", "--json")).code, 0);
    const log = r.logs.join("\n");
    assert.match(log, /cli ask ok/);
    assert.doesNotMatch(log, /invoice|12345|secret/, "arguments never reach the log");
  } finally { await r.done(); }
});

test("cli: app not running -> exit 3 with a hint, and nothing is opened", async () => {
  const dir = tmp("noapp");
  let opened = 0;
  try {
    const env = { ...process.env, WINGMAN_CONTROL_SOCKET: join(dir, "none.sock"), WINGMAN_CALLS_DIR: dir, WINGMAN_BRIEFS_DIR: join(dir, "b"), WINGMAN_USER_SETTINGS: join(dir, "s.yaml") };
    for (const argv of [["start"], ["stop"], ["ask", "hi"], ["note", "hi"], ["status"], ["quiet", "on"], ["client"]]) {
      let out = "";
      const code = await main([...argv, "--json"], { env, out: (s) => { out += s; }, err: () => {}, openApp: async () => { opened++; } });
      assert.equal(code, 3, argv.join(" "));
      const j = JSON.parse(out.trim().split("\n")[0]);
      assert.ok(j.error?.hint?.includes("wingman app open") || j.app?.hint?.includes("wingman app open"));
    }
    assert.equal(opened, 0, "the CLI never opens the app implicitly");
    let out = "";
    assert.equal(await main(["app", "open", "--json"], { env, out: (s) => { out += s; }, err: () => {}, sleep: () => Promise.resolve(), openApp: async () => { opened++; } }), 9, "opens only on `app open` (test opener does not create the socket)");
    assert.equal(opened, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("plan: create, edit, attach, list, clear (same files the app uses)", async () => {
  const r = await rig();
  try {
    const a = await r.run("plan", "set", "--who", "Dana Levi", "--kind", "vendor", "--topic", "hosting move", "--goal", "agree a date", "--must", "price", "--must", "downtime", "--note", "prefers WhatsApp; calls after 5", "--json");
    assert.equal(a.code, 0, a.out + a.err);
    const file = join(r.dir, "briefs", "latest.yaml");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const b = trayLib.readBrief(file);
    assert.equal(b.who, "Dana Levi"); assert.deepEqual(b.mustCover, ["price", "downtime"]);
    assert.ok(b.notes.includes("Call kind: vendor") && b.notes.includes("Topic: hosting move"));
    const e = await r.run("prepare", "--add-must", "backups", "--goal", "new goal", "--json");   // prepare = plan set when flags come first
    assert.equal(e.code, 0, e.out);
    assert.equal(e.json.plan.who, "Dana Levi", "untouched fields are kept"); assert.equal(e.json.plan.goal, "new goal");
    assert.deepEqual(e.json.plan.mustCover, ["price", "downtime", "backups"]);
    assert.equal(e.json.plan.kind, "vendor");
    assert.equal((await r.run("plan", "set", "--kind", "wizard", "--json")).code, 2);
    const att = await r.run("plan", "attach", "--text", "Invented background: Levi Studio runs 12 WordPress sites.", "--json");
    assert.equal(att.code, 0, att.out);
    const md = join(r.dir, "offer.md"); writeFileSync(md, "# Offer\nHosting 49 per month (invented).");
    const att2 = await r.run("plan", "attach", "--file", md, "--json");
    assert.equal(att2.json.attachments.length, 2);
    assert.equal((await r.run("plan", "attach", "--file", join(r.dir, "x.exe"), "--json")).code, 5);
    writeFileSync(join(r.dir, "bin.dat"), "x"); assert.equal((await r.run("plan", "attach", "--file", join(r.dir, "bin.dat"), "--json")).code, 1);
    const show = await r.run("plan", "show", "--json");
    assert.equal(show.json.plan.attachments.length, 2);
    assert.ok(!JSON.stringify(show.json).includes("Levi Studio runs"), "background text is not echoed");
    assert.equal((await r.run("plan", "detach", att.json.id, "--json")).code, 0);
    assert.equal((await r.run("plan", "detach", att.json.id, "--json")).code, 5);
    assert.equal((await r.run("plan", "clear", "--json")).code, 0);
    assert.equal((await r.run("plan", "show", "--json")).json.plan.ready, false);
    assert.equal(existsSync(file), false);
  } finally { await r.done(); }
});

function makeCall(callsDir: string, id: string) {
  const d = join(callsDir, id); mkdirSync(d, { recursive: true });
  const t0 = Date.parse("2026-11-02T09:00:00Z");
  const j = (rows: object[]) => rows.map((x) => JSON.stringify(x)).join("\n") + "\n";
  writeFileSync(join(d, "call.json"), JSON.stringify({ startedAt: new Date(t0).toISOString(), endedAt: new Date(t0 + 120000).toISOString(), mode: "file", profile: "demo" }));
  writeFileSync(join(d, "transcript.jsonl"), j([{ t: t0 + 1000, ch: "them", text: "How much is hosting?" }, { t: t0 + 9000, ch: "me", text: "Let me check." }]));
  writeFileSync(join(d, "cards.jsonl"), j([{ id: "c1", turnId: "t1", badge: "bank", question: "How much is hosting?", say: "Invented card: ask about traffic first.", at: t0 + 2000 }]));
  writeFileSync(join(d, "events.jsonl"), j([{ t: t0, type: "start" }, { t: t0 + 120000, type: "end" }]));
  writeFileSync(join(d, "summary.json"), JSON.stringify({ v: 1, generatedAt: "x", model: "scripted", summary: ["Talked about hosting."], decisions: ["Move in December"], nextSteps: [{ who: "דן", what: "Send an offer" }], openQuestions: ["Backup size?"], followUpEmail: "Hi Dana,\nthanks for the call.\nDan", costUsd: 0 }));
}

test("calls: list, show, summary, email, rate, purge (needs --yes), live snapshot", async () => {
  const r = await rig();
  const id = "01HXTESTCALL0000000000AAAA";
  try {
    makeCall(join(r.dir, "calls"), id);
    const l = await r.run("calls", "list", "--json");
    assert.equal(l.json.calls[0].id, id); assert.equal(l.json.calls[0].hasSummary, true);
    const s = await r.run("calls", "show", "latest", "--json");
    assert.equal(s.json.transcript.length, 2); assert.equal(s.json.cards[0].id, "c1");
    assert.match((await r.run("calls", "summary", id)).out, /Move in December/);
    assert.match((await r.run("calls", "email", id)).out, /thanks for the call/);
    assert.equal((await r.run("calls", "rate", id, "c1", "y", "--json")).code, 0);
    assert.equal((await r.run("calls", "show", id, "--json")).json.cards[0].rating, "y");
    assert.equal((await r.run("calls", "rate", id, "nope", "y", "--json")).code, 5);
    assert.equal((await r.run("calls", "rate", id, "c1", "maybe", "--json")).code, 2);
    const lv = await r.run("live", "--id", id, "--json");
    assert.equal(lv.code, 0, lv.out); assert.equal(lv.json.lines[0].cards[0].say.startsWith("Invented card"), true);
    assert.equal((await r.run("live", "--follow", "--id", id, "--json")).code, 4, "follow needs a running call");
    assert.equal((await r.run("calls", "show", "../etc", "--json")).code, 2);
    assert.equal((await r.run("calls", "show", "01HXTESTCALL0000000000ZZZZ", "--json")).code, 5);
    assert.equal((await r.run("calls", "purge", id, "--json")).code, 6);
    assert.ok(existsSync(join(r.dir, "calls", id)));
    assert.equal((await r.run("calls", "purge", id, "--yes", "--json")).code, 0);
    assert.equal(existsSync(join(r.dir, "calls", id)), false);
    assert.equal((await r.run("calls", "summary", "latest", "--json")).code, 5);
  } finally { await r.done(); }
});

test("settings: list/get/set use the app's catalog and validation; keys.* is off limits", async () => {
  const r = await rig();
  try {
    const l = await r.run("settings", "list", "--json");
    assert.ok(l.json.settings.some((s: any) => s.key === "cards.maxPerMinute"));
    assert.equal((await r.run("settings", "set", "cards.maxPerMinute", "7", "--json")).code, 0);
    assert.equal((await r.run("settings", "get", "cards.maxPerMinute", "--json")).json.setting.value, 7);
    assert.equal((await r.run("settings", "set", "cards.maxPerMinute", "0", "--json")).code, 2);
    assert.equal((await r.run("settings", "set", "run.noAi", "off", "--json")).code, 0);
    assert.equal((await r.run("settings", "get", "run.noAi", "--json")).json.setting.value, false);
    assert.equal((await r.run("settings", "set", "stt.language", "klingon", "--json")).code, 2);
    assert.equal((await r.run("settings", "set", "cards.maxPerMinute", "default", "--json")).code, 0);
    assert.equal((await r.run("settings", "get", "cards.maxPerMinute", "--json")).json.setting.changed, false);
    assert.equal((await r.run("settings", "set", "keys.file", "/tmp/x", "--advanced", "--json")).code, 4);
    assert.equal((await r.run("settings", "set", "audio.mic.device", ":1", "--json")).code, 5, "not in the catalog without --advanced");
    assert.equal((await r.run("settings", "set", "nope.nothing", "1", "--advanced", "--json")).code, 5);
    assert.ok(statSync(join(r.dir, "settings.yaml")).mode & 0o600);
  } finally { await r.done(); }
});

test("keys: status only, never a value or its last characters; set/migrate refused", async () => {
  const r = await rig();
  try {
    const secret = "sk-ant-api03-SUPERSECRETVALUE1234";
    const keychain = { get: (p: string) => (p === "anthropic" ? secret : null), set: () => true, remove: () => false };
    let out = "";
    const code = await main(["keys", "status", "--json"], { env: { ...r.env, WINGMAN_KEYS_FILE: join(r.dir, "nokeys.env"), DEEPGRAM_API_KEY: "" }, keychain, out: (s) => { out += s; }, err: () => {} });
    assert.equal(code, 7, "deepgram missing -> not ready");
    const j = JSON.parse(out);
    assert.equal(j.keys.find((k: any) => k.key === "anthropic").present, true);
    assert.equal(j.keys.find((k: any) => k.key === "deepgram").present, false);
    assert.ok(!out.includes(secret) && !out.includes("1234") && !out.includes("sk-ant"));
    for (const sub of ["set", "migrate", "remove"]) assert.equal((await r.run("keys", sub, "deepgram", "--json")).code, 4);
  } finally { await r.done(); }
});

test("help: agent manual mentions every command; exit codes documented; usage errors exit 2", async () => {
  const r = await rig();
  try {
    for (const w of ["status", "doctor", "plan", "prepare", "start", "stop", "ask", "live", "calls", "settings", "keys status", "app open", "--json", "--yes", "EXIT CODES"]) assert.ok(HELP.includes(w), w);
    const h = await r.run("help"); assert.equal(h.code, 0); assert.match(h.out, /for an AI agent/);
    assert.equal((await r.run("help", "--json")).json.ok, true);
    assert.equal((await r.run("start", "--bogus", "--json")).code, 2);
    assert.equal((await r.run("start", "--practice", "--no-ai", "--json")).code, 2);
    assert.equal((await r.run("nonsense", "--json")).code, 2);
    assert.equal((await r.run("doctor", "--help")).code, 0);
  } finally { await r.done(); }
});

test("doctor: runs directly when the app is not there (scripted runner), exit 7 on NOT READY", async () => {
  const dir = tmp("doc");
  try {
    const env = { ...process.env, WINGMAN_CONTROL_SOCKET: join(dir, "none.sock"), WINGMAN_CALLS_DIR: dir, WINGMAN_BRIEFS_DIR: dir, WINGMAN_USER_SETTINGS: join(dir, "s.yaml") };
    const run = (out: string) => { let o = ""; return main(["doctor", "--offline", "--json"], { env, out: (s) => { o += s; }, err: () => {}, spawnTsx: async () => ({ code: 1, out }) }).then((code) => ({ code, j: JSON.parse(o) })); };
    const bad = await run("Wingman doctor\n  ❌ DEEPGRAM_API_KEY missing\n     fix: add it\nNOT READY\n");
    assert.equal(bad.code, 7); assert.equal(bad.j.failing[0].fix, "add it");
    const ok = await run("  ⚠️  only one screen\n     fix: connect it\nREADY WITH WARNINGS\n");
    assert.equal(ok.code, 0); assert.equal(ok.j.warnings.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("hidden instance: the real controller + scripted engine (file mode) driven through the socket by the CLI", { timeout: 90_000 }, async () => {
  const dir = tmp("eng");
  const wav = join(dir, "silence.wav");
  await writeWav(wav, Buffer.alloc(16000 * 2 * 2 * 30), 2);
  // Same controller as the app; only the child command is swapped from call.ts (which opens the answer window) to run.ts in scripted file mode.
  const realSpawn = spawn;
  const spawnEngine = (bin: string, args: string[], opts: any) => realSpawn(bin, [join(ROOT, "src", "run.ts"), "--profile", "e2e", "--file", wav, "--no-brief"], {
    ...opts, env: { ...opts.env, WINGMAN_CALLS_DIR: join(dir, "calls"), WINGMAN_STT_SCRIPT: join(ROOT, "data", "test", "e2e-call.json"), WINGMAN_SCRIPT_GAP_MS: "1100" },
  });
  const r = await rig({ spawn: spawnEngine, callsDir: join(dir, "calls") });
  try {
    const s = await r.run("start", "--json");
    assert.equal(s.code, 0, s.out + s.err);
    assert.ok(["live", "waiting"].includes(s.json.phase), s.out);
    assert.equal((await r.run("start", "--json")).code, 4, "no second engine");
    let id = "", lines = 0;
    for (let i = 0; i < 60 && !lines; i++) {
      await new Promise((res) => setTimeout(res, 500));
      const st = await r.run("status", "--json"); id = st.json.call.callId;
      const lv = await r.run("live", "--json").catch(() => undefined);
      lines = lv?.json?.lines?.length ?? 0;
    }
    assert.ok(id && lines > 0, "transcript lines are readable through the CLI while the call runs");
    assert.equal((await r.run("note", "invented note about a server move", "--json")).code, 0);
    assert.equal((await r.run("quiet", "on", "--json")).code, 0);
    assert.equal((await r.run("quiet", "off", "--json")).code, 0);
    const aq = await r.run("ask", "what was the price", "--json");
    assert.equal(aq.code, 0); assert.equal(aq.json.engineSupportsAsk, true);
    assert.equal((await r.run("ask", "--listen", "--json")).code, 0);
    const stop = await r.run("stop", "--json");
    assert.equal(stop.code, 0, stop.out); assert.equal(stop.json.finished, true);
    const list = await r.run("calls", "list", "--json");
    assert.ok(list.json.calls.some((c: any) => c.id === id), "the call was saved in the temp calls dir");
    const events = readFileSync(join(dir, "calls", id, "events.jsonl"), "utf8");
    assert.match(events, /context\.note/);
    assert.match(events, /"reason":"typed"/, "the typed question reached the engine as a forced question");
    assert.equal((await r.run("calls", "purge", id, "--yes", "--json")).code, 0);
  } finally { await r.done(); rmSync(dir, { recursive: true, force: true }); }
});

test("stop --no-summary: keeps the call, sends stop-no-summary, refuses --delete, help documents it", async () => {
  const r = await rig();
  try {
    assert.ok(HELP.includes("--no-summary"));
    await r.run("start", "--json", "--no-wait");
    const c = r.f.spawned[0]; c.say("consented", { id: "S3" });
    assert.equal((await r.run("stop", "--no-summary", "--delete", "--yes", "--json")).code, 2);
    const st = await r.run("stop", "--no-summary", "--json", "--no-wait");
    assert.equal(st.code, 0, st.out); assert.deepEqual(c.written, ["stop-no-summary\n"]);
    assert.equal(st.json.summarySkipped, true); assert.equal(st.json.deleted, false);
    r.f.spawned[0].emit("exit", 0);
    const again = await r.run("start", "--json", "--no-wait"); const c2 = r.f.spawned[1]; c2.say("consented", { id: "S5" });
    assert.match((await r.run("stop", "--no-summary", "--no-wait")).out, /wingman calls summary S5 --generate/);
  } finally { await r.done(); }
});

test("status: shows the seconds left while Ctrl+Opt+A is armed (--json: questionSecondsLeft)", async () => {
  const r = await rig();
  try {
    await r.run("start", "--no-wait", "--json");
    r.f.spawned[0].say("consented", { id: "S4" }); r.f.spawned[0].say("ask", { on: true, until: Date.now() + 9500 });
    const j = (await r.run("status", "--json")).json;
    assert.equal(j.call.listeningForQuestion, true); assert.ok(j.call.questionSecondsLeft >= 8 && j.call.questionSecondsLeft <= 10, String(j.call.questionSecondsLeft));
    assert.match((await r.run("status")).out, /listening for your question \(\d+ s left\)/);
    r.f.spawned[0].say("ask", { on: false });
    assert.equal((await r.run("status", "--json")).json.call.questionSecondsLeft, null);
  } finally { await r.done(); }
});

test("status: shows the stop step while a call is being saved, and the listening-for-question state", async () => {
  const r = await rig();
  try {
    await r.run("start", "--no-wait", "--json");
    r.f.spawned[0].say("consented", { id: "S1" }); r.f.spawned[0].say("ask", { on: true });
    const a = await r.run("status");
    assert.match(a.out, /listening for your question/);
    assert.equal((await r.run("status", "--json")).json.call.aiMode, "ai");
    r.f.spawned[0].say("mode", { noAi: true });
    assert.equal((await r.run("status", "--json")).json.call.aiMode, "prepared-only");
    r.f.spawned[0].say("stopping"); r.f.spawned[0].say("stopphase", { phase: "summary" });
    const b = await r.run("status"), j = (await r.run("status", "--json")).json;
    assert.match(b.out, /stopping .*writing the summary/);
    assert.equal(j.call.stopPhase, "summary"); assert.equal(j.call.listeningForQuestion, false);
  } finally { await r.done(); }
});
