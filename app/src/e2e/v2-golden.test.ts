// The golden dev meetings through the real v2 engine modules (child process per meeting, virtual clock, memory loop on, scripted model replies),
// graded by qa/grade-golden.ts, with the null and noise controls. Scores are SCRIPTED: the replies were written next to the moments, so they prove
// the plumbing (hint, observer window, scheduler, guards, card kinds, timing, memory loop, cache layout), not the model. See docs/ARCHITECTURE.md, Moment core.
// Dev split only. The held-out test split is never read here.
import "../test-setup.ts";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadSplit } from "../../qa/golden-load.ts";
import { gradeGolden, gradeMemory, poolGrades, nullTimeline, noiseTimeline, CONTROL_LIMITS, type GoldenGrade } from "../../qa/grade-golden.ts";
import { guard } from "../guards.ts";
import { runMeeting, pool, type MeetingRun } from "./v2-kit.ts";
import { controlSubset } from "../../qa/eval-v2.ts";
import { TYPES } from "../../qa/golden-schema.ts";
import type { Golden } from "../testkit/golden-types.ts";

const dev = loadSplit("dev").filter((g) => g.type !== "interview"); // a practice interview keeps the classic engine
const pct = (x: number) => (x * 100).toFixed(1) + "%";
let clean: MeetingRun[] = [];
let noisy: MeetingRun[] = [];
/** Cards of the moment path (a direct question q*, an observer line o*): the cards the golden labels speak about. The rest is other features: the open-loop
 *  prompts and wrap-up cue (tips), the self-check card, and the user's own ask. The labels do not list those, so they count against strict precision. */
const momentPath = (r: MeetingRun) => r.cards.filter((_, i) => /^[qo]\d+$/.test(String(r.screen[i]?.turnId)));
const grade = (g: Golden, r: MeetingRun, only = false) => gradeGolden(g, only ? momentPath(r) : r.cards, { guard: (t) => !guard(t).ok });
const pooled = (runs: MeetingRun[], only = false) => {
  const gs = runs.map((r) => ({
    golden: dev.find((g) => g.id === r.id)!,
    grade: grade(
      dev.find((g) => g.id === r.id)!,
      r,
      only,
    ),
  }));
  return { gs, p: poolGrades(gs) };
};

before(
  async () => {
    clean = await pool(dev, 4, (g) => runMeeting(g.id));
    // the noisy copy runs on every fourth meeting (the eval's control subset): enough to see the gap, a quarter of the cost
    const sub = new Set(controlSubset(dev));
    noisy = await pool(
      dev.filter((g) => sub.has(g.id)),
      4,
      (g) => runMeeting(g.id, { noisy: true, asks: false }),
    );
  },
  { timeout: 600_000 },
);

test("golden dev through the engine (SCRIPTED): planned moments show, silent windows stay quiet, guards hold", () => {
  const { gs, p } = pooled(clean);
  const rows = gs.map(
    ({ golden: g, grade: x }: { golden: Golden; grade: GoldenGrade }) =>
      `${g.id.padEnd(20)} recall ${pct(x.recall).padStart(6)} prec ${pct(x.precision).padStart(6)} direct ${pct(x.directRecall).padStart(6)} p50 ${x.ttcP50 ?? "-"} silent ${x.silentCards} dup ${x.duplicates} guard ${x.guardBreaches}`,
  );
  console.log(rows.join("\n"));
  const mp = pooled(clean, true).p;
  const minutes = clean.reduce((a, r) => a + r.lengthMs, 0) / 60_000;
  const extras = clean.reduce((a, r) => a + (r.cards.length - momentPath(r).length), 0);
  console.log(
    `POOLED(moment path only) recall ${pct(mp.recall)} precision ${pct(mp.precision)} direct ${pct(mp.directRecall)} guard breaches ${mp.guardBreaches}; other cards (loops, tips, self-check, ask): ${extras} in ${minutes.toFixed(0)} min = ${((extras / minutes) * 10).toFixed(1)} per 10 min`,
  );
  const cls: Record<string, number> = {};
  for (const r of clean)
    for (const c of r.screen) {
      const t = String(c.turnId);
      const k = /^[qo]\d+$/.test(t)
        ? "moment"
        : t === "tips"
          ? "tip"
          : t === "observer"
            ? "open-loop"
            : /^sc/.test(t)
              ? "self-check"
              : /^k/.test(t)
                ? "ask"
                : t;
      cls[k] = (cls[k] ?? 0) + 1;
    }
  console.log("CARDS by origin:", JSON.stringify(cls));
  console.log(
    `POOLED(clean) recall ${pct(p.recall)} precision ${pct(p.precision)} direct ${pct(p.directRecall)} silent cpm ${p.silentCpm.toFixed(2)} dup ${pct(p.duplicateRate ?? 0)}`,
  );
  assert.equal(gs.length, dev.length);
  // Regression floors, set a little under what the scripted run gives today. The targets are recall 85, precision 80, direct 95: `pnpm eval` shows where
  // we stand. Strict precision counts every card on screen, also the open-loop, tip, self-check and ask cards the labels do not list.
  assert.ok(mp.recall >= 0.8, `recall ${mp.recall}`);
  assert.ok(mp.precision >= 0.85, `moment-path precision ${mp.precision}`);
  assert.ok(mp.directRecall >= 0.9, `direct recall ${mp.directRecall}`);
  assert.ok(p.precision >= 0.6, `strict precision ${p.precision}`);
  assert.ok(p.silentCpm <= 1 / 3, `cards per minute in silent windows ${p.silentCpm} (at most 1 per 3 minutes)`);
  assert.equal(mp.guardBreaches, 0, "no moment card breaks the price, date or promise guard");
  assert.ok((extras / minutes) * 10 <= 10, `other cards per 10 minutes ${(extras / minutes) * 10}`);
});

test("golden dev: noisy transcripts (no punctuation) stay within 10 points of the clean run", () => {
  const same = new Set(noisy.map((r) => r.id));
  const c = pooled(clean.filter((r) => same.has(r.id))).p,
    n = pooled(noisy).p;
  console.log(
    `POOLED(noisy) recall ${pct(n.recall)} precision ${pct(n.precision)} direct ${pct(n.directRecall)} (clean ${pct(c.recall)} / ${pct(c.precision)} / ${pct(c.directRecall)})`,
  );
  assert.ok(c.recall - n.recall <= 0.1, `recall drops ${pct(c.recall - n.recall)}`);
  assert.ok(c.precision - n.precision <= 0.1, `precision drops ${pct(c.precision - n.precision)}`);
  assert.ok(c.directRecall - n.directRecall <= 0.1, `direct recall drops ${pct(c.directRecall - n.directRecall)}`);
});

test("controls: the null run and the noise run on the same meetings fail the grader (the grader cannot be gamed)", () => {
  const nul = poolGrades(dev.map((g) => ({ golden: g, grade: gradeGolden(g, nullTimeline(g)) })));
  assert.ok(nul.recall <= CONTROL_LIMITS.nullRecall, `null run recall ${nul.recall}`);
  for (const seed of [1, 2, 3]) {
    const noise = poolGrades(dev.map((g) => ({ golden: g, grade: gradeGolden(g, noiseTimeline(g, seed)) })));
    assert.ok(noise.precision <= CONTROL_LIMITS.noisePrecision, `noise seed ${seed}: precision ${noise.precision}`);
    assert.ok(noise.recall <= CONTROL_LIMITS.noiseRecall, `noise seed ${seed}: recall ${noise.recall}`);
  }
  // and the engine run is well above both controls
  const { p } = pooled(clean);
  assert.ok(p.recall > 0.5 && p.precision > 0.5);
});

test("memory: the memory loop learns the planned facts (checked 35 s after the line, the updater's pace)", () => {
  let checks = 0,
    passed = 0;
  const fails: string[] = [];
  for (const r of clean) {
    const g = dev.find((x) => x.id === r.id)!;
    const m = gradeMemory(g, r.snapshots);
    checks += m.checks;
    passed += m.passed;
    for (const f of m.failures) fails.push(`${g.id}@${f.atLine}: missing ${f.missing.join(", ")}`);
  }
  console.log(`MEMORY checks ${passed}/${checks}` + (fails.length ? "\n  " + fails.slice(0, 12).join("\n  ") : ""));
  assert.ok(checks >= 10);
  assert.ok(passed / checks >= 0.7, `memory pass rate ${passed}/${checks}`);
});

test("each meeting: session.json is written, the memory loop ran, no engine error survived, every ask ended in a card", () => {
  for (const r of clean) {
    assert.ok(r.sessionFile, `${r.id}: session.json`);
    // the core meetings are 6 minutes or longer: the updater runs every few seconds. The short r2 meetings (2 to 4 minutes) only need it to run.
    const isCore = (TYPES as readonly string[]).includes(dev.find((g) => g.id === r.id)!.type);
    assert.ok((r.roleCalls.memory ?? 0) >= (isCore ? 5 : 1), `${r.id}: the memory updater ran (${r.roleCalls.memory ?? 0})`);
    const errs = r.events.filter((x) => x.type === "error.survived");
    assert.equal(errs.length, 0, `${r.id}: ${JSON.stringify(errs.slice(0, 2))}`);
    for (const a of r.askCards) assert.ok(a.say, `${r.id}: ask "${a.q}" gave no card`);
  }
});

test("cache layout: the shared prefix is read from the cache (reported per role); the share of cached input tokens is printed", () => {
  const by: Record<string, { read: number; all: number }> = {};
  for (const r of clean)
    for (const c of r.calls) {
      const b = (by[c.role] ??= { read: 0, all: 0 });
      b.read += c.read;
      b.all += c.read + c.write + c.plain;
    }
  const line = Object.entries(by)
    .map(([k, v]) => `${k} ${pct(v.read / v.all)}`)
    .join(", ");
  const read = Object.values(by).reduce((a, v) => a + v.read, 0),
    all = Object.values(by).reduce((a, v) => a + v.all, 0);
  console.log(`CACHE read share of input tokens: ${pct(read / all)} (${line})`);
  assert.ok(read / all >= 0.3, `cache read share ${read / all}`);
});
