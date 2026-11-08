// The judgement set: does the moment role make the right call at the right moment? 120 invented cases (60 English, 60 Hebrew, some with noisy speech-to-text or
// two languages) in data/judge-set/*.json. A case is what the model sees in one moment role call: the call memory so far, the last lines (at most 6), and the
// verdict a careful person would give: SKIP (stay silent) or one kind of card (ANS, REPLY, STALL, CHECK, TERM, PROMPT, NOTE), with `accept` for a second verdict that is
// just as good and `mustMention` for words the card must contain (a number or a fact that comes from the memory or the lines, never a guess).
//
// Why a set apart from the golden meetings: the meetings measure the whole engine over time. This set measures the judgement alone, with one clean call per case,
// so a bad prompt shows up as a number per kind. It uses no word list: the model reads the lines, the code only compares verdicts.
//
//   mode "fake"         the policy fake answers the labelled verdict with seeded noise. Tests the plumbing and the scorer; says nothing about a model.
//   mode "model"        a registry: the cassette replay (no key) or the owner's recording. The measure that matters.
//   control always-skip the model never speaks. Must fall under the limits.
//   control always-ans  every case gets an answer card. Must fall under the limits.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ROOT } from "../src/env.ts";
import { buildContext } from "../src/context/build.ts";
import { buildMomentPrompt } from "../src/moments/prompt.ts";
import { runMoment } from "../src/moments/run.ts";
import { applyPatch } from "../src/session/patch.ts";
import { emptyMemory, KINDS as MEMORY_KINDS } from "../src/session/types.ts";
import { MOMENT_TAGS, type MomentTag } from "../src/moments/types.ts";
import { policyModel } from "../src/testkit/policy-model.ts";
import { registerRole } from "../src/testkit/prompt.ts";
import type { ModelRegistry } from "../src/providers/llm.ts";
import { denylistHits } from "./denylist.ts";

/** The verdicts a case can ask for. BANK is not one of them: it needs a bank, and the engine's own tests cover it. */
export const JUDGE_TAGS = MOMENT_TAGS.filter((t) => t !== "BANK") as Exclude<MomentTag, "BANK">[];
export type JudgeTag = (typeof JUDGE_TAGS)[number];
export const JUDGE_DIR = join(ROOT, "data", "judge-set");
export const JUDGE_USER = "Dan";
export const JUDGE_MODEL = "anthropic:claude-haiku-5-5";

const Line = z.strictObject({ side: z.enum(["me", "them"]), name: z.string().min(1).optional(), text: z.string().min(1) });
export const JudgeCaseSchema = z.strictObject({
  id: z.string().regex(/^j-(en|he)-\d{3}$/),
  lang: z.enum(["en", "he"]),
  /** what is hard about it: smalltalk, objection, noq (no question mark), noisy, mixed, open-loop ... */
  tags: z.array(z.string().min(1)),
  kind: z.enum(MEMORY_KINDS),
  /** A memory patch applied to an empty memory: the state of the call memory before the last lines. */
  memory: z.strictObject({
    topic: z.string().optional(),
    summary: z.string().optional(),
    add: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).optional(),
  }),
  lines: z.array(Line).min(1).max(6),
  expected: z.strictObject({
    tag: z.enum(JUDGE_TAGS as [JudgeTag, ...JudgeTag[]]),
    accept: z.array(z.enum(JUDGE_TAGS as [JudgeTag, ...JudgeTag[]])).optional(),
    mustMention: z.array(z.string().min(1)).optional(),
  }),
});
export type JudgeCase = z.infer<typeof JudgeCaseSchema>;

export function loadJudgeSet(dir = JUDGE_DIR): JudgeCase[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JudgeCaseSchema.parse(JSON.parse(readFileSync(join(dir, f), "utf8"))));
}

const HEBREW = /[֐-׿]/;
const LATIN = /[A-Za-z]/;
/** Problems with the labels of a case (empty = fine). Keeps the labels honest: a fact the card must contain has to be in the case. */
export function validateJudgeCase(c: JudgeCase): string[] {
  const bad: string[] = [];
  if (!c.id.startsWith(`j-${c.lang}-`)) bad.push("id does not match lang");
  const last = c.lines.at(-1)!.text;
  if (c.lang === "he" ? !HEBREW.test(last) : HEBREW.test(last) && !LATIN.test(last)) bad.push("the last line is not in the language of the case");
  const first = c.lines.map((l) => l.text).join(" ");
  if (c.lang === "he" ? !HEBREW.test(first) : !LATIN.test(first)) bad.push("the lines are not in the language of the case");
  const e = c.expected;
  if (e.accept?.includes(e.tag)) bad.push("accept repeats the verdict");
  if (e.mustMention?.length && (e.tag === "SKIP" || e.tag === "STALL")) bad.push(`${e.tag} has no card text, so mustMention makes no sense`);
  const world = (JSON.stringify(c.memory) + " " + first).toLowerCase();
  for (const t of e.mustMention ?? []) if (!world.includes(t.toLowerCase())) bad.push(`mustMention "${t}" is not in the memory or the lines`);
  if ((e.tag === "ANS" || e.tag === "CHECK") && !e.mustMention?.length) bad.push(`${e.tag} needs a mustMention taken from the memory`);
  for (const h of denylistHits(JSON.stringify(c))) bad.push(`denylist: ${h}`);
  return bad;
}
/** Problems with the whole set: size, languages, ids, and the spread of verdicts. */
export function validateJudgeSet(cases: JudgeCase[]): string[] {
  const bad: string[] = [];
  const ids = new Set(cases.map((c) => c.id));
  if (ids.size !== cases.length) bad.push("duplicate ids");
  for (const c of cases) bad.push(...validateJudgeCase(c).map((p) => `${c.id}: ${p}`));
  for (const l of ["en", "he"] as const) {
    const mine = cases.filter((c) => c.lang === l);
    if (mine.length !== 60) bad.push(`${l}: ${mine.length} cases, need 60`);
    for (const t of JUDGE_TAGS) if (!mine.some((c) => c.expected.tag === t)) bad.push(`${l}: no case for ${t}`);
    if (mine.filter((c) => c.expected.tag === "SKIP").length > mine.length * 0.45) bad.push(`${l}: too many SKIP cases (an always-SKIP model would look good)`);
  }
  return bad;
}

// ---------------------------------------------------------------- running a case
const registered = (() => {
  registerRole("moment", "You are Wingman, a private voice that helps the user during a live call");
  return true;
})();

/** The context the engine builds for a moment call, for this case. */
export function judgeContext(c: JudgeCase) {
  void registered;
  const mem = applyPatch(emptyMemory(0), { ...c.memory, kind: c.kind } as never, { now: 1 }).mem;
  const names = [...new Set(c.lines.filter((l) => l.side === "them" && l.name).map((l) => l.name!))];
  const roster = names.map((name) => ({ name, side: "them" as const }));
  const trigger = c.lines.at(-1)!.text;
  return buildContext({
    role: "moment",
    roleInstructions: buildMomentPrompt({ userName: JUDGE_USER, roster, kind: c.kind }),
    memory: mem,
    rawLines: c.lines.map((l) => ({ side: l.side, text: l.text, ...(l.name ? { name: l.name } : {}) })),
    trigger,
  });
}

export type Verdict = { tag: JudgeTag | "ERROR"; say: string; usage?: unknown; error?: string };
const CFG = { timeoutMs: 8000, maxTokens: 200, maxRetries: 0, effort: "low", thinking: false, cache: "off" } as const;

/** Asks the moment role about one case. A model error is a verdict "ERROR" (counted as wrong), never an exception. */
export async function askCase(c: JudgeCase, registry: Pick<ModelRegistry, "resolve">, model = JUDGE_MODEL): Promise<Verdict> {
  const ctx = judgeContext(c);
  let out: Verdict | undefined;
  try {
    await runMoment({
      registry: registry as never,
      models: [model],
      role: "moment",
      ctx,
      cfg: { ...CFG },
      signal: new AbortController().signal,
      h: {
        onPartial: () => {},
        onDone: (d) => {
          out = { tag: d.moment.tag as JudgeTag, say: d.moment.say, usage: d.usage };
        },
      },
    });
  } catch (e) {
    return { tag: "ERROR", say: "", error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
  return out ?? { tag: "ERROR", say: "", error: "no answer" };
}

// ---------------------------------------------------------------- scoring
export type CaseResult = { id: string; lang: "en" | "he"; tags: string[]; expected: JudgeTag; got: Verdict["tag"]; ok: boolean; sayMiss: boolean };
const norm = (s: string) => s.toLowerCase();
export function gradeCase(c: JudgeCase, v: Verdict): CaseResult {
  const e = c.expected;
  const allowed = [e.tag, ...(e.accept ?? [])];
  const tagOk = v.tag !== "ERROR" && allowed.includes(v.tag);
  const needSay = v.tag === e.tag && !!e.mustMention?.length;
  const sayMiss = needSay && !e.mustMention!.every((t) => norm(v.say).includes(norm(t)));
  return { id: c.id, lang: c.lang, tags: c.tags, expected: e.tag, got: v.tag, ok: tagOk && !sayMiss, sayMiss };
}

export type KindScore = { n: number; tp: number; fp: number; fn: number; precision: number; recall: number; f1: number };
const kindScore = (tp: number, fp: number, fn: number): KindScore => {
  const precision = tp + fp ? tp / (tp + fp) : 0,
    recall = tp + fn ? tp / (tp + fn) : 0;
  return { n: tp + fn, tp, fp, fn, precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0 };
};
export type JudgeScore = {
  total: number;
  accuracy: number;
  macroF1: number;
  byKind: Record<JudgeTag, KindScore>;
  /** share of SKIP cases where the model stayed silent (or said an accepted verdict) */
  skipRecall: number;
  /** share of non-SKIP cases that got a right card */
  actionableRecall: number;
  /** share of SKIP cases where a card showed: the false alarms */
  falseAlarm: number;
  sayMisses: number;
  errors: number;
  byLang: Record<"en" | "he", { total: number; accuracy: number }>;
  /** accuracy of the cases that carry a tag: noisy, mixed, noq, objection ... */
  byTag: Record<string, { total: number; accuracy: number }>;
};
export function scoreJudge(cases: JudgeCase[], results: CaseResult[]): JudgeScore {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const counts = Object.fromEntries(JUDGE_TAGS.map((t) => [t, { tp: 0, fp: 0, fn: 0 }])) as Record<JudgeTag, { tp: number; fp: number; fn: number }>;
  for (const r of results) {
    // An accepted second verdict counts as the gold verdict for this case.
    const c = byId.get(r.id)!;
    const gold: JudgeTag = r.got !== "ERROR" && c.expected.accept?.includes(r.got) ? r.got : r.expected;
    if (r.ok) counts[gold].tp++;
    else {
      counts[r.expected].fn++;
      if (r.got !== "ERROR") counts[r.got].fp++;
    }
  }
  const byKind = Object.fromEntries(JUDGE_TAGS.map((t) => [t, kindScore(counts[t].tp, counts[t].fp, counts[t].fn)])) as Record<JudgeTag, KindScore>;
  const present = JUDGE_TAGS.filter((t) => byKind[t].n > 0);
  const skips = results.filter((r) => r.expected === "SKIP"),
    acts = results.filter((r) => r.expected !== "SKIP");
  const acc = (rs: CaseResult[]) => (rs.length ? rs.filter((r) => r.ok).length / rs.length : 0);
  const byTag: JudgeScore["byTag"] = {};
  for (const r of results) for (const t of r.tags) (byTag[t] ??= { total: 0, accuracy: 0 }).total++;
  for (const t of Object.keys(byTag)) byTag[t].accuracy = acc(results.filter((r) => r.tags.includes(t)));
  return {
    total: results.length,
    accuracy: acc(results),
    macroF1: present.length ? present.reduce((a, t) => a + byKind[t].f1, 0) / present.length : 0,
    byKind,
    skipRecall: acc(skips),
    actionableRecall: acc(acts),
    falseAlarm: skips.length ? skips.filter((r) => !r.ok && r.got !== "ERROR" && r.got !== "SKIP").length / skips.length : 0,
    sayMisses: results.filter((r) => r.sayMiss).length,
    errors: results.filter((r) => r.got === "ERROR").length,
    byLang: {
      en: { total: results.filter((r) => r.lang === "en").length, accuracy: acc(results.filter((r) => r.lang === "en")) },
      he: { total: results.filter((r) => r.lang === "he").length, accuracy: acc(results.filter((r) => r.lang === "he")) },
    },
    byTag,
  };
}

// ---------------------------------------------------------------- controls, limits, floors
export type JudgeMode = "fake" | "model" | "always-skip" | "always-ans";
/** What a control may not reach. A set that lets a model that never speaks, or one that always answers, score well is broken. */
export const JUDGE_CONTROL_LIMITS = {
  accuracyMax: 0.5,
  macroF1Max: 0.15,
  /** always-skip: share of the cards it may get right (only the cases where SKIP is accepted) */
  actionableRecallMax: 0.12,
  /** always-ans: share of the silent cases it may get right */
  skipRecallMax: 0.05,
  /** the fake with noise: a sanity floor for the plumbing */
  fakeMacroF1Min: 0.6,
} as const;
/** Floors for a RECORDED run (mode "model"). Provisional: the owner moves them after the first recorded run. */
export const JUDGE_FLOORS = { accuracy: 0.6, macroF1: 0.5, skipRecall: 0.75, actionableRecall: 0.5, langAccuracy: 0.5, falseAlarmMax: 0.2 } as const;

export function controlBreaches(mode: JudgeMode, s: JudgeScore): string[] {
  const L = JUDGE_CONTROL_LIMITS,
    out: string[] = [];
  const f = (x: number) => x.toFixed(2);
  if (mode !== "always-skip" && mode !== "always-ans") return out;
  if (s.accuracy > L.accuracyMax) out.push(`${mode} control accuracy ${f(s.accuracy)} is over ${L.accuracyMax}`);
  if (s.macroF1 > L.macroF1Max) out.push(`${mode} control macro F1 ${f(s.macroF1)} is over ${L.macroF1Max}`);
  if (mode === "always-skip" && s.actionableRecall > L.actionableRecallMax)
    out.push(`always-skip control gets ${f(s.actionableRecall)} of the cards, limit ${L.actionableRecallMax}`);
  if (mode === "always-ans" && s.skipRecall > L.skipRecallMax)
    out.push(`always-ans control stays silent in ${f(s.skipRecall)} of the silent cases, limit ${L.skipRecallMax}`);
  return out;
}
export function floorBreaches(mode: JudgeMode, s: JudgeScore): string[] {
  if (mode !== "model") return [];
  const F = JUDGE_FLOORS,
    out: string[] = [];
  const p = (x: number) => (x * 100).toFixed(0);
  if (s.accuracy < F.accuracy) out.push(`accuracy ${p(s.accuracy)} is under the floor ${p(F.accuracy)}`);
  if (s.macroF1 < F.macroF1) out.push(`macro F1 ${p(s.macroF1)} is under the floor ${p(F.macroF1)}`);
  if (s.skipRecall < F.skipRecall) out.push(`silence in SKIP cases ${p(s.skipRecall)} is under the floor ${p(F.skipRecall)}`);
  if (s.actionableRecall < F.actionableRecall) out.push(`right cards ${p(s.actionableRecall)} is under the floor ${p(F.actionableRecall)}`);
  if (s.falseAlarm > F.falseAlarmMax) out.push(`false alarms ${p(s.falseAlarm)} is over the limit ${p(F.falseAlarmMax)}`);
  for (const l of ["en", "he"] as const)
    if (s.byLang[l].accuracy < F.langAccuracy) out.push(`${l} accuracy ${p(s.byLang[l].accuracy)} is under the floor ${p(F.langAccuracy)}`);
  return out;
}

// ---------------------------------------------------------------- the fake
const hash = (s: string) => Array.from(s).reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
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
/** The reply text for a verdict, in the format the moment parser reads. The say-line holds the words the case asks for. */
export function replyFor(tag: JudgeTag, say: string): string {
  if (tag === "SKIP") return "SKIP\nWHY: nothing to add";
  if (tag === "STALL") return "STALL price\nVALUE: 2\nAIM: me\nWHY: a commitment is asked";
  return `${tag}\nVALUE: 3\nAIM: me\nSAY: ${say || "Check your notes on this point."}\nWHY: fake`;
}
/** A registry whose model answers the labelled verdict, and with probability `noise` a wrong one (seeded, the same every run). */
export function fakeJudgeRegistry(cases: JudgeCase[], o: { noise: number; seed: number }): Pick<ModelRegistry, "resolve"> {
  const pm = policyModel({ strict: false, defaultText: "SKIP" });
  for (const c of cases) {
    const r = rng(o.seed + hash(c.id));
    let tag: JudgeTag = c.expected.tag;
    if (r() < o.noise) tag = tag === "SKIP" ? "ANS" : r() < 0.5 ? "SKIP" : JUDGE_TAGS.filter((t) => t !== tag && t !== "SKIP")[Math.floor(r() * 6)];
    const user = judgeContext(c).messages[0].content;
    pm.reply((v) => v.user === user, replyFor(tag, c.expected.mustMention?.join(" ") ?? ""), { ms: 1 });
  }
  return { resolve: async () => pm.model };
}

// ---------------------------------------------------------------- the run
export type JudgeRun = { mode: JudgeMode; cases: JudgeCase[]; results: CaseResult[]; verdicts: Verdict[]; score: JudgeScore };
export async function runJudgeSet(o: {
  mode: JudgeMode;
  cases?: JudgeCase[];
  registry?: Pick<ModelRegistry, "resolve">;
  model?: string;
  noise?: number;
  seed?: number;
}): Promise<JudgeRun> {
  const cases = o.cases ?? loadJudgeSet();
  let verdicts: Verdict[];
  if (o.mode === "always-skip") verdicts = cases.map(() => ({ tag: "SKIP", say: "" }));
  else if (o.mode === "always-ans") verdicts = cases.map(() => ({ tag: "ANS", say: "Take a moment to summarise the main points so far." }));
  else {
    if (o.mode === "model" && !o.registry) throw new Error("runJudgeSet: mode 'model' needs a registry (a cassette replay or a live one)");
    const registry = o.mode === "model" ? o.registry! : fakeJudgeRegistry(cases, { noise: o.noise ?? 0.15, seed: o.seed ?? 7 });
    verdicts = [];
    for (const c of cases) verdicts.push(await askCase(c, registry, o.model));
  }
  const results = cases.map((c, i) => gradeCase(c, verdicts[i]));
  return { mode: o.mode, cases, results, verdicts, score: scoreJudge(cases, results) };
}

// ---------------------------------------------------------------- output
const pct = (x: number) => (x * 100).toFixed(0).padStart(3) + "%";
export function formatJudge(r: JudgeRun): string {
  const s = r.score;
  const row = (name: string, k: KindScore) =>
    `${name.padEnd(8)} n ${String(k.n).padStart(3)}  precision ${pct(k.precision)}  recall ${pct(k.recall)}  F1 ${pct(k.f1)}`;
  const tags = ["noq", "noisy", "mixed", "objection", "open-loop"].filter((t) => s.byTag[t]);
  return [
    `judgement set, mode ${r.mode}, ${s.total} cases`,
    ...JUDGE_TAGS.map((t) => row(t, s.byKind[t])),
    `accuracy ${pct(s.accuracy)}   macro F1 ${pct(s.macroF1)}   silence in SKIP cases ${pct(s.skipRecall)}   right cards ${pct(s.actionableRecall)}   false alarms ${pct(s.falseAlarm)}`,
    `English ${pct(s.byLang.en.accuracy)} (${s.byLang.en.total})   Hebrew ${pct(s.byLang.he.accuracy)} (${s.byLang.he.total})   ${tags.map((t) => `${t} ${pct(s.byTag[t].accuracy)} (${s.byTag[t].total})`).join("   ")}`,
    ...(s.sayMisses || s.errors ? [`card text missed a required word in ${s.sayMisses} cases; ${s.errors} model errors or misses`] : []),
  ].join("\n");
}
