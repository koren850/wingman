// The moment engine wired to the call (moments.engine = v2). Shared by both ways to ask the model:
//   1. Context and presentation: momentContext (buildContext with the call memory), decideMoment (the scheduler: minimum value, aim, novelty,
//      per-minute cap, late and stale drops), momentCard (the card row v2), usage and SKIP rows.
//   2. The routing decision for a finished line from the other side (routeThem), the "AI paused" state, and the first memory seed.
//   3. Intake of a finished line (keepFeatures) and the language of the turn.
// The direct path (a strong hint) is in question-moment.ts, the observer path (lines without a clear question) in moments-observer.ts.
// The model decides meaning; this file decides timing, budgets, safety and fallbacks. A hint from the old gate never silences a line.
import { noteModel, cardSched, type Card } from "./cards.ts";
import { st, callKind } from "./state.ts";
import {
  S,
  log,
  cost,
  sup,
  tracker,
  transcript,
  speakers,
  brief,
  briefArg,
  contextNotes,
  intake,
  schedCfg,
  ctxBudgets,
  sharedCtx,
  breakers,
  PROMPT_V,
  UI_LANG,
} from "./boot.ts";
import { userName } from "../profile.ts";
import { buildContext, type ContextOutput, type RawLine } from "../context/build.ts";
import { buildMomentPrompt, type BankCandidate } from "../moments/prompt.ts";
import { decide, recordShown, clearHero, type Decision, type ScheduledMoment } from "../moments/scheduler.ts";
import { normalizeTagRows, parseTags, pickLabel, type CardSrc } from "./cards-v2.ts";
import { learnedOffsets, noteCallEnd } from "../moments/learn.ts";
import { modeInstructions } from "../moments/modes.ts";
import { estimateTokens } from "../context/budget.ts";
import type { TurnFeatures } from "../moments/intake.ts";
import type { HintLevel, Moment, MomentMeta, MomentSource, MomentTag } from "../moments/types.ts";
import { type MomentRole } from "../moments/run.ts";
import { seedForCall } from "../session/callseed.ts";
import { PEOPLE_FILE } from "../session/people.ts";
import { CALLS, USER_DATA } from "../env.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isEmptyMemory } from "../session/types.ts";
import { guard } from "../guards.ts";
import { leakedTag, wrongLanguage, wrongTextLanguage, langOf } from "../reflex.ts";
import { STALL_TIER, type BankCard } from "../bank.ts";
import { frameText } from "../frame.ts";
import { describe, ProviderError } from "../providers/errors.ts";
import { health, healthClear, survived } from "./out.ts";
import { ht } from "../htext.ts";
import { momentRoute, type MomentRoute } from "./rules.ts";
import { llmFailed, clearAiBar, refreshSignals, currentPause, v2Active } from "./degrade.ts";

// ---------------------------------------------------------------- routing
export const isSlow = () => sup.rung === 1;
/** Where a finished line from the other side goes. `hint` is the frozen legacy gate (strong, weak, none). */
export function routeThem(hint: HintLevel): { route: MomentRoute; why: string } {
  const paused = !!currentPause();
  // An old-gate question while paused still gets the old path (bank, calc, stall line); a line without a cue has nothing to do offline.
  const r = momentRoute({
    v2: v2Active(),
    hint: paused && hint === "weak" ? "strong" : hint,
    paused,
    slow: isSlow(),
    observerShed: cost.shed("observer"),
    observerOn: S.moments.observerPerMinute > 0,
  });
  return r;
}

// ---------------------------------------------------------------- memory seed
let seeded = false;
/** The memory starts from the prepared meeting (agenda, notes). The pre-meeting digest (another package) replaces it with a richer one. Safe to call often. */
export function ensureSeeded(): void {
  if (seeded) return;
  seeded = true;
  if (st.m.mem.ver > 0 || !isEmptyMemory(st.m.mem)) return; // the memory loop already set it (a resumed call, or a patch came first)
  try {
    const facts = [...contextNotes];
    if (!facts.length && !brief?.mustCover?.length) return;
    st.m.mem = seedForCall({
      mustCover: brief?.mustCover ?? [],
      ...(brief?.who ? { who: brief.who } : {}),
      notes: facts,
      ...(briefArg ? { briefFile: briefArg } : {}),
      now: Date.now(),
      pastCalls: S.context.pastCalls,
      callsDir: CALLS,
      peopleFile: join(USER_DATA, PEOPLE_FILE),
      callId: log.id,
    });
  } catch (e) {
    survived("moments.seed", e);
  }
}

// ---------------------------------------------------------------- context
/** The newest transcript lines as raw lines for the context builder. */
export function rawTail(n = 40): RawLine[] {
  return transcript.slice(-n).map((l) => {
    const name = l.ch === "them" && l.who ? speakers.current(l.who)?.name : undefined;
    return { side: l.ch, text: l.text, ...(name ? { name } : {}) };
  });
}
export const toCandidates = (cands: readonly { card: BankCard }[] = []): BankCandidate[] =>
  cands.slice(0, 3).map((c) => ({ id: c.card.id, title: c.card.title, say: c.card.say }));

/** The input of one moment or observer call. `trigger` is the sentence that caused it. */
export function momentContext(role: MomentRole, trigger: string, lines: RawLine[], cands: readonly BankCandidate[] = []): ContextOutput {
  ensureSeeded();
  const m = st.m.mem;
  const frame = frameText(tracker.current);
  const roster = m.roster.map((p) => ({ name: p.name, side: p.side, ...(p.role ? { role: p.role } : {}) }));
  const kind = callKind();
  const roleInstructions = buildMomentPrompt({ userName: userName(), roster, bankCandidates: cands, kind });
  // The mode text (practice interview coaching) comes on top of the 900 token budget of the rules, so it never cuts the call data.
  const extra = estimateTokens(modeInstructions(kind));
  const budgets = extra ? { ...ctxBudgets, [role]: { ...ctxBudgets[role], roleInstructions: ctxBudgets[role].roleInstructions + extra } } : ctxBudgets;
  return buildContext({
    role,
    roleInstructions: frame
      ? `${roleInstructions}\n\nCall frame (made by a small model, may be wrong): ${frame.replace(/\s+/g, " ").slice(0, 300)}`
      : roleInstructions,
    memory: m,
    rawLines: lines,
    trigger,
    budgets,
    shared: sharedCtx,
  });
}

// ---------------------------------------------------------------- scheduler
/** `sibling`: another part of the same final already showed a card; its card is not a hero that holds this one back. */
export type DecideInput = { source: MomentSource; turnId: number; cardId: string; lineAt: number; hint?: HintLevel; sibling?: boolean };
/** Runs the scheduler on a moment. A shown card becomes the hero in the scheduler state. */
export function decideMoment(m: Moment, o: DecideInput): Decision {
  const meta: MomentMeta = {
    turnId: o.turnId,
    source: o.source,
    lineAt: o.lineAt,
    topic: st.m.mem.topic.now || undefined,
    ...(o.hint ? { hint: o.hint } : {}),
  };
  const sm: ScheduledMoment = { ...m, ...meta };
  const base = {
    ...st.m.sched,
    now: Date.now(),
    memVer: st.m.mem.ver,
    kind: callKind(),
    currentTurnId: o.source === "observer" ? st.m.obs : st.m.direct,
    ...(st.m.sched.learn ? {} : { learn: learnedOffsets() }), // what earlier calls learned about this user, read once per call
  };
  // A direct question (a strong hint) is the job: it may take the screen from an observer card and is not held back by the per-minute cap
  // (its card still counts for the observer cards that follow, so a busy minute stays calm).
  const state = o.sibling || o.source === "direct" ? clearHero(base) : base;
  const d = decide(sm, state, o.source === "direct" ? { ...schedCfg, maxPerMinute: 99 } : schedCfg);
  st.m.sched = d.action === "show" ? recordShown(state, sm, o.cardId, d) : state;
  if (d.action !== "drop") cardSched.know(o.cardId, m.tag); // a rating on this card (shown or small) finds its kind
  return d;
}
/** The user rated a card (useful, not useful or "fewer like this"). Three "not useful" in a row for one kind raise that kind's minimum VALUE for the rest of the call, for direct,
 *  observer and open-loop cards alike (one scheduler state). A "fewer" rating raises it at once. */
export function noteFeedback(cardId: string, rating: "useful" | "not-useful" | "fewer"): void {
  applyFeedback([{ id: cardId, rating }]);
}
/** Rows of tags.jsonl (the whole file or only new rows; objects as the overlay writes them, `{id|cardId, rating|useful}`, or already normalised). A rating already applied is skipped,
 *  a changed one counts again. Called by the layer that reads tags.jsonl (coach.ts). Returns how many ratings were applied. */
export function applyFeedback(rows: readonly unknown[]): number {
  try {
    const norm = normalizeTagRows(rows);
    const tags = new Map(norm.map((r) => [r.id, cardSched.tagOf(r.id)] as const));
    const n = cardSched.applyFeedback(norm);
    if (n) log.write("events", { type: "cards.feedback", rows: n, boost: st.m.sched.boost, tags: Object.fromEntries([...tags].filter(([, t]) => t)) });
    return n;
  } catch (e) {
    survived("moments.feedback", e);
    return 0;
  }
}

/** The call is over: the negative ratings of this call (per kind of card) go to learn.json (counts only), once. Safe to call twice. */
let learnedThisCall = false;
export function endCallLearning(): void {
  if (learnedThisCall) return;
  learnedThisCall = true;
  try {
    // Ratings given in the last seconds were not read by the coach tick yet.
    try {
      applyFeedback(parseTags(readFileSync(join(log.dir, "tags.jsonl"), "utf8")));
    } catch {
      /* no ratings file */
    }
    const counts = cardSched.negatives();
    const state = noteCallEnd(counts);
    log.write("events", { type: "learn.call", negatives: counts, calls: state.calls, raised: Object.keys(learnedOffsets()) });
  } catch (e) {
    survived("moments.learn", e);
  }
}

// ---------------------------------------------------------------- cards
const KIND: Record<MomentTag, NonNullable<Card["kind"]>> = {
  SKIP: "fact",
  ANS: "answer",
  BANK: "answer",
  STALL: "answer",
  REPLY: "prompt",
  PROMPT: "prompt",
  CHECK: "check",
  TERM: "fact",
  NOTE: "fact",
};
const BADGE: Record<MomentTag, Card["badge"]> = {
  SKIP: "ai",
  ANS: "ai",
  BANK: "bank",
  STALL: "stall",
  REPLY: "ai",
  PROMPT: "ai",
  CHECK: "careful",
  TERM: "ai",
  NOTE: "ai",
};
const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** The card row for a moment (a text card: ANS, REPLY, CHECK, TERM, PROMPT, NOTE). Bank and stall cards are made by the caller from the bank. */
export function momentCard(
  m: Moment,
  o: { id: string; turnId: string; question: string; ctx?: ContextOutput["record"]; dim?: boolean; done?: boolean; bankTitle?: string },
): Card {
  // WHY and MORE follow the language of the card. A line in the other language (an English caution under a Hebrew card) is dropped, not shown.
  const ref = langOf(m.say) ?? langOf(o.question) ?? st.m.lang;
  const same = (t: string) => !ref || !wrongTextLanguage(ref, t);
  const more = m.more.map(clean).filter((t) => t && same(t));
  const why = m.why && same(m.why) ? clean(m.why) : "";
  const label = pickLabel({ label: m.label, bankTitle: o.bankTitle, topic: st.m.mem.topic.now });
  const val = KIND[m.tag] === "fact" ? (m.val ?? valOfRef(m.ref)) : undefined;
  return {
    id: o.id,
    turnId: o.turnId,
    badge: BADGE[m.tag],
    question: o.question,
    say: m.say,
    facts: more,
    at: Date.now(),
    kind: KIND[m.tag],
    value: m.value,
    ...(why ? { why } : {}),
    ...(more.length ? { more } : {}),
    ...(m.ref ? { ref: m.ref } : {}),
    ...(label ? { label } : {}),
    ...(m.about ? { about: m.about } : {}),
    ...(val ? { val } : {}),
    ...(m.conf ? { conf: m.conf } : {}),
    ...(m.fit === false ? { fit: false } : {}),
    ...(srcOfRef(m.ref) ? { src: srcOfRef(m.ref) } : {}),
    ...(o.ctx ? { ctx: { memV: o.ctx.memV, tokens: o.ctx.tokens, parts: o.ctx.parts } } : {}),
    ...(o.dim ? { dim: true } : {}),
    ...(o.done ? { done: true } : {}),
  };
}
/** Where the fact behind a memory id comes from: a prepared item or the user's own note, or this call. Undefined for no id or an id the memory does not know. */
export function srcOfRef(ref: string | undefined): CardSrc | undefined {
  if (!ref) return undefined;
  const m = st.m.mem;
  const fact = m.facts.find((f) => f.id === ref);
  if (fact) return fact.src === "user" ? "you" : fact.src;
  if (m.mustCover.some((x) => x.id === ref)) return "brief";
  if ([...m.numbers, ...m.commitments, ...m.openQuestions, ...m.decisions, ...m.objections].some((x) => x.id === ref)) return "call";
  return undefined;
}
/** The value of a number the memory holds (a fact card that points at it shows the value on its chip), at most 4 words. */
export function valOfRef(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  const n = st.m.mem.numbers.find((x) => x.id === ref);
  const v = n?.value.replace(/\s+/g, " ").trim().split(" ").slice(0, 4).join(" ").slice(0, 30);
  return v || undefined;
}
/** The same for a card from the bank (the model said BANK <id>, or the local scorer found it). */
export function bankMomentCard(c: BankCard, m: Moment, o: { id: string; turnId: string; question: string; ctx?: ContextOutput["record"] }): Card {
  return {
    ...momentCard({ ...m, say: c.say, more: [] }, { ...o, bankTitle: c.title }),
    badge: "bank",
    say: c.say,
    facts: c.facts,
    more: undefined,
    kind: "answer",
    priority: STALL_TIER.has(c.id) || c.id.startsWith("stall-") || undefined,
  };
}
/** The model's text may be shown to the user only if it carries no price, date or promise of its own (ANS and REPLY are lines the user may say aloud). */
export function sayAllowed(m: Moment, question: string, callLang: "he" | "en" | undefined = st.m.lang): { ok: boolean; why?: string } {
  const spoken = m.tag === "ANS" || m.tag === "REPLY";
  if (spoken && leakedTag(m.say)) return { ok: false, why: "leaked-tag" };
  if (m.tag === "ANS" && wrongLanguage(question, m.say)) return { ok: false, why: "language" };
  // Every text card follows the language of what was asked, else of the call: a Hebrew "careful" card in an English call is noise (in a recorded run: 6% of cards).
  const ref = langOf(question) ?? callLang;
  if (m.tag !== "ANS" && m.say && ref && wrongTextLanguage(ref, m.say)) return { ok: false, why: "language" };
  if (!spoken) return { ok: true };
  const g = guard(m.say);
  return g.ok ? { ok: true } : { ok: false, why: `guard:${g.rule}` };
}

// ---------------------------------------------------------------- logs and cost
/** A SKIP (or a drop) with its reason, so a miss can be measured later. */
export function logMomentRow(
  type: "moment.skip" | "moment.drop" | "moment.chip" | "moment.invalid" | "moment.retry",
  turnId: string,
  source: MomentSource,
  why: string,
  extra: Record<string, unknown> = {},
) {
  log.write("events", { type, turnId, source, why, ...extra });
}
/** Books the usage of a finished (or aborted) call. */
export function bookMomentUsage(
  role: MomentRole,
  turnId: string,
  d: { usage: unknown; providerMetadata: unknown; model: string },
  rec?: ContextOutput["record"],
  aborted = false,
) {
  const c = cost.addLlm(role, d.model, d.usage, d.providerMetadata);
  log.write("usage", {
    role,
    model: d.model,
    prompt: PROMPT_V,
    turnId,
    usage: d.usage,
    providerMetadata: d.providerMetadata,
    usd: c.usd,
    roleTotalUsd: cost.roles[role].usd,
    ...(rec ? { ctx: rec } : {}),
    ...(aborted ? { aborted: true } : {}),
  });
}
/** A model call worked: the failure state of the model goes back to normal. */
export function noteMomentOk(model: string) {
  st.q.reflexErrors = 0;
  st.m.lastFailKind = undefined;
  healthClear("ai");
  clearAiBar(model);
  breakers.get(model)?.success();
  sup.noteLlmOk();
  refreshSignals();
}
/** Counts a failed observer call. Two in a row raise the same amber "AI not answering" bar as the direct path (a success clears it). */
export function countFailure(e: ProviderError) {
  if (++st.q.reflexErrors >= 2) health("ai", "amber", ht(UI_LANG, "ai.silent"), String(e?.message ?? e));
}
/** A failed call: the model's health (breaker, ladder) and the reason for the paused bar. */
export function noteMomentFail(model: string, e: ProviderError) {
  st.m.lastFailKind = e?.kind;
  llmFailed(model, e);
}
export function noteMomentSwitch(turnId: string, from: string, to: string, e: ProviderError) {
  noteModel(turnId, to);
  log.write("events", { type: "llm.switch", turnId, from, to, kind: e.kind });
  console.log(`\n↪ AI ${from} -> ${to} (${describe(e)})`);
}

// ---------------------------------------------------------------- lines from the user
/** Language of the newest line with letters (for the card texts of this turn). */
export function noteLang(l: "he" | "en" | undefined) {
  if (l) st.m.lang = l;
}
/** Intake: a structural noise filter and the features of a finished line. Returns true when the line is kept. */
export function keepLine(side: "me" | "them", text: string, at: number, speaker?: string): boolean {
  return !!keepFeatures(side, text, at, speaker);
}
/** Like keepLine, but gives the features of a kept line (the speed hint reads them), or undefined for a dropped one. */
export function keepFeatures(side: "me" | "them", text: string, at: number, speaker?: string): TurnFeatures | undefined {
  const r = intake.accept({ text, side, at, ...(speaker ? { speaker } : {}) });
  if (!r.keep) {
    log.write("events", { type: "intake.drop", side, why: r.why, text: text.slice(0, 80) });
    return undefined;
  }
  if (r.features.lang === "he" || r.features.lang === "en") noteLang(r.features.lang);
  return r.features;
}
/** For tests and for run.ts at shutdown. */
export const _resetMoments = () => {
  seeded = false;
  cardSched.reset();
  learnedThisCall = false;
};
