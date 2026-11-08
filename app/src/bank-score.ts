// Local, language-neutral bank scorer: BM25 over character 3-grams of each card's title, triggers and say line (Hebrew and English text).
// It runs after the exact trigger match (bank.ts) and before the model: a paraphrase such as "הדף הראשי לוקח נצח להיטען" shares no trigger
// with the "site-slow" card but shares many 3-grams with it. No word lists, no network, no globals: the index is built from the bank
// that is passed in (and remembered per bank object). The scorer proposes; it never overrides a stall-tier card (price, timeline, guarantee).
import { normalize } from "./normalize.ts";
import type { BankCard } from "./bank.ts";

export type Candidate = { card: BankCard; score: number; coverage: number };
export type ScoredHit = { card: BankCard; score: number; coverage: number; margin: number };

const K1 = 1.2,
  B = 0.75;
/** A scorer hit needs this share of the question's (idf weighted) 3-grams inside one card, and this lead over the next card. Tuned on bank-cases.ts. */
export const MIN_COVERAGE = 0.42;
export const MIN_MARGIN = 1.5;
const MIN_QUERY_GRAMS = 6;

/** Padded 3-grams of every token: "^לט", "לטע", ..., "אה$". Short tokens (1 char) give no gram. */
export function grams(text: string): string[] {
  const out: string[] = [];
  for (const tok of normalize(text).split(" ")) {
    if (tok.length < 2) continue;
    const p = `^${tok}$`;
    for (let i = 0; i + 3 <= p.length; i++) out.push(p.slice(i, i + 3));
  }
  return out;
}

type Doc = { card: BankCard; tf: Map<string, number>; len: number };
type Index = { docs: Doc[]; idf: Map<string, number>; avg: number; maxIdf: number; n: number };
const cache = new WeakMap<BankCard[], Index>();

function docText(c: BankCard): string {
  return [c.title, ...c.triggers, c.say, c.en?.say ?? ""].join(" ");
}

function build(bank: BankCard[]): Index {
  const docs: Doc[] = [];
  const df = new Map<string, number>();
  for (const card of bank) {
    if (card.id === "stall") continue;
    const tf = new Map<string, number>();
    const gs = grams(docText(card));
    for (const g of gs) tf.set(g, (tf.get(g) ?? 0) + 1);
    for (const g of tf.keys()) df.set(g, (df.get(g) ?? 0) + 1);
    docs.push({ card, tf, len: gs.length });
  }
  const n = docs.length;
  const idf = new Map<string, number>();
  for (const [g, d] of df) idf.set(g, Math.log(1 + (n - d + 0.5) / (d + 0.5)));
  const avg = docs.reduce((s, d) => s + d.len, 0) / (n || 1);
  return { docs, idf, avg, maxIdf: Math.log(1 + (n + 0.5) / 1.5), n };
}

function indexFor(bank: BankCard[]): Index {
  const hit = cache.get(bank);
  if (hit && hit.n === bank.filter((c) => c.id !== "stall").length) return hit; // a card pushed onto the same array rebuilds the index
  const ix = build(bank);
  cache.set(bank, ix);
  return ix;
}

/** The best n cards for a question, best first. Cards with no shared 3-gram are left out. */
export function topCandidates(question: string, n: number, bank: BankCard[]): Candidate[] {
  const ix = indexFor(bank);
  const q = new Map<string, number>();
  for (const g of grams(question)) q.set(g, (q.get(g) ?? 0) + 1);
  if (!q.size || !ix.n) return [];
  let total = 0;
  for (const g of q.keys()) total += ix.idf.get(g) ?? ix.maxIdf;
  const out: Candidate[] = [];
  for (const d of ix.docs) {
    let score = 0,
      covered = 0;
    for (const g of q.keys()) {
      const f = d.tf.get(g);
      if (!f) continue;
      const w = ix.idf.get(g) ?? 0;
      score += (w * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / ix.avg));
      covered += w;
    }
    if (score > 0) out.push({ card: d.card, score, coverage: total ? covered / total : 0 });
  }
  out.sort((a, b) => b.score - a.score || b.coverage - a.coverage);
  return out.slice(0, Math.max(0, n));
}

/**
 * A confident scorer hit, or undefined (then the model gets the top 3 as candidates). Stall-tier cards never come from the scorer:
 * a price, timeline or guarantee needs an exact trigger. Short questions never score (too few 3-grams to mean anything).
 */
export function scoreBank(question: string, bank: BankCard[], stallTier: ReadonlySet<string>): ScoredHit | undefined {
  if (grams(question).length < MIN_QUERY_GRAMS) return undefined;
  const top = topCandidates(question, 2, bank);
  const [a, b] = top;
  if (!a || stallTier.has(a.card.id)) return undefined;
  const margin = b ? a.score / b.score : Infinity;
  if (a.coverage < MIN_COVERAGE || margin < MIN_MARGIN) return undefined;
  return { card: a.card, score: a.score, coverage: a.coverage, margin };
}
