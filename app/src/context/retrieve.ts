// Local BM25 search over background text (files the user gave). No dependency, no network, no model.
//   - Tokens come from Intl.Segmenter, so Hebrew, English and mixed text work. Hebrew one-letter prefixes (ה ו ב כ ל מ ש) also match the bare word.
//   - A file is cut into chunks of about 500 tokens. A search returns at most 3 chunks and 600 tokens, and only chunks above a score threshold:
//     a turn about something else returns nothing, so unrelated text never reaches a prompt.
import { estimateTokens, RETRIEVE, truncateToTokens } from "./budget.ts";

export type Chunk = { id: string; text: string; source?: string };
export type Hit = { chunk: Chunk; score: number; matched: number };
export type Bm25Index = {
  chunks: Chunk[];
  tf: Map<string, number>[]; // per chunk: term -> count
  len: number[];
  avg: number;
  df: Map<string, number>;
};

const seg = new Intl.Segmenter("und", { granularity: "word" });
const NIQQUD = /[֑-ׇ]/g;
const HEB_PREFIX = "והבכלמש";
const isHeb = (s: string) => /^[א-ת]+$/.test(s);

/** Function words that carry no topic. Used only when reading a QUERY for retrieval (it can never hide or block a card). Small on purpose. */
const STOP = new Set(
  (
    "a an the and or but if so to of in on at by for with from as is are was were be been it its this that these those i you he she we they me my your our their " +
    "do does did not no yes ok okay can will would should could have has had just about there here what when where who how why " +
    "אני אתה את הוא היא אנחנו הם הן של על עם אל מן או אם כי לא כן גם זה זו זאת אלה יש אין היה היו הוא מה מי למה איך מתי איפה כמה אבל רק עוד"
  ).split(" "),
);

/** Lower-case word tokens, plus light variants (Hebrew prefix removed, English plural "s" removed, numbers without separators). */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const t = String(text).normalize("NFKC").replace(NIQQUD, "").toLowerCase();
  for (const s of seg.segment(t)) {
    if (!s.isWordLike) continue;
    const w = s.segment;
    out.push(w);
    if (/^\d[\d.,]*\d$/.test(w)) {
      const plain = w.replace(/[.,]/g, "");
      if (plain !== w) out.push(plain);
    } else if (isHeb(w) && w.length >= 4 && HEB_PREFIX.includes(w[0])) {
      out.push(w.slice(1));
      if (w.length >= 5 && HEB_PREFIX.includes(w[1])) out.push(w.slice(2));
    } else if (/^[a-z]{4,}s$/.test(w) && !w.endsWith("ss")) out.push(w.slice(0, -1));
  }
  return out;
}

/** Cuts text into chunks of at most `chunkTokens` (estimated). Paragraphs stay whole when they can; a long paragraph is cut at sentence ends or by size. */
export function chunkText(text: string, chunkTokens: number = RETRIEVE.chunkTokens): string[] {
  const out: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  const pieces: string[] = [];
  for (const para of String(text).split(/\n\s*\n/)) {
    if (estimateTokens(para) <= chunkTokens) {
      pieces.push(para);
      continue;
    }
    // sentence-ish split, then a size split for anything still too long
    for (const sent of para.split(/(?<=[.!?׃\n])\s+/)) {
      let rest = sent;
      while (estimateTokens(rest) > chunkTokens) {
        const head = truncateToTokens(rest, chunkTokens) || rest.slice(0, 100);
        pieces.push(head);
        rest = rest.slice(head.length).trimStart();
      }
      if (rest) pieces.push(rest);
    }
  }
  for (const p of pieces) {
    if (cur && estimateTokens(cur + "\n\n" + p) > chunkTokens) flush();
    cur = cur ? cur + "\n\n" + p : p;
  }
  flush();
  return out;
}

export function buildIndex(chunks: Chunk[]): Bm25Index {
  const tf: Map<string, number>[] = [];
  const len: number[] = [];
  const df = new Map<string, number>();
  for (const c of chunks) {
    const m = new Map<string, number>();
    const toks = tokenize(c.text);
    for (const w of toks) m.set(w, (m.get(w) ?? 0) + 1);
    for (const w of m.keys()) df.set(w, (df.get(w) ?? 0) + 1);
    tf.push(m);
    len.push(toks.length);
  }
  const avg = len.length ? len.reduce((a, b) => a + b, 0) / len.length : 0;
  return { chunks, tf, len, avg, df };
}

const K1 = 1.2,
  B = 0.75;

export type SearchOpts = { topK?: number; maxTokens?: number; minScore?: number };

/** The best chunks for a query, best first. Empty when nothing is above the threshold. */
export function search(ix: Bm25Index, query: string, o: SearchOpts = {}): Hit[] {
  const N = ix.chunks.length;
  if (!N || !ix.avg) return [];
  const topK = o.topK ?? RETRIEVE.topChunks,
    maxTokens = o.maxTokens ?? RETRIEVE.maxTokens;
  // a tiny corpus cannot reach the same absolute score: scale the threshold down
  const minScore = (o.minScore ?? RETRIEVE.minScore) * Math.min(1, Math.log(N + 2) / Math.log(12));
  const terms = [...new Set(tokenize(query))].filter((t) => !STOP.has(t) && (t.length > 1 || /\d/.test(t)) && (N < 4 || (ix.df.get(t) ?? 0) / N <= 0.5));
  if (!terms.length) return [];
  const hits: Hit[] = [];
  for (let i = 0; i < N; i++) {
    let score = 0,
      matched = 0;
    for (const t of terms) {
      const f = ix.tf[i].get(t);
      if (!f) continue;
      const n = ix.df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * ix.len[i]) / ix.avg));
      matched++;
    }
    // one shared word is weak evidence when the query has several words: it must be a strong one
    const strong = score >= minScore * (terms.length >= 3 && matched < 2 ? 2 : 1);
    if (matched && strong) hits.push({ chunk: ix.chunks[i], score, matched });
  }
  hits.sort((a, b) => b.score - a.score || (a.chunk.id < b.chunk.id ? -1 : 1));
  const out: Hit[] = [];
  let left = maxTokens;
  for (const h of hits) {
    if (out.length >= topK || left < 40) break;
    const text = truncateToTokens(h.chunk.text, left);
    if (!text) break;
    left -= estimateTokens(text);
    out.push({ ...h, chunk: { ...h.chunk, text } });
  }
  return out;
}

/** Splits long background files into indexed chunks. `files` is [{source, text}]. */
export function indexFiles(files: { source?: string; text: string }[], chunkTokens: number = RETRIEVE.chunkTokens): Bm25Index {
  const chunks: Chunk[] = [];
  files.forEach((f, fi) => chunkText(f.text, chunkTokens).forEach((t, ci) => chunks.push({ id: `${fi + 1}.${ci + 1}`, text: t, source: f.source })));
  return buildIndex(chunks);
}
