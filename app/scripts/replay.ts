// Replay a real call through the moment role with another prompt and see which cards stay, appear or disappear.
//   pnpm replay <call-dir|events.jsonl> [--prompt <file>] [--cassette <file>] [--to-case] [--out <dir>] [--max 300] [--json]
//     <call-dir>   a folder with events.jsonl (the "stt" final lines) and, next to it, cards.jsonl (the cards the call showed) and tags.jsonl (your ratings).
//     --prompt     a text file that replaces the fixed rules of the moment role (MOMENT_RULES). Without it the current rules are used.
//     --cassette   read the model's answers from a cassette (no key, no network). Without it the policy fake answers: it repeats what the original call showed,
//                  so the diff must be empty. That is a check of this tool, not of any prompt. A prompt is judged only through a cassette the owner recorded.
//     --to-case    write every card you rated "not useful" (tags.jsonl) as a judgement-set case (data/judge-set format, expected verdict SKIP) into --out
//                  (default qa/out/cases). Emails and phone numbers are masked; a case with a word from the no-real-names list is NOT written. Read each file before you
//                  copy it into data/judge-set: real names in the lines are on you.
// The tool never calls a real model. It has no memory of the call (the call memory is not in events.jsonl): the context is the last 40 lines and an empty memory.
import "../src/test-setup.ts";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildContext } from "../src/context/build.ts";
import { MOMENT_RULES, momentData } from "../src/moments/prompt.ts";
import { modeInstructions } from "../src/moments/modes.ts";
import { emptyMemory } from "../src/session/types.ts";
import { Cassette, wrapCassette } from "../src/providers/cassette.ts";
import { policyModel } from "../src/testkit/policy-model.ts";
import { registerRole } from "../src/testkit/prompt.ts";
import { replyFor, JUDGE_MODEL, JudgeCaseSchema, type JudgeCase, type JudgeTag, type Verdict } from "../qa/judge-set.ts";
import { runMoment } from "../src/moments/run.ts";
import { denylistHits } from "../qa/denylist.ts";
import type { ModelRegistry } from "../src/providers/llm.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export type Line = { i: number; t: number; side: "me" | "them"; text: string };
export type OrigCard = { id: string; line: number; tag: JudgeTag; badge: string; say: string; rating?: "y" | "n" };
export type Call = { name: string; lines: Line[]; cards: OrigCard[] };

const readJsonl = (f: string): Record<string, unknown>[] =>
  existsSync(f)
    ? readFileSync(f, "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as Record<string, unknown>];
          } catch {
            return [];
          }
        })
    : [];
const str = (x: unknown) => (typeof x === "string" ? x : "");
const KIND_TAG: Record<string, JudgeTag> = { answer: "ANS", prompt: "PROMPT", check: "CHECK", fact: "TERM" };

/** Reads a call folder (or its events.jsonl). Cards that were hidden, withdrawn or not about a line (system cards) are left out. */
export function readCall(path: string): Call {
  const dir = existsSync(path) && statSync(path).isDirectory() ? path : dirname(path);
  const lines: Line[] = [];
  for (const r of readJsonl(existsSync(path) && statSync(path).isFile() ? path : join(dir, "events.jsonl"))) {
    if (r.type !== "stt" || r.final !== true || !str(r.text).trim()) continue;
    lines.push({ i: lines.length, t: Number(r.t) || 0, side: r.ch === "me" ? "me" : "them", text: str(r.text).trim() });
  }
  const ratings = new Map(readJsonl(join(dir, "tags.jsonl")).map((r) => [str(r.id), r.useful === "y" ? "y" : r.useful === "n" ? "n" : undefined] as const));
  const cards: OrigCard[] = [];
  for (const r of readJsonl(join(dir, "cards.jsonl"))) {
    if (r.type !== "card" || r.hidden || r.withdraw || r.clear || r.health || r.turnId === "side" || !str(r.say)) continue;
    const at = Number(r.at ?? r.t) || 0;
    const q = str(r.question);
    // the line the card answered: the same text when the card kept it, else the newest line before the card
    let line = q ? lines.findIndex((l) => l.text.slice(0, 200) === q.slice(0, 200)) : -1;
    if (line < 0) for (const l of lines) if (l.t <= at) line = l.i;
    if (line < 0) continue;
    const badge = str(r.badge);
    const tag: JudgeTag = badge === "stall" ? "STALL" : (KIND_TAG[str(r.kind)] ?? (badge === "tip" ? "PROMPT" : "ANS"));
    cards.push({ id: str(r.id), line, tag, badge, say: str(r.say), ...(ratings.get(str(r.id)) ? { rating: ratings.get(str(r.id)) } : {}) });
  }
  return { name: basename(dir), lines, cards };
}

export type ReplayOpts = { registry: Pick<ModelRegistry, "resolve">; rules?: string; model?: string; max?: number; tail?: number };
export type NewCard = { line: number; tag: JudgeTag; say: string };
const context = (call: Call, i: number, rules: string, tail: number) => {
  const raw = call.lines.slice(Math.max(0, i - tail + 1), i + 1).map((l) => ({ side: l.side, text: l.text }));
  return buildContext({
    role: "moment",
    roleInstructions: `${rules}\n\n${modeInstructions("other") ? modeInstructions("other") + "\n\n" : ""}${momentData({ userName: "Dan" })}`,
    memory: emptyMemory(0),
    rawLines: raw,
    trigger: call.lines[i].text,
  });
};

/** Which lines to ask about: every line of the other side, and the user's own lines that had a card. */
export function linesToAsk(call: Call, max = 300): number[] {
  const had = new Set(call.cards.map((c) => c.line));
  return call.lines
    .filter((l) => l.side === "them" || had.has(l.i))
    .map((l) => l.i)
    .slice(0, max);
}

export async function replayCall(call: Call, o: ReplayOpts): Promise<{ cards: NewCard[]; asked: number; errors: number; stale: number; missing: number }> {
  const rules = o.rules ?? MOMENT_RULES;
  const cards: NewCard[] = [];
  let errors = 0,
    stale = 0,
    missing = 0;
  const ask = linesToAsk(call, o.max);
  for (const i of ask) {
    const ctx = context(call, i, rules, o.tail ?? 40);
    let v: { tag: Verdict["tag"]; say: string; error?: string } = { tag: "ERROR", say: "" };
    try {
      let got: { tag: string; say: string } | undefined;
      await runMoment({
        registry: o.registry as never,
        models: [o.model ?? JUDGE_MODEL],
        role: "moment",
        ctx,
        cfg: { timeoutMs: 8000, maxTokens: 200, maxRetries: 0, effort: "low", thinking: false, cache: "off" },
        signal: new AbortController().signal,
        h: { onPartial: () => {}, onDone: (d) => (got = { tag: d.moment.tag, say: d.moment.say }) },
      });
      v = got ? { tag: got.tag as JudgeTag, say: got.say } : { tag: "ERROR", say: "", error: "no answer" };
    } catch (e) {
      v = { tag: "ERROR", say: "", error: e instanceof Error ? e.message : String(e) };
    }
    if (v.tag === "ERROR") {
      errors++;
      if (v.error?.includes("Cassette STALE")) stale++;
      else if (v.error?.includes("Cassette miss")) missing++;
    } else if (v.tag !== "SKIP") cards.push({ line: i, tag: v.tag, say: v.say });
  }
  return { cards, asked: ask.length, errors, stale, missing };
}

export type Diff = {
  kept: { line: number; was: JudgeTag; now: JudgeTag; say: string }[];
  added: NewCard[];
  gone: OrigCard[];
};
/** A card is kept when the same line has a card before and after (the kind may differ: it is listed), new when only the replay has one, gone when only the call had one. */
export function diffCards(orig: OrigCard[], now: NewCard[]): Diff {
  const byLine = new Map<number, NewCard>();
  for (const c of now) if (!byLine.has(c.line)) byLine.set(c.line, c);
  const seen = new Set<number>();
  const d: Diff = { kept: [], added: [], gone: [] };
  for (const o of orig) {
    const n = byLine.get(o.line);
    if (n && !seen.has(o.line)) d.kept.push({ line: o.line, was: o.tag, now: n.tag, say: n.say });
    else if (!n) d.gone.push(o);
    seen.add(o.line);
  }
  const had = new Set(orig.map((o) => o.line));
  d.added = now.filter((n) => !had.has(n.line));
  return d;
}

const cut = (s: string, n = 90) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
export function formatDiff(call: Call, r: { asked: number; errors: number; stale: number; missing: number }, d: Diff, now: NewCard[]): string {
  const L = (i: number) => `l${i + 1}`;
  const changed = d.kept.filter((k) => k.was !== k.now).length;
  return [
    `Replay of ${call.name}: ${call.lines.length} lines, ${r.asked} asked; the call showed ${call.cards.length} cards, the replay ${now.length}.`,
    `kept ${d.kept.length} (${changed} with another kind), new ${d.added.length}, gone ${d.gone.length}${r.errors ? `; ${r.errors} questions got no answer${r.stale ? ` (${r.stale} STALE: the cassette was recorded with an older prompt, re-record)` : ""}${r.missing ? ` (${r.missing} not in the cassette)` : ""}` : ""}`,
    ...d.kept.map((k) => `  kept  ${L(k.line)} ${k.was}${k.was === k.now ? "" : " -> " + k.now}  ${cut(k.say)}`),
    ...d.added.map((a) => `  new   ${L(a.line)} ${a.tag}  ${cut(a.say)}`),
    ...d.gone.map((g) => `  gone  ${L(g.line)} ${g.tag}${g.rating ? ` (you rated it ${g.rating === "y" ? "useful" : "not useful"})` : ""}  ${cut(g.say)}`),
  ].join("\n");
}

// ---------------------------------------------------------------- --to-case
const mask = (s: string) => s.replace(/[\w.+-]+@[\w-]+\.\w{2,}/g, "[email]").replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]");
const HEBREW = /[֐-׿]/;
/** One judgement case per card rated "not useful": the last 6 lines before the card, expected verdict SKIP. Cases with a denylisted word are returned as refused. */
export function toCases(call: Call, extraDeny: string[] = []): { cases: JudgeCase[]; refused: { id: string; why: string[] }[] } {
  const out: JudgeCase[] = [],
    refused: { id: string; why: string[] }[] = [];
  let n = 0;
  for (const c of call.cards.filter((x) => x.rating === "n")) {
    const lines = call.lines.slice(Math.max(0, c.line - 5), c.line + 1).map((l) => ({ side: l.side, text: mask(l.text) }));
    const lang = HEBREW.test(lines.at(-1)!.text) ? "he" : "en";
    const draft = {
      id: `j-${lang}-${900 + ++n}`,
      lang,
      tags: ["from-rating", "not-useful"],
      kind: "other",
      memory: {},
      lines,
      expected: { tag: "SKIP" },
    };
    const parsed = JudgeCaseSchema.safeParse(draft);
    const text = JSON.stringify(draft);
    const why = [
      ...denylistHits(text),
      ...extraDeny.filter((w) => w && text.toLowerCase().includes(w.toLowerCase())).map((w) => `name "${w}"`),
      ...(parsed.success ? [] : ["schema"]),
    ];
    if (why.length) refused.push({ id: c.id, why });
    else out.push(parsed.data!);
  }
  return { cases: out, refused };
}

// ---------------------------------------------------------------- the command
export type Deps = { log: (line: string) => void; registry?: Pick<ModelRegistry, "resolve"> };
/** The policy fake that repeats the original call: the same kind and say-line on the lines that had a card, SKIP on the others. */
export function echoRegistry(call: Call, rules: string, tail = 40): Pick<ModelRegistry, "resolve"> {
  registerRole("moment", "You are Wingman, a private voice that helps the user during a live call");
  const pm = policyModel({ strict: false, defaultText: "SKIP" });
  for (const c of call.cards) {
    const user = context(call, c.line, rules, tail).messages[0].content;
    pm.reply((v) => v.user === user, replyFor(c.tag, c.say), { ms: 1 });
  }
  return { resolve: async () => pm.model };
}

export async function main(argv: string[], deps: Deps): Promise<number> {
  const log = deps.log;
  const get = (f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const path = argv.find((a, i) => !a.startsWith("--") && !["--prompt", "--cassette", "--out", "--max", "--deny"].includes(argv[i - 1] ?? ""));
  if (!path || !existsSync(path)) return (log("usage: pnpm replay <call-dir|events.jsonl> [--prompt <file>] [--cassette <file>] [--to-case] [--out <dir>]"), 2);
  const call = readCall(path);
  if (!call.lines.length) return (log(`replay: no final lines in ${path} (events.jsonl needs rows of type "stt" with final: true)`), 2);
  if (argv.includes("--to-case")) {
    const { cases, refused } = toCases(call, (get("--deny") ?? "").split(","));
    const out = get("--out") ?? join(ROOT, "qa", "out", "cases");
    mkdirSync(out, { recursive: true });
    for (const c of cases) writeFileSync(join(out, `${c.id}.json`), JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
    log(`${cases.length} case(s) written to ${out} from ${call.cards.filter((c) => c.rating === "n").length} card(s) rated not useful.`);
    for (const r of refused) log(`  not written: card ${r.id} (${r.why.join(", ")})`);
    if (!call.cards.some((c) => c.rating === "n")) log('  No card is rated "not useful". Rate cards with: pnpm tag <call>');
    return 0;
  }
  const promptFile = get("--prompt");
  if (promptFile && !existsSync(promptFile)) return (log(`replay: no such prompt file ${promptFile}`), 2);
  const rules = promptFile ? readFileSync(promptFile, "utf8").trim() : MOMENT_RULES;
  const max = get("--max") === undefined ? 300 : Number(get("--max"));
  let registry = deps.registry;
  let basis = "policy fake (repeats the original call)";
  if (!registry) {
    const cf = get("--cassette");
    if (cf) {
      if (!existsSync(cf)) return (log(`replay: no such cassette ${cf}`), 2);
      const cassette = new Cassette(cf);
      registry = { resolve: async (ref, role) => wrapCassette({ mode: "replay", cassette, ref, role, timing: "instant" }) };
      basis = `cassette ${cf}`;
    } else registry = echoRegistry(call, rules);
  }
  const r = await replayCall(call, { registry, rules, max });
  const d = diffCards(call.cards, r.cards);
  if (argv.includes("--json")) log(JSON.stringify({ basis, ...r, diff: d }, null, 1));
  else {
    log(`Basis: ${basis}${promptFile ? `, prompt ${promptFile}` : ", current rules"}`);
    log(formatDiff(call, r, d, r.cards));
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2), { log: (l) => console.log(l) });
}
