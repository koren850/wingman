// Layered settings loader (settings.ts + defaults.yaml): precedence, env/CLI mapping, validation errors, redact, starter file.
// Uses a shared temp dir for user and profile files; the real user file is never read.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, SettingsError, parseScalar, flatten, redact, STARTER } from "./settings.ts";

const dir = mkdtempSync(join(tmpdir(), "wingman-settings-"));
const write = (name: string, text: string) => {
  const f = join(dir, name);
  writeFileSync(f, text);
  return f;
};
const load = (o: Parameters<typeof loadSettings>[0] = {}) => loadSettings({ env: {}, userFile: join(dir, "absent.yaml"), ...o });

test("defaults.yaml is complete and valid; legacy behaviour constants are the defaults", () => {
  const { settings: s, sources } = load();
  assert.equal(s.stt.endpointMs, 200);
  assert.equal(s.reflex.stallAfterMs, 1800);
  assert.equal(s.reflex.dropStaleMs, 4000);
  assert.equal(s.cards.maxPerMinute, 3);
  assert.equal(s.cards.windowMs, 60000);
  assert.equal(s.cards.lockoutMs, 1500);
  assert.equal(s.stt.flushFallbackMs, 800);
  assert.equal(s.llm.reflex.maxTokens, 200);
  assert.equal(s.llm.reflex.model, "anthropic:claude-haiku-5-5");
  assert.equal(s.audio.watchdog.silentThemMs, 8000);
  assert.equal(s.audio.watchdog.micSilentMs, 10000);
  assert.equal(s.audio.mic.device, ":default");
  assert.equal(s.stt.provider, "deepgram");
  assert.deepEqual(s.stt.fallback, []);
  assert.ok(Object.values(sources).every((x) => x.layer === "default"));
});

test("precedence: default < user < profile < env < cli, with source tags", () => {
  const user = write("u.yaml", "stt:\n  endpointMs: 500\ncards:\n  maxOnScreen: 5\nreflex:\n  stallAfterMs: 2000\n  dropStaleMs: 5000\n");
  const pdir = join(dir, "profiles");
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(pdir, "x.yaml"), "stt:\n  endpointMs: 600\nreflex:\n  stallAfterMs: 2100\n  dropStaleMs: 5100\n");
  const l = load({
    userFile: user,
    profilesDir: pdir,
    argv: ["--profile", "x", "--endpoint-ms", "900", "--set", "reflex.dropStaleMs=5200"],
    env: { WINGMAN_ENDPOINT_MS: "800" },
  });
  assert.equal(l.settings.stt.endpointMs, 900);
  assert.equal(l.sources["stt.endpointMs"].layer, "cli"); // cli beats env, profile, user
  assert.equal(l.settings.reflex.dropStaleMs, 5200);
  assert.equal(l.sources["reflex.dropStaleMs"].layer, "cli");
  assert.equal(l.settings.reflex.stallAfterMs, 2100);
  assert.equal(l.sources["reflex.stallAfterMs"].layer, "profile"); // profile beats user
  assert.equal(l.settings.cards.maxOnScreen, 5);
  assert.equal(l.sources["cards.maxOnScreen"].layer, "user");
  const e = load({ userFile: user, env: { WINGMAN_ENDPOINT_MS: "800" } });
  assert.equal(e.settings.stt.endpointMs, 800);
  assert.equal(e.sources["stt.endpointMs"].layer, "env"); // env beats user
});

test("a settings file with a retired key still loads; the key is ignored and a typo is still an error", () => {
  const user = write("retired.yaml", "cards:\n  maxOnScreen: 4\n  lockoutMs: 900\nprivacy:\n  storeAudio: true\nframe:\n  enabled: false\n");
  const l = load({ userFile: user });
  assert.equal(l.settings.cards.maxOnScreen, 4);
  assert.equal(l.sources["cards.lockoutMs"]?.layer ?? "default", "default");
  const typo = write("typo.yaml", "cards:\n  maxOnScren: 4\n");
  assert.throws(() => load({ userFile: typo }));
});

test("existing WINGMAN_* env vars map onto keys", () => {
  const l = load({ env: { WINGMAN_MIC: ":2", WINGMAN_ALLOW_PRIMARY: "1", WINGMAN_SHOW_IN_CAPTURE: "1", WINGMAN_ENDPOINT_MS: "700" } });
  assert.equal(l.settings.audio.mic.device, ":2");
  assert.equal(l.settings.overlay.allowPrimary, true);
  assert.equal(l.settings.overlay.contentProtection, false);
  assert.equal(l.settings.stt.endpointMs, 700);
  assert.equal(l.sources["audio.mic.device"].detail, "WINGMAN_MIC");
});

test("CLI flags: --file, --no-ai, --discard, --stt-fallback list", () => {
  const l = load({ argv: ["--file", "x.wav", "--no-ai", "--discard", "--stt-fallback", "soniox,gladia", "--model", "openai:gpt-5-mini", "--count", "3"] });
  assert.equal(l.settings.run.file, "x.wav");
  assert.equal(l.settings.run.noAi, true);
  assert.equal(l.settings.run.discard, true);
  assert.deepEqual(l.settings.stt.fallback, ["soniox", "gladia"]);
  assert.equal(l.settings.llm.reflex.model, "openai:gpt-5-mini");
});

test("price tables merge key by key across layers", () => {
  const user = write("prices.yaml", 'budget:\n  prices:\n    llm:\n      "openai:gpt-4.1-mini": { inUsdPerM: 0.4, outUsdPerM: 1.6 }\n');
  const p = load({ userFile: user }).settings.budget.prices.llm;
  assert.ok(p["openai:gpt-4.1-mini"]);
  assert.ok(p["anthropic:claude-haiku-5-5"]);
});

test("validation errors name the file, key path and allowed values; exit-2 path is a SettingsError", () => {
  const user = write("bad.yaml", "stt:\n  provider: whisperx\nllm:\n  reflex:\n    timeoutMs: 10\n    typoKey: 1\n");
  try {
    load({ userFile: user });
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e instanceof SettingsError);
    const by = Object.fromEntries(e.issues.map((i) => [i.key, i]));
    assert.equal(by["stt.provider"].file, user);
    assert.match(by["stt.provider"].allowed!, /deepgram \| soniox \| gladia/);
    assert.equal(by["llm.reflex.timeoutMs"].file, user);
    assert.match(by["llm.reflex.timeoutMs"].allowed!, />=500/);
    assert.equal(by["llm.reflex.typoKey"].file, user);
    assert.match(by["llm.reflex.typoKey"].message, /unknown key/);
  }
  assert.throws(() => load({ argv: ["--profile", "nope"] }), SettingsError);
  assert.throws(() => load({ argv: ["--set", "noequals"] }), SettingsError);
  assert.throws(
    () => load({ argv: ["--set", "llm.reflex.model=badmodel"] }),
    (e: any) => /provider:model/.test(e.issues[0].message),
  );
  const badYaml = write("broken.yaml", "stt: [unclosed\n");
  assert.throws(() => load({ userFile: badYaml }), SettingsError);
});

test("parseScalar and flatten", () => {
  assert.equal(parseScalar("350", 0), 350);
  assert.equal(parseScalar("true", false), true);
  assert.equal(parseScalar("null", null), null);
  assert.deepEqual(parseScalar("a, b", []), ["a", "b"]);
  assert.deepEqual(parseScalar("[a, b]", []), ["a", "b"]);
  assert.equal(parseScalar("1234", "x"), "1234");
  assert.deepEqual(flatten({ a: { b: 1, c: [1, 2] } }), { "a.b": 1, "a.c": [1, 2] });
});

test("redact never prints secrets", () => {
  assert.equal(redact("x.apiKey", "abc"), "***");
  assert.equal(redact("x.note", "sk-ant-abcdefghijklmnopqrstuv"), '"***"');
  assert.equal(redact("stt.provider", "deepgram"), '"deepgram"');
});

test("starter user file is created only when absent, and is all comments", () => {
  const f = join(dir, "new", "settings.yaml");
  load({ userFile: f, createStarter: true });
  assert.ok(existsSync(f));
  assert.equal(readFileSync(f, "utf8"), STARTER);
  assert.ok(STARTER.split("\n").every((l) => !l.trim() || l.trim().startsWith("#")));
  writeFileSync(f, "# mine\n");
  load({ userFile: f, createStarter: true });
  assert.equal(readFileSync(f, "utf8"), "# mine\n");
  load({ userFile: f }); // the starter itself is valid
});
