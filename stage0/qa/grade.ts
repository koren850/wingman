// Grades one QA call folder against its scenario expectations. Pure functions over the call's JSONL files, so it is unit-tested offline.
// Called by run-qa.ts after each scenario. Inputs are the scenario (qa/scenarios/*.json), the render timeline (what was said when), and the call dir the engine wrote.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { guard } from "../src/guards.ts";
import { loadBank, STALL_TIER } from "../src/bank.ts";
import { isAgencyKind } from "../src/frame.ts";
import type { Scenario, TimelineTurn } from "./render.ts";

/** Name of the invented user in the scenarios (to be wired to the profile). */
const USER_NAME = "Dan";

export type Row = Record<string, any>;
/** Rows of a JSONL file; a missing file gives [] and a bad line gives {} (a half-written line must not stop grading). */
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
/** Frame and tips of one call. `graded`: the scenario has a frame block. */
export type FrameGrade = {
  graded: boolean; frames: number; kind?: string; firstKind?: string; kindFlips: number; topic?: string; checklistN: number; checklistDone: number;
  kindOk: boolean; topicOk: boolean; checklistOk: boolean; tips: { type: string; text: string; source?: string }[]; tipsOk: boolean; tipRelevant: boolean;
  irrelevantBank: string[]; tipLeaks: string[]; frameUsd: number; tipsUsd: number;
};
/** Answers for the user's own questions: graded "me" turns, how many got the expected result, and "For you" cards that no turn asked for. */
export type MeGrade = { graded: number; ok: number; answers: number; unexpected: string[] };
export type Grade = {
  me?: MeGrade;
  frame: FrameGrade;
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

/** p-th percentile (nearest rank, p in 0..100) of a number list, or undefined if empty. */
const pct = (a: number[], p: number) => { if (!a.length) return undefined; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
/** Does a card kind match an expectation? "stall" accepts "stall" and any "stall-*" tier. */
const kindMatches = (kind: string, want: string) => want === "stall" ? kind === "stall" || kind.startsWith("stall-") : kind === want;

/**
 * Grades one call folder. Steps: (1) match each STT word to the script turn it overlaps in time; (2) STT word accuracy; (3) map detect events to
 * turns; (4) tie question detects to latency rows; (5) find the final card per question; (6) grade turns (question found, split joined, right card);
 * (6b) "me" turns and For-you cards; (7) summary guard leaks; (8) cost. Frame and tips are graded by gradeFrame. Files read: transcript, events,
 * cards, latency, usage .jsonl and summary.json.
 */
export function grade(sc: Scenario & { name: string }, tl: TimelineTurn[], dir: string): Grade {
  const transcript = readJsonl(join(dir, "transcript.jsonl"));
  const events = readJsonl(join(dir, "events.jsonl"));
  const cards = readJsonl(join(dir, "cards.jsonl"));
  const lat = readJsonl(join(dir, "latency.jsonl"));
  const usage = readJsonl(join(dir, "usage.jsonl"));
  const bank = loadBank();
  const sayToId = new Map(bank.flatMap((c) => [[c.say.replace(/[*_#`>]+/g, "").trim(), c.id] as [string, string], ...[c.en?.say, ...(c.en?.alts ?? [])].filter(Boolean).map((x) => [x!.trim(), c.id] as [string, string])]));   // English card texts map to the same id

  // 1. Assign every STT word to the script turn it overlaps most (stream-relative word times vs the rendered timeline).
  //    A final can span several turns (Deepgram merges fast speech); its words are split between them.
  type Fin = { ch: "me" | "them"; text: string; turns: Set<number>; wordTurns: number[] };
  const finals: Fin[] = [];
  const wordsOfTurn = new Map<number, string[]>();
  for (const r of transcript) {
    const w: any[] = r.words ?? [];
    const turns = new Set<number>();
    const wordTurns: number[] = [];
    for (const x of w) {
      const s0 = x.start * 1000, e0 = x.end * 1000;
      let best = -1, bestOv = 0;
      for (const t of tl) {
        if (t.speaker !== r.ch) continue;
        const ov = Math.min(e0, t.endMs + 300) - Math.max(s0, t.startMs - 300);
        if (ov > bestOv) { bestOv = ov; best = t.i; }
      }
      wordTurns.push(best);
      if (best >= 0) { turns.add(best); (wordsOfTurn.get(best) ?? wordsOfTurn.set(best, []).get(best)!).push(String(x.word)); }
    }
    finals.push({ ch: r.ch, text: r.text, turns, wordTurns });
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
  let ptr = 0, multiWords: number[] = [], multiGlue: Set<number> | undefined;
  for (let k = 0; k < events.length; k++) {
    const e = events[k];
    if (e.type !== "detect") continue;
    // split.multi: one merged final cut into several questions; each piece takes the turns of its own words.
    if (typeof e.part === "number") {
      if (e.part === 0) {
        const wc = (x: unknown) => String(x ?? "").trim().split(/\s+/).filter(Boolean).length;
        const glued0 = events[k - 2]?.type === "split.join";
        const full = wc(events[k - 1]?.text ?? e.text), total = glued0 ? wc(events[k - 2].text) : full;
        multiWords = Array(full - total).fill(-1);   // the glued head fragment's words belong to the previous detect
        let got = 0;
        while (got < total && ptr < themFinals.length) { multiWords.push(...themFinals[ptr].wordTurns); got += themFinals[ptr].text.trim().split(/\s+/).filter(Boolean).length; ptr++; }
        if (glued0 && dets.length) multiGlue = dets[dets.length - 1].turns; else multiGlue = undefined;
      }
      const n = String(e.text).trim().split(/\s+/).filter(Boolean).length;
      const turns = new Set<number>(multiWords.splice(0, n).filter((x) => x >= 0));
      if (e.part === 0 && multiGlue) for (const t of multiGlue) turns.add(t);
      dets.push({ text: e.text, isQuestion: !!e.isQuestion, reason: e.reason, turns, glued: false });
      continue;
    }
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
  for (const c of cards) if (c.type === "card" && (c.badge === "ai" || c.badge === "tip") && !c.withdraw) { const g = guard(`${c.say} ${(c.facts ?? []).join(" ")}`); if (!g.ok) aiGuardLeaks.push(`${c.turnId}: ${g.rule}: ${c.say}`); }

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

  // 6b. "me" turns: did the user's question for Wingman get a "For you" card, and did a question for the other person (or thinking aloud) get none?
  const meById = new Map<string, Row>();
  for (const c of cards) if (c.type === "card" && c.badge === "me") { if (c.withdraw) meById.delete(c.id); else meById.set(c.id, c); }
  const meCards = [...meById.values()].filter((c) => !c.hidden);
  const overlap = (a: string[], b: string[]) => { const sb = new Set(b); return a.length ? a.filter((w) => sb.has(w)).length / a.length : 0; };
  const meGrade: MeGrade = { graded: 0, ok: 0, answers: meCards.length, unexpected: [] };
  const matched = new Set<string>();
  for (const t of tl) {
    const exp = sc.turns[t.i].expect;
    if (t.speaker !== "me" || !exp?.forMe) continue;
    const heardW = normWords(heardOf(t.i));
    const hit = heardW.length ? meCards.find((c) => overlap(heardW, normWords(String(c.question ?? ""))) >= 0.6) : undefined;
    if (hit && exp.forMe === "answer") matched.add(hit.id);
    meGrade.graded++;
    const ok = exp.forMe === "answer" ? !!hit : !hit;
    if (ok) meGrade.ok++;
    else failures.push({ turn: t.i, kind: exp.forMe === "answer" ? "no For-you answer" : "unwanted For-you answer", heard: heardOf(t.i) || "(nothing transcribed)", script: t.text, expected: exp.forMe === "answer" ? "a For-you card" : `no card for ${USER_NAME}`, got: hit ? `${hit.source ?? "ai"}: ${String(hit.say).slice(0, 70)}` : "no card" });
  }
  for (const c of meCards) if (!matched.has(c.id)) meGrade.unexpected.push(`${c.turnId}: "${String(c.question).slice(0, 60)}" -> ${String(c.say).slice(0, 50)}`);

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
  const fg = gradeFrame(sc, events, cards, usage, cardsByTurn, sayToId);
  for (const [kind, expected, got] of fg.problems) failures.push({ turn: -1, kind, heard: "(call frame)", script: sc.frame ? `${[sc.frame.kind].flat().join("|")}` : "", expected, got });
  return {
    me: meGrade,
    frame: fg.grade,
    scenario: sc.name, durationS: (tl.at(-1)?.endMs ?? 0) / 1000,
    falseCards, questionsAsked: dets.filter((d) => d.isQuestion).length, expectedQ, detectedQ, tp, fp, fn, recall: expectedQ ? tp / expectedQ : 1, precision: detectedQ ? tp / detectedQ : 1,
    cardGraded, cardOk, cardAcc: cardGraded ? cardOk / cardGraded : 1, priceTurns, priceOk, splitTested, splitOk,
    latP50: pct(lats, 50), latP95: pct(lats, 95), latN: lats.length, sttWordAcc, sttRefWords: refWords,
    summary, aiGuardLeaks, costUsd: sumRow?.totalUsd ?? 0, sttUsd: sumRow?.sttUsd ?? 0, llmUsd: sumRow?.llmUsd ?? 0,
    hiddenByCap, crashed, failures, turns,
  };
}

type CardRows = Map<string, Row[]>;
/** Frame + tips: what the call turned into, and whether it fits the scenario's `frame` block. Pure over the JSONL rows. */
export function gradeFrame(sc: Scenario & { name: string }, events: Row[], cards: Row[], usage: Row[], cardsByTurn: CardRows, sayToId: Map<string, string>): { grade: FrameGrade; problems: [string, string, string][] } {
  const exp = sc.frame;
  const frames = events.filter((e) => e.type === "frame" && e.frame);
  const last = frames.at(-1)?.frame, first = frames[0]?.frame;
  const kinds = frames.map((e) => e.frame.kind);
  let kindFlips = 0; for (let i = 1; i < kinds.length; i++) if (kinds[i] !== kinds[i - 1]) kindFlips++;
  const checklist: Row[] = last?.checklist ?? [];
  const tips = cards.filter((c) => c.type === "card" && c.badge === "tip" && !c.withdraw && !c.hidden).map((c) => ({ type: String(c.tipType ?? "?"), text: String(c.say ?? "") }));
  const tipSources = events.filter((e) => e.type === "tip").map((e) => String(e.source ?? ""));
  tips.forEach((t, i) => { (t as any).source = tipSources[i]; });
  const blob = [last?.topic, last?.goal, ...(last?.entities ?? []), ...checklist.map((c) => c.item)].join(" ").toLowerCase();
  const wantKinds = exp ? [exp.kind].flat() : [];
  // Irrelevant agency bank cards: any bank card that stayed on screen on a call that is not a client / support call, except the price / timeline / guarantee stall tier.
  const nonAgency = exp ? !wantKinds.some((k) => isAgencyKind(k)) : !!last && !isAgencyKind(last.kind);
  const irrelevantBank: string[] = [];
  if (nonAgency) for (const [turnId, rows] of cardsByTurn) {
    const withdrawn = new Set(rows.filter((r) => r.withdraw).map((r) => r.id));
    const byId = new Map<string, Row>(); for (const r of rows) if (!r.withdraw && !withdrawn.has(r.id)) byId.set(r.id, r);
    for (const c of byId.values()) {
      if (c.badge !== "bank" || c.hidden) continue;
      const id = sayToId.get(String(c.say).replace(/[*_#`>]+/g, "").trim()) ?? "bank?";
      if (!STALL_TIER.has(id) && !(exp?.allowBank ?? []).includes(id)) irrelevantBank.push(`${turnId}: ${id}${c.dim ? " (dimmed)" : ""}`);
    }
  }
  const tipLeaks = tips.filter((t) => !guard(t.text).ok).map((t) => t.text);
  const sum = usage.filter((u) => u.role === "summary" && u.roles).at(-1);
  const grade: FrameGrade = {
    graded: !!exp, frames: frames.length, kind: last?.kind, firstKind: first?.kind, kindFlips, topic: last?.topic, checklistN: checklist.length, checklistDone: checklist.filter((c) => c.done).length,
    kindOk: !exp || wantKinds.includes(last?.kind), topicOk: !exp?.topicAny?.length || exp.topicAny.some((w) => blob.includes(w.toLowerCase())),
    checklistOk: !exp || checklist.length >= (exp.minChecklist ?? 0), tips,
    tipsOk: !exp || tips.length >= (exp.minTips ?? 0), tipRelevant: !exp?.tipAny?.length || tips.length === 0 || tips.some((t) => exp.tipAny!.some((w) => t.text.toLowerCase().includes(w.toLowerCase()))),
    irrelevantBank, tipLeaks, frameUsd: sum?.roles?.frame?.usd ?? 0, tipsUsd: sum?.roles?.tips?.usd ?? 0,
  };
  const problems: [string, string, string][] = [];
  if (exp) {
    if (!grade.kindOk) problems.push(["frame kind", wantKinds.join(" | "), String(last?.kind ?? "no frame was produced")]);
    if (!grade.topicOk) problems.push(["frame topic", `one of: ${exp.topicAny!.join(", ")}`, `topic "${last?.topic ?? ""}", goal "${last?.goal ?? ""}"`]);
    if (!grade.checklistOk) problems.push(["frame checklist", `at least ${exp.minChecklist} items`, `${checklist.length}`]);
    if (!grade.tipsOk) problems.push(["no tip", `at least ${exp.minTips} tip(s)`, `${tips.length}`]);
    else if (!grade.tipRelevant) problems.push(["tip not on topic", `a tip mentioning one of: ${exp.tipAny!.join(", ")}`, tips.map((t) => t.text).join(" / ")]);
    if (irrelevantBank.length) problems.push(["irrelevant agency bank card", "no agency bank card on a non-client call", irrelevantBank.join(", ")]);
  }
  for (const l of tipLeaks) problems.push(["tip guard leak", "no price / date / promise", l]);
  return { grade, problems };
}
