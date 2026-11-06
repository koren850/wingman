// Keychain key management: keychain.ts, keys-cli.ts, env.ts key loading and dashboard/keys-ipc.cjs.
// Everything uses a mocked `security` runner, a fake key and a temp keys.env: no real Keychain, no real keys.
// The fake key must never show up outside the mock store (and its last 4 characters).
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, loadKeysWithSources, loadKeys } from "./env.ts";
import { createKeychain, migrateKeysToKeychain, keyStatus, childEnv, realRunner, checkKeyFormat, type Runner } from "./keychain.ts";
import { main as keysCli } from "./keys-cli.ts";
import { overlayEnv } from "./overlay.ts";
import { loadSettings } from "./settings.ts";
import { assertMode } from "./test-platform.ts";

const require = createRequire(import.meta.url);
const ipc = require("../dashboard/keys-ipc.cjs");
const KEY = "sk-ant-TESTONLY0123456789abcdefghijkl9F2a";
const DG = "dgTESTONLY0123456789abcdefABCDEF1234Zz";
const L4 = KEY.slice(-4);

/** Mock of /usr/bin/security: a Map store, `-i` reads command lines from stdin like the real tool (argv never carries a secret). */
function mockSecurity() {
  const store = new Map<string, string>(), calls: { args: string[]; input?: string }[] = [];
  const run: Runner = (args, input) => {
    calls.push({ args: [...args], input });
    if (args[0] === "-i") {
      for (const line of String(input).split("\n").filter(Boolean)) {
        const t = line.split(/\s+/);
        if (t[0] === "add-generic-password") store.set(t[t.indexOf("-a") + 1], t[t.indexOf("-w") + 1]);
      }
      return { status: 0, stdout: "", stderr: "" };
    }
    const a = args[args.indexOf("-a") + 1];
    if (args[0] === "find-generic-password") return store.has(a) ? { status: 0, stdout: store.get(a) + "\n", stderr: "" } : { status: 44, stdout: "", stderr: "not found" };
    if (args[0] === "delete-generic-password") return store.delete(a) ? { status: 0, stdout: "", stderr: "" } : { status: 44, stdout: "", stderr: "" };
    return { status: 1, stdout: "", stderr: "bad" };
  };
  return { run, store, calls };
}
const tmpHome = () => mkdtempSync(join(tmpdir(), "wingman-keys-"));
const fileWith = (lines: string) => { const f = join(tmpHome(), "keys.env"); writeFileSync(f, lines, { mode: 0o600 }); return f; };
// Needles found in the haystack: the tests assert this list is empty, so a failure names the leaked secret.
const leaks = (hay: string, ...needles: string[]) => needles.filter((n) => hay.includes(n));

function host(opts: { file: string; fetch?: typeof fetch; confirm?: number; env?: NodeJS.ProcessEnv }) {
  const m = mockSecurity();
  const handlers = new Map<string, (...a: any[]) => any>();
  let now = 1000;
  ipc.register({ handle: (n: string, fn: any) => handlers.set(n, fn), getWin: () => ({}), dialog: { showMessageBoxSync: () => opts.confirm ?? 1 }, keysFile: async () => opts.file, fake: "", run: m.run, env: opts.env ?? {}, fetch: opts.fetch, now: () => now });
  const call = (n: string, ...a: any[]) => handlers.get(n)!(...a);
  return { m, call, tick: (ms: number) => { now += ms; } };
}

test("write goes through `security -i` stdin: the secret is never in argv, read-back verifies, delete works", () => {
  const m = mockSecurity(), kc = createKeychain(m.run);
  assert.equal(kc.set("anthropic", KEY), true);
  assert.equal(kc.get("anthropic"), KEY);
  assert.deepEqual(m.calls.filter((c) => c.args.join(" ").includes(KEY)), [], "secret in argv");
  assert.deepEqual(m.calls[0].args, ["-i"]);
  assert.match(m.calls[0].input!, /^add-generic-password -U -s wingman -a ANTHROPIC_API_KEY -w sk-ant-/);
  assert.equal(kc.remove("anthropic"), true); assert.equal(kc.get("anthropic"), null);
});

test("a write that security silently ignored is caught by the read-back, with a generic error", () => {
  const kc = createKeychain(() => ({ status: 0, stdout: "", stderr: "" }));
  assert.throws(() => kc.set("anthropic", KEY), (e: Error) => !e.message.includes(KEY) && /did not return/.test(e.message));
});

test("secrets that could break the stdin command line are refused (quotes, backslash, whitespace, newline, control, leading dash)", () => {
  const kc = createKeychain(mockSecurity().run);
  for (const bad of ["a\"b".padEnd(30, "x"), "a'b".padEnd(30, "x"), "a\\b".padEnd(30, "x"), "ab cd".padEnd(30, "x"), "x".repeat(25) + "\nadd-generic-password -s evil", "x".repeat(25) + "\t", "x".repeat(25) + "\u0007", "-" + "x".repeat(25), "x".repeat(25) + "é"])
    assert.throws(() => kc.set("deepgram", bad), (e: Error) => !e.message.includes("xxxx"), JSON.stringify(bad));
  assert.throws(() => kc.set("openai" as any, KEY));
});

test("format checks: length, charset, sk-ant- prefix, provider allow-list; messages never echo the value", () => {
  assert.equal(checkKeyFormat("anthropic", KEY), null);
  assert.equal(checkKeyFormat("deepgram", DG), null);
  for (const [p, v] of [["anthropic", "sk-ant-short"], ["anthropic", "x".repeat(40)], ["deepgram", "a".repeat(301)], ["deepgram", "a b".repeat(10)], ["deepgram", 12345], ["nope", DG], ["deepgram", null]] as const) {
    const msg = checkKeyFormat(p, v as any); assert.ok(msg, `${p} ${String(v)}`); assert.ok(!msg!.includes(String(v)) || String(v).length < 8);
  }
});

test("load order: process env, then Keychain, then keys.env; sources reported, keys not written anywhere", () => {
  const m = mockSecurity(), kc = createKeychain(m.run), file = fileWith(`DEEPGRAM_API_KEY=${DG}\nANTHROPIC_API_KEY=file-${KEY}\nGROQ_API_KEY=groq-from-file\n`);
  kc.set("anthropic", KEY);
  let r = loadKeysWithSources(file, {}, kc);
  assert.deepEqual(r.sources, { deepgram: "file", anthropic: "keychain", groq: "file" }); assert.equal(r.keys.anthropic, KEY);
  r = loadKeysWithSources(file, { ANTHROPIC_API_KEY: "env-" + KEY }, kc);
  assert.equal(r.sources.anthropic, "env");
  assert.equal(loadKeys(file, {}).anthropic, `file-${KEY}`, "no keychain unless asked: tests never reach the real one");
});

test("the real runner refuses to run under the test runner", () => {
  assert.equal(realRunner(["find-generic-password", "-s", "wingman", "-a", "X", "-w"]).status, 126);
});

test("keys:set / status / test / remove: the fake key never appears in anything returned, logged or thrown", async () => {
  const file = fileWith("OTHER=1\n");
  const logs: string[] = [], orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of ["log", "error", "warn", "info"] as const) (console as any)[k] = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  const seen: string[] = []; let reqHeaders = "";
  const fetchMock = (async (url: string, init: any) => { reqHeaders = JSON.stringify(init.headers); return { status: 200 }; }) as any;
  const h = host({ file, fetch: fetchMock });
  try {
    seen.push(JSON.stringify(await h.call("keys:status")));
    seen.push(JSON.stringify(await h.call("keys:set", "anthropic", KEY)));
    seen.push(JSON.stringify(await h.call("keys:status")));
    seen.push(JSON.stringify(await h.call("keys:test", "anthropic")));
    for (const bad of [KEY.replace("sk-ant-", "xx-"), "bad key " + KEY]) { const r = await h.call("keys:set", "anthropic", bad); assert.equal(r.ok, false); seen.push(JSON.stringify(r)); }
    for (const [n, a] of [["keys:set", ["bogus", KEY]], ["keys:test", ["../x"]], ["keys:remove", [{}]]] as const) { try { await h.call(n, ...a); assert.fail("accepted"); } catch (e) { seen.push(String((e as Error).stack)); } }
    seen.push(JSON.stringify(await h.call("keys:remove", "anthropic")));
  } finally { Object.assign(console, orig); }
  const all = seen.join("\n") + logs.join("\n");
  assert.deepEqual(leaks(all, KEY), [], "key leaked");
  assert.ok(reqHeaders.includes(KEY), "the test request itself must carry the key (and only that)");
  assert.ok(JSON.parse(seen[2]).providers.anthropic.last4 === L4);
  assert.equal(JSON.parse(seen[2]).providers.anthropic.source, "keychain");
  assert.equal(h.m.store.size, 0, "removed");
  assert.deepEqual(readdirSync(join(file, "..")), ["keys.env"], "nothing else written");
  assert.equal(readFileSync(file, "utf8"), "OTHER=1\n");
});

test("keys:test maps 200 to ok, 401 to invalid, errors and 5xx to network; nothing but the result comes back", async () => {
  const file = fileWith("");
  for (const [status, want] of [[200, "ok"], [401, "invalid"], [403, "invalid"], [500, "network"]] as const) {
    const h = host({ file, fetch: (async () => ({ status })) as any }); await h.call("keys:set", "deepgram", DG);
    assert.deepEqual(await h.call("keys:test", "deepgram"), { ok: true, result: want });
  }
  const h = host({ file, fetch: (async () => { throw new Error("boom " + DG); }) as any }); await h.call("keys:set", "deepgram", DG);
  assert.deepEqual(await h.call("keys:test", "deepgram"), { ok: true, result: "network" });
});

test("set and test share a limit of 5 per minute", async () => {
  const h = host({ file: fileWith(""), fetch: (async () => ({ status: 200 })) as any });
  for (let i = 0; i < 5; i++) assert.equal((await h.call("keys:set", "anthropic", KEY)).ok, true);
  const r = await h.call("keys:set", "anthropic", KEY); assert.equal(r.ok, false); assert.match(r.message, /Too many/);
  assert.equal((await h.call("keys:test", "anthropic")).ok, false);
  h.tick(61000);
  assert.equal((await h.call("keys:test", "anthropic")).ok, true);
});

test("remove asks for confirmation; Cancel keeps the key", async () => {
  const h = host({ file: fileWith(""), confirm: 0 });
  await h.call("keys:set", "deepgram", DG);
  const r = await h.call("keys:remove", "deepgram"); assert.equal(r.cancelled, true); assert.equal(h.m.store.size, 1);
});

test("migrate: moves both keys, keeps other lines, file is 600, NO backup left behind, idempotent, no value in the result", async () => {
  const text = `# my keys\nDEEPGRAM_API_KEY=${DG}\nANTHROPIC_API_KEY="${KEY}"\nGROQ_API_KEY=keep-me\n`;
  const file = fileWith(text), dir = join(file, "..");
  const h = host({ file });
  const r = await h.call("keys:migrate");
  assert.equal(JSON.stringify(r).includes(KEY) || JSON.stringify(r).includes(DG), false);
  assert.deepEqual(r.moved, ["deepgram", "anthropic"]);
  assert.equal(h.m.store.get("ANTHROPIC_API_KEY"), KEY); assert.equal(h.m.store.get("DEEPGRAM_API_KEY"), DG);
  assert.equal(readFileSync(file, "utf8"), "# my keys\nGROQ_API_KEY=keep-me\n");
  assertMode(file, 0o600);
  assert.deepEqual(readdirSync(dir), ["keys.env"]);   // no plaintext backup, no temp file
  const again = await h.call("keys:migrate"); assert.deepEqual(again.moved, []); assert.deepEqual(readdirSync(dir), ["keys.env"]);
});

test("migrate: a failed write keeps that line in the file; an existing Keychain value is never overwritten", () => {
  const m = mockSecurity(), kc = createKeychain((a, i) => (a[0] === "-i" && String(i).includes("DEEPGRAM") ? { status: 1, stdout: "", stderr: DG } : m.run(a, i)));
  const file = fileWith(`DEEPGRAM_API_KEY=${DG}\nANTHROPIC_API_KEY=file-${KEY}\n`);
  m.store.set("ANTHROPIC_API_KEY", KEY);
  const r = migrateKeysToKeychain({ keychain: kc, file });
  assert.deepEqual(r.alreadyInKeychain, ["anthropic"]); assert.equal(r.failed.length, 1); assert.deepEqual(r.moved, []);
  assert.equal(JSON.stringify(r).includes(DG), false);
  assert.equal(m.store.get("ANTHROPIC_API_KEY"), KEY);
  assert.match(readFileSync(file, "utf8"), /DEEPGRAM_API_KEY=/);
});

test("status: source and last 4 only", () => {
  const m = mockSecurity(), kc = createKeychain(m.run), file = fileWith(`DEEPGRAM_API_KEY=${DG}\n`);
  kc.set("anthropic", KEY);
  const st = keyStatus({ keychain: kc, file, env: {} });
  assert.equal(st.anthropic.source, "keychain"); assert.equal(st.deepgram.source, "file"); assert.equal(st.deepgram.last4, DG.slice(-4));
  assert.deepEqual(leaks(JSON.stringify(st), KEY, DG), []);
});

test("CLI: set reads the hidden prompt (never argv), status/remove/migrate print no values", async () => {
  const m = mockSecurity(), kc = createKeychain(m.run), file = fileWith(`DEEPGRAM_API_KEY=${DG}\n`), out: string[] = [];
  const o = { keychain: kc, keysFile: file, out: (s: string) => out.push(s) };
  assert.equal(await keysCli(["set", "anthropic"], { ...o, readSecret: async () => KEY + "\n" }), 0);
  assert.equal(await keysCli(["set", "anthropic", KEY], { ...o, readSecret: async () => "x" }), 1, "an argv value is ignored: prompt value is validated");
  assert.equal(await keysCli(["status"], o), 0); assert.equal(await keysCli(["migrate"], o), 0); assert.equal(await keysCli(["remove", "anthropic"], o), 0);
  assert.deepEqual(leaks(out.join("\n"), KEY, DG), []);
  assert.ok(out.some((l) => l.includes(L4)));
  assert.equal(m.store.has("ANTHROPIC_API_KEY"), false);
});

test("children that do not need keys get no key env (overlay, ffmpeg...)", () => {
  const saved = { ...process.env };
  try {
    process.env.ANTHROPIC_API_KEY = KEY; process.env.DEEPGRAM_API_KEY = DG; process.env.OPENAI_API_KEY = "o"; process.env.GROQ_API_KEY = "g";
    const e = childEnv(); for (const k of Object.keys(e)) assert.ok(!/_API_KEY$|GENERATIVE_AI_API_KEY/.test(k), k);
    const o = overlayEnv(loadSettings({ argv: [], env: {} }).settings);
    assert.deepEqual(Object.keys(o).filter((k) => /API_KEY/.test(k)), []); assert.ok(!JSON.stringify(o).includes(KEY));
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
  const run = readFileSync(join(ROOT, "src/run.ts"), "utf8");
  assert.match(run, /for \(const v of KEY_ENV_VARS\) delete process\.env\[v\]/);
  assert.match(run, /spawn\("caffeinate"[\s\S]*?env: childEnv\(\)/);
  const audio = readFileSync(join(ROOT, "src/audio.ts"), "utf8");
  assert.equal((audio.match(/spawn\("ffmpeg"/g) || []).length, (audio.match(/env: childEnv\(\)/g) || []).length);
});

test("static: key values can only reach memory; no logging or persistence path touches them", () => {
  const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
  // 1. Modules that load or handle keys: an explicit allow-list. Anything else importing them is a new leak path to review.
  const users = ["src/env.ts", "src/keychain.ts", "src/keys-cli.ts", "src/doctor.ts", "src/call.ts", "src/run.ts", "src/gate.ts", "src/summary.ts", "src/settings-cli.ts", "src/providers/llm.ts", "src/keys.test.ts", "src/stt.ts", "src/providers/stt/channel.ts", "src/overlay.ts", "src/audio.ts", "src/cli/status.ts"];   // cli/status.ts: `wingman keys status`, present/missing only (asserted in cli.test.ts)
  const walk = (d: string): string[] => readdirSync(join(ROOT, d), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === "node_modules" ? [] : walk(join(d, e.name))) : [join(d, e.name)]);
  const files = ["src", "tray", "dashboard", "overlay", "qa"].flatMap(walk).filter((f) => /\.(ts|cjs|js)$/.test(f));
  for (const f of files) {
    const t = read(f);
    if (/(?:require|from)\s*\(?\s*["'][^"']*keychain|loadKeys|requireKeys|KEY_VARS/.test(t) && !users.includes(f) && !/^src\/(.*\.test\.ts|settings-edit-cli\.ts)$/.test(f) && !/^dashboard\/(keys-ipc|window)\.cjs$|^src\/keychain\.cjs$/.test(f)) assert.fail(`${f} touches keys and is not on the reviewed list`);
  }
  // 2. The key modules never log or persist anything themselves, and the window host never logs IPC args.
  for (const f of ["src/keychain.cjs", "dashboard/keys-ipc.cjs"]) assert.doesNotMatch(read(f), /console\.|logLine|appendFile|process\.stdout|process\.stderr|JSON\.stringify\(\s*(value|key)\b/, f);
  assert.doesNotMatch(read("dashboard/window.cjs"), /console\./);
  // 3. Writers of calls/, tray.log, events, settings YAML and snapshots do not know about keys at all.
  for (const f of ["src/log.ts", "src/settings-edit.ts", "tray/controller.cjs", "tray/lib.cjs", "dashboard/livetail.cjs", "dashboard/lib.cjs", "src/notes.ts", "src/summary.ts"]) assert.doesNotMatch(read(f).replace(/requireKeys\([^)]*\)|import[^\n]*env\.ts[^\n]*/g, ""), /keychain|\bkeys\.(deepgram|anthropic)\b|API_KEY/i, f);
  // 4. Snapshot hook never reaches the Keychain; set/test are rate limited; only the sender-checked handle() registers handlers.
  assert.match(read("dashboard/window.cjs"), /fake: process\.env\.WINGMAN_DASHBOARD_FAKE_KEYS \|\| \(SNAP \? "missing" : ""\)/);
  assert.doesNotMatch(read("dashboard/keys-ipc.cjs"), /ipcMain/);
  assert.match(read("dashboard/keys-ipc.cjs"), /keys:set[\s\S]{0,300}limit\(\)/);
  // 4b. Migration has exactly two triggers: the button's IPC and the CLI. Never startup.
  const callers = files.filter((f) => /migrateKeysToKeychain|keysMigrate|keys:migrate/.test(read(f)) && !/\.test\.ts$/.test(f)).sort();
  assert.deepEqual(callers, ["dashboard/keys-ipc.cjs", "dashboard/preload.cjs", "dashboard/settings.js", "src/keychain.cjs", "src/keychain.ts", "src/keys-cli.ts"]);
  assert.doesNotMatch(read("tray/main.cjs"), /migrateKeys|keysMigrate|keys:migrate/);   // (the data-folder copy in shared/migrate.cjs is unrelated)
  // 5. Renderer: password input, no value in state/storage/attributes.
  const ui = read("dashboard/settings.js");
  assert.match(ui, /type: "password", id, autocomplete: "off", spellcheck: "false"/);
  assert.doesNotMatch(ui, /localStorage|sessionStorage/);
  assert.match(ui, /const v = inp\.value; inp\.value = ""/);
});

test("migrate refuses a keys.env that is a symlink and never follows a pre-placed temp or backup symlink", async () => {
  const { symlinkSync, mkdirSync } = await import("node:fs");
  const dir = tmpHome(), real = join(dir, "real.env"), victim = join(dir, "victim.txt");
  writeFileSync(real, `DEEPGRAM_API_KEY=${DG}\n`, { mode: 0o600 }); writeFileSync(victim, "precious");
  const link = join(dir, "keys.env"); symlinkSync(real, link);
  const m = mockSecurity();
  assert.throws(() => migrateKeysToKeychain({ keychain: createKeychain(m.run), file: link }), /link or not a regular file/);
  assert.equal(m.store.size, 0); assert.match(readFileSync(real, "utf8"), /DEEPGRAM_API_KEY=/);
  // pre-placed symlinks at the old predictable names (keys.env.tmp-<pid>, keys.env.bak-<date>) must not redirect any write
  const file = join(dir, "sub-keys.env"); writeFileSync(file, `DEEPGRAM_API_KEY=${DG}\n`, { mode: 0o600 });
  for (const n of [`sub-keys.env.tmp-${process.pid}`, `sub-keys.env.bak-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`]) symlinkSync(victim, join(dir, n));
  const r = migrateKeysToKeychain({ keychain: createKeychain(m.run), file });
  assert.deepEqual(r.moved, ["deepgram"]); assert.equal(readFileSync(victim, "utf8"), "precious"); assert.equal(readFileSync(file, "utf8"), "");
  assert.equal(r.backup, null);
});

test("migrate: a line edited while the migration ran is not overwritten; a failed keychain write leaves the file byte-identical", () => {
  const m = mockSecurity(), file = fileWith(`DEEPGRAM_API_KEY=${DG}\n`);
  const kc = createKeychain((a, i) => { const r = m.run(a, i); if (a[0] === "-i") writeFileSync(file, `DEEPGRAM_API_KEY=${DG}-changed-by-user\n`, { mode: 0o600 }); return r; });
  migrateKeysToKeychain({ keychain: kc, file });
  assert.equal(readFileSync(file, "utf8"), `DEEPGRAM_API_KEY=${DG}-changed-by-user\n`);
  const m2 = mockSecurity(), f2 = fileWith(`# x\nDEEPGRAM_API_KEY=${DG}\n`), before = readFileSync(f2, "utf8");
  const bad = createKeychain((a, i) => (a[0] === "-i" ? { status: 1, stdout: "", stderr: "" } : m2.run(a, i)));
  const r = migrateKeysToKeychain({ keychain: bad, file: f2 });
  assert.equal(r.failed.length, 1); assert.equal(readFileSync(f2, "utf8"), before);
});

test("IPC sender check: only the dashboard window's main frame on our own page is accepted", () => {
  const win = require("../dashboard/window.cjs");
  const wc = { mainFrame: { url: "file:///app/dashboard/index.html?view=settings" } };
  const w = { isDestroyed: () => false, webContents: wc };
  assert.equal(win.isDashboardSender({ sender: wc, senderFrame: wc.mainFrame }, w), true);
  assert.equal(win.isDashboardSender({ sender: wc, senderFrame: { url: wc.mainFrame.url } }, w), false);          // sub-frame / iframe
  assert.equal(win.isDashboardSender({ sender: wc, senderFrame: null }, w), false);
  assert.equal(win.isDashboardSender({ sender: {}, senderFrame: wc.mainFrame }, w), false);                       // overlay / prompt / practice
  assert.equal(win.isDashboardSender({ sender: wc, senderFrame: wc.mainFrame }, undefined), false);
  const nav = { mainFrame: { url: "https://evil.example/dashboard/index.html" } };
  assert.equal(win.isDashboardSender({ sender: nav, senderFrame: nav.mainFrame }, { isDestroyed: () => false, webContents: nav }), false);   // navigated away
});

test("remove and migrate have their own rate limit; settings children get no key env; test refuses header-unsafe keys", async () => {
  const h = host({ file: fileWith(""), confirm: 0 });
  await h.call("keys:set", "deepgram", DG);
  for (let i = 0; i < 5; i++) await h.call("keys:remove", "deepgram");
  assert.match((await h.call("keys:remove", "deepgram")).message, /Too many/);
  assert.match((await h.call("keys:migrate")).message, /Too many/);
  assert.match(readFileSync(join(ROOT, "dashboard/window.cjs"), "utf8"), /settingsEnv = \(\) => \(\{ \.\.\.require\("\.\.\/src\/keychain\.cjs"\)\.childEnv/);
  const { testKey } = await import("./keychain.ts");
  let called = false;
  assert.equal(await testKey("deepgram", "abc\r\nX-Evil: 1", (async () => { called = true; return { status: 200 }; }) as any), "invalid"); assert.equal(called, false);
});
