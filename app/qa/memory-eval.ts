// Memory-quality eval: does the call memory catch what a person would write down?
//
// 12 invented calls (6 English, 6 Hebrew) in data/memory-eval/*.json. Each one has labels for the FINAL memory: promises (with the owner), questions still
// open at the end, numbers (with the owner) and decisions. runMemoryEval() plays a call through the real memory loop (the same code path as a live call:
// buildContext, the model runner, parseJsonObject, applyPatch) and scores the memory it ends with: precision and recall per class.
//
//   mode "fake"      the policy fake model answers with the labelled items, with seeded noise (some dropped, one wrong owner, one extra). Tests the pipeline and the
//                    scorer. It says nothing about a real model. Works offline, no key.
//   mode "model"     a real registry: the cassette replay (WINGMAN_LLM_MODE=replay) or a live model. This is the measure that matters; the owner records it.
//   mode "null"      control: the updater never writes anything. Must score (almost) zero.
//   mode "copy-all"  control: every line is written into every class. Must have a low precision.
// A grader that lets a control through is broken: CONTROL_LIMITS are checked by the tests and by scripts/eval-memory.ts.
//
// Matching uses no word list: a label has `keys` (stems of its own words, any language); an extracted item matches when every word of every key appears in
// its text, the owner fits and (for numbers) the digits are equal. One extracted item matches at most one label.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../src/env.ts";
import { MemoryLoop, DEFAULT_MEMORY_CONFIG, makeModelRunner } from "../src/engine/memory.ts";
import { applyPatch } from "../src/session/patch.ts";
import { emptyMemory, type SessionMemory } from "../src/session/types.ts";
import { policyModel } from "../src/testkit/policy-model.ts";
import { registerRole } from "../src/testkit/prompt.ts";
import type { ModelRegistry } from "../src/providers/llm.ts";

export const CLASSES = ["promises", "openQuestions", "numbers", "decisions"] as const;
export type Cls = (typeof CLASSES)[number];

export type EvalLine = { side: "me" | "them"; name?: string; text: string };
export type EvalCase = {
  id: string;
  lang: "en" | "he";
  title: string;
  kind: string;
  lines: EvalLine[];
  expected: {
    promises: { line: number; who: string; what: string; keys: string[] }[];
    openQuestions: { line: number; asker: string; text: string; keys: string[] }[];
    numbers: { line: number; what: string; value: string; who: string; keys: string[] }[];
    decisions: { line: number; text: string; keys: string[] }[];
  };
};

/** The limits a control must stay under (checked by the tests and by scripts/eval-memory.ts). */
export const CONTROL_LIMITS = {
  /** the null memory: overall F1 */
  nullF1Max: 0.02,
  /** the copy-all memory: overall precision */
  copyAllPrecisionMax: 0.3,
  /** the fake-model run with noise (a sanity floor for the pipeline, not a quality claim) */
  fakeF1Min: 0.6,
} as const;

export const EVAL_DIR = join(ROOT, "data", "memory-eval");

// ---------------------------------------------------------------- cases
export function loadCases(dir = EVAL_DIR): EvalCase[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as EvalCase);
}

const words = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const hasKeys = (text: string, keys: readonly string[]): boolean => {
  const t = text.toLowerCase();
  return keys.every((k) => words(k).every((w) => t.includes(w)));
};

/** Problems with the labels of a case (empty = fine). Every key must appear in the line the label points at, so the labels stay honest. */
export function validateCase(c: EvalCase): string[] {
  const bad: string[] = [];
  if (!/^mem-(en|he)-\d+$/.test(c.id)) bad.push("id");
  if (c.lang !== "en" && c.lang !== "he") bad.push("lang");
  if (c.lines.length < 8 || c.lines.some((l) => !l.text || (l.side !== "me" && l.side !== "them"))) bad.push("lines");
  const check = (cls: Cls, i: number, l: { line: number; keys: string[] } & Record<string, unknown>) => {
    const src = c.lines[l.line];
    if (!src) return bad.push(`${cls}[${i}]: line ${l.line} does not exist`);
    if (!l.keys?.length) bad.push(`${cls}[${i}]: no keys`);
    else if (!hasKeys(src.text, l.keys)) bad.push(`${cls}[${i}]: keys ${JSON.stringify(l.keys)} are not in line ${l.line}`);
    if (cls === "numbers" && !src.text.includes(String(l.value))) bad.push(`numbers[${i}]: value ${l.value} is not in line ${l.line}`);
  };
  for (const cls of CLASSES) c.expected[cls].forEach((l, i) => check(cls, i, l as never));
  if (CLASSES.every((cls) => c.expected[cls].length === 0)) bad.push("no labels");
  return bad;
}

// ---------------------------------------------------------------- scoring
export type ClassScore = { tp: number; extracted: number; expected: number; precision: number; recall: number; f1: number };
const ratio = (a: number, b: number) => (b > 0 ? a / b : 0);
export function toScore(tp: number, extracted: number, expected: number): ClassScore {
  const precision = ratio(tp, extracted),
    recall = ratio(tp, expected);
  return { tp, extracted, expected, precision, recall, f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0 };
}
const digits = (s: unknown) => String(s ?? "").replace(/[^\d.]/g, "");
/** Does the owner in the memory fit the label? "me" also fits "I" and "אני"; a name fits when one contains the other. */
export function ownerFits(label: string, got: string | undefined): boolean {
  const a = label.trim().toLowerCase(),
    b = (got ?? "").trim().toLowerCase();
  if (!b) return false;
  if (a === "me") return b === "me" || b === "i" || b === "אני";
  if (b === "me" || b === "i" || b === "אני") return false;
  return a === b || a.includes(b) || b.includes(a);
}

type Item = { text: string; who?: string; value?: string };
export function itemsOf(mem: SessionMemory): Record<Cls, Item[]> {
  return {
    promises: mem.commitments.map((c) => ({ text: `${c.what} ${c.due ?? ""}`, who: c.who })),
    openQuestions: mem.openQuestions.filter((q) => q.status === "open").map((q) => ({ text: q.text, who: q.asker })),
    numbers: mem.numbers.map((n) => ({ text: n.what, who: n.who, value: n.value })),
    decisions: mem.decisions.map((d) => ({ text: d.text })),
  };
}
type Label = { keys: string[]; who?: string; asker?: string; value?: string };
const fits = (cls: Cls, label: Label, it: Item): boolean => {
  if (!hasKeys(it.text, label.keys)) return false;
  if (cls === "promises") return ownerFits(label.who ?? "", it.who);
  if (cls === "numbers") return digits(it.value) === digits(label.value) && ownerFits(label.who ?? "", it.who);
  return true; // a question's asker is not scored: the model may call the same person "them"
};

/** Precision and recall of one memory against the labels of its call. */
export function scoreMemory(mem: SessionMemory, c: EvalCase): Record<Cls, ClassScore> {
  const got = itemsOf(mem);
  const out = {} as Record<Cls, ClassScore>;
  for (const cls of CLASSES) {
    const used = new Set<number>();
    let tp = 0;
    for (const label of c.expected[cls] as Label[]) {
      const i = got[cls].findIndex((it, k) => !used.has(k) && fits(cls, label, it));
      if (i >= 0) {
        used.add(i);
        tp++;
      }
    }
    out[cls] = toScore(tp, got[cls].length, c.expected[cls].length);
  }
  return out;
}
const sum = (rows: ClassScore[]): ClassScore =>
  toScore(
    rows.reduce((a, r) => a + r.tp, 0),
    rows.reduce((a, r) => a + r.extracted, 0),
    rows.reduce((a, r) => a + r.expected, 0),
  );

// ---------------------------------------------------------------- the memory a mode builds
/** Mulberry32: a small seeded generator, so a noisy fake run is the same every time. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The patch a perfect updater would write for lines [from, to), with seeded noise: labels dropped, a number with the wrong owner, one extra decision. */
export function oraclePatch(c: EvalCase, from: number, to: number, noise: number, r: () => number): object {
  const inRange = (l: { line: number }) => l.line >= from && l.line < to;
  const keep = () => r() >= noise;
  const add: Record<string, object[]> = {};
  const push = (list: string, item: object) => (add[list] ??= []).push(item);
  for (const p of c.expected.promises.filter(inRange)) keep() && push("commitments", { who: p.who, what: p.what });
  for (const q of c.expected.openQuestions.filter(inRange)) keep() && push("openQuestions", { asker: q.asker, text: q.text });
  for (const n of c.expected.numbers.filter(inRange))
    keep() && push("numbers", { what: n.what, value: n.value, who: r() < noise / 2 ? "someone else" : n.who });
  for (const d of c.expected.decisions.filter(inRange)) keep() && push("decisions", { text: d.text });
  // over-extraction: a plain line becomes a decision
  const labelled = new Set(Object.values(c.expected).flatMap((ls) => (ls as { line: number }[]).map((l) => l.line)));
  for (let i = from; i < to; i++) if (!labelled.has(i) && noise > 0 && r() < noise / 3) push("decisions", { text: c.lines[i].text.slice(0, 120) });
  return Object.keys(add).length ? { add } : {};
}

/** A memory with nothing in it (the updater never writes). */
export const nullMemory = (): SessionMemory => emptyMemory(0);
/** A memory with every line copied into every class. */
export function copyAllMemory(c: EvalCase): SessionMemory {
  let mem = emptyMemory(0);
  const step = 10; // CAPS.addPerList
  for (let i = 0; i < c.lines.length; i += step) {
    const part = c.lines.slice(i, i + step);
    const who = (l: EvalLine) => (l.side === "me" ? "me" : (l.name ?? "them"));
    const r = applyPatch(
      mem,
      {
        add: {
          commitments: part.map((l) => ({ who: who(l), what: l.text })),
          openQuestions: part.map((l) => ({ asker: who(l), text: l.text })),
          numbers: part.map((l) => ({ what: l.text, value: l.text.match(/\d+/)?.[0] ?? "0", who: who(l) })),
          decisions: part.map((l) => ({ text: l.text })),
        },
      },
      { now: i + 1 },
    );
    mem = r.mem;
  }
  return mem;
}

// ---------------------------------------------------------------- playing a call through the memory loop
export type DriveOpts = {
  registry: Pick<ModelRegistry, "resolve">;
  model: string;
  /** lines per updater run (about the 25 new words the live loop waits for) */
  batch?: number;
  onUsage?: (role: string, usage: unknown) => void;
};
/** Feeds the lines to a MemoryLoop on a manual clock, one batch at a time, and returns the final memory. */
export async function driveCase(c: EvalCase, o: DriveOpts): Promise<{ memory: SessionMemory; runs: number; dropped: number }> {
  const batch = o.batch ?? 5;
  let clock = 1_800_000_000_000;
  const run = makeModelRunner({ registry: o.registry as ModelRegistry, model: o.model, onUsage: (role, _m, usage) => o.onUsage?.(role, usage) });
  const loop = new MemoryLoop(
    { now: () => clock, run, save: () => {}, sendView: () => {}, log: () => {} },
    { ...DEFAULT_MEMORY_CONFIG, minNewWords: 1, compactEveryMinutes: 10_000 },
    emptyMemory(clock),
  );
  for (let i = 0; i < c.lines.length; i += batch) {
    for (const l of c.lines.slice(i, i + batch)) loop.addLine({ side: l.side, text: l.text, ...(l.name ? { name: l.name } : {}) });
    clock += 21_000;
    loop.tick();
    while (loop.isBusy) await new Promise((r) => setTimeout(r, 0));
  }
  await loop.finalPass(5000);
  loop.stop();
  return { memory: loop.memory, runs: loop.stats.runs, dropped: loop.stats.dropped };
}

registerRole("memory", "You keep the memory of a live call");
registerRole("compact", "You tidy the memory of a live call");
/** A registry whose model answers with the (noisy) oracle patches of this case, one per batch. */
export function fakeRegistryFor(c: EvalCase, o: { noise: number; seed: number; batch?: number }): Pick<ModelRegistry, "resolve"> {
  const batch = o.batch ?? 5;
  const pm = policyModel({ strict: false, defaultText: "{}" });
  const r = rng(o.seed + Array.from(c.id).reduce((a, ch) => a + ch.charCodeAt(0), 0));
  for (let from = 0; from < c.lines.length; from += batch) {
    const to = Math.min(c.lines.length, from + batch);
    const last = c.lines[to - 1].text;
    pm.reply((v) => v.role === "memory" && v.user.includes(last), JSON.stringify(oraclePatch(c, from, to, o.noise, r)), { times: 1 });
  }
  return { resolve: async () => pm.model };
}

// ---------------------------------------------------------------- the eval
export type MemoryEvalOpts = {
  mode?: "fake" | "model" | "null" | "copy-all";
  cases?: EvalCase[];
  /** model mode: the registry (cassette replay or live) and the model ref of the memory updater */
  registry?: Pick<ModelRegistry, "resolve">;
  model?: string;
  /** fake mode: share of labels the fake updater leaves out (default 0.15) and the seed */
  noise?: number;
  seed?: number;
};
export type CaseResult = { id: string; lang: "en" | "he"; byClass: Record<Cls, ClassScore>; overall: ClassScore; runs: number; dropped: number };
export type MemoryEvalResult = {
  mode: NonNullable<MemoryEvalOpts["mode"]>;
  cases: CaseResult[];
  byClass: Record<Cls, ClassScore>;
  byLang: Record<"en" | "he", ClassScore>;
  overall: ClassScore;
};

export async function runMemoryEval(opts: MemoryEvalOpts = {}): Promise<MemoryEvalResult> {
  const mode = opts.mode ?? "fake";
  const cases = opts.cases ?? loadCases();
  if (mode === "model" && !opts.registry) throw new Error("runMemoryEval: mode 'model' needs a registry (a cassette replay or a live one)");
  const results: CaseResult[] = [];
  for (const c of cases) {
    let memory: SessionMemory,
      runs = 0,
      dropped = 0;
    if (mode === "null") memory = nullMemory();
    else if (mode === "copy-all") memory = copyAllMemory(c);
    else {
      const registry = mode === "model" ? opts.registry! : fakeRegistryFor(c, { noise: opts.noise ?? 0.15, seed: opts.seed ?? 7 });
      const d = await driveCase(c, { registry, model: opts.model ?? "anthropic:claude-haiku-5-5" });
      ({ memory, runs, dropped } = d);
    }
    const byClass = scoreMemory(memory, c);
    results.push({ id: c.id, lang: c.lang, byClass, overall: sum(CLASSES.map((k) => byClass[k])), runs, dropped });
  }
  const pool = (rs: CaseResult[]) => ({
    byClass: Object.fromEntries(CLASSES.map((k) => [k, sum(rs.map((r) => r.byClass[k]))])) as Record<Cls, ClassScore>,
    overall: sum(rs.map((r) => r.overall)),
  });
  const all = pool(results);
  return {
    mode,
    cases: results,
    byClass: all.byClass,
    byLang: { en: pool(results.filter((r) => r.lang === "en")).overall, he: pool(results.filter((r) => r.lang === "he")).overall },
    overall: all.overall,
  };
}

// ---------------------------------------------------------------- output
const pct = (x: number) => (x * 100).toFixed(0).padStart(3) + "%";
/** A text table: one line per class, then English, Hebrew and everything. */
export function formatEval(r: MemoryEvalResult): string {
  const row = (name: string, s: ClassScore) =>
    `${name.padEnd(14)} precision ${pct(s.precision)}  recall ${pct(s.recall)}  F1 ${pct(s.f1)}   (${s.tp} right of ${s.extracted} written, ${s.expected} labelled)`;
  return [
    `memory eval, mode ${r.mode}, ${r.cases.length} calls`,
    ...CLASSES.map((k) => row(k, r.byClass[k])),
    row("English", r.byLang.en),
    row("Hebrew", r.byLang.he),
    row("all", r.overall),
  ].join("\n");
}

/** What a control may not do. Returns the broken limits (empty = the control is under its limit). */
export function controlBreaches(r: MemoryEvalResult): string[] {
  if (r.mode === "null" && r.overall.f1 > CONTROL_LIMITS.nullF1Max) return [`null control F1 ${r.overall.f1.toFixed(2)} is over ${CONTROL_LIMITS.nullF1Max}`];
  if (r.mode === "copy-all" && r.overall.precision > CONTROL_LIMITS.copyAllPrecisionMax)
    return [`copy-all control precision ${r.overall.precision.toFixed(2)} is over ${CONTROL_LIMITS.copyAllPrecisionMax}`];
  return [];
}
