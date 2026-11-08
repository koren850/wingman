// Local BM25 retrieval (src/context/retrieve.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { buildIndex, chunkText, indexFiles, search, tokenize } from "./context/retrieve.ts";
import { estimateTokens, RETRIEVE } from "./context/budget.ts";

function rng(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  };
}
const SYL = ["ba", "ko", "ri", "ta", "mu", "len", "sor", "vi", "dan", "pek", "lor", "nit", "gra", "zu"];
/** About `bytes` of invented filler text: paragraphs of made-up words. */
function filler(bytes: number, seed = 7): string {
  const r = rng(seed);
  const vocab = ["the", "and", "of", "to", "on", "in"].concat(
    Array.from({ length: 400 }, () => Array.from({ length: 2 + Math.floor(r() * 2) }, () => SYL[Math.floor(r() * SYL.length)]).join("")),
  );
  const paras: string[] = [];
  let n = 0;
  while (n < bytes) {
    const p = Array.from({ length: 60 + Math.floor(r() * 60) }, () => vocab[Math.floor(r() * vocab.length)]).join(" ") + ".";
    paras.push(p);
    n += p.length + 2;
  }
  return paras.join("\n\n");
}

test("tokenize: English, Hebrew with niqqud and prefixes, numbers", () => {
  assert.deepEqual(tokenize("Quotes for 12,000 units"), ["quotes", "quote", "for", "12,000", "12000", "units", "unit"]);
  const he = tokenize("בנמל-גל");
  assert.ok(he.includes("בנמל-גל") && he.includes("נמל-גל"));
  assert.ok(tokenize("שָׁלוֹם").includes("שלום"));
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("   ...  "), []);
});

test("chunkText: chunks stay under 500 tokens and keep all the text", () => {
  const text = filler(30_000);
  const chunks = chunkText(text);
  assert.ok(chunks.length > 5);
  for (const c of chunks) assert.ok(estimateTokens(c) <= RETRIEVE.chunkTokens, "chunk " + estimateTokens(c));
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  assert.equal(
    chunks.reduce((n, c) => n + words(c), 0),
    words(text),
  );
  // one huge line with no break still gets cut
  const one = chunkText("word ".repeat(5000));
  assert.ok(one.length > 3);
  for (const c of one) assert.ok(estimateTokens(c) <= RETRIEVE.chunkTokens);
  assert.deepEqual(chunkText(""), []);
});

test("BM25 finds a fact buried in a 100 KB file", () => {
  const needle = "The Rivermouth warehouse closes on the fourteenth of March for the yearly inventory count.";
  const parts = filler(100_000).split("\n\n");
  parts.splice(Math.floor(parts.length * 0.6), 0, needle);
  const text = parts.join("\n\n");
  assert.ok(text.length > 100_000);
  const ix = indexFiles([{ source: "notes.txt", text }]);
  assert.ok(ix.chunks.length > 30);
  const hits = search(ix, "when does the Rivermouth warehouse close for inventory?");
  assert.ok(hits.length >= 1);
  assert.ok(hits[0].chunk.text.includes("Rivermouth warehouse"), "best hit holds the fact");
  assert.equal(hits[0].chunk.source, "notes.txt");
  assert.ok(hits.length <= RETRIEVE.topChunks);
  assert.ok(hits.reduce((n, h) => n + estimateTokens(h.chunk.text), 0) <= RETRIEVE.maxTokens);
});

test("BM25 ignores an unrelated turn", () => {
  const text = filler(100_000) + "\n\nThe Rivermouth warehouse closes on the fourteenth of March.";
  const ix = indexFiles([{ text }]);
  for (const q of ["ok sounds good, let's move on to the next point", "thanks everyone, see you tomorrow", "can you hear me now?", "", "   "])
    assert.deepEqual(search(ix, q), [], q);
});

test("BM25 finds Hebrew text through a one-letter prefix", () => {
  const text = filler(20_000) + "\n\nמחסן נמל-גל ייסגר בארבעה עשר במרץ לצורך ספירת מלאי.";
  const ix = indexFiles([{ text }]);
  const hits = search(ix, "מה קורה עם המחסן בנמל-גל");
  assert.ok(hits.length >= 1 && hits[0].chunk.text.includes("ספירת מלאי"));
});

test("search is deterministic and respects topK and the token cap", () => {
  const chunks = Array.from({ length: 10 }, (_, i) => ({ id: String(i), text: `shared topic words appear here with unique${i} ` + "padding ".repeat(30) }));
  const ix = buildIndex([...chunks, ...Array.from({ length: 30 }, (_, i) => ({ id: "x" + i, text: filler(2000, i) }))]);
  const a = search(ix, "shared topic words", { minScore: 0.1 });
  const b = search(ix, "shared topic words", { minScore: 0.1 });
  assert.deepEqual(a, b);
  assert.equal(a.length, 3);
  assert.ok(a.reduce((n, h) => n + estimateTokens(h.chunk.text), 0) <= 600);
  assert.equal(search(ix, "shared topic words", { topK: 1, minScore: 0.1 }).length, 1);
});

test("an empty index returns nothing", () => {
  assert.deepEqual(search(buildIndex([]), "anything"), []);
  assert.deepEqual(search(indexFiles([{ text: "" }]), "anything"), []);
});
