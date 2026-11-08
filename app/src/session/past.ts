// Search of finished calls: "what did we agree with Dana about the backup?" asked in a later call or from the command line.
//   collectPast(callsDir)        the saved summaries and facts of finished calls as small documents (one line each, with the call date and where it came from)
//   searchPast(docs, question)   BM25 (the same local index as the background files), best 3 lines, each with call date and source
//   answerPast(hits, labels)     a plain answer from those lines, labelled "AI offline: from notes". No model call, no network.
//   askPast(callsDir, question)  the three above in one call. Never throws.
// Everything read here is the user's own saved text. It stays on this Mac. A line is shown as it was saved; nothing is added to it.
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildIndex, search } from "../context/retrieve.ts";
import { cleanText } from "./patch.ts";
import { isForgotten, readIndex } from "./people.ts";
import { loadMemory } from "./store.ts";
import { numbersGrounded } from "./ask.ts";

export type PastSource = "summary" | "decision" | "promise" | "fact" | "topic";
export type PastDoc = {
  callId: string;
  /** end of the call (epoch ms) */
  at: number;
  source: PastSource;
  text: string;
  /** names of the other side on that call's roster */
  people: string[];
  /** the topic of that call */
  topic: string;
  /** topic, names and roles of that call: what a company or topic word is matched against (not shown) */
  head: string;
};
export type PastHit = PastDoc & { score: number };

const MAX_CALLS = 200;
const MAX_FILE = 600_000;
const MAX_DOCS_PER_CALL = 60;
const LINE_MAX = 220;

const readJson = (f: string): unknown => {
  try {
    if (!existsSync(f) || lstatSync(f).size > MAX_FILE) return undefined;
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return undefined;
  }
};
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap((x) => (typeof x === "string" ? [x] : [])) : []);

/** The lines of one finished call: its summary, decisions, open promises, facts from the call and the user, and the topic. Never throws. */
export function docsOfCall(dir: string, callId: string, at: number): PastDoc[] {
  const out: PastDoc[] = [];
  let people: string[] = [],
    topic = "",
    head = "";
  const add = (source: PastSource, t: unknown) => {
    const text = cleanText(t, LINE_MAX);
    if (text && out.length < MAX_DOCS_PER_CALL && !out.some((d) => d.text === text)) out.push({ callId, at, source, text, people, topic, head });
  };
  try {
    const mem = loadMemory(dir, at).mem;
    people = mem.roster.filter((p) => p.side !== "me").map((p) => p.name);
    topic = cleanText(mem.topic.now || mem.topic.history.at(-1)?.label, 120) ?? "";
    head = [topic, ...mem.roster.filter((p) => p.side !== "me").flatMap((p) => [p.name, p.role ?? ""])].join(" ");
    // text that came from the other side's brief or from an earlier call is not something this call said
    for (const f of mem.facts) if (f.src === "call" || f.src === "user") add("fact", f.text);
    for (const d of mem.decisions) add("decision", d.text);
    for (const c of mem.commitments) add("promise", `${c.who}: ${c.what}${c.due ? ` (${c.due})` : ""}`);
    for (const n of mem.numbers) add("fact", `${n.what}: ${n.value}`);
    if (mem.summary) add("summary", mem.summary);
  } catch {
    /* a call without a memory still may have a summary */
  }
  const s = readJson(join(dir, "summary.json")) as { summary?: unknown; decisions?: unknown; nextSteps?: unknown } | undefined;
  if (s && typeof s === "object") {
    for (const t of strs(s.summary)) add("summary", t);
    for (const t of strs(s.decisions)) add("decision", t);
    if (Array.isArray(s.nextSteps))
      for (const n of s.nextSteps as { who?: unknown; what?: unknown }[])
        if (n && typeof n.what === "string") add("promise", `${typeof n.who === "string" ? n.who + ": " : ""}${n.what}`);
  }
  if (topic) add("topic", topic);
  return out;
}

/** Finished live calls, newest first, at most 200. `skipId` is a call that is running. A call needs `endedAt` in call.json. */
export function collectPast(callsDir: string, o: { skipId?: string; max?: number; peopleFile?: string } = {}): PastDoc[] {
  const blocked = o.peopleFile ? readIndex(o.peopleFile).blocked : undefined;
  let ids: string[] = [];
  try {
    ids = readdirSync(callsDir).filter((n) => n !== "latest" && n !== o.skipId);
  } catch {
    return [];
  }
  const out: PastDoc[] = [];
  for (const id of ids.sort().reverse().slice(0, MAX_CALLS)) {
    const dir = join(callsDir, id);
    try {
      if (!lstatSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const meta = readJson(join(dir, "call.json")) as { mode?: string; endedAt?: string; startedAt?: string } | undefined;
    if (!meta || meta.mode !== "live" || !meta.endedAt) continue;
    const at = Date.parse(meta.endedAt) || Date.parse(meta.startedAt ?? "") || 0;
    if (!at) continue;
    out.push(...docsOfCall(dir, id, at).filter((d) => !isForgotten(blocked, id, d.people))); // what the user deleted from the list is not searched
    if (out.length > (o.max ?? 4000)) break;
  }
  return out;
}

/**
 * The best lines for the question, best first, at most `topK` (default 3), one line once. Two searches run (BM25, the same local index as the background files):
 * over the lines themselves (summary, decision, promise, fact), and over each call's topic, names and roles, so "what did we decide with Levi Studio?" finds the call
 * even when no line says the company's name. A call that matches that way brings its topic and up to two decisions or promises.
 */
export function searchPast(docs: PastDoc[], question: string, o: { topK?: number } = {}): PastHit[] {
  if (!docs.length || !question.trim()) return [];
  const topK = o.topK ?? 3;
  const lineDocs = docs.filter((d) => d.source !== "topic");
  const scored = new Map<PastDoc, number>();
  if (lineDocs.length) {
    const ix = buildIndex(lineDocs.map((d, i) => ({ id: String(i), text: d.text })));
    for (const h of search(ix, question, { topK: 12, maxTokens: 100_000, minScore: 1 })) scored.set(lineDocs[Number(h.chunk.id)], h.score);
  }
  const callIds = [...new Set(docs.map((d) => d.callId))];
  const firstOf = (id: string) => docs.find((d) => d.callId === id) as PastDoc;
  const hix = buildIndex(callIds.map((id) => ({ id, text: firstOf(id).head })));
  for (const h of search(hix, question, { topK: 3, maxTokens: 100_000, minScore: 1 })) {
    const mine = docs.filter((d) => d.callId === h.chunk.id);
    const head = mine.find((d) => d.source === "topic") ?? {
      ...firstOf(h.chunk.id),
      source: "topic" as const,
      text: firstOf(h.chunk.id).topic || firstOf(h.chunk.id).people.join(", "),
    };
    if (head.text) scored.set(head, Math.max(scored.get(head) ?? 0, h.score));
    for (const d of mine.filter((x) => x.source === "decision" || x.source === "promise").slice(0, 2))
      scored.set(d, Math.max(scored.get(d) ?? 0, h.score * 0.9));
  }
  const out: PastHit[] = [];
  const seen = new Set<string>();
  for (const [d, score] of [...scored.entries()].sort((a, b) => b[1] - a[1] || b[0].at - a[0].at)) {
    if (seen.has(d.text)) continue;
    seen.add(d.text);
    out.push({ ...d, score: Math.round(score * 100) / 100 });
    if (out.length >= topK) break;
  }
  return out;
}

export type PastLabels = { offline: string; nothing: string; sources: Record<PastSource, string>; date: (at: number) => string };
export const PAST_LABELS_EN: PastLabels = {
  offline: "AI offline: from notes",
  nothing: "Nothing found in your finished calls.",
  sources: { summary: "summary", decision: "decision", promise: "promise", fact: "fact", topic: "topic" },
  date: (at) => new Date(at).toISOString().slice(0, 10),
};

/** One line of the answer: the saved text, then (call date, where it came from). */
export const citeLine = (h: PastHit, l: PastLabels = PAST_LABELS_EN): string => `${h.text} (${l.date(h.at)}, ${l.sources[h.source]})`;

/** The plain answer from the top lines, with the label that says no AI wrote it. */
export function answerPast(hits: PastHit[], l: PastLabels = PAST_LABELS_EN): { text: string; found: boolean } {
  if (!hits.length) return { text: l.nothing, found: false };
  return { text: `${l.offline}: ${hits.map((h) => citeLine(h, l)).join(" | ")}`, found: true };
}

/** What a model may write for a past answer: it must keep the numbers of the saved lines (nothing new). Returns the text or undefined. */
export function guardPastAnswer(model: string, hits: PastHit[]): string | undefined {
  const t = model.trim();
  if (!t || !numbersGrounded(t, hits.map((h) => h.text).join(" "))) return undefined;
  return t;
}

export type PastAnswer = { ok: true; question: string; found: boolean; text: string; ai: boolean; offline: boolean; hits: PastHit[] };
/** Search the finished calls and answer from the best lines. `synthesize` (optional) is a model that writes the answer from those lines; the answer is used only when its numbers are in them. */
export async function askPast(
  callsDir: string,
  question: string,
  o: {
    skipId?: string;
    peopleFile?: string;
    labels?: PastLabels;
    synthesize?: (hits: PastHit[], question: string) => Promise<string | undefined>;
    docs?: PastDoc[];
  } = {},
): Promise<PastAnswer> {
  const q = cleanText(question, 400) ?? "";
  const labels = o.labels ?? PAST_LABELS_EN;
  try {
    const hits = q
      ? searchPast(o.docs ?? collectPast(callsDir, { ...(o.skipId ? { skipId: o.skipId } : {}), ...(o.peopleFile ? { peopleFile: o.peopleFile } : {}) }), q)
      : [];
    if (hits.length && o.synthesize) {
      try {
        const made = await o.synthesize(hits, q);
        const ok = made ? guardPastAnswer(made, hits) : undefined;
        if (ok)
          return {
            ok: true,
            question: q,
            found: true,
            text: `${ok} | ${hits.map((h) => `${labels.date(h.at)} ${labels.sources[h.source]}`).join(", ")}`,
            ai: true,
            offline: false,
            hits,
          };
      } catch {
        /* the model is down: fall through to the notes */
      }
    }
    const a = answerPast(hits, labels);
    return { ok: true, question: q, found: a.found, text: a.text, ai: false, offline: a.found, hits };
  } catch {
    return { ok: true, question: q, found: false, text: labels.nothing, ai: false, offline: false, hits: [] };
  }
}
