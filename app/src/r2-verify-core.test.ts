// Tests of the round 2 verification work: the rubric judge, the model-judge adapter (replay from a mock cassette), the cassette record command (mock
// transport only), the no-question-mark corpus, the held-out test-b split, the bad-model controls and their self-test, the v2 baseline, the eval gates.
// No network, no keys. The few tests that play meetings run the v2 worker in a child process on the policy fake.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cassette, CassetteMiss } from "./providers/cassette.ts";
import { loadSplit, loadFinalSplits, readSplitFiles } from "../qa/golden-load.ts";
import { MEETINGS } from "../qa/golden-build.ts";
import { GoldenSchema, EXTRA_TYPES } from "../qa/golden-schema.ts";
import { noqProblems, questionShape } from "../qa/golden-noq.ts";
import { gradeGolden, poolGrades, controlProblems, CONTROL_LIMITS, type Golden, type TimelineCard } from "../qa/grade-golden.ts";
import { controlReplies, CONTROLS } from "../qa/controls.ts";
import { rubricJudge, rubricCard, ModelJudge, judgePrompt, judgeKey, parseVerdict, JUDGE_MODEL } from "../qa/judge.ts";
import { v2Meetings, baselineOf, compare, controlResults, controlSubset, play, v2Metrics, FLOOR, type V2Baseline } from "../qa/eval-v2.ts";
import { main as recordMain, parseArgs, estimate } from "../scripts/cassette-record.ts";

const all = () => [...loadSplit("dev"), ...loadFinalSplits()];
const noq = (g: Golden) => g.moments.filter((m) => m.tags?.includes("noq"));
const c = (atMs: number, kind: TimelineCard["kind"], text: string, extra: Partial<TimelineCard> = {}): TimelineCard => ({ atMs, kind, text, ...extra });

// ---------------------------------------------------------------- the corpus
test("noq: at least 40 moments where the line has no '?' and no question word, EN and HE within 10 percent, dev and test-b both have them", () => {
  const gs = all();
  const count = (lang: string, split?: string) => gs.filter((g) => g.lang === lang && (!split || g.split === split)).reduce((s, g) => s + noq(g).length, 0);
  const en = count("en"),
    he = count("he");
  assert.ok(en + he >= 40, `noq moments ${en + he}`);
  assert.ok(Math.abs(en - he) / Math.max(en, he) <= 0.1, `noq EN ${en} vs HE ${he}`);
  for (const split of ["dev", "test-b"]) {
    assert.ok(count("en", split) >= 12 && count("he", split) >= 12, `${split} has at least 12 noq moments per language`);
  }
  // the four shapes the plan names: a problem, a number claim, a decision, an objection
  const tags = new Set(gs.flatMap((g) => noq(g).flatMap((m) => m.tags ?? [])));
  for (const need of ["problem", "number", "decision", "objection"]) assert.ok(tags.has(need), `noq tag ${need}`);
});

test("noq: every tagged line and the line before it is a plain statement (the checker is also tested on its own)", () => {
  for (const g of all()) assert.deepEqual(noqProblems(g), [], g.id);
  // the checker itself: it must catch what it is for
  for (const bad of [
    "What time does it start",
    "How long will it take",
    "Is it ready",
    "Can you send it",
    "Tell me the price",
    "Okay?",
    "איך זה עובד",
    "מתי זה מגיע",
    "האם יש הנחה",
    "ומה עם המחיר",
    "אשמח לדעת את המחיר",
  ])
    assert.ok(questionShape(bad).length > 0, bad);
  for (const good of [
    "Our checkout takes eight seconds to load on mobile.",
    "The budget is nine thousand dollars, no more.",
    "We are cutting the scope to two features.",
    "הטופס נתקע באייפון, הכפתור פשוט לא מגיב.",
    "אנחנו בוחרים בקבלן ב' כי האחריות שלו ארוכה יותר.",
  ])
    assert.deepEqual(questionShape(good), [], good);
});

test("noq: the builder refuses a noq moment on a line with a question word", () => {
  const g = loadSplit("dev").find((x) => noq(x).length)!;
  const m = noq(g)[0];
  const bad = { ...g, lines: g.lines.map((l) => (l.id === m.afterLine ? { ...l, text: "How long does it take?" } : l)) };
  assert.ok(noqProblems(bad).length > 0);
});

test("variety corpus: a 45 minute monologue, cross-talk, three speakers, ASR errors and a silent meeting, in both languages", () => {
  const dev = loadSplit("dev");
  for (const t of EXTRA_TYPES)
    for (const lang of ["en", "he"])
      assert.ok(
        dev.some((g) => g.type === t && g.lang === lang),
        `dev has ${t} in ${lang}`,
      );
  for (const g of dev.filter((x) => x.type === "monologue")) {
    assert.ok(g.lines.at(-1)!.t / 60_000 >= 45, `${g.id}: ${(g.lines.at(-1)!.t / 60_000).toFixed(1)} min`);
    assert.equal(new Set(g.lines.filter((l) => l.side === "them").map((l) => l.speaker)).size, 1, `${g.id}: one speaker`);
    assert.ok((g.memoryChecks?.length ?? 0) >= 3, `${g.id}: long-call memory checks`);
  }
  for (const g of dev.filter((x) => x.type === "threeway"))
    assert.ok(new Set(g.lines.map((l) => l.speaker).filter(Boolean)).size >= 3, `${g.id}: three speakers`);
  for (const g of dev.filter((x) => x.type === "silence")) {
    assert.equal(g.moments.length, 0, `${g.id}: the right behaviour is no card`);
    assert.equal(g.silent[0]?.fromLine, "l1");
    assert.equal(g.silent.at(-1)?.toLine, `l${g.lines.length}`, `${g.id}: the whole meeting is a silent window`);
  }
  // ASR errors: duplicated finals, split finals, homophones, glued Hebrew prefixes exist in the labels
  const tags = new Set(dev.filter((g) => g.type === "asr").flatMap((g) => g.moments.flatMap((m) => m.tags ?? [])));
  for (const need of ["duplicate", "split-final", "homophone", "prefix-glue"]) assert.ok(tags.has(need), `asr tag ${need}`);
  assert.ok(
    dev.filter((g) => g.type === "asr").every((g) => g.variant === "noisy"),
    "asr meetings are noisy",
  );
  // a duplicated final really is there: two neighbouring lines where one starts like the other
  const asrEn = dev.find((g) => g.id === "dev-asr-en")!;
  assert.ok(
    asrEn.lines.some((l, i) => i && l.speaker === asrEn.lines[i - 1].speaker && l.text.startsWith(asrEn.lines[i - 1].text)),
    "a duplicated final",
  );
  assert.ok(
    dev.some((g) => (g.allowedExtra?.length ?? 0) > 0),
    "allowedExtra labels exist",
  );
});

test("test-b: a held-out split with its own lock, 10 or more meetings, EN and HE, noq moments, valid schema, ids that start with test-b", () => {
  const files = readSplitFiles("test-b");
  assert.ok(files.length >= 10, `${files.length} files`);
  const gs = files.map((f) => GoldenSchema.parse(JSON.parse(f.text)));
  for (const g of gs) {
    assert.equal(g.split, "test-b");
    assert.match(g.id, /^test-b-/);
  }
  assert.ok(gs.some((g) => g.lang === "en") && gs.some((g) => g.lang === "he"));
  const en = gs.filter((g) => g.lang === "en").length,
    he = gs.filter((g) => g.lang === "he").length;
  assert.equal(en, he, "equal EN and HE meetings");
  assert.ok(gs.filter((g) => g.type === "noq").length >= 8);
  // test-b adds no scenario text that is also in dev (written apart, not copied): no identical line longer than 6 words
  const devLines = new Set(
    loadSplit("dev")
      .flatMap((g) => g.lines.map((l) => l.text.toLowerCase()))
      .filter((t) => t.split(/\s+/).length > 6),
  );
  for (const g of gs) for (const l of g.lines) assert.ok(!devLines.has(l.text.toLowerCase()), `${g.id} copies a dev line: ${l.text}`);
});

test("pnpm eval --final reads both held-out splits behind their locks: an edited test or test-b meeting stops it", () => {
  assert.ok(loadFinalSplits().length >= 18);
  for (const split of ["test", "test-b"]) {
    const tmp = mkdtempSync(join(tmpdir(), "final-lock-"));
    try {
      cpSync(MEETINGS, tmp, { recursive: true });
      assert.ok(loadFinalSplits(tmp).length >= 18);
      const f = join(tmp, split, readdirSync(join(tmp, split))[0]);
      writeFileSync(f, readFileSync(f, "utf8").replace('"side"', '"side" '));
      assert.throws(() => loadFinalSplits(tmp), new RegExp(`${split}.lock does not match`));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  assert.throws(() => loadSplit("test-b"), /held out/, "without the flag the split does not load");
});

// ---------------------------------------------------------------- allowedExtra in the grader
test("allowedExtra: a useful extra card is neither right nor wrong; one that matches nothing still lowers precision", () => {
  const g: Golden = {
    id: "dev-toy",
    split: "dev",
    lang: "en",
    type: "sales",
    variant: "clean",
    lines: Array.from({ length: 10 }, (_, i) => ({ id: `l${i + 1}`, t: 1000 + i * 10000, side: "them" as const, text: `line ${i + 1} about the budget` })),
    moments: [{ id: "m1", afterLine: "l1", kind: "check", mustMention: ["budget"], latestMs: 5000 }],
    silent: [],
    allowedExtra: [{ id: "x1", afterLine: "l3", kind: "fact", mustMention: ["glossary"], latestMs: 8000 }],
  };
  const hit = c(2000, "check", "budget differs");
  const extra = c(23000, "fact", "glossary: a term");
  const wrong = c(53000, "fact", "something else");
  const r = gradeGolden(g, [hit, extra]);
  assert.equal(r.allowed, 1);
  assert.equal(r.precision, 1, "the labelled extra is left out of the denominator");
  assert.equal(r.recall, 1);
  assert.equal(r.silentCards, 0);
  assert.equal(gradeGolden(g, [hit, wrong]).precision, 1 / 2);
  assert.equal(gradeGolden(g, [hit, c(23000, "fact", "no match here")]).precision, 1 / 2, "a card without the tokens is not allowed");
  assert.equal(gradeGolden(g, [hit, c(23000, "answer", "glossary")]).allowed, 0, "the kind must match when the label names one");
  assert.equal(gradeGolden(g, [hit, c(90000, "fact", "glossary late")]).allowed, 0, "after its window it is not allowed");
  assert.equal(poolGrades([{ golden: g, grade: r }]).allowed, 1);
});

// ---------------------------------------------------------------- the rubric judge
const meeting: Golden = {
  id: "dev-judge",
  split: "dev",
  lang: "en",
  type: "sales",
  variant: "clean",
  lines: [
    { id: "l1", t: 1000, side: "them", text: "The budget is now twelve thousand dollars for the whole project." },
    { id: "l2", t: 30000, side: "me", text: "Okay, I will note it." },
    { id: "l3", t: 60000, side: "them", text: "Another vendor offered us a lower price for the same scope." },
    { id: "l4", t: 90000, side: "them", text: "The weather is lovely today." },
  ],
  moments: [
    { id: "m1", afterLine: "l1", kind: "check", mustMention: ["5,000", "12,000"], latestMs: 8000 },
    { id: "m2", afterLine: "l3", kind: "prompt", mustMention: ["scope"], latestMs: 8000 },
  ],
  silent: [{ fromLine: "l4", toLine: "l4" }],
};
test("rubric: a card with the tokens, in time, in the call language and not a repeat passes", () => {
  const { verdicts, summary } = rubricJudge(meeting, [c(2500, "check", "Brief says $5,000; she says $12,000.")]);
  assert.deepEqual(verdicts[0], { card: 0, moment: "m1", relevant: true, language: true, fresh: true, window: true, pass: true, reasons: [] });
  assert.equal(summary.rate, 1);
});
test("rubric: a card without the tokens of its moment is not relevant", () => {
  const v = rubricJudge(meeting, [c(2500, "check", "Please confirm the new total.")]).verdicts[0];
  assert.equal(v.relevant, false);
  assert.equal(v.pass, false);
  assert.match(v.reasons.join(" "), /missing: 5,000, 12,000/);
});
test("rubric: a card that repeats an earlier card within two minutes is not fresh; after two minutes it is", () => {
  const first = c(2500, "check", "Brief says $5,000; she says $12,000.");
  const again = c(20000, "check", "Brief says $5,000, she says $12,000!");
  const v = rubricJudge(meeting, [first, again]).verdicts;
  assert.equal(v[1].fresh, false);
  assert.match(v[1].reasons.join(" "), /repeats/);
  const late = rubricCard(meeting, [first, c(200_000, "check", "Brief says $5,000; she says $12,000.")], 1);
  assert.equal(late.fresh, true);
});
test("rubric: a Hebrew card on an English call fails the language check", () => {
  const v = rubricJudge(meeting, [c(61500, "prompt", "לשאול מה כלול בהצעה של הספק האחר, scope")]).verdicts[0];
  assert.equal(v.moment, "m2");
  assert.equal(v.language, false);
  assert.match(v.reasons.join(" "), /card is he, the call is en/);
  assert.equal(v.pass, false);
});
test("rubric: a card that comes after the window is late; one inside a silent window fails the window check", () => {
  const lateCard = rubricJudge(meeting, [c(1000 + 12000, "check", "Brief says $5,000; she says $12,000.")]).verdicts[0];
  assert.equal(lateCard.window, false);
  assert.match(lateCard.reasons.join(" "), /late by 4000 ms/);
  const quiet = rubricJudge(meeting, [c(91000, "fact", "The weather and the budget for the whole project.")]).verdicts[0];
  assert.equal(quiet.window, false);
  assert.match(quiet.reasons.join(" "), /silent window/);
});
test("rubric: a miss (no card at all) judges nothing; an extra card is judged against the last lines", () => {
  assert.deepEqual(rubricJudge(meeting, []).summary, { cards: 0, pass: 0, rate: 1, failed: { relevant: 0, language: 0, fresh: 0, window: 0 } });
  const off = rubricJudge(meeting, [c(35000, "fact", "Photosynthesis turns light into sugar.")]).verdicts[0];
  assert.equal(off.relevant, false, "shares no word with the last lines");
  const on = rubricJudge(meeting, [c(35000, "fact", "The project budget changed to twelve thousand dollars.")]).verdicts[0];
  assert.equal(on.relevant, true);
});

// ---------------------------------------------------------------- the model judge on a mock cassette
test("model judge: replays a recorded verdict from the cassette; a missing one is a loud CassetteMiss; no call is made", async () => {
  const card = c(2500, "check", "Brief says $5,000; she says $12,000.");
  const p = judgePrompt(meeting, card);
  assert.match(p.user, /Other: The budget is now twelve thousand dollars/);
  assert.match(p.user, /Card \(check\): Brief says/);
  const cas = new Cassette();
  const key = judgeKey(JUDGE_MODEL, p);
  cas.put({
    key,
    role: "judge",
    model: JUDGE_MODEL,
    source: "recorded",
    request: { system: p.system, messages: [p.user], options: {} },
    chunks: [{ at: 700, text: "VERDICT: good\nREASON: It names both numbers." }],
    finish: { unified: "stop" },
    usage: null,
    ms: 700,
  });
  const judge = new ModelJudge({ cassette: cas });
  const v = await judge.judge(meeting, card);
  assert.deepEqual(v, { good: true, reason: "It names both numbers.", source: "recorded", key });
  await assert.rejects(judge.judge(meeting, c(2500, "check", "A different card.")), (e) => e instanceof CassetteMiss && /role=judge/.test(e.message));
});
test("model judge: with a transport it records the answer once, and the next run replays it; an unreadable answer counts as bad", async () => {
  const cas = new Cassette();
  let calls = 0;
  const judge = new ModelJudge({
    cassette: cas,
    transport: async (req) => {
      calls++;
      assert.equal(req.model, JUDGE_MODEL);
      return { text: calls === 1 ? "VERDICT: bad\nREASON: Late." : "I think it is fine", ms: 5 };
    },
  });
  const card = c(2500, "check", "Brief says $5,000; she says $12,000.");
  assert.equal((await judge.judge(meeting, card)).good, false);
  assert.equal((await judge.judge(meeting, card)).good, false, "the second ask is served from the cassette");
  assert.equal(calls, 1);
  assert.equal(cas.size, 1);
  const other = await judge.judge(meeting, c(2600, "check", "Another card."));
  assert.equal(other.good, false);
  assert.match(other.reason, /unreadable/);
  assert.deepEqual(parseVerdict("verdict: GOOD\nreason: ok"), { good: true, reason: "ok" });
  const all = await judge.judgeAll(meeting, [card, c(2600, "check", "Another card.")]);
  assert.equal(all.length, 2);
});

// ---------------------------------------------------------------- the cassette record command (mock transport only)
const logLines = () => {
  const lines: string[] = [];
  return { lines, log: (l: string) => void lines.push(l) };
};
test("cassette-record: arguments are checked (suite, cap, pace)", () => {
  assert.match(String(parseArgs([])), /--suite/);
  assert.match(String(parseArgs(["--suite", "dev"])), /--cap/);
  assert.match(String(parseArgs(["--suite", "dev", "--cap", "0"])), /--cap/);
  assert.match(String(parseArgs(["--suite", "nope", "--cap", "1"])), /--suite/);
  assert.match(String(parseArgs(["--suite", "dev", "--cap", "1", "--pace", "0"])), /--pace/);
  assert.deepEqual(parseArgs(["--suite", "test-b", "--cap", "2.5", "--final", "--only", "x"]), {
    suite: "test-b",
    cap: 2.5,
    final: true,
    out: undefined,
    only: "x",
    pace: undefined,
    allowPartial: false,
    judge: false,
  });
});
test("cassette-record: refuses without a key, refuses in CI, refuses a held-out suite without --final; the estimate comes before any run", async () => {
  const ran: string[] = [];
  const run = (async (id: string) => (ran.push(id), Promise.reject(new Error("must not run")))) as never;
  const a = logLines();
  assert.equal(await recordMain(["--suite", "dev", "--cap", "5"], {}, { transport: "real", log: a.log, run }), 2);
  assert.match(a.lines.join("\n"), /no ANTHROPIC_API_KEY/);
  const b = logLines();
  assert.equal(await recordMain(["--suite", "dev", "--cap", "5"], { ANTHROPIC_API_KEY: "x", CI: "true" }, { transport: "real", log: b.log, run }), 2);
  assert.match(b.lines.join("\n"), /refusing to record in CI/);
  const b2 = logLines();
  assert.equal(
    await recordMain(["--suite", "dev", "--cap", "5"], { ANTHROPIC_API_KEY: "x", GITHUB_ACTIONS: "true" }, { transport: "mock", log: b2.log, run }),
    2,
  );
  assert.match(b2.lines.join("\n"), /CI/);
  const d = logLines();
  assert.equal(await recordMain(["--suite", "test-b", "--cap", "5"], { ANTHROPIC_API_KEY: "x" }, { transport: "real", log: d.log, run }), 2);
  assert.match(d.lines.join("\n"), /held-out suite/);
  // the estimate is printed, and a cap below it stops the run before any meeting is played
  const e = logLines();
  assert.equal(await recordMain(["--suite", "dev", "--cap", "0.01"], { ANTHROPIC_API_KEY: "x" }, { transport: "real", log: e.log, run }), 2);
  const text = e.lines.join("\n");
  assert.match(text, /Cassette recording: estimate/);
  assert.match(text, /model calls\s+about \d+/);
  assert.match(text, /cost\s+about \$\d+\.\d\d \(cap \$0\.01\)/);
  assert.match(text, /estimate .* is above the cap/);
  assert.deepEqual(ran, [], "no meeting was played");
  const est = estimate(v2Meetings(loadSplit("dev")), 1);
  assert.ok(est.usd > 0 && est.calls > 0 && est.hours > 3);
});
test(
  "cassette-record: with a mock transport it plays one meeting, writes a sorted cassette of recorded entries, and prints the estimate first",
  { timeout: 60_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "cassette-rec-"));
    try {
      const l = logLines();
      const code = await recordMain(["--suite", "dev", "--cap", "5", "--only", "dev-silence-en"], {}, { transport: "mock", log: l.log, dataDir: dir });
      assert.equal(code, 0, l.lines.join("\n"));
      assert.ok(l.lines[0].startsWith("Cassette recording: estimate"), "the estimate is the first thing printed");
      const out = join(dir, "dev.cassette.json");
      assert.ok(existsSync(out));
      const cas = new Cassette(out);
      assert.ok(cas.size >= 5, `${cas.size} entries`);
      assert.ok(cas.entries().every((e) => e.source === "recorded" && e.chunks.length >= 0));
      assert.ok(cas.entries().some((e) => e.role === "moment" || e.role === "observer" || e.role === "reflex"));
      const keys = JSON.parse(readFileSync(out, "utf8")).entries.map((e: { key: string }) => e.key);
      assert.deepEqual(keys, [...keys].sort(), "sorted by key");
      assert.deepEqual(
        readdirSync(dir).filter((f) => f.includes(".part.")),
        [],
        "part files are merged away",
      );
      assert.match(l.lines.at(-1)!, /^Done: \d+ entries/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------- controls, through the real v2 engine
const subsetOf = (ids: string[]) => loadSplit("dev").filter((g) => ids.includes(g.id));
test("controls: the replies of each bad model are what they say (pure)", () => {
  const g = loadSplit("dev").find((x) => x.id === "dev-sales-en")!;
  const textOf = new Map(g.lines.map((l) => [l.id, l.text]));
  assert.deepEqual(controlReplies(g, "null", textOf), []);
  const ans = controlReplies(g, "always-ans", textOf);
  assert.equal(ans.length, 1);
  assert.equal(ans[0].lastLine, undefined, "it answers every call");
  assert.match(ans[0].reply, /^TAG: ANS/);
  const real = controlReplies(g, undefined, textOf);
  const shuffled = controlReplies(g, "shuffled", textOf);
  assert.equal(shuffled.length, real.length);
  assert.ok(
    shuffled.every((r, i) => r.lastLine === real[i].lastLine),
    "the slots (the lines the calls are about) stay where they are",
  );
  assert.ok(
    real.every((r, i) => r.reply === "TAG: SKIP" || shuffled[i].reply !== r.reply),
    "every real reply is moved to another slot (the SKIP replies of the quiet lines are all the same)",
  );
  assert.deepEqual([...shuffled.map((r) => r.reply)].sort(), [...real.map((r) => r.reply)].sort(), "the same replies, moved");
  const noise = controlReplies(g, "noise", textOf);
  assert.ok(noise.length > 5 && noise.length < g.lines.length);
  assert.deepEqual(noise, controlReplies(g, "noise", textOf), "deterministic");
});

test(
  "controls: null, noise, shuffled and always-ANS each score under their limit on the real engine; a broken engine fails the baseline; a high control fails the self-test",
  { timeout: 170_000 },
  async () => {
    // four meetings of different kinds, played clean and with every control: 20 child processes
    const ids = ["dev-sales-en", "dev-support-he", "dev-noq-decision-en", "dev-noq-objection-he"];
    const meetings = subsetOf(ids);
    // play() runs the controls on every fourth meeting by default; here all four controls run on all four meetings
    const full = await play(meetings, { split: () => "dev", noisy: false, controlsOn: ids });
    const results = controlResults(meetings, full.controls);
    assert.equal(results.length, 4);
    for (const r of results) assert.deepEqual(r.problems, [], `${r.name}: recall ${r.recall} precision ${r.precision}`);
    const clean = poolGrades(
      full.clean.map((run) => ({
        golden: meetings.find((g) => g.id === run.id)!,
        grade: gradeGolden(
          meetings.find((g) => g.id === run.id)!,
          run.cards,
        ),
      })),
    );
    assert.ok(clean.recall > 0.6, `the scripted engine is far above the controls (${clean.recall})`);
    for (const r of results) assert.ok(r.recall < clean.recall - 0.4, `${r.name} is well under the engine`);

    // a deliberately broken engine (shuffled replies as the engine under test) fails the committed baseline
    const base = JSON.parse(readFileSync(join(MEETINGS, "..", "..", "qa", "eval-baseline.json"), "utf8")).v2 as V2Baseline;
    const shuffledRuns = full.controls.shuffled!;
    const broken = v2Metrics(meetings, shuffledRuns);
    const cmp = compare(broken.list, base);
    assert.ok(cmp.failed >= 3, `a shuffled engine fails the baseline (${cmp.failed} gates)`);
    assert.ok(cmp.rows.find((r) => r.id === "card.recall")!.verdict === "FAIL");
    assert.ok(cmp.rows.find((r) => r.id === "card.precision")!.verdict === "FAIL");

    // self-test: if a control scored high the check says so. Same always-ANS cards, graded against labels with no tokens and a wide window (a weak grader).
    // (The window is 120 s: the engine drops the same sentence twice within 20 s, so the control makes fewer repeat cards than it used to.)
    const weak = meetings.map((g) => ({ ...g, moments: g.moments.map((m) => ({ ...m, mustMention: [], latestMs: 120_000 })) }));
    const ansRuns = full.controls["always-ans"]!;
    const weakPool = poolGrades(
      ansRuns.map((run) => ({
        golden: weak.find((g) => g.id === run.id)!,
        grade: gradeGolden(
          weak.find((g) => g.id === run.id)!,
          run.cards,
        ),
      })),
    );
    const problems = controlProblems("always-ans", weakPool);
    assert.ok(problems.length > 0, "a grader that ignores the tokens lets always-ANS score high, and the self-test says so");
    assert.match(problems.join(" "), /always-ans: (recall|precision)/);
    // and the four limits are really checked
    assert.ok(controlProblems("null", { recall: 0.5, precision: 0, cards: 0 }).length);
    assert.ok(controlProblems("noise", { recall: 0.05, precision: 0.9, cards: 10 }).length);
    assert.ok(controlProblems("shuffled", { recall: 0.9, precision: 0.1, cards: 10 }).length);
    assert.deepEqual(controlProblems("shuffled", { recall: 0.05, precision: 0.1, cards: 10 }), []);
    assert.ok(CONTROL_LIMITS.shuffledRecall <= 0.2 && CONTROL_LIMITS.ansPrecision <= 0.4);
    assert.deepEqual([...CONTROLS], ["null", "noise", "shuffled", "always-ans"]);
    assert.ok(controlSubset(loadSplit("dev")).length >= 6);
  },
);

// ---------------------------------------------------------------- the baseline
test("baseline: the committed v2 baseline has no zero, covers every metric, and is built by baselineOf with a floor", () => {
  const b = JSON.parse(readFileSync(join(MEETINGS, "..", "..", "qa", "eval-baseline.json"), "utf8")) as {
    v2: V2Baseline;
    legacy: { metrics: Record<string, number> };
  };
  assert.equal(b.v2.engine, "v2");
  assert.equal(b.v2.scripted, true);
  for (const [id, m] of Object.entries(b.v2.metrics)) {
    assert.ok(m.value > 0, `baseline ${id} is ${m.value}: a zero baseline cannot fail`);
    assert.ok(m.n > 0, `baseline ${id} has a sample size`);
  }
  for (const id of [
    "card.recall",
    "card.precision",
    "recall.answer",
    "recall.prompt",
    "recall.check",
    "recall.fact",
    "direct.recall",
    "noq.recall",
    "ttc.p50",
    "ttc.p95",
    "silent.cpm",
    "noisy.delta",
    "cost.perHour",
  ])
    assert.ok(b.v2.metrics[id], `metric ${id}`);
  assert.ok(b.v2.meetings >= 28);
  // the legacy part is kept under its own name and is not the headline
  assert.ok(b.legacy.metrics["detector.set.precision"] > 0);
  // the floor
  const zero = baselineOf(
    [
      { id: "silent.cpm", label: "x", value: 0, n: 5, unit: "/min", better: "lower" },
      { id: "wrong.card", label: "y", value: 0, n: 5, unit: "%", better: "lower" },
    ],
    1,
    1,
  );
  assert.equal(zero.metrics["silent.cpm"].value, FLOOR["/min"]);
  assert.equal(zero.metrics["wrong.card"].value, FLOOR["%"]);
});

test("baseline: tolerance follows the sample size, a worse metric fails, a metric past its own limit fails, no baseline fails", () => {
  const base: V2Baseline = baselineOf(
    [
      { id: "card.recall", label: "recall", value: 0.8, n: 300, unit: "%", better: "higher" },
      { id: "wrong.card", label: "wrong", value: 0.04, n: 300, unit: "%", better: "lower" },
      { id: "silent.cpm", label: "silent", value: 0.04, n: 100, unit: "/min", better: "lower", max: 1 / 3 },
      { id: "cost.perHour", label: "cost", value: 0.04, n: 100, unit: "usd", better: "lower" },
    ],
    10,
    300,
  );
  const m = (id: string, value: number, n: number, unit: "%" | "/min" | "usd", better: "higher" | "lower", max?: number) => ({
    id,
    label: id,
    value,
    n,
    unit,
    better,
    max,
  });
  // 300 items: the band is about 4.5 points; 3 points lower is fine, 8 lower is not
  assert.equal(compare([m("card.recall", 0.77, 300, "%", "higher")], base).failed, 0);
  assert.equal(compare([m("card.recall", 0.72, 300, "%", "higher")], base).failed, 1);
  // 20 items: the band is wide (never over what the baseline sample allows: min of both n)
  assert.equal(compare([m("card.recall", 0.72, 20, "%", "higher")], base).failed, 0, "a small sample may move more");
  assert.equal(compare([m("wrong.card", 0.2, 300, "%", "lower")], base).failed, 1);
  assert.equal(compare([m("silent.cpm", 0.5, 100, "/min", "lower", 1 / 3)], base).failed, 1, "over its own limit");
  assert.equal(compare([m("cost.perHour", 0.06, 100, "usd", "lower")], base).failed, 1, "cost up by more than 20 percent");
  assert.equal(compare([m("cost.perHour", 0.045, 100, "usd", "lower")], base).failed, 0);
  assert.equal(compare([m("new.metric", 0.5, 100, "%", "higher")], base).failed, 1, "a metric with no baseline fails");
});

test("pnpm eval --broken shuffled: the whole eval exits 1 for a deliberately broken engine", { timeout: 240_000 }, async () => {
  const { spawnSync } = await import("node:child_process");
  const { tsx } = await import("./test-platform.ts");
  const { ROOT } = await import("./env.ts");
  const r = spawnSync(...tsx([join(ROOT, "scripts", "eval.ts"), "--broken", "shuffled", "--limit", "8"]), {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 220_000,
    env: { ...process.env },
  });
  assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /BROKEN ENGINE \(shuffled\)/);
  assert.match(r.stdout, /FAIL/);
});

// ---------------------------------------------------------------- lint rules that replaced source-text tests
test("lint rules: Hebrew literals, unknown tr() keys, SK() and a language global in bank.ts are errors; clean code passes", { timeout: 60_000 }, async () => {
  const { ESLint } = await import("eslint");
  const { ROOT } = await import("./env.ts");
  const eslint = new ESLint({ cwd: ROOT });
  const rules = async (file: string, code: string) =>
    (await eslint.lintText(code, { filePath: join(ROOT, file) }))[0].messages.filter((m) => m.severity === 2).map((m) => m.ruleId);
  assert.deepEqual(await rules("overlay/app.js", 'const a = tr("state.ended"); const re = /שלום/;\n'), [], "a real key and a regex literal are fine");
  assert.deepEqual(await rules("overlay/app.js", 'el.textContent = "שלום";\n'), ["wingman/no-hebrew-literal"]);
  assert.deepEqual(await rules("overlay/text.js", "const s = `שלום ${x}`;\n"), ["wingman/no-hebrew-literal"]);
  assert.deepEqual(await rules("overlay/app.js", 'tr("no.such.key");\n'), ["wingman/tr-key-exists"]);
  assert.deepEqual(await rules("overlay/app.js", 'tr("badge." + type);\n'), [], "a key built at run time is not checked here");
  assert.deepEqual(await rules("dashboard/home.js", "const skin = SK();\n"), ["no-restricted-syntax"]);
  const lang = await rules("src/bank.ts", "let turnLang = 'he';\nexport const x = turnLang;\nturnLang = 'en';\n");
  assert.ok(lang.length >= 2 && lang.every((r) => r === "no-restricted-syntax"), "a language `let` and the turnLang name are both refused");
  assert.deepEqual(
    await rules("src/bank.ts", "let cache: string[] = [];\nexport const c = () => cache;\nexport const set = (x: string[]) => (cache = x);\n"),
    [],
    "other module state is allowed",
  );
});

test("overlay strings: keys built at run time exist in the English table, every key has a Hebrew text, and every data-i18n key of the page exists", async () => {
  const { createRequire } = await import("node:module");
  const { ROOT } = await import("./env.ts");
  const strings = createRequire(import.meta.url)("../overlay/strings.js") as { STRINGS: { en: Record<string, string>; he: Record<string, string> } };
  const dyn: Record<string, string[]> = {
    badge: ["bank", "ai", "stall", "me", "fix", "careful", "calc", "info", "consent"],
    kind: ["client", "support", "vendor", "team", "consult", "personal", "other"],
    tip: ["ask", "clarify", "term", "remind", "note"],
    cap: ["phone", "email", "domain"],
    keys: ["ask", "rewind", "checklist", "pause", "clear", "copy"],
    "health.who": ["stt-me", "stt-them"],
  };
  for (const [p, names] of Object.entries(dyn)) for (const n of names) assert.ok(`${p}.${n}` in strings.STRINGS.en, `${p}.${n}`);
  for (const st of ["ended", "paused", "quiet", "starting", "waiting", "listening"])
    for (const part of ["", ".title", ".sub"]) assert.ok(`state.${st}${part}` in strings.STRINGS.en, `state.${st}${part}`);
  for (const k of Object.keys(strings.STRINGS.en)) assert.ok(k in strings.STRINGS.he, `no Hebrew text for ${k}`);
  const html = readFileSync(join(ROOT, "overlay", "index.html"), "utf8"); // the page template is data: its data-i18n names must exist
  for (const m of html.matchAll(/data-i18n="([\w.]+)"/g)) assert.ok(m[1] in strings.STRINGS.en, "unknown key " + m[1]);
});
