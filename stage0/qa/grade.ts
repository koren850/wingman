// Grades one QA call folder against its scenario expectations. Pure functions over the call's JSONL files, so it is unit-tested offline.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { guard } from "../src/guards.ts";
import { loadBank } from "../src/bank.ts";
import type { Scenario, TimelineTurn } from "./render.ts";

export type Row = Record<string, any>;
export const readJsonl = (file: string): Row[] => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }) : [];

/** Lowercase, drop niqqud/punctuation/bidi marks, collapse spaces: the form used to compare STT text with the script. */
export function normWords(s: string): string[] {
  return s.toLowerCase().replace(/[֑-ׇ​-‏‪-‮⁦-⁩]/g, "").replace(/["'״׳`’]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
}
/** Word edit distance (substitutions + insertions + deletions). */
export function wordEdits(ref: string[], hyp: string[]): number {
  const m = ref.length, n = hyp.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

export type Failure = { turn: number; kind: string; heard: string; script: string; expected: string; got: string };
export type TurnResult = { i: number; text: string; heard: string; q: boolean; outcome?: string; ok: boolean; reasons: string[]; latencyMs?: number; hidden?: string };
export type Grade = {
  scenario: string; durationS: number;
  falseCards: number; questionsAsked: number; expectedQ: number; detectedQ: number; tp: number; fp: number; fn: number; recall: number; precision: number;
  cardGraded: number; cardOk: number; cardAcc: number;
  priceTurns: number; priceOk: number;
  splitTested: number; splitOk: number;
  latP50?: number; latP95?: number; latN: number;
  sttWordAcc: number; sttRefWords: number;
  summary: { present: boolean; guardOk: boolean; replaced: number; emailLeaks: string[]; otherLeaks: string[] };
  aiGuardLeaks: string[];
  costUsd: number; sttUsd: number; llmUsd: number;
  hiddenByCap: number; crashed: boolean; failures: Failure[]; turns: TurnResult[];
};

const pct = (a: number[], p: number) => { if (!a.length) return undefined; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const kindMatches = (kind: string, want: string) => want === "stall" ? kind === "stall" || kind.startsWith("stall-") : kind === want;

export function grade(sc: Scenario & { name: string }, tl: TimelineTurn[], dir: string): Grade {
  const transcript = readJsonl(join(dir, "transcript.jsonl"));
  const events = readJsonl(join(dir, "events.jsonl"));
  const cards = readJsonl(join(dir, "cards.jsonl"));
  const lat = readJsonl(join(dir, "latency.jsonl"));
  const usage = readJsonl(join(dir, "usage.jsonl"));
  const bank = loadBank();
  const sayToId = new Map(bank.map((c) => [c.say.replace(/[*_#`>]+/g, "").trim(), c.id]));

  // 1. Assign every STT word to the script turn it overlaps most (stream-relative word times vs the rendered timeline).
  //    A final can span several turns (Deepgram merges fast speech); its words are split between them.
  type Fin = { ch: "me" | "them"; text: string; turns: Set<number> };
  const finals: Fin[] = [];
  const wordsOfTurn = new Map<number, string[]>();
  for (const r of transcript) {
    const w: any[] = r.words ?? [];
    const turns = new Set<number>();
    for (const x of w) {
      const s0 = x.start * 1000, e0 = x.end * 1000;
      let best = -1, bestOv = 0;
      for (const t of tl) {
        if (t.speaker !== r.ch) continue;
        const ov = Math.min(e0, t.endMs + 300) - Math.max(s0, t.startMs - 300);
        if (ov > bestOv) { bestOv = ov; best = t.i; }
      }
      if (best >= 0) { turns.add(best); (wordsOfTurn.get(best) ?? wordsOfTurn.set(best, []).get(best)!).push(String(x.word)); }
    }
    finals.push({ ch: r.ch, text: r.text, turns });
  }
  const heardOf = (i: number) => (wordsOfTurn.get(i) ?? []).join(" ");

  // 2. STT word accuracy.
  let refWords = 0, edits = 0;
  for (const t of tl) { const ref = normWords(t.text); refWords += ref.length; edits += wordEdits(ref, normWords(heardOf(t.i))); }
  const sttWordAcc = refWords ? Math.max(0, 1 - edits / refWords) : 0;

  // 3. Map detect events to the client finals they were built from (word-count consumption; a split.join glues the previous detect too).
  const themFinals = finals.filter((f) => f.ch === "them");
  type Det = { text: string; isQuestion: boolean; reason?: string; turns: Set<number>; glued: boolean; q?: Row; };
  const dets: Det[] = [];
  let ptr = 0;
  for (let k = 0; k < events.length; k++) {
    const e = events[k];
    if (e.type !== "detect") continue;
    const glued = events[k - 1]?.type === "split.join";
    const rem = (glued ? String(events[k - 1].text) : String(e.text)).trim().split(/\s+/).filter(Boolean).length;
    const turns = new Set<number>();
    let got = 0;
    while (got < rem && ptr < themFinals.length) { for (const x of themFinals[ptr].turns) turns.add(x); got += themFinals[ptr].text.trim().split(/\s+/).filter(Boolean).length; ptr++; }
    if (glued && dets.length) for (const t of dets[dets.length - 1].turns) turns.add(t);
    dets.push({ text: e.text, isQuestion: !!e.isQuestion, reason: e.reason, turns, glued });
  }
  // 4. Question detects get their turnId by order (run.ts numbers questions q1, q2, ... as it handles them); the latency row is looked up by that id.
  let qn = 0;
  for (const d of dets) if (d.isQuestion) { const id = `q${++qn}`; d.q = lat.find((l) => l.turnId === id) ?? { turnId: id }; }

  // 5. Outcome card per question turn.
  const cardsByTurn = new Map<string, Row[]>();
  for (const c of cards) if (c.type === "card" && c.turnId && c.turnId.startsWith("q") && !c.health) { const a = cardsByTurn.get(c.turnId) ?? []; a.push(c); cardsByTurn.set(c.turnId, a); }
  const kindOf = (c: Row) => c.badge === "bank" ? (sayToId.get(String(c.say).trim()) ?? "bank?") : c.badge === "stall" ? "stall" : c.badge === "ai" ? "ai" : String(c.badge);
  const outcomeOf = (turnId: string | undefined) => {
    const rows = (turnId && cardsByTurn.get(turnId)) || [];
    const withdrawn = new Set(rows.filter((r) => r.withdraw).map((r) => r.id));
    const live = rows.filter((r) => !r.withdraw && !withdrawn.has(r.id));
    const byId = new Map<string, Row>(); for (const r of live) byId.set(r.id, r);   // upserts (AI facts) keep the last version
    const list = [...byId.values()].sort((a, b) => a.t - b.t);
    return { final: list.at(-1), all: list };
  };

  // 6. Grade the turns.
  const turns: TurnResult[] = [], failures: Failure[] = [];
  let falseCards = 0, tp = 0, fp = 0, fn = 0, cardGraded = 0, cardOk = 0, priceTurns = 0, priceOk = 0, splitTested = 0, splitOk = 0, hiddenByCap = 0;
  const lats: number[] = [];
  const aiGuardLeaks: string[] = [];
  for (const c of cards) if (c.type === "card" && c.badge === "ai" && !c.withdraw) { const g = guard(`${c.say} ${(c.facts ?? []).join(" ")}`); if (!g.ok) aiGuardLeaks.push(`${c.turnId}: ${g.rule}: ${c.say}`); }

  for (const t of tl) {
    const exp = sc.turns[t.i].expect;
    if (t.speaker !== "them" || !exp || exp.part === "head") continue;
    const heard = heardOf(t.i);
    const containing = dets.filter((d) => d.turns.has(t.i));
    const qDet = containing.find((d) => d.isQuestion);
    const isQ = !!qDet;
    const reasons: string[] = [];
    const fail = (kind: string, expected: string, got: string) => { reasons.push(kind); failures.push({ turn: t.i, kind, heard: heard || "(nothing transcribed)", script: t.text, expected, got }); };
    let outcome: string | undefined, latencyMs: number | undefined, hidden: string | undefined;
    const oc = qDet ? outcomeOf(qDet.q?.turnId) : undefined;
    if (oc?.final?.hidden === "cap") hiddenByCap++;
    if (exp.question === true) {
      if (isQ) tp++; else { fn++; fail("question missed", "detected as a question", containing.length ? `detected as statement: "${containing[0].text}"` : "no STT final for this turn"); }
    } else if (exp.question === false) {
      // a merged final (Deepgram joined the greeting and the question) is not a false question when another expected question is in it
      const carriedByOther = isQ && [...qDet!.turns].some((j) => j !== t.i && sc.turns[j]?.expect?.question === true);
      if (isQ && !carriedByOther) { fp++; { const shownCard = oc?.final && !oc.final.hidden; if (shownCard) falseCards++; fail(shownCard ? "false question WITH a card" : "false question (no card)", "no question / no card", `detected as question (${qDet!.reason ?? "?"}): "${qDet!.text}" -> ${oc?.final ? `${kindOf(oc.final)}${oc.final.hidden ? ` (hidden: ${oc.final.hiddenReason})` : ""}` : "no card"}`); } }
    }
    if (exp.joinWith === "prev") {
      splitTested++;
      if (qDet && qDet.turns.has(t.i - 1)) splitOk++;
      else fail("split join failed", "fragments joined into one question", qDet ? `question detected without the head: "${qDet.text}"` : "no question");
    }
    if (qDet) {
      const q = qDet.q;
      const { final, all } = oc!;
      outcome = final ? kindOf(final) : "none";
      if (final?.hidden) hidden = final.hiddenReason;
      if (q) {
        const first = Math.min(...["bankAt", "stallAt", "cardAt"].map((k) => typeof q[k] === "number" ? q[k] : Infinity)) - q.speechEnd;
        if (Number.isFinite(first)) { latencyMs = first; lats.push(first); }
      }
      if (exp.card !== undefined && exp.question !== false) {
        const want = Array.isArray(exp.card) ? exp.card : [exp.card];
        cardGraded++;
        const ok = want.some((w) => w === "none" ? !final : !!final && kindMatches(outcome!, w));
        const isPrice = want.includes("stall-price");
        if (isPrice) priceTurns++;
        if (ok) { cardOk++; if (isPrice) priceOk++; }
        else {
          fail("wrong card", want.join(" | "), `${outcome}${final ? `: ${String(final.say).slice(0, 70)}` : ""}${all.length > 1 ? ` (+${all.length - 1} more card)` : ""}`);
        }
        if (isPrice && all.some((c) => c.badge === "ai")) { if (ok) priceOk--; fail("AI answer on a price question", "stall only", all.filter((c) => c.badge === "ai").map((c) => c.say).join(" / ")); }
      }
    }
    turns.push({ i: t.i, text: t.text, heard, q: isQ, outcome, ok: reasons.length === 0, reasons, latencyMs, hidden });
  }

  // 7. Summary.
  const sumFile = join(dir, "summary.json");
  let summary: Grade["summary"] = { present: false, guardOk: true, replaced: 0, emailLeaks: [], otherLeaks: [] };
  if (existsSync(sumFile)) {
    const s = JSON.parse(readFileSync(sumFile, "utf8"));
    const emailLeaks: string[] = [], otherLeaks: string[] = [];
    const g = guard(String(s.followUpEmail ?? "")); if (!g.ok) emailLeaks.push(`email: ${g.rule}`);
    for (const line of String(s.followUpEmail ?? "").split("\n")) { const gl = guard(line); if (!gl.ok) emailLeaks.push(`${gl.rule}: ${line.slice(0, 90)}`); }
    const others = [...(s.summary ?? []), ...(s.decisions ?? []), ...(s.openQuestions ?? []), ...(s.nextSteps ?? []).map((n: any) => `${n.what} ${n.when ?? ""}`)];
    for (const o of others) { const go = guard(String(o)); if (!go.ok) otherLeaks.push(`${go.rule}: ${String(o).slice(0, 90)}`); }
    summary = { present: true, guardOk: emailLeaks.length === 0 && otherLeaks.length === 0, replaced: s.guard?.replaced ?? 0, emailLeaks, otherLeaks };
  }

  // 8. Cost.
  const sumRow = usage.filter((u) => u.role === "summary" && typeof u.totalUsd === "number").at(-1);
  const crashed = events.some((e) => e.type === "crash" || e.type === "shutdown.error");

  const expectedQ = tp + fn, detectedQ = tp + fp;
  return {
    scenario: sc.name, durationS: (tl.at(-1)?.endMs ?? 0) / 1000,
    falseCards, questionsAsked: dets.filter((d) => d.isQuestion).length, expectedQ, detectedQ, tp, fp, fn, recall: expectedQ ? tp / expectedQ : 1, precision: detectedQ ? tp / detectedQ : 1,
    cardGraded, cardOk, cardAcc: cardGraded ? cardOk / cardGraded : 1, priceTurns, priceOk, splitTested, splitOk,
    latP50: pct(lats, 50), latP95: pct(lats, 95), latN: lats.length, sttWordAcc, sttRefWords: refWords,
    summary, aiGuardLeaks, costUsd: sumRow?.totalUsd ?? 0, sttUsd: sumRow?.sttUsd ?? 0, llmUsd: sumRow?.llmUsd ?? 0,
    hiddenByCap, crashed, failures, turns,
  };
}
