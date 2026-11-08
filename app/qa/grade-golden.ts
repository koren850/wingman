// Grader for the golden meetings (PLAN 3.4). Pure: a golden meeting plus a card timeline in, metrics out. It imports no engine code,
// so the same grader scores the legacy engine, the v2 engine, a recorded cassette run and the two negative controls.
//
// A card timeline is a list of { atMs, kind, text } with atMs measured from the start of the meeting (virtual time is fine).
// A moment is "recalled" when a card of the same kind shows within [line.t, line.t + latestMs] and its text holds every `mustMention` token.
//   - right kind, in time, tokens missing  -> wrong text (the moment is not recalled; counts in the wrong-card rate)
//   - right kind, after latestMs (up to 2x) -> late (not recalled)
//   - a card that matches no moment         -> extra (lowers precision; inside a silent window it is a silent breach)
//   - a second card with the same text/ref close to an earlier one, or a second card for an already served moment -> duplicate
import type { Golden, Kind } from "./golden-schema.ts";
export type { Golden, Kind } from "./golden-schema.ts";
import { KINDS } from "./golden-schema.ts";

export type TimelineCard = { atMs: number; kind: Kind; text: string; lang?: "he" | "en"; ref?: string };
export type GradeOpts = {
  /** True when the text breaks a guard (price, date, promise). The caller passes the engine guard in; the grader does not import it. */
  guard?: (text: string) => boolean;
  /** Kinds the guard applies to: the lines the user may say out loud. Default answer and prompt (a check or fact card quotes the call). */
  guardKinds?: Kind[];
  /** A card up to this many times latestMs late is "late" (a miss that is still explained). Default 2. */
  lateFactor?: number;
  /** Two cards with the same text/ref inside this window are duplicates. Default 120 s. */
  dupWindowMs?: number;
};
export type MomentResult = { id: string; kind: Kind; status: "hit" | "miss" | "late" | "wrong-text"; ttcMs?: number; card?: number };
export type KindStats = { moments: number; hits: number; cards: number; correct: number; recall: number; precision: number };
export type GoldenGrade = {
  id: string;
  moments: number;
  cards: number;
  hits: number;
  recall: number; // 0..1
  precision: number; // 0..1 (correct cards / all cards); 1 when there are no cards
  byKind: Record<Kind, KindStats>;
  directMoments: number;
  directRecall: number;
  ttcP50: number | null; // ms from the line to the card, over recalled moments
  ttcP95: number | null;
  silentMinutes: number;
  silentCards: number;
  silentCpm: number; // cards per minute inside silent windows
  wrongCards: number;
  wrongCardRate: number; // wrong-text cards / cards that were in time for a moment
  duplicates: number;
  duplicateRate: number;
  wrongLang: number;
  langKnown: number;
  wrongLangRate: number;
  guardBreaches: number;
  results: MomentResult[];
};

// ---- text helpers
/** Lowercase letters and digits only: "$4,000" -> "4000", "Next week" -> "nextweek", Hebrew points and quotes dropped. */
export const squash = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
export const hasAll = (text: string, tokens: string[] = []) => {
  const t = squash(text);
  return tokens.every((k) => t.includes(squash(k)));
};
/** "he" when the text is mostly Hebrew letters (English terms inside Hebrew are fine), "en" for Latin text, undefined for too little text. */
export function scriptLang(s: string): "he" | "en" | undefined {
  const h = (s.match(/[֐-׿]/g) ?? []).length,
    l = (s.match(/[A-Za-z]/g) ?? []).length;
  if (h + l < 3) return undefined;
  return h >= 2 && h * 3 >= l ? "he" : "en";
}
export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

// ---- the grader
export function gradeGolden(g: Golden, cardsIn: TimelineCard[], opts: GradeOpts = {}): GoldenGrade {
  const lateFactor = opts.lateFactor ?? 2,
    dupWindow = opts.dupWindowMs ?? 120_000;
  const idx = new Map(g.lines.map((l, i) => [l.id, i]));
  const lineT = (id: string) => g.lines[idx.get(id)!].t;
  const cards = cardsIn.map((c, i) => ({ ...c, i })).sort((a, b) => a.atMs - b.atMs || a.i - b.i);
  const used = new Set<number>(); // cards assigned to a moment (any outcome)
  const correct = new Set<number>();
  const inTime = new Set<number>(); // cards in time and of the right kind (right or wrong text)
  const wrongText = new Set<number>();
  const results: MomentResult[] = [];
  const momentOfCard = new Map<number, string>();

  // Three passes, so an early moment never steals the card that is a clean hit for a later one: hits first, then wrong text, then late.
  const ordered = [...g.moments].sort((a, b) => lineT(a.afterLine) - lineT(b.afterLine));
  const byId = new Map<string, MomentResult>();
  const freeOf = (kind: Kind) => cards.filter((c) => !used.has(c.i) && c.kind === kind);
  for (const m of ordered) {
    const t0 = lineT(m.afterLine);
    const good = freeOf(m.kind).find((c) => c.atMs >= t0 && c.atMs <= t0 + m.latestMs && hasAll(c.text, m.mustMention));
    if (!good) continue;
    used.add(good.i);
    correct.add(good.i);
    inTime.add(good.i);
    momentOfCard.set(good.i, m.id);
    byId.set(m.id, { id: m.id, kind: m.kind, status: "hit", ttcMs: good.atMs - t0, card: good.i });
  }
  for (const m of ordered) {
    if (byId.has(m.id)) continue;
    const t0 = lineT(m.afterLine);
    const wrong = freeOf(m.kind).find((c) => c.atMs >= t0 && c.atMs <= t0 + m.latestMs);
    if (!wrong) continue;
    used.add(wrong.i);
    inTime.add(wrong.i);
    wrongText.add(wrong.i);
    momentOfCard.set(wrong.i, m.id);
    byId.set(m.id, { id: m.id, kind: m.kind, status: "wrong-text", card: wrong.i });
  }
  for (const m of ordered) {
    if (byId.has(m.id)) continue;
    const t0 = lineT(m.afterLine);
    const late = freeOf(m.kind).find((c) => c.atMs > t0 + m.latestMs && c.atMs <= t0 + m.latestMs * lateFactor);
    if (late) {
      used.add(late.i);
      momentOfCard.set(late.i, m.id);
      byId.set(m.id, { id: m.id, kind: m.kind, status: "late", card: late.i });
    } else byId.set(m.id, { id: m.id, kind: m.kind, status: "miss" });
  }
  for (const m of ordered) results.push(byId.get(m.id)!);

  // duplicates: a second card with the same squashed text (or ref) within the window, or a second right-kind card inside a served moment's window
  const dup = new Set<number>();
  const lastSeen = new Map<string, number>();
  for (const c of cards) {
    const key = `${c.kind}|${c.ref ?? squash(c.text)}`;
    const prev = lastSeen.get(key);
    if (prev !== undefined && c.atMs - prev <= dupWindow) dup.add(c.i);
    lastSeen.set(key, c.atMs);
  }
  for (const m of g.moments) {
    const t0 = lineT(m.afterLine);
    const servedCard = [...momentOfCard].find(([, id]) => id === m.id)?.[0];
    if (servedCard === undefined) continue;
    for (const c of cards) if (!used.has(c.i) && c.kind === m.kind && c.atMs >= t0 && c.atMs <= t0 + m.latestMs) dup.add(c.i);
  }

  // silent windows
  const windows = g.silent.map((s) => {
    const a = idx.get(s.fromLine)!,
      b = idx.get(s.toLine)!;
    return { from: g.lines[a].t, to: g.lines[b + 1]?.t ?? g.lines[b].t + 3000 };
  });
  windows.sort((a, b) => a.from - b.from);
  const merged: typeof windows = []; // overlapping windows must not count their minutes twice
  for (const w of windows) {
    const last = merged.at(-1);
    if (last && w.from <= last.to) last.to = Math.max(last.to, w.to);
    else merged.push({ ...w });
  }
  windows.splice(0, windows.length, ...merged);
  const silentMs = windows.reduce((s, w) => s + (w.to - w.from), 0);
  const silentCards = cards.filter((c) => !used.has(c.i) && windows.some((w) => c.atMs >= w.from && c.atMs < w.to)).length;

  // language: the card should be in the language of the line it answers (for an extra card, of the last "them" line before it)
  let wrongLang = 0,
    langKnown = 0;
  for (const c of cards) {
    const mid = momentOfCard.get(c.i);
    const m = mid ? g.moments.find((x) => x.id === mid) : undefined;
    const ref = m ? g.lines[idx.get(m.afterLine)!] : [...g.lines].reverse().find((l) => l.t <= c.atMs && l.side === "them");
    const want = ref && scriptLang(ref.text),
      got = c.lang ?? scriptLang(c.text);
    if (!want || !got) continue;
    langKnown++;
    if (want !== got) wrongLang++;
  }

  const gk = opts.guardKinds ?? (["answer", "prompt"] as Kind[]);
  const guardBreaches = opts.guard ? cards.filter((c) => gk.includes(c.kind) && opts.guard!(c.text)).length : 0;

  const byKind = {} as Record<Kind, KindStats>;
  for (const k of KINDS) {
    const ms = results.filter((r) => r.kind === k);
    const hits = ms.filter((r) => r.status === "hit").length;
    const kc = cards.filter((c) => c.kind === k);
    const ok = kc.filter((c) => correct.has(c.i)).length;
    byKind[k] = {
      moments: ms.length,
      hits,
      cards: kc.length,
      correct: ok,
      recall: ms.length ? hits / ms.length : 1,
      precision: kc.length ? ok / kc.length : 1,
    };
  }
  const hits = results.filter((r) => r.status === "hit");
  const direct = g.moments.filter((m) => m.direct);
  const directHits = hits.filter((r) => direct.some((m) => m.id === r.id)).length;
  const ttc = hits.map((r) => r.ttcMs!);
  return {
    id: g.id,
    moments: g.moments.length,
    cards: cards.length,
    hits: hits.length,
    recall: g.moments.length ? hits.length / g.moments.length : 1,
    precision: cards.length ? correct.size / cards.length : 1,
    byKind,
    directMoments: direct.length,
    directRecall: direct.length ? directHits / direct.length : 1,
    ttcP50: percentile(ttc, 50),
    ttcP95: percentile(ttc, 95),
    silentMinutes: silentMs / 60000,
    silentCards,
    silentCpm: silentMs ? silentCards / (silentMs / 60000) : 0,
    wrongCards: wrongText.size,
    wrongCardRate: inTime.size ? wrongText.size / inTime.size : 0,
    duplicates: dup.size,
    duplicateRate: cards.length ? dup.size / cards.length : 0,
    wrongLang,
    langKnown,
    wrongLangRate: langKnown ? wrongLang / langKnown : 0,
    guardBreaches,
    results,
  };
}

/** Pools many meetings: counts add up, rates are recomputed from the counts, and the time-to-card percentiles use every recalled moment. */
export type PooledGrade = {
  meetings: number;
  moments: number;
  cards: number;
  hits: number;
  correct: number;
  recall: number;
  precision: number;
  byKind: Record<Kind, KindStats>;
  directMoments: number;
  directHits: number;
  directRecall: number;
  ttcP50: number | null;
  ttcP95: number | null;
  silentMinutes: number;
  silentCards: number;
  silentCpm: number;
  inTime: number;
  wrongCards: number;
  wrongCardRate: number;
  duplicates: number;
  duplicateRate: number;
  wrongLang: number;
  langKnown: number;
  wrongLangRate: number;
  guardBreaches: number;
};
export function poolGrades(gs: { golden: Golden; grade: GoldenGrade }[]): PooledGrade {
  const sum = (f: (x: GoldenGrade) => number) => gs.reduce((s, x) => s + f(x.grade), 0);
  const byKind = {} as Record<Kind, KindStats>;
  for (const k of KINDS) {
    const moments = sum((x) => x.byKind[k].moments),
      hits = sum((x) => x.byKind[k].hits),
      cards = sum((x) => x.byKind[k].cards),
      correct = sum((x) => x.byKind[k].correct);
    byKind[k] = { moments, hits, cards, correct, recall: moments ? hits / moments : 1, precision: cards ? correct / cards : 1 };
  }
  const ttc = gs.flatMap((x) => x.grade.results.filter((r) => r.status === "hit").map((r) => r.ttcMs!));
  const directIds = (x: { golden: Golden }) => new Set(x.golden.moments.filter((m) => m.direct).map((m) => m.id));
  const directHits = gs.reduce((s, x) => s + x.grade.results.filter((r) => r.status === "hit" && directIds(x).has(r.id)).length, 0);
  const directMoments = sum((x) => x.directMoments);
  const moments = sum((x) => x.moments),
    cards = sum((x) => x.cards),
    hits = sum((x) => x.hits);
  const correct = KINDS.reduce((s, k) => s + byKind[k].correct, 0);
  const wrongCards = sum((x) => x.wrongCards);
  const inTime = hits + wrongCards;
  const silentMinutes = sum((x) => x.silentMinutes),
    silentCards = sum((x) => x.silentCards);
  const duplicates = sum((x) => x.duplicates);
  const wrongLang = sum((x) => x.wrongLang);
  const langKnown = sum((x) => x.langKnown);
  return {
    meetings: gs.length,
    moments,
    cards,
    hits,
    correct,
    recall: moments ? hits / moments : 1,
    precision: cards ? correct / cards : 1,
    byKind,
    directMoments,
    directHits,
    directRecall: directMoments ? directHits / directMoments : 1,
    ttcP50: percentile(ttc, 50),
    ttcP95: percentile(ttc, 95),
    silentMinutes,
    silentCards,
    silentCpm: silentMinutes ? silentCards / silentMinutes : 0,
    inTime,
    wrongCards,
    wrongCardRate: inTime ? wrongCards / inTime : 0,
    duplicates,
    duplicateRate: cards ? duplicates / cards : 0,
    wrongLang,
    langKnown,
    wrongLangRate: langKnown ? wrongLang / langKnown : 0,
    guardBreaches: sum((x) => x.guardBreaches),
  };
}

// ---- memory
export type MemorySnapshot = { atLine: string; memory: unknown };
export type MemoryGrade = { checks: number; passed: number; rate: number; failures: { atLine: string; missing: string[] }[] };
const flatten = (v: unknown): string =>
  v === null || v === undefined
    ? ""
    : typeof v === "object"
      ? Object.values(v as object)
          .map(flatten)
          .join(" ")
      : String(v);
/** For each check: the newest snapshot taken at or before the check's line must hold every `mustContain` token somewhere in its values. No snapshot = fail. */
export function gradeMemory(g: Golden, snaps: MemorySnapshot[]): MemoryGrade {
  const idx = new Map(g.lines.map((l, i) => [l.id, i]));
  const failures: MemoryGrade["failures"] = [];
  const checks = g.memoryChecks ?? [];
  for (const c of checks) {
    const at = idx.get(c.atLine)!;
    const snap = snaps
      .filter((s) => (idx.get(s.atLine) ?? Infinity) <= at)
      .sort((a, b) => idx.get(a.atLine)! - idx.get(b.atLine)!)
      .at(-1);
    const text = squash(flatten(snap?.memory));
    const missing = c.mustContain.filter((k) => !text.includes(squash(k)));
    if (!snap || missing.length) failures.push({ atLine: c.atLine, missing: snap ? missing : c.mustContain });
  }
  return {
    checks: checks.length,
    passed: checks.length - failures.length,
    rate: checks.length ? (checks.length - failures.length) / checks.length : 1,
    failures,
  };
}

// ---- negative controls and the oracle
/** The null model: always SKIP, so no cards. */
export const nullTimeline = (_g: Golden): TimelineCard[] => [];
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
/** The noise model: a random card about every 12 s with random kind and six words picked at random from the meeting itself. */
export function noiseTimeline(g: Golden, seed = 1): TimelineCard[] {
  const r = rng(seed);
  const words = g.lines.flatMap((l) => l.text.split(/\s+/)).filter(Boolean);
  const end = g.lines.at(-1)!.t + 5000;
  const out: TimelineCard[] = [];
  for (let t = 3000; t < end; t += 6000 + Math.floor(r() * 12000)) {
    const text = Array.from({ length: 6 }, () => words[Math.floor(r() * words.length)]).join(" ");
    out.push({ atMs: t, kind: KINDS[Math.floor(r() * KINDS.length)], text });
  }
  return out;
}
/** What a perfect model would do: one card per moment, 1.2 s after its line, with the SAY text of the scripted reply (checks the golden file itself). */
export function oracleTimeline(g: Golden): TimelineCard[] {
  const out: TimelineCard[] = [];
  for (const m of g.moments) {
    const s = g.script?.find((x) => x.role === "moment" && x.whenLastLine === m.afterLine);
    const say = /^SAY:\s*(.+)$/m.exec(s?.reply ?? "")?.[1] ?? (m.mustMention ?? []).join(" ");
    out.push({ atMs: g.lines.find((l) => l.id === m.afterLine)!.t + 1200, kind: m.kind, text: say });
  }
  return out;
}
/** Limits the negative controls must stay under (PLAN g1-golden item 4). */
export const CONTROL_LIMITS = { nullRecall: 0.2, noisePrecision: 0.4, noiseRecall: 0.2 };

// ---- ASR noise for runs on clean meetings: drop "?" and all punctuation, lowercase Latin text. Deterministic. The test meetings carry richer noise by hand.
export function degradeAsr(g: Golden): Golden {
  const lines = g.lines.map((l) => ({
    ...l,
    text:
      l.text
        .replace(/[?!.,;:"]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase() || l.text,
  }));
  return { ...g, lines, variant: "noisy" };
}
