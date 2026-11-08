// Tests for the golden meetings and their grader (qa/grade-golden.ts, qa/golden-*.ts). No model, no network.
// Structure checks read the test split as raw files (counts, schema, lock). Nothing here scores an engine on it: only `pnpm eval --final` does.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./env.ts";
import { tsx } from "./test-platform.ts";
import { guard } from "./guards.ts";
import {
  gradeGolden,
  gradeMemory,
  poolGrades,
  nullTimeline,
  noiseTimeline,
  oracleTimeline,
  degradeAsr,
  percentile,
  scriptLang,
  squash,
  CONTROL_LIMITS,
  type Golden,
  type TimelineCard,
} from "../qa/grade-golden.ts";
import { GoldenSchema, TYPES } from "../qa/golden-schema.ts";
import { loadSplit, checkTestLock, readSplitFiles, lockHash } from "../qa/golden-load.ts";
import { buildAll, MEETINGS } from "../qa/golden-build.ts";
import { legacyTimeline } from "../qa/legacy-replay.ts";

const dev = () => loadSplit("dev");
const allRaw = () => [...readSplitFiles("dev"), ...readSplitFiles("test")].map((f) => GoldenSchema.parse(JSON.parse(f.text)));

// ---------------------------------------------------------------- the grader on a toy meeting
const toy: Golden = {
  id: "dev-toy",
  split: "dev",
  lang: "en",
  type: "sales",
  variant: "clean",
  lines: [
    { id: "l1", t: 1000, side: "them", text: "What is the price for the plan?" },
    { id: "l2", t: 10000, side: "them", text: "That seems expensive compared with the other offer." },
    { id: "l3", t: 20000, side: "them", text: "Earlier you said the plan has 3 hours." },
    { id: "l4", t: 30000, side: "me", text: "Let me check." },
    { id: "l5", t: 40000, side: "them", text: "Nice weather today." },
    { id: "l6", t: 50000, side: "them", text: "Yes it is." },
    { id: "l7", t: 60000, side: "them", text: "And how long does a build take?" },
  ],
  moments: [
    { id: "m1", afterLine: "l1", kind: "answer", mustMention: ["price"], latestMs: 4000, direct: true },
    { id: "m2", afterLine: "l2", kind: "prompt", mustMention: ["scope"], latestMs: 8000 },
    { id: "m3", afterLine: "l3", kind: "check", mustMention: ["3 hours"], latestMs: 8000 },
    { id: "m4", afterLine: "l7", kind: "answer", mustMention: ["build"], latestMs: 4000, direct: true },
  ],
  silent: [{ fromLine: "l5", toLine: "l6" }],
};
const c = (atMs: number, kind: TimelineCard["kind"], text: string, extra: Partial<TimelineCard> = {}): TimelineCard => ({ atMs, kind, text, ...extra });

test("grader: a hit counts for recall, precision and time to card", () => {
  const g = gradeGolden(toy, [c(2500, "answer", "The price depends on the plan")]);
  assert.equal(g.results.find((r) => r.id === "m1")?.status, "hit");
  assert.equal(g.results.find((r) => r.id === "m1")?.ttcMs, 1500);
  assert.equal(g.hits, 1);
  assert.equal(g.recall, 1 / 4);
  assert.equal(g.precision, 1);
  assert.equal(g.byKind.answer.recall, 1 / 2);
  assert.equal(g.directRecall, 1 / 2);
  assert.equal(g.ttcP50, 1500);
});

test("grader: a miss is a miss, and a card of the wrong kind does not count", () => {
  const g = gradeGolden(toy, [c(11000, "answer", "scope scope")]);
  assert.equal(g.results.find((r) => r.id === "m2")?.status, "miss");
  assert.equal(g.hits, 0);
  assert.equal(g.precision, 0);
});

test("grader: a late card is a late miss, not a hit", () => {
  const g = gradeGolden(toy, [c(10000 + 12000, "prompt", "Talk about scope")]); // latest is 8000, lateFactor 2 allows up to 16000
  assert.equal(g.results.find((r) => r.id === "m2")?.status, "late");
  assert.equal(g.recall, 0);
  assert.equal(g.precision, 0);
  const way = gradeGolden(toy, [c(10000 + 30000, "prompt", "Talk about scope")]);
  assert.equal(way.results.find((r) => r.id === "m2")?.status, "miss");
});

test("grader: wrong text (a mustMention token missing) is counted as a wrong card, not a hit", () => {
  const g = gradeGolden(toy, [c(21000, "check", "Something about hours"), c(2000, "answer", "The price is on the page")]);
  assert.equal(g.results.find((r) => r.id === "m3")?.status, "wrong-text");
  assert.equal(g.wrongCards, 1);
  assert.equal(g.wrongCardRate, 1 / 2); // 2 cards were in time and of the right kind, 1 had the wrong text
  assert.equal(g.hits, 1);
});

test("grader: a card inside a silent window is counted and the cards per minute follow", () => {
  const g = gradeGolden(toy, [c(41000, "answer", "Anything at all")]);
  assert.equal(g.silentCards, 1);
  assert.ok(g.silentMinutes > 0);
  assert.ok(g.silentCpm > 0);
  const quiet = gradeGolden(toy, [c(2500, "answer", "The price")]);
  assert.equal(quiet.silentCards, 0);
  assert.equal(quiet.silentCpm, 0);
});

test("grader: a second card for a served moment, or the same text again, is a duplicate", () => {
  const g = gradeGolden(toy, [c(2500, "answer", "The price depends"), c(3000, "answer", "The price depends again")]);
  assert.equal(g.duplicates, 1);
  assert.equal(g.duplicateRate, 1 / 2);
  assert.equal(g.precision, 1 / 2);
  const same = gradeGolden(toy, [c(45000, "fact", "Same text"), c(80000, "fact", "same   text!")]);
  assert.equal(same.duplicates, 1);
});

test("grader: wrong language and guard breaches", () => {
  const he = gradeGolden(toy, [c(2500, "answer", "המחיר תלוי בחבילה, price")]);
  assert.equal(he.wrongLang, 1);
  assert.equal(he.wrongLangRate, 1);
  const g = gradeGolden(toy, [c(2500, "answer", "The price is $500")], { guard: (t) => /\$\d/.test(t) });
  assert.equal(g.guardBreaches, 1);
  const check = gradeGolden(toy, [c(21000, "check", "You said $500 and 3 hours")], { guard: (t) => /\$\d/.test(t) });
  assert.equal(check.guardBreaches, 0, "a check card quotes the call: the guard applies to answer and prompt cards only");
});

test("grader: percentiles, script language, squash", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(scriptLang("Send me the file"), "en");
  assert.equal(scriptLang("שלח לי את הקובץ with the API"), "he");
  assert.equal(scriptLang("12"), undefined);
  assert.equal(squash("$4,000 Next-Week!"), "4000nextweek");
});

test("gradeMemory: the newest snapshot at or before the check line must hold every token", () => {
  const g: Golden = {
    ...toy,
    memoryChecks: [
      { atLine: "l3", mustContain: ["Friday", "quote"] },
      { atLine: "l7", mustContain: ["3 hours"] },
    ],
  };
  const snaps = [
    { atLine: "l1", memory: { commitments: [{ what: "send the quote", due: "Friday" }] } },
    { atLine: "l5", memory: { numbers: [{ what: "support", value: "3 hours" }] } },
  ];
  const r = gradeMemory({ ...g, memoryChecks: [...g.memoryChecks!, { atLine: "l7", mustContain: ["Friday"] }] }, snaps);
  assert.equal(r.checks, 3);
  assert.equal(r.passed, 2, "l1 snapshot passes the first check, the l5 snapshot passes the second, and it lost Friday so the third fails");
  assert.deepEqual(r.failures, [{ atLine: "l7", missing: ["Friday"] }]);
  assert.equal(gradeMemory(g, []).passed, 0, "no snapshot = fail");
  const late = gradeMemory({ ...g, memoryChecks: [{ atLine: "l3", mustContain: ["3 hours"] }] }, snaps);
  assert.equal(late.passed, 0, "a snapshot taken after the check line does not count");
});

// ---------------------------------------------------------------- negative controls
test("controls: the null model and the noise model score under the limits on every dev meeting set", () => {
  const meetings = dev();
  const nul = poolGrades(meetings.map((golden) => ({ golden, grade: gradeGolden(golden, nullTimeline(golden)) })));
  assert.ok(nul.recall < CONTROL_LIMITS.nullRecall, `null recall ${nul.recall}`);
  for (const seed of [1, 2, 3]) {
    const noise = poolGrades(meetings.map((golden, i) => ({ golden, grade: gradeGolden(golden, noiseTimeline(golden, seed * 100 + i)) })));
    assert.ok(noise.precision < CONTROL_LIMITS.noisePrecision, `noise precision ${noise.precision} (seed ${seed})`);
    assert.ok(noise.recall < CONTROL_LIMITS.noiseRecall, `noise recall ${noise.recall} (seed ${seed})`);
  }
});

test("controls: the grader self-test would fail if a bad grader let noise through", () => {
  // a deliberately broken grader (kind and token ignored, any card in time counts) must break the control limits, so the control can catch it
  const meetings = dev();
  let hits = 0,
    moments = 0;
  for (const g of meetings) {
    const cards = noiseTimeline(g, 5);
    for (const m of g.moments) {
      const t0 = g.lines.find((l) => l.id === m.afterLine)!.t;
      moments++;
      if (cards.some((x) => x.atMs >= t0 && x.atMs <= t0 + m.latestMs)) hits++;
    }
  }
  assert.ok(hits / moments >= CONTROL_LIMITS.noiseRecall, `a sloppy grader gives noise ${hits / moments} recall: the control would fail it`);
});

test("oracle: one card per moment from the scripted SAY scores perfectly on every meeting", () => {
  for (const g of allRaw()) {
    const r = gradeGolden(g, oracleTimeline(g), { guard: (t) => !guard(t).ok });
    assert.equal(r.recall, 1, `${g.id}: ${JSON.stringify(r.results.filter((x) => x.status !== "hit"))}`);
    assert.equal(r.precision, 1, g.id);
    assert.equal(r.silentCards, 0, `${g.id}: an oracle card fell in a silent window`);
    assert.equal(r.wrongLang, 0, `${g.id}: oracle card in the wrong language`);
    assert.equal(r.duplicates, 0, g.id);
    assert.equal(r.ttcP95, 1200);
  }
});

test("oracle: answer and prompt cards pass the engine guards (no price, date or promise a user could say)", () => {
  const bad: string[] = [];
  for (const g of allRaw())
    for (const x of oracleTimeline(g).entries()) {
      const m = g.moments[x[0]];
      if ((m.kind === "answer" || m.kind === "prompt") && !guard(x[1].text).ok) bad.push(`${g.id} ${m.id}: ${x[1].text}`);
    }
  assert.deepEqual(bad, []);
});

test("memory oracle: the scripted memory patches, applied in order, pass every memory check", () => {
  for (const g of allRaw()) {
    const mem: Record<string, unknown[]> = {};
    const snaps: { atLine: string; memory: unknown }[] = [];
    for (const s of g.script ?? []) {
      if (s.role === "digest") {
        const d = JSON.parse(s.reply);
        for (const k of ["roster", "agenda", "facts", "likelyQuestions"]) (mem[`digest.${k}`] ??= []).push(...(d[k] ?? []));
      }
      if (s.role !== "memory") continue;
      const patch = JSON.parse(s.reply) as { add?: Record<string, object[]>; topic?: string };
      for (const [k, v] of Object.entries(patch.add ?? {})) (mem[k] ??= []).push(...v);
      if (patch.topic) (mem.topic ??= []).push(patch.topic);
      snaps.push({ atLine: s.whenLastLine, memory: { ...mem } });
    }
    const r = gradeMemory(g, snaps);
    assert.deepEqual(r.failures, [], `${g.id}: ${JSON.stringify(r.failures)}`);
    assert.ok(r.checks >= 1, `${g.id} has a memory check`);
  }
});

// ---------------------------------------------------------------- the files
test("every golden file validates against the schema, and the JSON on disk matches the sources", () => {
  const built = buildAll(false).golden;
  const disk = allRaw();
  assert.equal(disk.length, built.length);
  for (const b of built) {
    const d = disk.find((x) => x.id === b.id);
    assert.ok(d, `${b.id} is on disk`);
    assert.deepEqual(d, b, `${b.id}: run tsx qa/golden-build.ts`);
  }
  for (const s of ["dev", "test"] as const)
    for (const f of readdirSync(join(MEETINGS, s)).filter((x) => x.endsWith(".json"))) assert.match(f, new RegExp(`^${s}-[a-z0-9-]+\\.json$`));
});

test("counts: 24 meetings, 16 dev and 8 test, 300 or more moments, 100 or more in test, English and Hebrew balanced", () => {
  const all = allRaw();
  assert.equal(all.length, 24);
  assert.equal(all.filter((g) => g.split === "dev").length, 16);
  assert.equal(all.filter((g) => g.split === "test").length, 8);
  const moments = (gs: Golden[]) => gs.reduce((s, g) => s + g.moments.length, 0);
  assert.ok(moments(all) >= 300, `moments ${moments(all)}`);
  assert.ok(moments(all.filter((g) => g.split === "test")) >= 100);
  // mixed meetings (Hebrew with English terms) count half for each side
  const side = (lang: "en" | "he", by: (gs: Golden[]) => number) => by(all.filter((g) => g.lang === lang)) + by(all.filter((g) => g.lang === "mixed")) / 2;
  for (const by of [(gs: Golden[]) => gs.length, moments]) {
    const en = side("en", by),
      he = side("he", by);
    assert.ok(Math.abs(en - he) / Math.max(en, he) <= 0.1, `EN ${en} vs HE ${he}`);
  }
  // 8 types x 3: the dev split has an EN and an HE meeting of every type; the test split has one meeting of every type
  for (const t of TYPES) {
    const ofType = all.filter((g) => g.type === t);
    assert.equal(ofType.length, 3, t);
    assert.deepEqual(
      ofType
        .filter((g) => g.split === "dev")
        .map((g) => g.lang)
        .sort(),
      ["en", "he"],
      t,
    );
    assert.equal(ofType.filter((g) => g.split === "test").length, 1, t);
  }
});

test("shape: 6 to 20 minutes, 10 or more moments each, every kind and every hard case present, noisy test meetings", () => {
  const all = allRaw();
  const tags = new Set(all.flatMap((g) => g.moments.flatMap((m) => m.tags ?? [])));
  for (const need of ["implied", "objection", "number-conflict", "promise", "jargon", "topic-shift", "unanswered"]) assert.ok(tags.has(need), `tag ${need}`);
  const kinds = new Set(all.flatMap((g) => g.moments.map((m) => m.kind)));
  assert.deepEqual([...kinds].sort(), ["answer", "check", "fact", "prompt"]);
  for (const g of all) {
    const minutes = g.lines.at(-1)!.t / 60000;
    assert.ok(minutes >= 6 && minutes <= 20, `${g.id}: ${minutes.toFixed(1)} min`);
    assert.ok(g.moments.length >= 10, `${g.id}: ${g.moments.length} moments`);
    assert.ok(g.silent.length >= 1, `${g.id}: needs a silent window`);
    assert.ok((g.memoryChecks?.length ?? 0) >= 1, `${g.id}: needs a memory check`);
    assert.ok(g.scripted, `${g.id} is marked scripted`);
    assert.ok(g.context, `${g.id} has pre-meeting context`);
    assert.ok(g.lines.some((l) => l.side === "me") && g.lines.some((l) => l.side === "them"));
    const silentIds = new Set(
      g.silent.flatMap((w) =>
        g.lines
          .slice(
            g.lines.findIndex((l) => l.id === w.fromLine),
            g.lines.findIndex((l) => l.id === w.toLine) + 1,
          )
          .map((l) => l.id),
      ),
    );
    for (const m of g.moments) assert.ok(!silentIds.has(m.afterLine), `${g.id}: moment ${m.id} sits in a silent window`);
    // a long chatter window: some meeting stretch of 4 or more quiet lines in a row
  }
  assert.ok(
    all.some((g) => g.silent.some((w) => Number(w.toLine.slice(1)) - Number(w.fromLine.slice(1)) >= 3)),
    "a long chatter window exists",
  );
  // a question addressed to someone else and "send me the file": quiet lines with a question mark or a send request exist
  const quietText = all.flatMap((g) =>
    g.lines
      .filter((l) => g.silent.some((w) => Number(l.id.slice(1)) >= Number(w.fromLine.slice(1)) && Number(l.id.slice(1)) <= Number(w.toLine.slice(1))))
      .map((l) => l.text),
  );
  assert.ok(
    quietText.some((t) => /send me|שלח לי|תשלח לי|תוכל לשלוח לי|אפשר שתשלח/.test(t)),
    "send-me-the-file cases exist",
  );
  const noisy = all.filter((g) => g.variant === "noisy");
  assert.equal(noisy.length, 8);
  for (const g of noisy) {
    const withQ = g.lines.filter((l) => l.text.includes("?")).length / g.lines.length;
    assert.ok(withQ < 0.05, `${g.id}: noisy meetings drop the question mark (${withQ})`);
  }
  for (const g of all.filter((x) => x.variant === "clean"))
    assert.ok(g.lines.filter((l) => l.text.includes("?")).length >= 3, `${g.id}: clean meetings keep question marks`);
});

test("script: every moment has a reply in the PLAN 3.2 format; quiet lines get SKIP; memory and digest replies parse", () => {
  const TAGS = /^TAG: (ANS|BANK \w+|STALL|REPLY|CHECK|TERM|PROMPT|NOTE)\nVALUE: [0-3]\nAIM: (me|other|all|unclear)\nSAY: (.+)\nWHY: (.+)$/;
  for (const g of allRaw()) {
    const moment = (g.script ?? []).filter((s) => s.role === "moment");
    for (const m of g.moments) {
      const s = moment.find((x) => x.whenLastLine === m.afterLine);
      assert.ok(s, `${g.id} ${m.id} has a scripted reply`);
      const hit = TAGS.exec(s.reply);
      assert.ok(hit, `${g.id} ${m.id}: ${s.reply}`);
      assert.ok(hit[4].trim().split(/\s+/).length <= 14, `${g.id} ${m.id}: SAY over 14 words`);
    }
    const momentLines = new Set(g.moments.map((m) => m.afterLine));
    for (const s of moment) if (!momentLines.has(s.whenLastLine)) assert.equal(s.reply, "TAG: SKIP", `${g.id} ${s.whenLastLine}`);
    for (const s of (g.script ?? []).filter((x) => x.role === "memory")) assert.ok(typeof JSON.parse(s.reply) === "object", g.id);
    const dig = (g.script ?? []).filter((x) => x.role === "digest");
    assert.equal(dig.length, 1, `${g.id} has one digest reply`);
    const d = JSON.parse(dig[0].reply);
    assert.ok(
      Array.isArray(d.roster) && Array.isArray(d.agenda) && Array.isArray(d.facts) && Array.isArray(d.likelyQuestions) && Array.isArray(d.chunks),
      g.id,
    );
    assert.ok(
      (g.script ?? []).some((x) => x.role === "memory"),
      `${g.id} has a memory patch`,
    );
  }
});

test("denylist: no real person, company or client name in the golden data or its sources", () => {
  // The repo owner, the owner's employer and clients, and well-known companies a test author might reach for. Invented names only.
  const DENY = [
    "name-a",
    "name-b",
    "name-c",
    "name-d",
    "name-g",
    "name-h",
    "name-i",
    "name-e",
    "name-j",
    "name-k",
    "name-f",
    "name-l",
    "google",
    "microsoft",
    "amazon",
    "facebook",
    "apple inc",
    "paypal",
    "stripe",
    "wix",
    "shopify",
    "monday.com",
    "deepgram",
    "anthropic",
    "openai",
  ];
  const files = [
    ...readSplitFiles("dev").map((f) => f.text),
    ...readSplitFiles("test").map((f) => f.text),
    ...readdirSync(join(MEETINGS, "src")).map((f) => readFileSync(join(MEETINGS, "src", f), "utf8")),
  ];
  for (const text of files) {
    const low = text.toLowerCase();
    for (const w of DENY) assert.ok(!low.includes(w), `denylisted name "${w}" found`);
    assert.ok(!/[\w.+-]+@[\w-]+\.\w{2,}/.test(text), "no email address in golden data");
    assert.ok(!/\b0\d{1,2}-?\d{7}\b|\+972/.test(text), "no phone number in golden data");
  }
});

// ---------------------------------------------------------------- the lock and the final flag
test("test.lock: the test split matches its hash; any edit, addition or missing lock is refused", () => {
  checkTestLock();
  const tmp = mkdtempSync(join(tmpdir(), "golden-lock-"));
  try {
    cpSync(MEETINGS, tmp, { recursive: true });
    checkTestLock(tmp);
    const f = join(tmp, "test", readdirSync(join(tmp, "test"))[0]);
    writeFileSync(f, readFileSync(f, "utf8").replace('"side"', '"side" '));
    assert.throws(() => checkTestLock(tmp), /does not match/);
    assert.throws(() => loadSplit("test", { final: true, dir: tmp }), /does not match/);
    cpSync(join(MEETINGS, "test", readdirSync(join(MEETINGS, "test"))[0]), f);
    checkTestLock(tmp);
    writeFileSync(join(tmp, "test", "test-extra.json"), "{}");
    assert.throws(() => checkTestLock(tmp), /does not match/, "an extra file changes the hash");
    rmSync(join(tmp, "test", "test-extra.json"));
    rmSync(join(tmp, "test.lock"));
    assert.throws(() => checkTestLock(tmp), /test.lock is missing/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  assert.equal(
    lockHash([
      { name: "b", text: "2" },
      { name: "a", text: "1" },
    ]),
    lockHash([
      { name: "a", text: "1" },
      { name: "b", text: "2" },
    ]),
    "the hash does not depend on file order",
  );
});

test("the test split is held out: loadSplit refuses without final, and pnpm eval never reads it", () => {
  assert.throws(() => loadSplit("test"), /held out/);
  assert.equal(loadSplit("test", { final: true }).length, 8);
  assert.equal(loadSplit("dev").length, 16);
});

test("pnpm eval: prints the legacy gates and the golden baseline on dev in under 60 s; --final never writes a baseline", { timeout: 120_000 }, () => {
  const t0 = Date.now();
  const r = spawnSync(...tsx([join(ROOT, "scripts", "eval.ts")]), { cwd: ROOT, encoding: "utf8", timeout: 100_000, env: { ...process.env } });
  const secs = (Date.now() - t0) / 1000;
  assert.equal(r.status, 0, `eval exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.ok(secs < 60, `eval took ${secs} s`);
  assert.match(r.stdout, /Legacy gates \(in-sample/);
  assert.match(r.stdout, /Golden meetings, dev: engine legacy, 16 meetings/);
  assert.match(r.stdout, /legacy baseline/);
  assert.match(r.stdout, /Negative controls: null recall .* ok; noise precision .* ok/);
  assert.doesNotMatch(r.stdout, /HELD OUT/, "a plain eval run never touches the test split");
  const both = spawnSync(...tsx([join(ROOT, "scripts", "eval.ts"), "--final", "--update"]), {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 100_000,
    env: { ...process.env },
  });
  assert.equal(both.status, 2, "--final never writes a baseline");
});

test("noise helper: degradeAsr drops question marks and punctuation, keeps ids and moments", () => {
  const g = dev()[0];
  const d = degradeAsr(g);
  assert.equal(d.variant, "noisy");
  assert.deepEqual(d.moments, g.moments);
  assert.deepEqual(
    d.lines.map((l) => l.id),
    g.lines.map((l) => l.id),
  );
  assert.ok(!d.lines.some((l) => /[?.,!]/.test(l.text)));
});

test("legacy replay: runs with no model, only bank answers, and scores below the v2 targets (the measured floor)", () => {
  const meetings = dev();
  const per = meetings.map((golden) => ({ golden, grade: gradeGolden(golden, legacyTimeline(golden), { guard: (t) => !guard(t).ok }) }));
  const p = poolGrades(per);
  assert.ok(p.recall < 0.2, `legacy recall ${p.recall}`);
  assert.equal(p.guardBreaches, 0);
  assert.ok(
    per.every((x) => legacyTimeline(x.golden).every((cd) => cd.kind === "answer")),
    "the legacy engine only makes answer cards",
  );
});

test("grader: an early moment does not steal the card that is a clean hit for a later moment of the same kind", () => {
  const g: Golden = {
    ...toy,
    lines: [
      { id: "l1", t: 1000, side: "them", text: "First question here?" },
      { id: "l2", t: 6000, side: "them", text: "Second question here?" },
      ...toy.lines.slice(2).map((l, i) => ({ ...l, id: `l${i + 3}`, t: 20000 + i * 10000 })),
    ],
    moments: [
      { id: "m1", afterLine: "l1", kind: "answer", mustMention: ["alpha"], latestMs: 4000 },
      { id: "m2", afterLine: "l2", kind: "answer", mustMention: ["beta"], latestMs: 4000 },
    ],
    silent: [],
  };
  // The beta card at 9000 is late for m1 (window ends 5000, late up to 9000) but a hit for m2. m1 must not take it.
  const r = gradeGolden(g, [c(9000, "answer", "beta")]);
  assert.equal(r.results.find((x) => x.id === "m2")?.status, "hit");
  assert.equal(r.results.find((x) => x.id === "m1")?.status, "miss");
  assert.equal(r.hits, 1);
});

test("grader: overlapping silent windows count their minutes once", () => {
  const g: Golden = {
    ...toy,
    silent: [
      { fromLine: "l5", toLine: "l6" },
      { fromLine: "l5", toLine: "l6" },
    ],
  };
  const one = gradeGolden({ ...toy, silent: [{ fromLine: "l5", toLine: "l6" }] }, []);
  assert.equal(gradeGolden(g, []).silentMinutes, one.silentMinutes);
});
