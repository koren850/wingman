// Local, language-neutral bank scorer: BM25 over character 3-grams AND over word tokens of each card's title, triggers and say line (Hebrew and English text).
// Word tokens come from Intl.Segmenter. A glued Hebrew prefix letter is stripped only when the stripped form is a word the bank (or the call) really uses:
// the test is the vocabulary, not a word list. The 3-gram part keeps catching spelling noise; the word part adds the exact-word signal and the English side of a card.
// It runs after the exact trigger match (bank.ts) and before the model: a paraphrase such as "הדף הראשי לוקח נצח להיטען" shares no trigger
// with the "site-slow" card but shares many 3-grams with it. No word lists, no network, no globals: the index is built from the bank
// that is passed in (and remembered per bank object). The scorer proposes; it never overrides a stall-tier card (price, timeline, guarantee).
import { normalize, tokenVariants } from "./normalize.ts";
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

const segmenter = new Intl.Segmenter("und", { granularity: "word" });
/** Word tokens: letters and numbers only, normalized, single characters left out. */
export function wordTokens(text: string): string[] {
  const out: string[] = [];
  for (const s of segmenter.segment(text)) {
    if (!s.isWordLike) continue;
    for (const t of normalize(s.segment).split(" ")) if (t.length >= 2) out.push(t); // "25,000" is one segment and two tokens after normalize
  }
  return out;
}
/** The form of a token to index or look up: the longest prefix-stripped form that the vocabulary knows, else the token itself. */
export function stem(t: string, vocab: ReadonlySet<string>): string {
  const v = tokenVariants(t);
  for (let i = v.length - 1; i >= 1; i--) if (vocab.has(v[i])) return v[i];
  return t;
}
/** How much the word part counts against the 3-gram part, in score and in coverage. */
const WORD_W = 0.5;

type Doc = { card: BankCard; tf: Map<string, number>; len: number; wtf: Map<string, number>; wlen: number };
type Index = {
  docs: Doc[];
  idf: Map<string, number>;
  avg: number;
  maxIdf: number;
  n: number;
  widf: Map<string, number>;
  wavg: number;
  vocab: Set<string>;
};
const cache = new WeakMap<BankCard[], Index>();

function docText(c: BankCard): string {
  return [c.title, ...c.triggers, c.say, c.en?.say ?? ""].join(" ");
}

function build(bank: BankCard[]): Index {
  const df = new Map<string, number>();
  const wdf = new Map<string, number>();
  const vocab = new Set<string>();
  const raw: { card: BankCard; gs: string[]; ws: string[] }[] = [];
  for (const card of bank) {
    if (card.id === "stall") continue;
    const text = docText(card);
    const ws = wordTokens(text);
    for (const w of ws) vocab.add(w);
    raw.push({ card, gs: grams(text), ws });
  }
  const docs: Doc[] = [];
  for (const { card, gs, ws } of raw) {
    const tf = new Map<string, number>();
    for (const g of gs) tf.set(g, (tf.get(g) ?? 0) + 1);
    for (const g of tf.keys()) df.set(g, (df.get(g) ?? 0) + 1);
    const wtf = new Map<string, number>();
    for (const w of ws) {
      const k = stem(w, vocab);
      wtf.set(k, (wtf.get(k) ?? 0) + 1);
    }
    for (const w of wtf.keys()) wdf.set(w, (wdf.get(w) ?? 0) + 1);
    docs.push({ card, tf, len: gs.length, wtf, wlen: ws.length });
  }
  const n = docs.length;
  const idfOf = (m: Map<string, number>) => {
    const out = new Map<string, number>();
    for (const [g, d] of m) out.set(g, Math.log(1 + (n - d + 0.5) / (d + 0.5)));
    return out;
  };
  const avg = docs.reduce((s, d) => s + d.len, 0) / (n || 1);
  const wavg = docs.reduce((s, d) => s + d.wlen, 0) / (n || 1);
  return { docs, idf: idfOf(df), avg, maxIdf: Math.log(1 + (n + 0.5) / 1.5), n, widf: idfOf(wdf), wavg, vocab };
}

function indexFor(bank: BankCard[]): Index {
  const hit = cache.get(bank);
  if (hit && hit.n === bank.filter((c) => c.id !== "stall").length) return hit; // a card pushed onto the same array rebuilds the index
  const ix = build(bank);
  cache.set(bank, ix);
  return ix;
}

/** Optional extra vocabulary (words of the call memory, the roster, the notes): a prefix is stripped when the rest is one of these words too. */
export type ScoreOpts = { vocab?: Iterable<string> };

/** The best n cards for a question, best first. Cards with no shared 3-gram and no shared word are left out. */
export function topCandidates(question: string, n: number, bank: BankCard[], opts: ScoreOpts = {}): Candidate[] {
  const ix = indexFor(bank);
  const q = new Map<string, number>();
  for (const g of grams(question)) q.set(g, (q.get(g) ?? 0) + 1);
  if (!q.size || !ix.n) return [];
  let vocab: ReadonlySet<string> = ix.vocab;
  if (opts.vocab) vocab = new Set([...ix.vocab, ...[...opts.vocab].flatMap((w) => wordTokens(w))]);
  const qw = new Map<string, number>();
  for (const w of wordTokens(question)) {
    const k = stem(w, vocab);
    qw.set(k, (qw.get(k) ?? 0) + 1);
  }
  let total = 0;
  for (const g of q.keys()) total += ix.idf.get(g) ?? ix.maxIdf;
  let wtotal = 0;
  for (const w of qw.keys()) wtotal += ix.widf.get(w) ?? ix.maxIdf;
  const out: Candidate[] = [];
  for (const d of ix.docs) {
    let score = 0,
      covered = 0,
      wscore = 0,
      wcovered = 0;
    for (const g of q.keys()) {
      const f = d.tf.get(g);
      if (!f) continue;
      const w = ix.idf.get(g) ?? 0;
      score += (w * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / ix.avg));
      covered += w;
    }
    for (const t of qw.keys()) {
      const f = d.wtf.get(t);
      if (!f) continue;
      const w = ix.widf.get(t) ?? 0;
      wscore += (w * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.wlen) / (ix.wavg || 1)));
      wcovered += w;
    }
    const gcov = total ? covered / total : 0;
    const wcov = wtotal ? wcovered / wtotal : 0;
    // The word part can only help a candidate: coverage is the better of the 3-gram share and the blend of both.
    const coverage = Math.max(gcov, (1 - WORD_W) * gcov + WORD_W * wcov);
    const sc = score + WORD_W * wscore;
    if (sc > 0) out.push({ card: d.card, score: sc, coverage });
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
