// The memory-quality eval (qa/memory-eval.ts): the labels are honest, the scorer is right, the controls stay under their limit, and a fake-model run
// produces the per-class table. Offline: the model is the policy fake.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLASSES,
  CONTROL_LIMITS,
  controlBreaches,
  floorBreaches,
  RECORDED_FLOORS,
  copyAllMemory,
  formatEval,
  itemsOf,
  loadCases,
  nullMemory,
  ownerFits,
  runMemoryEval,
  scoreMemory,
  validateCase,
  type EvalCase,
} from "../qa/memory-eval.ts";
import { applyPatch } from "./session/patch.ts";
import { emptyMemory } from "./session/types.ts";

const cases = loadCases();

test("24 labelled calls: 10 English, 9 Hebrew, 5 mixed; labels point at lines that contain their keys", () => {
  assert.equal(cases.length, 24);
  assert.equal(cases.filter((c) => c.lang === "en").length, 10);
  assert.equal(cases.filter((c) => c.lang === "he").length, 9);
  assert.equal(cases.filter((c) => c.lang === "mixed").length, 5);
  for (const c of cases) assert.deepEqual(validateCase(c), [], c.id);
  for (const cls of CLASSES) {
    const withLabel = cases.filter((c) => (c.expected[cls] ?? []).length >= 1).length;
    assert.ok(withLabel >= (cls === "objections" ? 8 : 20), `${cls}: ${withLabel} calls have a label`);
  }
  const hebrew = cases.filter((c) => c.lang === "he").flatMap((c) => c.lines.map((l) => l.text));
  assert.ok(
    hebrew.every((t) => /[֐-׿]/.test(t)),
    "the Hebrew calls are in Hebrew",
  );
});

test("validateCase finds a label whose keys are not in its line", () => {
  const bad: EvalCase = structuredClone(cases.find((c) => c.id === "mem-en-1")!);
  bad.expected.promises[0].keys = ["zebra"];
  bad.expected.numbers[0].value = "999999";
  const problems = validateCase(bad);
  assert.ok(problems.some((p) => p.startsWith("promises[0]")));
  assert.ok(problems.some((p) => p.startsWith("numbers[0]: value")));
});

test("scoring: a memory that has the labelled items scores 1, a wrong owner is both a miss and a false item", () => {
  const c = cases.find((x) => x.id === "mem-en-7")!;
  const perfect = applyPatch(
    emptyMemory(0),
    {
      add: {
        commitments: c.expected.promises.map((p) => ({ who: p.who, what: p.what })),
        openQuestions: c.expected.openQuestions.map((q) => ({ asker: q.asker, text: q.text })),
        numbers: c.expected.numbers.map((n) => ({ what: n.what, value: n.value, who: n.who })),
        decisions: c.expected.decisions.map((d) => ({ text: d.text })),
        objections: (c.expected.objections ?? []).map((o) => ({ who: o.who, text: o.text })),
      },
    },
    { now: 1 },
  ).mem;
  for (const k of CLASSES) assert.equal(scoreMemory(perfect, c)[k].f1, 1, k);
  const wrong = applyPatch(
    emptyMemory(0),
    { add: { numbers: c.expected.numbers.map((n) => ({ what: n.what, value: n.value, who: "someone else" })) } },
    { now: 1 },
  ).mem;
  const s = scoreMemory(wrong, c).numbers;
  assert.equal(s.tp, 0);
  assert.equal(s.extracted, c.expected.numbers.length);
  // an answered question is not "open at the end"
  const answered = applyPatch(
    perfect,
    { update: [{ id: itemsOf(perfect).openQuestions.length ? "q1" : "q0", fields: { status: "answered" } }] },
    { now: 2 },
  ).mem;
  assert.equal(scoreMemory(answered, c).openQuestions.extracted, 0);
});

test("owners: me fits I and the Hebrew word, a name fits itself, nobody fits nothing", () => {
  assert.ok(ownerFits("me", "me") && ownerFits("me", "I") && ownerFits("me", "אני"));
  assert.ok(ownerFits("Dana", "dana") && ownerFits("מר הלל", "הלל"));
  assert.ok(!ownerFits("me", "Dana") && !ownerFits("Dana", "me") && !ownerFits("Dana", undefined));
});

test("null control: an empty memory scores under the limit", async () => {
  const r = await runMemoryEval({ mode: "null" });
  console.log(formatEval(r));
  assert.deepEqual(controlBreaches(r), []);
  assert.ok(r.overall.f1 <= CONTROL_LIMITS.nullF1Max);
  assert.equal(r.overall.recall, 0);
  assert.equal(itemsOf(nullMemory()).promises.length, 0);
});

test("copy-all control: every line in every class has a low precision (and a high recall, so it is a fair try)", async () => {
  const r = await runMemoryEval({ mode: "copy-all" });
  console.log(formatEval(r));
  assert.deepEqual(controlBreaches(r), []);
  assert.ok(r.overall.precision <= CONTROL_LIMITS.copyAllPrecisionMax, `precision ${r.overall.precision}`);
  assert.ok(r.overall.recall >= 0.5, `recall ${r.overall.recall}: the control must catch many labels, or it proves nothing`);
  assert.ok(itemsOf(copyAllMemory(cases[0])).decisions.length >= 10);
});

test("a grader that lets a control through is reported", () => {
  const fake = { mode: "null" as const, overall: { f1: 0.5 } } as never;
  assert.equal(controlBreaches(fake).length, 1);
});

test("fake model through the real memory loop: a table with precision and recall per class, English and Hebrew", async () => {
  const r = await runMemoryEval({ mode: "fake" });
  console.log(formatEval(r));
  assert.equal(r.cases.length, 24);
  assert.ok(
    r.cases.every((c) => c.runs >= 2),
    "the loop made several updater runs per call",
  );
  assert.equal(
    r.cases.reduce((a, c) => a + c.dropped, 0),
    0,
    "no patch was dropped",
  );
  for (const k of CLASSES) {
    assert.ok(r.byClass[k].expected >= (k === "objections" ? 8 : 10), k);
    assert.ok(r.byClass[k].recall > 0.5 && r.byClass[k].precision > 0.5, `${k}: ${JSON.stringify(r.byClass[k])}`);
  }
  assert.ok(r.overall.f1 >= CONTROL_LIMITS.fakeF1Min, `F1 ${r.overall.f1}`);
  assert.ok(r.byLang.en.f1 > 0.5 && r.byLang.he.f1 > 0.5 && r.byLang.mixed.f1 > 0.5, "every language group scores");
  const text = formatEval(r);
  for (const k of CLASSES) assert.match(text, new RegExp(`${k}\\s+precision`));
  assert.match(text, /Hebrew\s+precision/);
  assert.match(text, /Mixed\s+precision/);
  for (const k of CLASSES) assert.match(text, new RegExp(`${k}\\s+precision \\s*\\d+%  recall \\s*\\d+%  F1 \\s*\\d+%`), `F1 printed for ${k}`);
});

test("fake model with no noise finds every label; with noise it loses some; the same seed gives the same table", async () => {
  const clean = await runMemoryEval({ mode: "fake", noise: 0 });
  assert.equal(clean.overall.f1, 1);
  const noisy = await runMemoryEval({ mode: "fake", noise: 0.4, seed: 3 });
  assert.ok(noisy.overall.f1 < 0.9 && noisy.overall.recall < 1, `F1 ${noisy.overall.f1}`);
  const again = await runMemoryEval({ mode: "fake", noise: 0.4, seed: 3 });
  assert.deepEqual(again.overall, noisy.overall);
});

test("model mode needs a registry", async () => {
  await assert.rejects(runMemoryEval({ mode: "model" }), /needs a registry/);
});

test("the set covers the hard cases: noisy speech-to-text, two voices on the user's side, a long call with compaction", () => {
  const has = (t: string) => cases.filter((c) => c.tags?.includes(t));
  assert.ok(has("noisy-stt").length >= 3, "noisy speech-to-text");
  const two = has("two-me-voices");
  assert.ok(two.length >= 2);
  for (const c of two)
    assert.ok(new Set(c.lines.filter((l) => l.side === "me" && l.name).map((l) => l.name)).size >= 1, `${c.id}: a named second voice on the me side`);
  const long = has("long");
  assert.ok(long.length >= 1 && long.every((c) => c.lines.length >= 30 && (c.compactEveryMinutes ?? 0) > 0));
  assert.ok(has("objection").length >= 2 && has("mixed").length >= 3);
});

test("long call: the compaction runs in the loop and the early promise is still there at the end", async () => {
  const long = cases.filter((c) => c.tags?.includes("compaction"));
  const r = await runMemoryEval({ mode: "fake", noise: 0, cases: long });
  assert.ok(r.cases[0].compactions >= 1, `compactions: ${r.cases[0].compactions}`);
  assert.equal(r.byClass.promises.recall, 1, "the promise from line 2 survived");
  assert.match(formatEval(r), /compactions in the long calls: 1 calls/);
});

test("floors apply to a recorded run only: a weak model run breaks them, the fake and the controls are not held to them", async () => {
  const weak = await runMemoryEval({ mode: "fake", noise: 0.9, seed: 5 });
  assert.deepEqual(floorBreaches(weak), [], "fake mode is not held to the floors");
  const asModel = { ...weak, mode: "model" as const };
  const breaches = floorBreaches(asModel);
  assert.ok(breaches.length >= 3, breaches.join("; "));
  assert.ok(breaches.some((b) => b.startsWith("overall F1")));
  const good = await runMemoryEval({ mode: "fake", noise: 0 });
  assert.deepEqual(floorBreaches({ ...good, mode: "model" as const }), []);
  assert.equal(RECORDED_FLOORS.classF1.objections > 0, true);
});
