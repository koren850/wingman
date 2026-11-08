// Replays a golden meeting through the LEGACY question path, in process, with no model and no network: the same detect() gate, bank matcher and
// guards that src/engine/question.ts uses, and the "legacy fake" model (the scripted:bank double: it answers the bank card the matcher found and
// says SKIP for anything else). Output is a card timeline for qa/grade-golden.ts.
// What it does not replay: the frame, notes and tip timers (they need a live model and are not tied to a line), the stall timer, audio.
// So it is a floor for the legacy engine on these meetings: a card only for a line the gate calls a question AND the bank can answer.
import { detect } from "../src/detector.ts";
import { loadBank, matchBankFor, localizeCard, setTurnLang, questionLang, type BankCard } from "../src/bank.ts";
import { guard } from "../src/guards.ts";
import type { Golden, TimelineCard } from "./grade-golden.ts";

/** Virtual time from a final line to the bank card on screen: the bank path is local (PLAN 3.6: 0.6 s p50). */
export const BANK_CARD_MS = 600;

export function legacyTimeline(g: Golden, bank: BankCard[] = loadBank()): TimelineCard[] {
  const out: TimelineCard[] = [];
  for (const l of g.lines) {
    if (l.side !== "them") continue; // the legacy question gate looks at the other side only
    const hit = matchBankFor(l.text, bank);
    const det = detect(l.text, { bankScore: hit?.score, stall: !!hit?.card.id.startsWith("stall-") });
    if (!det.isQuestion || !hit) continue;
    const lang = questionLang(l.text) ?? "he";
    setTurnLang(lang);
    const card = localizeCard(hit.card, lang);
    if (!card) continue; // no version in this language: the legacy path shows nothing
    out.push({ atMs: l.t + BANK_CARD_MS, kind: "answer", text: card.say, lang, ref: hit.card.id });
  }
  return out;
}
/** The engine guard as a yes/no for the grader (true = the text breaks a guard). */
export const guardBreach = (text: string) => !guard(text).ok;

/**
 * The legacy question gate alone, with the answer text assumed right: how many answer moments does detect() call a question, and how many
 * lines that should stay quiet (silent windows) does it call a question? This isolates the word-list design the owner doubts.
 */
export function gateReport(g: Golden, bank: BankCard[] = loadBank()) {
  const flagged = (text: string) => {
    const hit = matchBankFor(text, bank);
    return detect(text, { bankScore: hit?.score, stall: !!hit?.card.id.startsWith("stall-") }).isQuestion;
  };
  const answerLines = new Set(g.moments.filter((m) => m.kind === "answer").map((m) => m.afterLine));
  const quietLines = new Set<string>();
  for (const w of g.silent) {
    const a = g.lines.findIndex((l) => l.id === w.fromLine),
      b = g.lines.findIndex((l) => l.id === w.toLine);
    for (let i = a; i <= b; i++) quietLines.add(g.lines[i].id);
  }
  const themQuiet = g.lines.filter((l) => l.side === "them" && quietLines.has(l.id));
  return {
    answerMoments: answerLines.size,
    answerFlagged: g.lines.filter((l) => answerLines.has(l.id) && flagged(l.text)).length,
    quietLines: themQuiet.length,
    quietFlagged: themQuiet.filter((l) => flagged(l.text)).length,
  };
}
