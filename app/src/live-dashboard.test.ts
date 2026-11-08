// Round 12 live UI, Wingman window side: the live notes (knowslib, memlib, livetail), Prepare (dashboard/prepare.cjs, src/prepare-cli.ts),
// the golden-run fixtures, EN/HE parity of the new strings, and the opt-in Electron snapshots with clipping checks.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./env.ts";
import { POSIX } from "./test-platform.ts";
import { goldenLiveRun, liveFixtureSet, LIVE_FIXTURE_FILE, LIVE_MEETINGS } from "./testkit/live-golden.ts";
import { loadSplit } from "../qa/golden-load.ts";
import { UserEditQueue } from "./session/useredit.ts";
import { cleanDigest, readDigestNear, writeDigestFile, digestFileNear } from "./session/digest-file.ts";

const require = createRequire(import.meta.url);
const K = require("../dashboard/knowslib.js");
const memlib = require("../dashboard/memlib.cjs");
const prep = require("../dashboard/prepare.cjs");
const { createLiveTail } = require("../dashboard/livetail.cjs");
const EN = require("../dashboard/strings.en.js");
const HE = require("../dashboard/strings.he.js");
const fixtures = JSON.parse(readFileSync(LIVE_FIXTURE_FILE, "utf8"));

const tmp = () => mkdtempSync(join(tmpdir(), "wm-livedash-"));
const CALL = "01TESTCALL0000000000000001";
function callsWith(mem: unknown) {
  const calls = tmp();
  mkdirSync(join(calls, CALL));
  if (mem) writeFileSync(join(calls, CALL, "session.json"), JSON.stringify(mem));
  return calls;
}

// ---- golden-run fixtures ----

test("golden run: the committed fixture file equals a fresh build, and the set renders every card kind", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(liveFixtureSet())),
    fixtures,
    "run: npx tsx scripts of src/testkit/live-golden.ts liveFixtureSet() and prettier --write the JSON",
  );
  const kinds = new Set<string>();
  for (const id of LIVE_MEETINGS) for (const c of fixtures[id].cards) if (c.kind) kinds.add(c.kind);
  assert.deepEqual([...kinds].sort(), ["answer", "check", "fact", "prompt"]);
  for (const id of LIVE_MEETINGS) {
    const f = fixtures[id];
    assert.ok(
      f.cards.some((c: { closes?: string }) => c.closes === "answered"),
      "a closed-by-answer row",
    );
    assert.ok(f.mem.openQuestions.length && f.mem.commitments.length && f.mem.decisions.length && f.mem.facts.length);
    assert.equal(f.view.type, "view");
  }
  assert.ok(new Set(LIVE_MEETINGS.map((i) => fixtures[i].lang)).size === 2, "English and Hebrew");
});

test("golden run: every dev meeting runs through the real parsers without a bad row", () => {
  for (const g of loadSplit("dev")) {
    const run = goldenLiveRun(g as never);
    assert.ok(run.cards.length > 0, g.id);
    for (const c of run.cards) {
      if (c.closes) continue;
      assert.ok(typeof c.say === "string" && (c.say as string).split(/\s+/).length <= 14, g.id + " say");
      assert.ok(["answer", "prompt", "check", "fact"].includes(c.kind as string));
    }
  }
});

// ---- live notes model ----

test("fromMemory keeps memory ids; toEdit turns page actions into edit messages and refuses unknown sections", () => {
  const m = K.fromMemory(fixtures["dev-support-en"].mem);
  assert.equal(m.source, "memory");
  assert.ok(m.sections.open[0].id.startsWith("q"));
  assert.deepEqual(K.toEdit({ op: "remove", id: "q1" }), { op: "remove", id: "q1" });
  assert.deepEqual(K.toEdit({ op: "add", sec: "promises", text: "x" }), { op: "add", list: "commitments", text: "x" });
  assert.equal(K.toEdit({ op: "add", sec: "roster", text: "x" }), null);
  assert.equal(K.toEdit({ op: "nope" }), null);
  assert.equal(K.toEdit(null), null);
});

test("fromDigest: people, agenda and facts with stable ids; junk gives empty sections", () => {
  const m = K.fromDigest({
    roster: [{ name: "Dana", role: "owner" }, { name: "" }],
    agenda: ["Price", { text: "Dates" }],
    facts: [{ text: "Renews in March" }, 5],
  });
  assert.deepEqual(
    m.sections.roster.map((x: { id: string }) => x.id),
    ["p1"],
  );
  assert.equal(m.sections.agenda.length, 2);
  assert.equal(m.sections.facts.length, 1);
  assert.equal(K.count(K.fromDigest(null)), 0);
});

// ---- main process: reading, queueing edits, invalid input ----

test("memlib: live model from session.json; a symlink, a bad id, a torn file and a missing call give nothing", { ...POSIX }, () => {
  const calls = callsWith(fixtures["dev-support-en"].mem);
  const r = memlib.knowsLive(calls, CALL);
  assert.equal(r.ok, true);
  assert.ok(r.model.sections.promises.length);
  assert.equal(memlib.knowsLive(calls, "../etc").model, null);
  assert.equal(memlib.knowsLive(calls, "01NOSUCHCALL000000000000").model, null);
  writeFileSync(join(calls, CALL, "session.json"), '{"v":1,"ver"');
  assert.equal(memlib.knowsLive(calls, CALL).model, null);
});

const BAD: unknown[] = [
  null,
  "x",
  5,
  [],
  {},
  { op: "edit" },
  { op: "edit", id: "../x", text: "a" },
  { op: "edit", id: "f1", text: "" },
  { op: "edit", id: "f1", text: "a".repeat(300) },
  { op: "remove", id: "zz" },
  { op: "add", list: "roster", text: "a" },
  { op: "edit", id: "f1", text: "a", extra: 1 },
];
test("memlib.editMemory: invalid input is rejected and writes nothing; a valid edit is queued once and the engine applies it", { ...POSIX }, () => {
  const mem = fixtures["dev-support-en"].mem;
  const calls = callsWith(mem);
  for (const b of BAD) {
    const r = memlib.editMemory(calls, CALL, b);
    assert.equal(r.ok, false, JSON.stringify(b));
  }
  assert.equal(existsSync(join(calls, CALL, "user-edits.jsonl")), false);
  assert.equal(memlib.editMemory(calls, "bad id", { op: "remove", id: "f1" }).ok, false);
  assert.equal(memlib.editMemory(calls, "01NOSUCHCALL000000000000", { op: "remove", id: "f1" }).ok, false);
  const id = mem.openQuestions[0].id;
  assert.deepEqual(memlib.editMemory(calls, CALL, { op: "edit", id, text: "Will we lose orders today?" }), { ok: true, queued: true });
  assert.equal(memlib.editMemory(calls, CALL, { op: "remove", id: mem.facts[0].id }).ok, true);
  const q = new UserEditQueue(join(calls, CALL));
  const r = q.drain(mem, Date.now());
  assert.equal(r.applied, 2);
  assert.equal(r.mem.openQuestions[0].text, "Will we lose orders today?");
  assert.ok(!r.mem.facts.some((f: { id: string }) => f.id === mem.facts[0].id));
});

test("memlib.editMemory: a flood of edits stops at the limit with a plain message", { ...POSIX }, () => {
  const calls = callsWith(fixtures["dev-support-en"].mem);
  const f = join(calls, CALL, "user-edits.jsonl");
  writeFileSync(f, '{"at":1,"edit":{"op":"add","list":"facts","text":"x"}}\n'.repeat(memlib.MAX_EDIT_ROWS));
  assert.deepEqual(memlib.editMemory(calls, CALL, { op: "add", list: "facts", text: "y" }), { ok: false, error: "too many changes" });
});

test("memlib.afterCall: loops split by who I am; no memory gives null", { ...POSIX }, () => {
  const calls = callsWith(fixtures["dev-support-en"].mem);
  const a = memlib.afterCall(calls, CALL, { meNames: ["Dan"] });
  assert.deepEqual(
    a.loops.promises.map((p: { who: string }) => p.who),
    ["Dan"],
  );
  assert.deepEqual(
    a.loops.theirs.map((p: { who: string }) => p.who),
    ["Lena"],
  );
  assert.equal(a.empty, false);
  assert.equal(memlib.afterCall(callsWith(null), CALL), null);
});

// ---- live tail carries the memory ----

test("livetail: session.json changes arrive with the live payload; AI paused follows the health bars; a torn file is skipped", { ...POSIX }, () => {
  const calls = tmp();
  const dir = join(calls, CALL);
  mkdirSync(dir);
  const sent: Record<string, any>[] = [];
  const tail = createLiveTail({ callsDir: calls, send: (p: Record<string, unknown>) => sent.push(p), setInterval: () => 0, clearInterval: () => {} });
  tail.sync({ running: true, callId: CALL });
  sent.length = 0;
  const mem = fixtures["dev-support-en"].mem;
  writeFileSync(join(dir, "session.json"), JSON.stringify(mem));
  tail.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].memory.model.source, "memory");
  assert.equal(sent[0].memory.ai, "ok");
  tail.tick();
  assert.equal(sent.length, 1, "nothing new, nothing sent");
  appendFileSync(
    join(dir, "cards.jsonl"),
    JSON.stringify({ type: "card", id: "health-ai", health: true, level: "amber", badge: "warn", say: "AI is slow" }) + "\n",
  );
  tail.tick();
  assert.equal(sent.at(-1)!.memory.ai, "paused");
  writeFileSync(join(dir, "session.json"), '{"v":1,"ver":9,');
  tail.tick();
  assert.equal(tail.snapshot(CALL).memory.model.sections.promises.length > 0, true, "the last good notes stay");
  appendFileSync(join(dir, "cards.jsonl"), JSON.stringify({ type: "card", id: "health-ai", health: true, clear: true, badge: "warn" }) + "\n");
  tail.tick();
  assert.equal(sent.at(-1)!.memory.ai, "ok");
  tail.stop();
});

// ---- Prepare ----

test("prepare: runPrepare maps child results, hides failures behind a reason, never throws", async () => {
  const mk =
    (stdout: string, err: unknown = null) =>
    (_a: string[], _o: unknown, cb: (e: unknown, s: string) => void) => {
      setImmediate(() => cb(err, stdout));
      return { stdin: { on() {}, end() {} } };
    };
  const plan = { title: "t", who: "w" };
  const base = { plan, attachDir: "x", out: "y", lang: "en", cwd: ROOT };
  const ok = await prep.runPrepare({ ...base, exec: mk('{"ok":true,"digest":true,"counts":{"roster":2}}\n') });
  assert.deepEqual(ok, { ok: true, digest: true, counts: { roster: 2 } });
  assert.equal((await prep.runPrepare({ ...base, exec: mk('{"ok":true,"digest":false,"reason":"no-digest"}') })).reason, "no-digest");
  assert.equal((await prep.runPrepare({ ...base, exec: mk("garbage") })).reason, "failed");
  assert.equal((await prep.runPrepare({ ...base, exec: mk("", { killed: true }) })).reason, "timeout");
  assert.equal((await prep.runPrepare({ ...base, exec: mk('{"ok":true,"digest":false,"reason":"<script>"}') })).reason, undefined);
  assert.equal(
    (
      await prep.runPrepare({
        ...base,
        exec: () => {
          throw new Error("spawn failed");
        },
      })
    ).reason,
    "failed",
  );
});

function runCli(input: unknown, env: Record<string, string>) {
  const r = spawnSync(join(ROOT, "node_modules", ".bin", "tsx"), ["src/prepare-cli.ts"], {
    cwd: ROOT,
    input: JSON.stringify(input),
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}
test("prepare-cli: empty text, no digest module, a fake digest module, a failing one and a garbage one", { ...POSIX, timeout: 120_000 }, () => {
  const d = tmp();
  const attach = join(d, "files");
  mkdirSync(attach);
  const out = join(d, "digest.json");
  const input = { out, lang: "en", plan: { title: "Hosting move", who: "Dana Levi", goal: "", notes: "", mustCover: "Price" } };
  assert.deepEqual(runCli({ ...input, plan: {} }, { WINGMAN_ATTACH_DIR: attach }), { ok: true, digest: false, reason: "empty" });
  assert.equal(runCli(input, { WINGMAN_ATTACH_DIR: attach, WINGMAN_DIGEST_MODULE: join(d, "missing.mjs") }).reason, "no-digest");
  const fake = join(d, "fake.mjs");
  writeFileSync(
    fake,
    'export async function runDigest(i){ return { digest: { roster:[{name:"Dana Levi",role:"owner"}], agenda:["Price"], facts:[{text:"Seen: "+(i.text.includes("Hosting move"))}], likelyQuestions:[], chunks:[] } }; }',
  );
  const r = runCli(input, { WINGMAN_ATTACH_DIR: attach, WINGMAN_DIGEST_MODULE: fake });
  assert.equal(r.digest, true);
  assert.equal(r.counts.roster, 1);
  const saved = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(saved.facts[0], "Seen: true");
  const bad = join(d, "bad.mjs");
  writeFileSync(bad, 'export async function runDigest(){ throw new Error("529 overloaded"); }');
  assert.equal(runCli(input, { WINGMAN_ATTACH_DIR: attach, WINGMAN_DIGEST_MODULE: bad }).reason, "failed");
  const junk = join(d, "junk.mjs");
  writeFileSync(junk, "export async function runDigest(){ return 42; }");
  assert.equal(runCli(input, { WINGMAN_ATTACH_DIR: attach, WINGMAN_DIGEST_MODULE: junk }).reason, "raw");
});

test("digest file: strict clean, size and shape limits, atomic write, read next to the brief", { ...POSIX }, () => {
  assert.equal(cleanDigest(null), null);
  assert.equal(cleanDigest({ roster: "x" }), null);
  const d = cleanDigest({ roster: [{ name: "A‮B", side: "me" }, {}], agenda: ["a", 5], facts: [{ text: "f" }], chunks: [{ text: "c" }], evil: "<x>" })!;
  assert.equal(d.roster[0].name, "AB");
  assert.equal(d.roster[0].side, "me");
  assert.equal(JSON.stringify(d).includes("evil"), false);
  const dir = tmp();
  const brief = join(dir, "brief.yaml");
  writeDigestFile(digestFileNear(brief), d);
  assert.deepEqual(readDigestNear(brief), d);
  assert.equal(readDigestNear(join(tmp(), "brief.yaml")), undefined);
  writeFileSync(digestFileNear(brief), "{bad");
  assert.equal(readDigestNear(brief), undefined);
});

// ---- strings ----

test("strings: every key exists in EN and HE, the v2 settings labels are complete, placeholders match", () => {
  assert.deepEqual(Object.keys(EN).sort(), Object.keys(HE).sort());
  const keys = [
    "moments.engine",
    "moments.observerPerMinute",
    "moments.windowSeconds",
    "moments.minValue",
    "memory.enabled",
    "memory.everySeconds",
    "memory.minNewWords",
    "memory.compactEveryMinutes",
    "memory.budgetTokens",
    "ctx.rawTailTokens",
    "digest.model",
    "budget.maxLlmUsdPerHour",
  ];
  for (const k of keys) for (const f of ["label", "help"]) for (const L of [EN, HE]) assert.ok(L[`set.${k}.${f}`], `${k}.${f}`);
  for (const v of ["v2", "legacy"]) assert.ok(EN[`set.moments.engine.opt.${v}`] && HE[`set.moments.engine.opt.${v}`]);
  const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
  for (const k of Object.keys(EN).filter((k) => /^(set\.|tab\.|after\.(loops|draft)|knows\.ai|ctx\.prep|err\.(digest|memory))/.test(k)))
    assert.equal(ph(EN[k]), ph(HE[k]), k);
  assert.equal(HE["tab.followup"], "מעקב");
  assert.equal(EN["tab.followup"], "Follow-up");
});

// ---- Electron snapshots (opt-in, macOS): live notes, AI paused, after-call, EN/HE, light/dark ----

const DASH = join(ROOT, "dashboard");
const SNAP = process.env.WINGMAN_DASH_SNAP === "1" && process.platform === "darwin" && existsSync(join(ROOT, "node_modules", ".bin", "electron"));
test("dashboard snapshots over golden-run data: no clipping in EN, HE, light and dark", { skip: !SNAP, timeout: 900_000 }, () => {
  const out = mkdtempSync(join(tmpdir(), "wm-dash-live-"));
  const A = "01SNAPGOLDENENA00000000000",
    B = "01SNAPGOLDENHEB00000000000";
  const specs = [
    "live-en-dark:en:dark:home:live:-:-:-:golden",
    "live-he-light:he:light:home:live:-:-:-:golden",
    "paused-he-dark:he:dark:home:live:-:-:-:golden-paused",
    "paused-en-light:en:light:home:live:-:-:-:golden-offline",
    `after-en-dark:en:dark:home:-:-:${A}:followup`,
    `after-he-light:he:light:home:-:-:${B}:followup`,
  ];
  execFileSync(join(DASH, "snapshot.sh"), [out, ...specs], { env: { ...process.env, WINGMAN_DASHBOARD_SIZE: "1100x1500" }, timeout: 600_000 });
  for (const s of specs) {
    const r = JSON.parse(readFileSync(join(out, s.split(":")[0] + ".png.json"), "utf8"));
    assert.deepEqual(r.problems, [], s);
    assert.equal(r.dir, s.split(":")[1] === "he" ? "rtl" : "ltr");
  }
});
