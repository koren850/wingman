// `wingman diagnose`: the report holds ids, counts, lengths and health/ladder events, and never transcript text, card text, emails, phone numbers or keys.
// All data below is invented.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli/index.ts";
import { scrub, scrubDevice, settingValue, buildReport } from "./diagnose.ts";

const ID = "01JTESTDIAGNOSE00000000000";
const SECRET_KEY = "sk-ant-api03-AbCdEf1234567890ZyXwVuTsRq";
const HEX_KEY = "0123456789abcdef0123456789abcdef01234567";
const SAID = "Please send the offer to riverstone.owner@example.org and call 054-5550123 about the ZEBRA-MOON budget";
const ANSWER = "Tell her the price depends on scope, mention ZEBRA-MOON";

function fixture() {
  const tmp = mkdtempSync(join(tmpdir(), "wm-diag-"));
  const calls = join(tmp, "calls");
  const dir = join(calls, ID);
  mkdirSync(dir, { recursive: true });
  const rows = (name: string, list: object[]) => writeFileSync(join(dir, `${name}.jsonl`), list.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(
    join(dir, "call.json"),
    JSON.stringify({
      id: ID,
      startedAt: "2026-11-07T10:00:00.000Z",
      mode: "live",
      model: "anthropic:claude-haiku-5-5",
      prompt: "ab12cd34",
      profile: { name: "Dan Invented" },
      file: "/Users/danfake/Desktop/zebra.wav",
    }),
  );
  rows("transcript", [
    { t: 1, ch: "them", text: SAID },
    { t: 2, ch: "me", text: "ok I will do that" },
  ]);
  rows("cards", [
    { t: 3, type: "card", id: "c1", badge: "ai", say: ANSWER, question: SAID, facts: ["x"], model: "anthropic:claude-haiku-5-5", prompt: "ab12cd34" },
    { t: 4, type: "card", id: "health-stt", badge: "warn", health: true, say: "Speech to text is down", facts: [] },
    { t: 5, type: "capture", kind: "email", value: "riverstone.owner@example.org" },
  ]);
  rows("events", [
    { t: 1, type: "stt", ch: "them", text: SAID },
    { t: 2, type: "me.detect", text: SAID },
    { t: 3, type: "reflex.raw", text: ANSWER },
    { t: 4, type: "ladder", from: 0, to: 4, reasons: ["other side not heard"], idle: false },
    { t: 5, type: "health", id: "stt-them", level: "red", text: "Speech to text is down", note: "Authorization: Bearer " + SECRET_KEY },
    {
      t: 6,
      type: "stt.error",
      ch: "them",
      kind: "network",
      error: `socket closed for riverstone.owner@example.org key=${HEX_KEY} ${SECRET_KEY} at /Users/danfake/x`,
    },
    { t: 7, type: "audio.mic.device", configured: "default", using: "Dana's AirPods Pro", failures: 1 },
    { t: 8, type: "context.note", note: SAID },
    { t: 9, type: "stt.recovered", ch: "them", attempts: 3 },
  ]);
  rows("latency", [{ t: 1, speechEnd: 1000, cardAt: 1900, bankId: "price-stall", q: SAID }]);
  rows("usage", [
    {
      t: 1,
      role: "reflex",
      model: "anthropic:claude-haiku-5-5",
      usage: { inputTokens: 100, outputTokens: 5 },
      providerMetadata: { anthropic: { note: SAID } },
      usd: 0.001,
    },
  ]);
  const settings = join(tmp, "settings.yaml");
  writeFileSync(
    settings,
    [
      "llm:",
      "  reflex:",
      '    model: "anthropic:claude-haiku-5-5"',
      "stt:",
      "  keyterms:",
      "    max: 5",
      "privacy:",
      `  consentText: "Hello, this call is recorded for ${SAID.slice(0, 20)} and mail riverstone.owner@example.org"`,
      "",
    ].join("\n"),
  );
  return { tmp, calls, settings };
}

async function run(args: string[], f: ReturnType<typeof fixture>) {
  const out: string[] = [];
  const code = await main(["diagnose", ...args], {
    env: { ...process.env, WINGMAN_CALLS_DIR: f.calls, WINGMAN_USER_SETTINGS: f.settings },
    userSettings: f.settings,
    calls: f.calls,
    out: (s) => out.push(s),
    err: (s) => out.push(s),
    devices: async () => [{ name: "Dana's AirPods Pro", transport: "bluetooth", defaultInput: true, defaultOutput: true }],
  });
  return { code, out: out.join("") };
}

test("diagnose: the file has the useful parts and none of the words said, no emails, phone numbers or keys", async () => {
  const f = fixture();
  const file = join(f.tmp, "report.json");
  const r = await run([ID, "--out", file], f);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /report\.json/);
  assert.match(r.out, /Check it before you share it/);
  const text = readFileSync(file, "utf8");
  for (const bad of [
    "riverstone",
    "example.org",
    "054-5550123",
    "5550123",
    "ZEBRA",
    "Please send",
    "ok I will do that",
    "price depends on scope",
    SECRET_KEY,
    "AbCdEf1234567890",
    HEX_KEY,
    "danfake",
    "Dan Invented",
    "Dana",
  ])
    assert.ok(!text.includes(bad), `report must not contain "${bad}"`);
  const rep = JSON.parse(text);
  assert.equal(rep.reportVersion, 1);
  assert.match(rep.app.version, /^\d+\.\d+\.\d+/);
  assert.equal(rep.system.node, process.version);
  assert.equal(rep.call.meta.prompt, "ab12cd34");
  assert.deepEqual(
    rep.call.events.map((e: { type: string }) => e.type),
    ["ladder", "health", "stt.error", "audio.mic.device", "stt.recovered"],
    "only health / ladder / stt / audio / error events are kept",
  );
  assert.equal(rep.call.events[0].to, 4);
  assert.equal(rep.call.events[3].using, "<name>'s AirPods Pro");
  assert.equal(rep.call.counts.transcriptByChannel.them.chars, SAID.length, "lengths, not text");
  assert.equal(rep.call.cards[0].sayChars, ANSWER.length);
  assert.equal(rep.call.cards[0].model, "anthropic:claude-haiku-5-5");
  assert.deepEqual(rep.call.latency, [{ t: 1, speechEnd: 1000, cardAt: 1900 }]);
  assert.deepEqual(rep.call.usage[0].tokens, { input: 100, output: 5 });
  assert.equal(rep.devices[0].name, "<name>'s AirPods Pro");
  const changed = rep.settingsChangedFromDefaults;
  assert.ok(
    Object.keys(changed).some((k) => k.startsWith("llm.reflex.model")),
    JSON.stringify(changed),
  );
  const consent = Object.entries(changed).find(([k]) => k.startsWith("privacy.consentText"));
  assert.match(String(consent?.[1]), /^<text, \d+ chars>$/);
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o077, 0, "private file"); // no POSIX modes on Windows
});

test("diagnose: no call id means the latest call; with no calls the file still has app, system and settings", async () => {
  const f = fixture();
  const file = join(f.tmp, "latest.json");
  assert.equal((await run(["--out", file], f)).code, 0);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).call.meta.id, ID);
  const empty = fixture();
  const calls2 = mkdtempSync(join(tmpdir(), "wm-diag-empty-"));
  empty.calls = calls2;
  const file2 = join(empty.tmp, "none.json");
  const r = await run(["--out", file2], empty);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /No saved call/);
  const rep = JSON.parse(readFileSync(file2, "utf8"));
  assert.equal(rep.call, undefined);
  assert.ok(rep.settingsChangedFromDefaults);
});

test("diagnose: a bad call id is refused and an existing --out file is not overwritten", async () => {
  const f = fixture();
  assert.equal((await run(["not-an-id", "--out", join(f.tmp, "x.json")], f)).code, 2);
  const file = join(f.tmp, "once.json");
  assert.equal((await run([ID, "--out", file], f)).code, 0);
  assert.equal((await run([ID, "--out", file], f)).code, 4);
});

test("scrub: emails, phone numbers, key-like strings and home folders", () => {
  assert.equal(scrub("mail a.b+c@mail.example.com now"), "mail <email> now");
  for (const p of ["054-5550123", "+972 54 555 0123", "(555) 010-9999", "0545550123"]) assert.equal(scrub(`call ${p} today`), "call <phone> today", p);
  assert.equal(scrub("sk-ant-api03-AbCdEf1234567890ZyXwVuTsRq"), "<key>");
  assert.equal(scrub("Bearer abcdefghij1234567890"), "<key>");
  assert.equal(scrub("https://x.example/a?api_key=SECRETVALUE&b=1"), "https://x.example/a?api_key=<removed>&b=1");
  assert.equal(scrub("opened /Users/someone/Desktop/f.wav"), "opened /Users/<user>/Desktop/f.wav");
  assert.equal(scrub("2026-11-07T10:00:00.000Z after 12345 ms, 3 retries"), "2026-11-07T10:00:00.000Z after 12345 ms, 3 retries");
  assert.equal(scrubDevice("Dana's AirPods"), "<name>'s AirPods");
  assert.equal(scrubDevice("MacBook Pro Microphone"), "MacBook Pro Microphone");
});

test("settings values: secrets, paths, free text and word lists are not copied", () => {
  assert.equal(settingValue("stt.apiKey", "abc123"), "<removed>");
  assert.equal(settingValue("keys.file", "~/.config/wingman/keys.env"), "<path, 26 chars>");
  assert.equal(settingValue("stt.keyterms.list", ["Zebra", "Moon"]), "<2 items>");
  assert.deepEqual(settingValue("llm.reflex.fallbacks", ["anthropic:claude-haiku-5-5"]), ["anthropic:claude-haiku-5-5"]);
  assert.equal(settingValue("llm.reflex.model", "anthropic:claude-haiku-5-5"), "anthropic:claude-haiku-5-5");
  assert.equal(settingValue("x.y", "sk-ant-api03-AbCdEf1234567890ZyXwVuTsRq"), "<text, 39 chars>");
  assert.equal(settingValue("cards.maxPerMinute", 4), 4);
});

test("scrub: adversarial secrets, credentials in URLs and home folders with spaces or Windows paths", () => {
  const gone = (s: string, secret: string) => assert.ok(!scrub(s).includes(secret), `${s} -> ${scrub(s)}`);
  gone("wss://x.example/v1?access_token=abc123xyz", "abc123xyz");
  gone("https://x.example/?client_secret=hunter22&a=1", "hunter22");
  gone("ANTHROPIC_API_KEY=abcDEF123", "abcDEF123");
  gone("env: DEEPGRAM_API_KEY: abcDEF123", "abcDEF123");
  gone("password: hunter2", "hunter2");
  gone('{"password":"hunter2","a":1}', "hunter2");
  gone("https://user:pw12@host.example/x", "pw12");
  gone("Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz");
  gone("Authorization: Bearer abc.def.ghi-123456", "abc.def.ghi-123456");
  assert.equal(scrub("https://x.example/a?b=1&c=2"), "https://x.example/a?b=1&c=2");
  assert.equal(scrub("/Users/Dana Cohen/Library/x"), "/Users/<user>/Library/x");
  assert.equal(scrub("C:\\Users\\Dana\\AppData\\Local\\x"), "C:\\Users\\<user>\\AppData\\Local\\x");
  assert.equal(scrub("C:\\\\Users\\\\Dana Cohen\\\\x"), "C:\\\\Users\\\\<user>\\\\x");
  assert.equal(scrub("/home/dana/.config"), "/home/<user>/.config");
});

test("scrubDevice: product words stay, any other word (Latin or Hebrew) becomes <name>", () => {
  assert.equal(scrubDevice("Dana Cohen AirPods Pro"), "<name> AirPods Pro");
  assert.equal(scrubDevice("Dana Cohen's MacBook Pro Microphone"), "<name>'s MacBook Pro Microphone");
  assert.equal(scrubDevice("Built-in Microphone"), "Built-in Microphone");
  assert.equal(scrubDevice("האוזניות של דנה"), "<name>");
  assert.equal(scrubDevice("AirPods של דנה כהן"), "AirPods <name>");
  assert.equal(scrubDevice("Jabra Evolve2 65"), "Jabra <name> 65"); // unknown words are cut, even product names
  assert.ok(!scrubDevice("Zebra Moon Headset").includes("Zebra"));
});

test("diagnose: error events never carry quoted text, JSON parser detail or secrets", () => {
  const f = fixture();
  const msg = `Unexpected token 'ש', "שלום, אני "... is not valid JSON`;
  const rows = [
    { type: "notes.error", error: msg },
    { type: "frame.error", error: `Something failed "ZEBRA-MOON offer" access_token=abc123xyz` },
    { type: "me.error", error: "APICallError (HTTP 500): upstream said 'send riverstone now'" },
  ];
  writeFileSync(join(f.calls, ID, "events.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const out = JSON.stringify(buildReport({ appVersion: "0.0.1", callDir: join(f.calls, ID) }));
  for (const bad of ["שלום", "ZEBRA", "abc123xyz", "riverstone"]) assert.ok(!out.includes(bad), bad);
});

test("scrub: kernel and OS version strings stay readable, real phone numbers still go", () => {
  const v = "Darwin Kernel Version 25.1.0: Tue Oct 7 2026; root:xnu-12377.41.6~2/RELEASE_ARM64_T6000";
  assert.equal(scrub(v), v);
  assert.equal(scrub("Windows 10.0.19045"), "Windows 10.0.19045");
  assert.equal(scrub("call 555.010.9999 now"), "call <phone> now");
});
