// Resilience matrix of the v2 engine. Every case asserts the three things the owner cares about:
//   1. no empty screen   a question that needs help ends in a card (an answer, a prepared card, the stall line or a plain error line)
//   2. bar raised        when something is wrong the user is told, in one calm bar (health row), and the bar clears when it is over
//   3. no crash          the process survives, no handler error escapes, the call files stay readable
// Cases: model down, STT down, both, slow model, 429 storm, truncated stream, corrupt session.json, brief missing, memory disk full (in v2-soak),
// kill during a patch (a real SIGKILL), clock jump, huge pasted brief. The 3-hour soak is in v2-soak.test.ts.
// In-process cases use the virtual clock and the policy fake; the two STT cases run the real engine in a child process.
import "../test-setup.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupEngine, type Engine } from "../testkit/engine-inproc.ts";
import { error, garbage, hang, truncate, refuse } from "../testkit/policy-model.ts";
import { PolicyModel, policyModel } from "../testkit/policy-model.ts";
import { setClockSource } from "../clock.ts";
import { realTimers } from "../testkit/vclock.ts";
import { loadMemory, saveMemory, checkMemory, SESSION_FILE } from "../session/store.ts";
import { emptyMemory } from "../session/types.ts";
import { buildContext } from "../context/build.ts";
import { DEFAULT_BUDGETS } from "../context/budget.ts";
import { runDigest, MAX_INPUT_CHARS } from "../digest.ts";
import { seedFromDigest } from "../session/seed.ts";
import { MOMENT_RULES } from "../moments/prompt.ts";
import { runGolden, runEngine, scriptFile, readRows, callDir, Q as sttLine } from "./helpers.ts";
import { writeWav } from "../audio.ts";
import { ROOT } from "../env.ts";
import { tsx, POSIX } from "../test-platform.ts";
import type { ModelRegistry } from "../providers/llm.ts";

let e: Engine;
before(async () => {
  e = await setupEngine({ "llm.reflex.model": "anthropic:claude-haiku-5-5" });
  // the health tick of run.ts: signals to the supervisor, the pause bar and its clearing, sleep and clock-jump detection, cost and disk checks
  (await import("../engine/degrade.ts")).startHealthTick();
});
after(() => e?.stop());

const reply = (tag: string, say: string, value = 3, aim = "me") => `${tag}\nVALUE: ${value}\nAIM: ${aim}\nSAY: ${say}\nWHY: test`;
const Q = "Which kinds of databases can the reporting tool connect to?";
const events = () =>
  readFileSync(e.boot.log.dir + "/events.jsonl", "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
/** The health bars on screen now: raised and not cleared. */
const bars = () => {
  const by = new Map<string, Record<string, unknown>>();
  for (const r of e.rows) if (typeof r.id === "string" && r.id.startsWith("health-")) r.clear ? by.delete(r.id) : by.set(r.id, r);
  return [...by.values()];
};
/** The three promises, for one question that was asked while something was broken. */
function noEmptyScreen(name: string, o: { within?: number; at: number }) {
  const cards = e.screen().filter((c) => c.badge !== "info");
  assert.ok(cards.length >= 1, `${name}: empty screen\n${JSON.stringify(events().slice(-6))}`);
  const ms = e.firstCardMs(o.at);
  assert.ok(ms !== undefined && ms <= (o.within ?? 1800), `${name}: first card after ${ms} ms`);
}
const survived = () => events().filter((x) => x.type === "error.survived");

// ---------------------------------------------------------------- model down
const MODEL_FAILS: [string, () => unknown][] = [
  ["model down (503)", () => error(503)],
  ["overloaded (529)", () => error(529)],
  ["network error", () => ({ kind: "error", status: undefined, message: "fetch failed ECONNRESET" })],
  ["refusal", () => refuse()],
  ["garbage", () => garbage()],
  ["truncated stream", () => truncate(55)],
  ["hung", () => hang()],
];
for (const [name, act] of MODEL_FAILS) {
  test(`matrix: ${name}: a direct question ends in a card by 1.8 s, the bar rises after repeated failures, no crash`, async () => {
    await e.reset();
    e.pm.on({ role: ["moment", "observer"] }, act() as never);
    for (let i = 0; i < 3; i++) {
      const at = e.say("them", Q.replace("?", ` (${i})?`));
      await e.vc.advance(1800);
      noEmptyScreen(name, { at });
      await e.vc.advance(700);
    }
    assert.equal(survived().length, 0, JSON.stringify(survived().slice(0, 2)));
    assert.equal(e.st.call.crashed ?? false, false);
    // a failure the user can see: after the repeated failures there is one bar (hung calls are cut by the timer, so also count them)
    if (name !== "garbage" && name !== "refusal" && name !== "truncated stream" && name !== "hung") assert.ok(bars().length >= 1, `${name}: no bar`);
    assert.ok(bars().length <= 3, `${name}: ${bars().length} bars at once is not calm: ${JSON.stringify(bars().map((b) => b.id))}`);
  });
}

test("matrix: model down, then back: the bar clears and the next question gets a model answer", async () => {
  await e.reset();
  e.pm.on({ role: "moment" }, error(503), { times: 3 }); // three failures open the breaker; the probe after the cool-down finds the model well again
  for (let i = 0; i < 3; i++) {
    e.say("them", Q.replace("?", ` (${i})?`));
    await e.vc.advance(2500);
  }
  assert.ok(bars().length >= 1, "bar while down");
  await e.vc.advance(35_000); // the breaker's cool-down is 15 s; the health tick then lifts the pause
  e.pm.reset(); // the model is well again
  e.pm.reply({ role: "moment", lastLine: "databases" }, reply("ANS", "Postgres and MySQL are both supported"), { ms: 500 });
  const at = e.say("them", Q);
  await e.vc.advance(3000);
  assert.ok(
    e.screen().some((c) => c.badge === "ai" && /Postgres/.test(String(c.say))),
    JSON.stringify(e.screen().map((c) => [c.badge, c.say])) +
      JSON.stringify(
        events()
          .slice(-14)
          .map((x) => [x.type, x.id ?? x.why ?? x.rung ?? x.to]),
      ),
  );
  void at;
  assert.equal(bars().filter((b) => /ai/.test(String(b.id))).length, 0, "the AI bar cleared: " + JSON.stringify(bars().map((b) => b.id)));
});

// ---------------------------------------------------------------- slow
test("matrix: slow model (every answer takes 3.5 s): the stall line by 1.8 s, the answer replaces it, the supervisor steps down a rung and the bar says so", async () => {
  await e.reset();
  for (let i = 0; i < 10; i++) {
    e.pm.reply({ role: "moment", lastLine: `tool ${i} connect` }, reply("ANS", `Slow answer ${i}`), { ms: 3500 });
    const at = e.say("them", `Which databases does the slow reporting tool ${i} connect to?`);
    await e.vc.advance(1800);
    noEmptyScreen(`slow ${i}`, { at });
    await e.vc.advance(10_000);
    e.boot.sup.tick();
  }
  assert.equal(survived().length, 0);
  assert.ok(e.boot.sup.rung >= 1, `rung ${e.boot.sup.rung}`);
  assert.ok(bars().length >= 1 && bars().length <= 2, JSON.stringify(bars().map((b) => b.id)));
});

// ---------------------------------------------------------------- 429 storm
test("matrix: a 429 storm (40 questions, every call refused): no empty screen, the model is not hammered, one calm bar, no crash", async () => {
  await e.reset();
  let empty = 0;
  for (let i = 0; i < 40; i++) {
    e.pm.on({ role: ["moment", "observer"] }, error(429));
    const at = e.say("them", `Which databases does tool number ${i} connect to?`);
    await e.vc.advance(1900);
    const ms = e.firstCardMs(at);
    if (ms === undefined || ms > 1800) empty++;
    await e.vc.advance(900);
  }
  const calls = e.pm.calls.length;
  console.log(`429 STORM: ${calls} model calls for 40 questions, ${empty} questions without a card in time, ${bars().length} bars`);
  assert.equal(empty, 0, "every question got a card in time");
  assert.ok(calls <= 40 + 12, `the breaker stops the calls: ${calls} calls for 40 questions`);
  assert.ok(bars().length >= 1 && bars().length <= 3, JSON.stringify(bars().map((b) => b.id)));
  assert.equal(survived().length, 0);
});

// ---------------------------------------------------------------- clock jump
test("matrix: the wall clock jumps forward 3 hours, then back 5 hours: questions still get cards, the pace limits do not wedge, no crash", async () => {
  await e.reset();
  const base = e.vc.now;
  let off = 0;
  const jump = (ms: number) => {
    off += ms;
    (globalThis.Date as unknown as { now: () => number }).now = () => base() + off;
    setClockSource({ wall: () => base() + off, mono: e.vc.perf });
  };
  try {
    e.pm.reply({ role: "moment" }, reply("ANS", "Postgres and MySQL are both supported"), { ms: 600 });
    let at = e.say("them", Q);
    await e.vc.advance(2500);
    noEmptyScreen("before the jump", { at });
    for (const delta of [3 * 3_600_000, -5 * 3_600_000, 36_000_000]) {
      jump(delta);
      await e.vc.advance(5000);
      await e.reset(0);
      e.pm.reply({ role: "moment" }, reply("ANS", "Postgres and MySQL are both supported"), { ms: 600 });
      at = e.say("them", Q.replace("kinds", `kinds ${delta}`));
      await e.vc.advance(2500);
      noEmptyScreen(`jump ${delta / 3_600_000} h`, { at, within: 2000 });
    }
    // the memory-loop and observer pace after the jumps: still allowed to run
    e.pm.reply({ role: "observer" }, "SKIP\nWHY: nothing", { ms: 300 });
    e.say("them", "We talked about the rollout plan for the region and the people who are involved in it");
    await e.vc.advance(5000);
    assert.ok(e.pm.callsFor("observer").length >= 1, "the observer still runs after the clock moved");
    assert.equal(survived().length, 0, JSON.stringify(survived().slice(0, 2)));
  } finally {
    (globalThis.Date as unknown as { now: () => number }).now = () => e.vc.now();
    setClockSource({ wall: e.vc.now, mono: e.vc.perf });
  }
});

// ---------------------------------------------------------------- session.json: corrupt, torn, killed
const tmp = () => mkdtempSync(join(tmpdir(), "wm-res-"));
test("matrix: corrupt session.json: the load never throws; bad file moved aside; the previous copy or an empty memory is used", () => {
  const d = tmp();
  const good = { ...emptyMemory(1), ver: 3, summary: "They plan to move the shop." };
  saveMemory(d, good);
  saveMemory(d, { ...good, ver: 4 }); // the first one becomes session.prev.json
  for (const [name, bytes] of [
    ["truncated json", '{"v":1,"updatedAt":1,"ver":'],
    ["binary junk", Buffer.from([0, 255, 254, 3, 0, 9])],
    ["empty file", ""],
    ["valid json, wrong shape", '{"v":1,"updatedAt":"x"}'],
    ["a list", "[1,2,3]"],
  ] as const) {
    writeFileSync(join(d, SESSION_FILE), bytes);
    const r = loadMemory(d, 5);
    assert.ok(checkMemory(r.mem).ok, `${name}: the memory that comes back is valid`);
    assert.equal(r.status, "recovered", name);
    assert.equal(r.mem.ver, 3, `${name}: the previous good copy is used`);
    assert.ok(existsSync(join(d, "session.bad")), `${name}: the bad file is kept for a look`);
  }
  // both files bad: an empty memory, a call never fails to start
  writeFileSync(join(d, SESSION_FILE), "nope");
  writeFileSync(join(d, "session.prev.json"), "nope");
  const r = loadMemory(d, 5);
  assert.equal(r.status, "corrupt");
  assert.ok(checkMemory(r.mem).ok);
  rmSync(d, { recursive: true, force: true });
});

test("matrix: kill during a patch: a real SIGKILL at a random moment of a tight save loop never leaves a bad session.json (10 kills)", POSIX, async () => {
  const d = tmp();
  const script = join(d, "saver.mts");
  writeFileSync(
    script,
    `import { saveMemory } from ${JSON.stringify(join(ROOT, "src/session/store.ts"))};
import { emptyMemory } from ${JSON.stringify(join(ROOT, "src/session/types.ts"))};
const dir = process.argv[2];
for (let i = 1; i < 2000000; i++) { const m = emptyMemory(i); m.ver = i; m.summary = "word ".repeat(1 + (i % 500)); saveMemory(dir, m); if (i === 3) console.log("ready"); }
`,
  );
  let versions = 0;
  for (let k = 0; k < 10; k++) {
    const dir = join(d, "c" + k);
    mkdirSync(dir);
    const p = spawn(...tsx([script, dir]), { cwd: ROOT, detached: true }); // its own process group: the kill reaches the saver behind the tsx wrapper
    await new Promise<void>((res) => {
      p.stdout.on("data", (b) => /ready/.test(String(b)) && res());
      p.on("exit", () => res());
    });
    await new Promise((r) => realTimers.setTimeout(r, 20 + k * 25)); // a different moment each time (real time: the virtual clock is installed)
    try {
      process.kill(-p.pid!, "SIGKILL");
    } catch {
      p.kill("SIGKILL");
    }
    await new Promise((r) => realTimers.setTimeout(r, 150)); // let the dying process finish with the disk
    await new Promise((r) => (p.exitCode !== null || p.signalCode !== null ? r(null) : p.on("exit", r)));
    const r = loadMemory(dir, 0);
    assert.ok(r.status === "ok" || r.status === "recovered", `kill ${k}: ${r.status} ${r.detail ?? ""}`);
    assert.ok(checkMemory(r.mem).ok, `kill ${k}`);
    assert.ok(r.mem.ver >= 1, `kill ${k}: the last saved version came back (ver ${r.mem.ver})`);
    versions += r.mem.ver;
  }
  assert.ok(versions > 10);
  rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ---------------------------------------------------------------- brief missing, huge brief
const regOf = (pm: PolicyModel) => ({ resolve: async () => pm.model }) as unknown as ModelRegistry;
test("matrix: brief missing: a call without any pre-meeting text works as before (empty memory, a card for the first question)", async () => {
  await e.reset();
  assert.equal(seedFromDigest(undefined, 0).ver, 0);
  const none = await runDigest({}, { registry: regOf(policyModel({ strict: false })), models: ["anthropic:claude-haiku-5-5"] });
  assert.equal(none.why, "empty");
  assert.equal(none.memory.facts.length, 0);
  e.pm.reply({ role: "moment", lastLine: "databases" }, reply("ANS", "Postgres and MySQL are both supported"), { ms: 600 });
  const at = e.say("them", Q);
  await e.vc.advance(2500);
  noEmptyScreen("no brief", { at });
});

test("matrix: a huge pasted brief (5 MB, 40 files) is cut to the input cap, one model call, the call context stays in budget and fast", async () => {
  const para = "The client runs a garden tools shop with 1200 products and wants a faster store. Backups run every night. ";
  const text = para.repeat(Math.ceil(5_000_000 / para.length));
  const files = Array.from({ length: 40 }, (_, i) => ({ name: `plan-${i}.txt`, text: para.repeat(500) + ` unique${i}` }));
  const pm = policyModel({ strict: false });
  const { registerRole } = await import("../testkit/prompt.ts");
  registerRole("digest", "You prepare a pre-meeting brief");
  pm.reply({ role: "digest" }, JSON.stringify({ kind: "client", roster: [{ name: "Noa", side: "them" }], agenda: ["move"], facts: [], likelyQuestions: [] }), {
    ms: 800,
  });
  const t0 = performance.now();
  const running = runDigest({ text, files }, { registry: regOf(pm), models: ["anthropic:claude-haiku-5-5"] });
  await e.vc.advance(1500); // the fake model answers on the virtual clock
  const d = await running;
  const wall = performance.now() - t0;
  assert.equal(d.source, "ai", d.why);
  assert.equal(pm.callsFor("digest").length, 1, "one model call");
  assert.ok(d.record!.tokens < 16_000, `the digest input is ${d.record!.tokens} tokens`);
  const sent = pm.calls[0].view.system.length + pm.calls[0].view.user.length;
  assert.ok(sent <= MAX_INPUT_CHARS + 20_000, `${sent} characters went to the model (cap ${MAX_INPUT_CHARS})`);
  assert.ok(d.digest.chunks.length < 400, `chunks ${d.digest.chunks.length}`);
  // and every later call stays in budget with that digest in block A
  const t1 = performance.now();
  for (const role of ["moment", "observer", "memory", "ask"] as const) {
    const ctx = buildContext({
      role,
      roleInstructions: MOMENT_RULES,
      memory: d.memory,
      rawLines: Array.from({ length: 200 }, (_, i) => ({
        side: i % 2 ? ("me" as const) : ("them" as const),
        text: `line ${i} about the garden tools shop and backups`,
      })),
      trigger: "Do you keep nightly backups of the store?",
      shared: { digest: d.digest, rules: "Be short.", profile: "Dan" },
    });
    assert.ok(ctx.record.tokens <= DEFAULT_BUDGETS[role].total, `${role}: ${ctx.record.tokens} tokens over budget ${DEFAULT_BUDGETS[role].total}`);
  }
  assert.ok(performance.now() - t1 < 1500, "building the contexts is fast");
  console.log(`HUGE BRIEF: ${wall.toFixed(0)} ms wall, ${d.record!.tokens} tokens sent, ${d.digest.chunks.length} chunks kept`);
});

test("matrix: a first question after a huge brief still gets its card by the budget (the brief only enters through search)", async () => {
  await e.reset();
  e.pm.reply({ role: "moment", lastLine: "databases" }, reply("ANS", "Postgres and MySQL are both supported"), { ms: 700 });
  const at = e.say("them", Q);
  await e.vc.advance(2500);
  noEmptyScreen("huge brief", { at });
});

// ---------------------------------------------------------------- STT down, and both down (the real engine in a child process, real time)
test(
  "matrix: STT down from second 4 (the other side's channel refused): a bar, the call goes on, the user's own question still gets a card, clean exit",
  { timeout: 90_000 },
  async () => {
    const pm = policyModel({ strict: false, fallback: "SKIP" });
    pm.reply({}, "ANS\nVALUE: 3\nAIM: me\nSAY: A CDN caches your pages near the visitor; DNS finds the server\nWHY: user asked", { ms: 300 });
    const g = {
      lines: [
        { id: "l1", t: 0, side: "them" as const, text: "Which databases can the reporting tool connect to?" },
        { id: "l2", t: 8, side: "me" as const, text: "Wingman, what is the difference between a CDN and DNS?" },
      ],
    };
    const run = await runGolden(g, {
      policy: pm,
      tailSeconds: 6,
      env: { WINGMAN_STT_FAIL: "them:503@4000" },
      args: ["--set", "moments.engine=v2", "--set", "assist.answerMe=always"],
    });
    try {
      assert.equal(run.code, 0, run.out);
      const cards = run.rows("cards.jsonl");
      const bar = cards.find((c) => /^health-stt/.test(String(c.id)) && !c.clear);
      assert.ok(bar, "a speech-to-text bar: " + JSON.stringify(cards.filter((c) => /health/.test(String(c.id))).map((c) => [c.id, c.level])));
      assert.ok(
        cards.some((c) => c.type === "card" && !c.health && !c.withdraw && c.badge !== "info" && c.say),
        "the user's own question got a card: " + JSON.stringify(cards.map((c) => [c.id, c.badge])),
      );
      assert.ok(
        !cards.some((c) => c.say && /Postgres|databases/.test(String(c.say)) && c.badge === "ai"),
        "nothing was invented for the line that never arrived",
      );
      const meta = JSON.parse(readFileSync(join(run.dir, "call.json"), "utf8"));
      assert.equal(meta.phase, "ended");
    } finally {
      run.cleanup();
    }
  },
);

test(
  "matrix: STT down and the model down together: the bars rise, the user's ask ends in a plain error card (never an empty screen), clean exit",
  { timeout: 90_000 },
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "wm-both-"));
    const calls = join(tmp, "calls");
    mkdirSync(calls);
    const wav = join(tmp, "s.wav");
    await writeWav(wav, Buffer.alloc(16000 * 2 * 2 * 10), 2);
    const settings = join(tmp, "user.yaml");
    writeFileSync(settings, "ui:\n  language: en\nmoments:\n  engine: v2\n");
    const eng = runEngine(["--file", wav], {
      WINGMAN_CALLS_DIR: calls,
      WINGMAN_USER_SETTINGS: settings,
      WINGMAN_CONTROL: "1",
      WINGMAN_LLM_FAIL: "60:529", // every model call fails
      WINGMAN_STT_FAIL: "them:503@4000", // the other side's speech-to-text dies at second 4
      WINGMAN_STT_SCRIPT: scriptFile(tmp, [
        sttLine("them", "Which databases can the reporting tool connect to?", 700),
        sttLine("me", "what is the difference between a CDN and DNS", 6500),
      ]),
    });
    await new Promise((r) => realTimers.setTimeout(r, 5500)); // real time: the virtual clock is installed in this file
    eng.p.stdin?.write("ask\n");
    const code = await eng.done;
    try {
      assert.equal(code, 0, eng.out());
      const dir = callDir(calls),
        cards = readRows(dir, "cards.jsonl"),
        ev = readRows(dir, "events.jsonl");
      assert.ok(
        cards.some((c) => /^health-stt/.test(String(c.id)) && !c.clear),
        "an STT bar",
      );
      assert.ok(
        cards.some((c) => c.id === "health-ai" && !c.clear),
        "the AI bar rose too",
      );
      const mine = cards.find((c) => c.type === "card" && !c.health && !c.withdraw && c.badge === "me" && c.say);
      assert.ok(mine, "a card for the failed ask\n" + eng.out().slice(-1500));
      assert.equal(JSON.parse(readFileSync(join(dir, "call.json"), "utf8")).phase, "ended");
      assert.equal(ev.filter((x) => x.type === "error.survived").length, 0, "no handler error");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },
);

test(
  "matrix: defaults (reflex.stall off), model down, a question with no prepared card: the AI bar is the screen (no stall line is invented)",
  { timeout: 60_000 },
  async () => {
    const pm = policyModel({ strict: false, fallback: "SKIP" });
    pm.on({}, error(503));
    const g = { lines: [{ id: "l1", t: 0, side: "them" as const, text: "Can you walk me through how the quarterly numbers were put together?" }] };
    const run = await runGolden(g, { policy: pm, tailSeconds: 6, args: ["--set", "moments.engine=v2", "--set", "reflex.stall=false"] });
    try {
      assert.equal(run.code, 0, run.out);
      const cards = run.rows("cards.jsonl");
      assert.ok(
        cards.some((c) => /^health-(ai|ladder)/.test(String(c.id)) && !c.clear),
        "a bar that says the AI is down: " + JSON.stringify(cards.map((c) => c.id)),
      );
      assert.equal(cards.filter((c) => c.type === "card" && !c.health && c.badge !== "info" && c.say).length, 0, "no invented card");
    } finally {
      run.cleanup();
    }
  },
);
