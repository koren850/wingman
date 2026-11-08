// Tests of the round 3 verification work (package r3-verify-ship): the absolute ship gates (qa/ship.json), the blind split test-c, the latency
// distribution, and the rule that no unit test greps a source file for a word (except the security-config list kept at the end).
// No network, no keys.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadSplit, loadFinalSplits, readSplitFiles, lockHash, checkLock } from "../qa/golden-load.ts";
import { MEETINGS } from "../qa/golden-build.ts";
import { HELD_OUT, SHIP_ONLY } from "../qa/golden-schema.ts";
import { judgeShip, controlShip, readShip, type ShipLine, type ShipValues } from "../qa/ship.ts";
import { ROOT } from "./env.ts";

const ship = readShip();
const line = (id: string) => ship.lines.find((l) => l.id === id)!;

// ---------------------------------------------------------------- the ship gates
test("qa/ship.json: the gates PLAN 3.6 names, each with a direction and a limit; the two recorded-only lines are marked", () => {
  const ids = ship.lines.map((l) => l.id);
  for (const want of [
    "precision.answer",
    "precision.check",
    "precision.fact",
    "recall",
    "noq.recall",
    "dup.rate",
    "silent.cpm",
    "cards.perHour",
    "gap.recall",
    "gap.precision",
    "wrong.lang",
    "memory.f1",
    "ttc.direct.p95",
    "cost.perHour",
  ])
    assert.ok(ids.includes(want), want);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  assert.deepEqual(
    ship.lines.filter((l) => l.recordedOnly).map((l) => l.id),
    ["memory.f1", "ttc.direct.p95"],
  );
  assert.equal(line("precision.answer").limit, 0.8);
  assert.equal(line("noq.recall").limit, 0.85);
  assert.equal(line("dup.rate").limit, 0.03);
  assert.equal(line("silent.cpm").limit, 0.02);
  assert.equal(line("cards.perHour").limit, 40);
  assert.equal(line("wrong.lang").limit, 0);
  assert.equal(line("cost.perHour").limit, 0.25);
  assert.equal(line("ttc.direct.p95").limit, 2500);
});

const good: ShipValues = Object.fromEntries(ship.lines.map((l) => [l.metric, { value: l.op === ">=" ? l.limit + 0.01 : Math.max(0, l.limit - 0.001), n: 50 }]));

test("judgeShip: a value on the right side passes, on the wrong side fails; a limit itself passes", () => {
  const j = judgeShip(good, ship.lines, true);
  assert.equal(j.failed, 0, JSON.stringify(j.rows.filter((r) => r.verdict !== "pass")));
  const bad = judgeShip({ ...good, "card.precision": { value: 0.79, n: 50 }, "dup.rate": { value: 0.031, n: 50 } }, ship.lines, true);
  assert.deepEqual(
    bad.rows.filter((r) => r.verdict === "FAIL").map((r) => r.id),
    ["precision", "dup.rate"],
  );
  const edge = judgeShip({ ...good, "card.recall": { value: 0.8, n: 5 }, "wrong.lang": { value: 0, n: 5 } }, ship.lines, true);
  assert.equal(edge.rows.find((r) => r.id === "recall")!.verdict, "pass");
  assert.equal(edge.rows.find((r) => r.id === "wrong.lang")!.verdict, "pass");
});

test("judgeShip: recordedOnly lines print n/a (scripted) on scripted replies and are never counted; on a recorded run a missing value fails them", () => {
  const scripted = judgeShip({ ...good, "memory.f1": undefined, "ttc.direct.p95": undefined }, ship.lines, false);
  for (const id of ["memory.f1", "ttc.direct.p95"]) assert.equal(scripted.rows.find((r) => r.id === id)!.verdict, "n/a (scripted)");
  assert.equal(scripted.failed, 0);
  assert.equal(scripted.skipped, 2);
  // even a value that would fail does not count on scripted replies
  const worse = judgeShip({ ...good, "ttc.direct.p95": { value: 9000, n: 3 } }, ship.lines, false);
  assert.equal(worse.rows.find((r) => r.id === "ttc.direct.p95")!.verdict, "n/a (scripted)");
  // recorded: no evidence is no pass
  const rec = judgeShip({ ...good, "memory.f1": undefined }, ship.lines, true);
  assert.equal(rec.rows.find((r) => r.id === "memory.f1")!.verdict, "FAIL");
  const rec2 = judgeShip({ ...good, "ttc.direct.p95": { value: 2600, n: 3 } }, ship.lines, true);
  assert.equal(rec2.rows.find((r) => r.id === "ttc.direct.p95")!.verdict, "FAIL");
});

test("controls on the ship gate: null, noise, shuffled and always-ANS fail it; a good run does not trip the control check", () => {
  const limits = { null: { recall: 0, precision: 0, cards: 17, silentCpm: 0.18 }, noise: { recall: 0, precision: 0, cards: 77, silentCpm: 2.6 } };
  for (const c of Object.values(limits)) assert.equal(controlShip(c).passes, false);
  // a bad model that showed no card at all still fails on recall
  assert.equal(controlShip({ recall: 0, precision: 1, cards: 0, silentCpm: 0 }).passes, false);
  assert.ok(controlShip({ recall: 0, precision: 1, cards: 0, silentCpm: 0 }).failing.includes("recall"));
  // a run that is good on every line a pooled grade can answer would pass: the check is what flags a fooled grader
  assert.equal(controlShip({ recall: 0.9, precision: 0.9, cards: 30, silentCpm: 0 }).passes, true);
  const lines: ShipLine[] = [{ id: "x", label: "x", metric: "card.recall", op: ">=", limit: 0.5, unit: "%" }];
  assert.equal(controlShip({ recall: 0.4, precision: 1, cards: 0, silentCpm: 0 }, lines).passes, false);
});

// ---------------------------------------------------------------- the blind split test-c
const testC = () =>
  readSplitFiles("test-c").map((f) => JSON.parse(f.text) as { id: string; lang: string; lines: { text: string; speaker?: string }[]; type: string });

test("test-c: at least 8 meetings, EN and HE equal within 10 percent, a sha256 lock, and it is held out and ship-only", () => {
  const gs = testC();
  assert.ok(gs.length >= 8, `${gs.length} meetings`);
  const en = gs.filter((g) => g.lang === "en").length,
    he = gs.filter((g) => g.lang === "he").length;
  assert.ok(Math.abs(en - he) <= 0.1 * Math.max(en, he), `en ${en}, he ${he}`);
  assert.ok(HELD_OUT.includes("test-c"));
  assert.deepEqual([...SHIP_ONLY], ["test-c"]);
  const lock = readFileSync(join(MEETINGS, "test-c.lock"), "utf8").trim();
  assert.match(lock, /^[0-9a-f]{64}$/);
  assert.equal(lock, lockHash(readSplitFiles("test-c")), "the lock matches the files");
  // the lock hash is a sha256 over name and bytes: recompute it by hand
  const h = createHash("sha256");
  for (const f of readSplitFiles("test-c")) h.update(f.name + "\n" + f.text + "\n");
  assert.equal(h.digest("hex"), lock);
});

test("test-c: it has the cases the plan asks for (three speakers, a long silence, a topic jump, Hebrew ASR errors, English words in Hebrew letters)", () => {
  const gs = loadSplit("test-c", { final: true, ship: true });
  const tags = new Set(gs.flatMap((g) => g.moments.flatMap((m) => m.tags ?? [])));
  for (const t of ["crosstalk", "topic-shift", "asr", "dropped-word", "split-final", "duplicate", "english-in-hebrew", "number-conflict", "objection"])
    assert.ok(tags.has(t), `tag ${t}`);
  assert.ok(
    gs.some((g) => g.type === "threeway" && new Set(g.lines.map((l) => l.speaker ?? "me")).size >= 3),
    "a 3-speaker meeting",
  );
  assert.ok(
    gs.some((g) => g.lines.some((l, i) => i && l.t - g.lines[i - 1].t >= 40_000)),
    "a pause of 40 s or more",
  );
  assert.ok(gs.filter((g) => g.silent.length).length >= 4, "most meetings end in a silent window");
  // Hebrew ASR errors: a glued or split prefix, a Hebrew-letter English word, a number written as words
  const he = gs.filter((g) => g.lang === "he").flatMap((g) => g.lines.map((l) => l.text));
  assert.ok(
    he.some((t) => /(^|\s)ב שישי|שבו עות/.test(t)),
    "a split word",
  );
  assert.ok(
    he.some((t) => /אפדייט|רולבק/.test(t)),
    "English words in Hebrew letters",
  );
  assert.ok(
    he.some((t) => /חמש מאות|חמישים אלף|ארבעים וחמישה/.test(t)),
    "numbers as words",
  );
  // every moment has a latest time and the meetings are scripted (the scripted caveat is in the README)
  for (const g of gs) assert.equal(g.scripted, true);
});

test("test-c: invented data only. No email, phone number, link or handle; the private denylist (when set) finds nothing; the check itself works", () => {
  const files = [
    ...readSplitFiles("test-c").map((f) => f.text),
    ...readdirSync(join(MEETINGS, "src"))
      .filter((f) => f.startsWith("test-c-"))
      .map((f) => readFileSync(join(MEETINGS, "src", f), "utf8")),
  ];
  assert.ok(files.length >= 16);
  const shapes: [RegExp, string][] = [
    [/[\w.+-]+@[\w-]+\.[a-z]{2,}/i, "email address"],
    [/\b(?:\+?\d{1,3}[ -])?\(?\d{2,3}\)?[ -]\d{3}[ -]\d{4}\b/, "phone number"],
    [/\bhttps?:\/\/|\bwww\./i, "link"],
    [/\b\d{9}\b/, "ID number"],
  ];
  const found = (text: string, extra?: RegExp) => [
    ...shapes.filter(([re]) => re.test(text)).map(([, n]) => n),
    ...(extra && extra.test(text) ? ["denylist"] : []),
  ];
  const file = join(ROOT, "data", "private", "denylist.txt");
  const words = [...(process.env.WINGMAN_DENYLIST ?? "").split(","), ...(existsSync(file) ? readFileSync(file, "utf8").split("\n") : [])]
    .map((w) => w.trim())
    .filter((w) => w && !w.startsWith("#"));
  const deny = words.length ? new RegExp(words.join("|"), "i") : undefined;
  for (const t of files) assert.deepEqual(found(t, deny), []);
  // the mechanism works on bad text
  assert.deepEqual(found("write to dana@example.com"), ["email address"]);
  assert.deepEqual(found("call 054 123 4567 now"), ["phone number"]);
  assert.deepEqual(found("see https://x.example"), ["link"]);
  assert.deepEqual(found("the secretword is here", /secretword/), ["denylist"]);
  // names are from the invented roster and are not shared with other splits' real-looking names list: no meeting copies a dev line
  const devLines = new Set(
    loadSplit("dev")
      .flatMap((g) => g.lines.map((l) => l.text.toLowerCase()))
      .filter((t) => t.split(/\s+/).length > 6),
  );
  for (const g of testC()) for (const l of g.lines) assert.ok(!devLines.has(l.text.toLowerCase()), `${g.id} copies a dev line: ${l.text}`);
});

test("test-c is read only by 'eval --final --ship': without the flag the loader refuses, 'eval --final' alone never lists it, and an edit stops it", () => {
  assert.throws(() => loadSplit("test-c"), /held out/);
  assert.throws(() => loadSplit("test-c", { final: true }), /blind.*--final --ship/);
  assert.equal(loadSplit("test-c", { final: true, ship: true }).length, testC().length);
  const plain = loadFinalSplits();
  assert.ok(plain.length >= 18 && plain.every((g) => g.split !== "test-c"), "eval --final alone reads test and test-b only");
  assert.ok(loadFinalSplits(undefined, { ship: true }).some((g) => g.split === "test-c"));
  const tmp = mkdtempSync(join(tmpdir(), "final-lock-c-"));
  try {
    cpSync(MEETINGS, tmp, { recursive: true });
    checkLock("test-c", tmp);
    const f = join(tmp, "test-c", readdirSync(join(tmp, "test-c"))[0]);
    writeFileSync(f, readFileSync(f, "utf8").replace('"side"', '"side" '));
    assert.throws(() => loadFinalSplits(tmp, { ship: true }), /test-c.lock does not match/);
    // a missing lock file also stops it
    cpSync(MEETINGS, tmp, { recursive: true });
    rmSync(join(tmp, "test-c.lock"));
    assert.throws(() => loadFinalSplits(tmp, { ship: true }), /test-c.lock is missing/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- no more tests that grep a source file for a word
// A test that reads a source file and matches a word or a require line breaks on every refactor and proves nothing about behaviour. Behaviour tests or ESLint
// rules (eslint.config.mjs) replace them. This ratchet lists the test files that still read source text. A new one fails here. Security-config greps stay.
const SOURCE_READ = /(?:read|readFileSync|readFile)\([^)]*["'`][^"'`]*\.(?:cjs|mjs|js|ts|sh|html|css)["'`]/;
const KEPT: Record<string, string> = {
  "invariants.test.ts":
    "security config: CSP, sender checks, window flags, preload command lists, the key-value allow-list, the scrubbed child environment, no sudo in the installers. A regression is silent at runtime (the page just becomes less safe), so the text is the only place to check it. The lockdown call and the overlay crash handlers moved to ESLint rules (wingman/installs-permissions, wingman/main-crash-handlers).",
  "r2-gates.test.ts":
    "security config: the snapshot script must never name a command that steals focus (osascript, open -a, activate). Its other rules are behaviour tests with stub scripts now.",
  "r2-verify-core.test.ts": "template data, not code: every data-i18n name in overlay/index.html must exist in overlay/strings.js.",
};
// Files of other packages: they clean up their own tests in round 3 (PLAN-r3: r3-moments-precision, r3-cards-overlay, r3-app-ux). Listed so the count only goes down.
const OWNER_TODO = [
  "dashboard-i18n.test.ts",
  "overlay-v2.test.ts",
  "r2-dash-ux.test.ts",
  "r2-modes.test.ts",
  "r2-overlay-ux.test.ts",
  "tray-reliability.test.ts",
];

test("no unit test greps a source file, except the security-config list kept here (and the files other packages still have to clean up)", () => {
  const dir = join(ROOT, "src");
  const found = new Set(
    readdirSync(dir)
      .filter((f) => f.endsWith(".test.ts") && f !== "r3-verify-ship.test.ts")
      .filter((f) => SOURCE_READ.test(readFileSync(join(dir, f), "utf8"))),
  );
  const allowed = new Set([...Object.keys(KEPT), ...OWNER_TODO]);
  for (const f of found) assert.ok(allowed.has(f), `${f} reads a source file as text: write a behaviour test or an ESLint rule`);
  for (const f of allowed) assert.ok(found.has(f), `${f} no longer reads source text: remove it from the list in r3-verify-ship.test.ts`);
  for (const [f, why] of Object.entries(KEPT)) assert.ok(why.length > 20, `${f} needs a reason`);
  // the number of source reads in invariants.test.ts only goes down
  const inv = readFileSync(join(dir, "invariants.test.ts"), "utf8");
  const n = inv.split("\n").filter((l) => SOURCE_READ.test(l)).length;
  assert.ok(n <= 51, `invariants.test.ts has ${n} source reads (51 at the start of round 3; it only goes down)`);
});

test("the shared lint rules for the Electron main processes exist and are switched on", async () => {
  const { ESLint } = await import("eslint");
  const cfg = (await new ESLint({ cwd: ROOT }).calculateConfigForFile(join(ROOT, "overlay", "main.cjs"))) as { rules: Record<string, unknown> };
  assert.deepEqual(cfg.rules["wingman/installs-permissions"], [2]);
  assert.deepEqual(cfg.rules["wingman/main-crash-handlers"], [2]);
  const tray = (await new ESLint({ cwd: ROOT }).calculateConfigForFile(join(ROOT, "tray", "main.cjs"))) as { rules: Record<string, unknown> };
  assert.deepEqual(tray.rules["wingman/installs-permissions"], [2]);
});

test("qa/legacy-tests.json: every listed legacy test file exists, none is listed twice, and none of them is a v2 or r3 test", () => {
  const j = JSON.parse(readFileSync(join(ROOT, "qa", "legacy-tests.json"), "utf8")) as {
    lane: { file: string; ms: number }[];
    staysInMain: { file: string }[];
  };
  const all = [...j.lane, ...j.staysInMain].map((x) => x.file);
  assert.equal(new Set(all).size, all.length);
  for (const f of all) assert.ok(existsSync(join(ROOT, "src", f)), f);
  for (const f of j.lane.map((x) => x.file)) assert.ok(!/^(r\d|v2|moments-(engine|golden|fuzz))/.test(f), `${f} is not a legacy test`);
  assert.ok(j.lane.length >= 5);
});
