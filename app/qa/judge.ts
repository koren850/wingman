// A second opinion on the cards, apart from the golden labels. Two parts:
//  1. rubricJudge: a deterministic rubric. For each card on screen: is it relevant (the tokens of the moment it serves, or words from the last lines),
//     is it in the language of the call, is it not a repeat of an earlier card, and is it inside the time window. No model, same answer every time.
//  2. ModelJudge: asks a model "is this card useful here". It replays the answer from a cassette file. It records new answers only when the owner
//     passes a transport (scripts/cassette-record.ts does that, never in CI). In replay a missing answer is a loud CassetteMiss, not a guess.
// Why both: the labels list the moments we thought of. The rubric catches a card that is late, in the wrong language, repeated or off topic. The model
// judge rates the cards the labels do not list (tips, open loops) with a usefulness verdict that can be stored and replayed.
import { Cassette, CassetteMiss, cassetteKey } from "../src/providers/cassette.ts";
import { hasAll, scriptLang, squash, type Golden, type Kind, type TimelineCard } from "./grade-golden.ts";

// ---------------------------------------------------------------- the rubric
export type RubricCheck = "relevant" | "language" | "fresh" | "window";
export type RubricVerdict = {
  /** index in the card list that was given in */
  card: number;
  /** the moment this card was judged against, when there is one */
  moment?: string;
  relevant: boolean;
  language: boolean;
  fresh: boolean;
  window: boolean;
  pass: boolean;
  reasons: string[];
};
export type RubricOpts = {
  /** A card this much after its moment's latestMs is late (default 1: not tolerated). The grader's "late" band is 2x. */
  lateFactor?: number;
  /** Cards with the same words within this window are a repeat (default 120 s). */
  repeatWindowMs?: number;
  /** Share of the words of an earlier card that makes a repeat (default 0.8). */
  repeatShare?: number;
  /** Words (4 letters or more) a card without a moment must share with the last lines before it (default 2). */
  overlapWords?: number;
};

/** Words of 4 letters or more; a Hebrew word of 5 letters or more loses one glued prefix letter, so "והמחיר" and "מחיר" meet. */
const stem = (w: string) => (/^[֐-׿]{5,}$/.test(w) && /^[והבלכמש]/.test(w) ? w.slice(1) : w);
const words = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).map(stem);
const share = (a: string, b: string) => {
  const A = new Set(words(a)),
    B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / Math.min(A.size, B.size);
};

/** Judges one card. `prior` are the cards before it (the repeat check), `kind` names what it is. */
export function rubricCard(g: Golden, cards: TimelineCard[], i: number, o: RubricOpts = {}): RubricVerdict {
  const c = cards[i];
  const lateFactor = o.lateFactor ?? 1,
    repeatWindow = o.repeatWindowMs ?? 120_000,
    repeatShare = o.repeatShare ?? 0.8,
    overlapWords = o.overlapWords ?? 2;
  const lineT = (id: string) => g.lines.find((l) => l.id === id)?.t ?? 0;
  // The moment this card serves: same kind, the newest one whose line is before the card and whose window (twice the latest, to see late cards) holds it.
  const candidates = g.moments
    .filter((m) => m.kind === c.kind && lineT(m.afterLine) <= c.atMs && c.atMs <= lineT(m.afterLine) + m.latestMs * 2)
    .sort((x, y) => lineT(y.afterLine) - lineT(x.afterLine));
  const served = candidates.find((m) => !m.mustMention?.length || hasAll(c.text, m.mustMention)) ?? candidates[0];
  const extra = served
    ? undefined
    : (g.allowedExtra ?? []).find(
        (x) => (!x.kind || x.kind === c.kind) && lineT(x.afterLine) <= c.atMs && c.atMs <= lineT(x.afterLine) + x.latestMs && hasAll(c.text, x.mustMention),
      );
  const before = g.lines.filter((l) => l.t <= c.atMs);
  const reasons: string[] = [];

  // 1. relevant
  let relevant: boolean;
  if (served?.mustMention?.length) relevant = hasAll(c.text, served.mustMention);
  else if (extra) relevant = hasAll(c.text, extra.mustMention);
  else {
    const recent = before
      .slice(-4)
      .map((l) => l.text)
      .join(" ");
    const mine = new Set(words(c.text));
    relevant = words(recent).filter((w, k, a) => a.indexOf(w) === k && mine.has(w)).length >= overlapWords;
  }
  if (!relevant)
    reasons.push(
      served?.mustMention?.length
        ? `missing: ${served.mustMention.filter((t) => !hasAll(c.text, [t])).join(", ")}`
        : "shares too few words with the last lines",
    );

  // 2. language of the call
  const refLine = served ? g.lines.find((l) => l.id === served.afterLine) : ([...before].reverse().find((l) => l.side === "them") ?? before.at(-1));
  const want = refLine && scriptLang(refLine.text),
    got = c.lang ?? scriptLang(c.text);
  const language = !want || !got || want === got;
  if (!language) reasons.push(`card is ${got}, the call is ${want}`);

  // 3. not a repeat
  const rep = cards
    .slice(0, i)
    .find((p) => c.atMs - p.atMs <= repeatWindow && c.atMs >= p.atMs && (squash(p.text) === squash(c.text) || share(p.text, c.text) >= repeatShare));
  const fresh = !rep;
  if (rep) reasons.push("repeats an earlier card");

  // 4. time window
  let window = true;
  if (served) {
    window = c.atMs <= lineT(served.afterLine) + served.latestMs * lateFactor;
    if (!window) reasons.push(`late by ${c.atMs - lineT(served.afterLine) - served.latestMs} ms`);
  } else {
    const inSilent = g.silent.some((s) => {
      const a = g.lines.findIndex((l) => l.id === s.fromLine),
        b = g.lines.findIndex((l) => l.id === s.toLine);
      return c.atMs >= g.lines[a].t && c.atMs < (g.lines[b + 1]?.t ?? g.lines[b].t + 3000);
    });
    window = !inSilent && !!before.length;
    if (!window) reasons.push(inSilent ? "inside a silent window" : "before the first line");
  }
  return { card: i, ...(served ? { moment: served.id } : {}), relevant, language, fresh, window, pass: relevant && language && fresh && window, reasons };
}

export type RubricSummary = { cards: number; pass: number; rate: number; failed: Record<RubricCheck, number> };
export function rubricJudge(g: Golden, cardsIn: TimelineCard[], o: RubricOpts = {}): { verdicts: RubricVerdict[]; summary: RubricSummary } {
  const cards = [...cardsIn].sort((a, b) => a.atMs - b.atMs);
  const verdicts = cards.map((_, i) => rubricCard(g, cards, i, o));
  const failed = { relevant: 0, language: 0, fresh: 0, window: 0 };
  for (const v of verdicts) for (const k of Object.keys(failed) as RubricCheck[]) if (!v[k]) failed[k]++;
  const pass = verdicts.filter((v) => v.pass).length;
  return { verdicts, summary: { cards: cards.length, pass, rate: cards.length ? pass / cards.length : 1, failed } };
}
export function poolRubric(xs: RubricSummary[]): RubricSummary {
  const failed = { relevant: 0, language: 0, fresh: 0, window: 0 };
  let cards = 0,
    pass = 0;
  for (const s of xs) {
    cards += s.cards;
    pass += s.pass;
    for (const k of Object.keys(failed) as RubricCheck[]) failed[k] += s.failed[k];
  }
  return { cards, pass, rate: cards ? pass / cards : 1, failed };
}

// ---------------------------------------------------------------- the model judge
export type JudgeTransport = (req: { model: string; system: string; user: string }) => Promise<{ text: string; usage?: unknown; ms?: number }>;
export type ModelVerdict = { good: boolean; reason: string; source: "replay" | "recorded"; key: string };
export const JUDGE_MODEL = "anthropic:claude-haiku-5-5";
export const JUDGE_SYSTEM = [
  "You judge one card that a live meeting assistant showed to the user.",
  "You get the last lines of the call and the card. Decide if the card was useful at that moment.",
  "A useful card is relevant to what was just said, correct, short, in the language of the call, and not a repeat.",
  "Answer in exactly two lines:",
  "VERDICT: good or bad",
  "REASON: one short sentence",
].join("\n");

/** The text a judge sees: the last `n` lines before the card, then the card. Deterministic, so the cassette key is stable. */
export function judgePrompt(g: Golden, c: TimelineCard, n = 6): { system: string; user: string } {
  const lines = g.lines.filter((l) => l.t <= c.atMs).slice(-n);
  const user = [`Last lines of the call:`, ...lines.map((l) => `${l.side === "me" ? "User" : "Other"}: ${l.text}`), ``, `Card (${c.kind}): ${c.text}`].join(
    "\n",
  );
  return { system: JUDGE_SYSTEM, user };
}
export const judgeKey = (model: string, p: { system: string; user: string }) =>
  cassetteKey({ role: "judge", model, system: p.system, messages: [p.user], options: {} as never });

/** Parses "VERDICT: good|bad" and "REASON: ..." (any case). An unreadable answer counts as bad, with the reason saying so. */
export function parseVerdict(text: string): { good: boolean; reason: string } {
  const v = /^\s*VERDICT:\s*(good|bad)\b/im.exec(text)?.[1]?.toLowerCase();
  const reason = /^\s*REASON:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? "";
  return v ? { good: v === "good", reason } : { good: false, reason: `unreadable judge answer: ${text.slice(0, 60)}` };
}

export class ModelJudge {
  constructor(
    private o: {
      cassette: Cassette;
      model?: string;
      /** Only the owner's record command passes this. Without it a miss throws CassetteMiss. */
      transport?: JudgeTransport;
    },
  ) {}
  get model() {
    return this.o.model ?? JUDGE_MODEL;
  }
  async judge(g: Golden, c: TimelineCard): Promise<ModelVerdict> {
    const p = judgePrompt(g, c),
      key = judgeKey(this.model, p);
    const hit = this.o.cassette.get(key);
    if (hit) return { ...parseVerdict(hit.chunks.map((x) => x.text).join("")), source: hit.source === "recorded" ? "recorded" : "replay", key };
    if (!this.o.transport) {
      throw new CassetteMiss(
        `Cassette miss: role=judge model=${this.model} key=${key}. Record it with scripts/cassette-record.ts (needs a key), or author the entry.`,
        key,
      );
    }
    const t0 = Date.now();
    const r = await this.o.transport({ model: this.model, ...p });
    const ms = r.ms ?? Date.now() - t0;
    this.o.cassette.put({
      key,
      role: "judge",
      model: this.model,
      source: "recorded",
      request: { system: p.system, messages: [p.user], options: {} },
      chunks: [{ at: ms, text: r.text }],
      finish: { unified: "stop" },
      usage: r.usage ?? null,
      ms,
    });
    return { ...parseVerdict(r.text), source: "recorded", key };
  }
  /** Judges every card of a list. Cards are judged one after the other, so the cassette order is stable. */
  async judgeAll(g: Golden, cards: TimelineCard[]): Promise<ModelVerdict[]> {
    const out: ModelVerdict[] = [];
    for (const c of [...cards].sort((a, b) => a.atMs - b.atMs)) out.push(await this.judge(g, c));
    return out;
  }
}
export type { Kind };
