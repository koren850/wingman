import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamText } from "ai";
import { Cassette, CassetteMiss, wrapCassette, cassetteKey, llmMode, diffLines, resetCassetteCache } from "./providers/cassette.ts";
import { ModelRegistry, ConfigError, generateOnce } from "./providers/llm.ts";
import { policyModel } from "./testkit/policy-model.ts";
import { viewOf } from "./testkit/prompt.ts";
import { assertPromptSnapshot, renderPrompt } from "./testkit/prompt-snapshot.ts";
import { withVClock } from "./testkit/vclock.ts";
import type { Keys } from "./env.ts";

const REF = "anthropic:claude-haiku-5-5";
const call = (system: string, user: string) => ({
  instructions: { role: "system", content: system },
  messages: [{ role: "user", content: user }],
  maxRetries: 0,
});
const rawCall = (system: string, user: string) => ({
  prompt: [
    { role: "system", content: system },
    { role: "user", content: [{ type: "text", text: user }] },
  ],
  maxOutputTokens: 200,
});
const tmp = () => mkdtempSync(join(tmpdir(), "wingman-cassette-"));
const withEnv = async (env: Record<string, string | undefined>, f: () => Promise<void>) => {
  const was = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  resetCassetteCache();
  try {
    await f();
  } finally {
    for (const [k, v] of Object.entries(was)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    resetCassetteCache();
  }
};

test("cassette: the key follows role, model, system, messages and options, and nothing else", () => {
  const a = viewOf(REF, { ...rawCall("S", "hello"), providerOptions: { wingman: { role: "moment" } } });
  const same = viewOf(REF, { ...rawCall("S", "hello"), providerOptions: { wingman: { role: "moment" } } });
  assert.equal(cassetteKey(a), cassetteKey(same));
  for (const other of [
    viewOf("anthropic:other", rawCall("S", "hello")),
    viewOf(REF, rawCall("S2", "hello")),
    viewOf(REF, rawCall("S", "hello!")),
    viewOf(REF, { ...rawCall("S", "hello"), temperature: 0.2 }),
  ])
    assert.notEqual(cassetteKey(other), cassetteKey({ ...a, role: "unknown" }));
  assert.notEqual(cassetteKey({ ...a, role: "ask" }), cassetteKey(a), "the role is part of the key");
});

test("cassette replay: authored from the SDK's own call, replay is deterministic for generate and stream", async () => {
  const rec = new Cassette();
  const seen: unknown[] = [];
  const spy = policyModel({ strict: false, fallback: "ANS\nSAY: Nightly." }).model as unknown as { doGenerate: (c: unknown) => Promise<unknown> };
  const inner = new Proxy(spy, { get: (t, k) => (k === "doGenerate" ? (c: unknown) => (seen.push(c), t.doGenerate(c)) : (t as never)[k]) });
  const recorder = wrapCassette({ mode: "record", cassette: rec, ref: REF, role: "moment", inner: inner as never, autosave: false });
  await generateOnce(undefined, { model: recorder, ...call("You are X", "[l1] them: how long?") });
  assert.equal(rec.size, 1);
  const rep = wrapCassette({ mode: "replay", cassette: rec, ref: REF, role: "moment", timing: "instant" });
  const out = [];
  for (let i = 0; i < 3; i++) out.push((await generateOnce(undefined, { model: rep, ...call("You are X", "[l1] them: how long?") })).text);
  assert.deepEqual(out, ["ANS\nSAY: Nightly.", "ANS\nSAY: Nightly.", "ANS\nSAY: Nightly."]);
  const s = streamText({ model: rep, ...call("You are X", "[l1] them: how long?") } as never);
  let text = "";
  for await (const d of s.textStream) text += d;
  assert.equal(text, "ANS\nSAY: Nightly.");
});

test("cassette replay: a miss throws CassetteMiss with a readable diff against the nearest entry", async () => {
  const rec = new Cassette();
  const pm = policyModel({ strict: false, fallback: "ok" });
  const recorder = wrapCassette({ mode: "record", cassette: rec, ref: REF, role: "moment", inner: pm.model, autosave: false });
  const system = ["You are the moment observer.", "Rule one.", "Rule two.", "Rule three."].join("\n");
  await generateOnce(undefined, { model: recorder, ...call(system, "[l1] them: hi\n[l2] them: how long is a backup?") });
  const rep = wrapCassette({ mode: "replay", cassette: rec, ref: REF, role: "moment" });
  const err = (await generateOnce(undefined, {
    model: rep,
    ...call(system.replace("Rule two.", "Rule 2 changed."), "[l1] them: hi\n[l2] them: how long is a backup?"),
  }).catch((e) => e)) as Error;
  const msg = String(err.message ?? err);
  assert.match(msg, /Cassette miss: role=moment model=anthropic:claude-haiku-5-5 key=[0-9a-f]{24}/);
  assert.match(msg, /Nearest entry: key=[0-9a-f]{24} role=moment/);
  assert.match(msg, /^- Rule two\.$/m, msg);
  assert.match(msg, /^\+ Rule 2 changed\.$/m, msg);
  assert.match(msg, /WINGMAN_LLM_MODE=record/);
  const empty = wrapCassette({ mode: "replay", cassette: new Cassette(), ref: REF });
  await assert.rejects(generateOnce(undefined, { model: empty, ...call("a", "b") }), /The cassette is empty/);
  assert.ok(CassetteMiss.prototype instanceof Error);
});

test("cassette record: refuses without the real model (no key), and writes a sorted cassette file through a mock transport", async () => {
  assert.throws(() => wrapCassette({ mode: "record", cassette: new Cassette(), ref: REF }), /needs the real model and its API key/);
  const dir = tmp();
  try {
    const file = join(dir, "x", "t.cassette.json");
    const c = new Cassette(file);
    const pm = policyModel({ usage: { input: 321, output: 9 } });
    pm.reply({}, "ANS\nSAY: first part second part", { chunks: 2, chunkMs: 5 });
    const model = wrapCassette({ mode: "record", cassette: c, ref: REF, role: "moment", inner: pm.model });
    const s = streamText({ model, ...call("sys", "[l1] them: q") } as never);
    let text = "";
    for await (const d of s.textStream) text += d;
    assert.equal(text, "ANS\nSAY: first part second part");
    assert.ok(existsSync(file), "file written");
    const j = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(j.v, 1);
    assert.equal(j.entries.length, 1);
    const e = j.entries[0];
    assert.equal(e.source, "recorded");
    assert.equal(e.role, "moment");
    assert.equal(e.chunks.length, 2);
    assert.ok(e.chunks[1].at >= e.chunks[0].at, "timing kept");
    assert.equal(e.usage.inputTokens.total, 321);
    assert.equal(e.request.system, "sys");
    // a new Cassette object reads it back and replays it
    const back = new Cassette(file);
    const rep = wrapCassette({ mode: "replay", cassette: back, ref: REF, role: "moment", timing: "instant" });
    const s2 = streamText({ model: rep, ...call("sys", "[l1] them: q") } as never);
    let t2 = "";
    for await (const d of s2.textStream) t2 += d;
    assert.equal(t2, text);
    assert.equal(((await s2.usage) as { inputTokens?: number }).inputTokens, 321);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cassette replay: the recorded timing is replayed (first token after the recorded ms), on a virtual clock", async () => {
  const c = new Cassette();
  await withVClock(async (vc) => {
    const pm = policyModel();
    pm.reply({}, "ANS\nSAY: late", { ms: 1500 });
    const rec = wrapCassette({ mode: "record", cassette: c, ref: REF, role: "moment", inner: pm.model, autosave: false });
    const p = generateOnce(undefined, { model: rec, ...call("sys-slow", "q") });
    await vc.advance(1600);
    await p;
    assert.equal(c.entries()[0].ms, 1500, "the recorded call took 1500 ms of (virtual) time");
    const rep = wrapCassette({ mode: "replay", cassette: c, ref: REF, role: "moment" });
    let text = "";
    const t0 = Date.now();
    const q = generateOnce(undefined, { model: rep, ...call("sys-slow", "q") }).then((r) => (text = r.text));
    await vc.advance(1400);
    assert.equal(text, "", "nothing before the recorded delay");
    await vc.advance(200);
    await q;
    assert.equal(text, "ANS\nSAY: late");
    assert.ok(Date.now() - t0 >= 1500);
  });
});

test("cassette: a hand-authored entry is marked authored and is found by the same key", () => {
  const c = new Cassette();
  const e = c.author(REF, rawCall("S", "U"), "SKIP", { role: "observer" });
  assert.equal(e.source, "authored");
  assert.equal(c.get(cassetteKey({ ...viewOf(REF, rawCall("S", "U")), role: "observer" }))?.chunks[0].text, "SKIP");
});

test("cassette: saving is atomic and sorted by key, and an unknown version is refused", () => {
  const dir = tmp();
  try {
    const f = join(dir, "c.json");
    const c = new Cassette(f);
    for (const u of ["b", "a", "c"]) c.author(REF, rawCall("S", u), u, { role: "ask" });
    c.save();
    const keys = JSON.parse(readFileSync(f, "utf8")).entries.map((e: { key: string }) => e.key);
    assert.deepEqual(keys, [...keys].sort());
    writeFileSync(f, JSON.stringify({ v: 2, entries: [] }));
    assert.throws(() => new Cassette(f), /unknown version/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cassette: WINGMAN_LLM_MODE is live by default, accepts record and replay, and rejects anything else", () => {
  assert.equal(llmMode({}), "live");
  assert.equal(llmMode({ WINGMAN_LLM_MODE: " Replay " }), "replay");
  assert.equal(llmMode({ WINGMAN_LLM_MODE: "record" }), "record");
  assert.throws(() => llmMode({ WINGMAN_LLM_MODE: "yes" }), /must be live, record or replay/);
});

test("registry seam: replay needs no key and no package; record without a key is refused; live is untouched", async () => {
  const dir = tmp();
  try {
    const file = join(dir, "r.json");
    const c = new Cassette(file);
    c.author(
      REF,
      {
        prompt: [
          { role: "system", content: "S" },
          { role: "user", content: [{ type: "text", text: "U" }] },
        ],
      },
      "hello",
      { role: "ask" },
    );
    c.save();
    const reg = new ModelRegistry({} as Keys, async () => {
      throw new Error("the package must not be loaded in replay mode");
    });
    await withEnv({ WINGMAN_LLM_MODE: "replay", WINGMAN_CASSETTE: file }, async () => {
      const model = await reg.resolve(REF, "ask");
      assert.equal(
        (await generateOnce(undefined, { model, instructions: { role: "system", content: "S" }, messages: [{ role: "user", content: "U" }], maxRetries: 0 }))
          .text,
        "hello",
      );
    });
    await withEnv({ WINGMAN_LLM_MODE: "record", WINGMAN_CASSETTE: file }, async () => {
      const noKey = new ModelRegistry({} as Keys, async () => ({ createAnthropic: () => () => ({}) }));
      await assert.rejects(noKey.resolve(REF, "ask"), (e) => e instanceof ConfigError && /ANTHROPIC_API_KEY is missing/.test(e.message));
    });
    await withEnv({ WINGMAN_LLM_MODE: undefined }, async () => {
      const live = new ModelRegistry({ anthropic: "k" } as unknown as Keys, async () => ({ createAnthropic: () => (id: string) => ({ id }) }));
      assert.deepEqual(await live.resolve(REF), { id: "claude-haiku-5-5" });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prompt snapshot: missing fails, update writes, equal passes, a change fails with a diff", () => {
  const dir = tmp();
  try {
    const p = { system: "You are X.\nRule A.\nRule B.", user: "[l1] them: hi" };
    assert.throws(() => assertPromptSnapshot("moment", p, { dir }), /does not exist/);
    assertPromptSnapshot("moment", p, { dir, update: true });
    assert.equal(readFileSync(join(dir, "moment.txt"), "utf8"), renderPrompt("moment", p));
    assertPromptSnapshot("moment", p, { dir });
    assert.throws(
      () => assertPromptSnapshot("moment", { ...p, system: "You are X.\nRule A.\nRule B changed." }, { dir }),
      /changed[^]*^- Rule B\.$[^]*^\+ Rule B changed\.$/m,
    );
    assertPromptSnapshot("moment", { ...p, system: "You are X.\nRule A.\nRule B changed." }, { dir, update: true });
    // dates and times do not make a snapshot flap
    assert.equal(
      renderPrompt("ask", { system: "Today 2026-11-08 12:30 now", user: "x" }),
      renderPrompt("ask", { system: "Today 2030-01-02 07:05 now", user: "x" }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("diffLines: shows removed and added lines with one line of context, and caps the length", () => {
  const a = ["one", "two", "three", "four", "five", "six"];
  const b = ["one", "two", "THREE", "four", "five", "six"];
  assert.equal(diffLines(a, b), ["  two", "- three", "+ THREE", "  four"].join("\n"));
  assert.match(
    diffLines(
      Array.from({ length: 100 }, (_, i) => `a${i}`),
      Array.from({ length: 100 }, (_, i) => `b${i}`),
      10,
    ),
    /more lines/,
  );
});
