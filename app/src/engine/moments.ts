// The moment engine wired to the call (moments.engine = v2). Three jobs:
//   1. Context and presentation shared by both ways to ask the model: momentContext (buildContext with the call memory), decideMoment (the
//      scheduler: minimum value, aim, novelty, per-minute cap, late and stale drops), momentCard (the card row v2), usage and SKIP rows.
//   2. The observer path: lines without a clear question wait in the observer window; a due window becomes one `observer` model call.
//      (The direct path, a strong hint, is in question.ts: it keeps the bank card, calc, stall line and the turn state of the old engine.)
//   3. The routing decision for a finished line from the other side (routeThem), the "AI paused" state, and the first memory seed.
// The model decides meaning; this file decides timing, budgets, safety and fallbacks. A hint from the old gate never silences a line.
import { emitCard, recordLatency, noteModel, type Card } from "./cards.ts";
import { st } from "./state.ts";
import {
  S,
  log,
  cost,
  sup,
  tracker,
  transcript,
  speakers,
  brief,
  contextNotes,
  interview,
  registry,
  bank,
  stall,
  intake,
  observer,
  schedCfg,
  ctxBudgets,
  sharedCtx,
  notesAbort,
  breakers,
  PROMPT_V,
  UI_LANG,
} from "./boot.ts";
import { userName } from "../profile.ts";
import { buildContext, type ContextOutput, type RawLine } from "../context/build.ts";
import { buildMomentPrompt, type BankCandidate } from "../moments/prompt.ts";
import { decide, recordShown, clearHero, recordFeedback, type Decision, type ScheduledMoment } from "../moments/scheduler.ts";
import type { HintLevel, Moment, MomentMeta, MomentSource, MomentTag } from "../moments/types.ts";
import { runMoment, type MomentDone, type MomentRole } from "../moments/run.ts";
import type { ParsedMoment } from "../moments/parse.ts";
import type { ObserverWindow } from "../moments/observer.ts";
import { seedFromDigest } from "../session/seed.ts";
import { guard } from "../guards.ts";
import { leakedTag, resolveBankId, wrongLanguage } from "../reflex.ts";
import { stallSay, STALL_TIER, type BankCard } from "../bank.ts";
import { frameText, isAgencyKind, isAgencyTopic } from "../frame.ts";
import { describe, ProviderError } from "../providers/errors.ts";
import { health, healthClear, errBrief, survived } from "./out.ts";
import { ht } from "../htext.ts";
import { agencyGate, momentRoute, type MomentRoute } from "./rules.ts";
import { llmFailed, usableModels, clearAiBar, refreshSignals, currentPause, v2Active } from "./degrade.ts";

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
  try {
    const facts = [...contextNotes];
    if (!facts.length && !brief?.mustCover?.length) return;
    st.m.mem = seedFromDigest({ roster: [], agenda: brief?.mustCover ?? [], facts, likelyQuestions: [], chunks: [] }, Date.now());
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
  const roleInstructions = buildMomentPrompt({ userName: userName(), roster, bankCandidates: cands });
  return buildContext({
    role,
    roleInstructions: frame
      ? `${roleInstructions}\n\nCall frame (made by a small model, may be wrong): ${frame.replace(/\s+/g, " ").slice(0, 300)}`
      : roleInstructions,
    memory: m,
    rawLines: lines,
    trigger,
    budgets: ctxBudgets,
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
  const base = { ...st.m.sched, now: Date.now(), memVer: st.m.mem.ver, currentTurnId: o.source === "observer" ? st.m.obs : st.m.direct };
  // A direct question (a strong hint) is the job: it may take the screen from an observer card and is not held back by the per-minute cap
  // (its card still counts for the observer cards that follow, so a busy minute stays calm).
  const state = o.sibling || o.source === "direct" ? clearHero(base) : base;
  const d = decide(sm, state, o.source === "direct" ? { ...schedCfg, maxPerMinute: 99 } : schedCfg);
  st.m.sched = d.action === "show" ? recordShown(state, sm, o.cardId, d) : state;
  if (d.action === "show") tagOfCard.set(o.cardId, m.tag);
  return d;
}
const tagOfCard = new Map<string, MomentTag>();
/** The user rated a card (useful or not useful). Three "not useful" in a row for one kind raise that kind's minimum VALUE for the rest of the call. Called by the layer that hears the overlay's rating. */
export function noteFeedback(cardId: string, rating: "useful" | "not-useful"): void {
  const tag = tagOfCard.get(cardId);
  if (!tag) return;
  st.m.sched = recordFeedback(st.m.sched, tag, rating, schedCfg);
  log.write("events", { type: "moment.feedback", cardId, tag, rating });
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
export const cardKindOf = (t: MomentTag) => KIND[t];
const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** The card row for a moment (a text card: ANS, REPLY, CHECK, TERM, PROMPT, NOTE). Bank and stall cards are made by the caller from the bank. */
export function momentCard(m: Moment, o: { id: string; turnId: string; question: string; ctx?: ContextOutput["record"]; dim?: boolean; done?: boolean }): Card {
  const more = m.more.map(clean).filter(Boolean);
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
    ...(m.why ? { why: clean(m.why) } : {}),
    ...(more.length ? { more } : {}),
    ...(m.ref ? { ref: m.ref } : {}),
    ...(o.ctx ? { ctx: { memV: o.ctx.memV, tokens: o.ctx.tokens, parts: o.ctx.parts } } : {}),
    ...(o.dim ? { dim: true } : {}),
    ...(o.done ? { done: true } : {}),
  };
}
/** The same for a card from the bank (the model said BANK <id>, or the local scorer found it). */
export function bankMomentCard(c: BankCard, m: Moment, o: { id: string; turnId: string; question: string; ctx?: ContextOutput["record"] }): Card {
  return {
    ...momentCard({ ...m, say: c.say, more: [] }, { ...o }),
    badge: "bank",
    say: c.say,
    facts: c.facts,
    more: undefined,
    kind: "answer",
    priority: STALL_TIER.has(c.id) || c.id.startsWith("stall-") || undefined,
  };
}
/** The model's text may be shown to the user only if it carries no price, date or promise of its own (ANS and REPLY are lines the user may say aloud). */
export function sayAllowed(m: Moment, question: string): { ok: boolean; why?: string } {
  if (m.tag !== "ANS" && m.tag !== "REPLY") return { ok: true };
  if (leakedTag(m.say)) return { ok: false, why: "leaked-tag" };
  if (m.tag === "ANS" && wrongLanguage(question, m.say)) return { ok: false, why: "language" };
  const g = guard(m.say);
  return g.ok ? { ok: true } : { ok: false, why: `guard:${g.rule}` };
}

// ---------------------------------------------------------------- logs and cost
/** A SKIP (or a drop) with its reason, so a miss can be measured later. */
export function logMomentRow(
  type: "moment.skip" | "moment.drop" | "moment.chip" | "moment.invalid",
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
function countFailure(e: ProviderError) {
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

// ---------------------------------------------------------------- the observer path
let lineSeq = 0;
let obsTimer: NodeJS.Timeout | undefined;
let obsAc: AbortController | undefined;
const wordsIn = (t: string) => t.split(/\s+/).filter(Boolean).length;
/** A line without a hint that still deserves a look when the speaker pauses: a sentence of some length, or one with a figure. The observer cap bounds the cost. */
const WORTH_A_LOOK_WORDS = 6;

/** A kept line from the other side enters the observer window (a line a direct call handles does not come here). The window only decides WHEN to ask;
 *  what the model reads is the transcript tail, so a line that was not pushed is still in its context. */
export function noteLine(o: { text: string; at: number; hint: HintLevel; hasFigure?: boolean }): void {
  if (!v2Active() || st.call.shuttingDown) return;
  try {
    const id = `l${++lineSeq}`;
    const worth = o.hint !== "none" || wordsIn(o.text) >= WORTH_A_LOOK_WORDS || !!o.hasFigure;
    const hint: HintLevel | undefined = o.hint === "strong" ? "strong" : worth ? "weak" : undefined;
    const w = observer.push({ id, text: o.text, side: "them", at: o.at, hint });
    if (w) dispatch(w);
    arm();
  } catch (e) {
    survived("moments.noteLine", e);
  }
}
/** Timer that fires when the next window is due (a weak line after its quiet time, or a held-back window when a call slot frees up). */
function arm() {
  clearTimeout(obsTimer);
  const due = observer.nextDueAt();
  if (due === undefined || st.call.shuttingDown) return;
  obsTimer = setTimeout(
    () => {
      try {
        const w = observer.poll();
        if (w) dispatch(w);
      } catch (e) {
        survived("moments.poll", e);
      }
      arm();
    },
    Math.max(0, due - Date.now()),
  );
  obsTimer.unref?.();
}
/** The memory says the topic changed (called by the memory loop): the observer looks at the call now. */
export function topicChanged(): void {
  if (!v2Active() || st.call.shuttingDown) return;
  const w = observer.topicChange();
  if (w) dispatch(w);
  arm();
}
export function stopObserver() {
  clearTimeout(obsTimer);
  obsAc?.abort();
}

function dispatch(w: ObserverWindow) {
  const r = routeThem("weak");
  if (r.route !== "observer") {
    log.write("events", { type: "moment.observer-drop", why: r.why, trigger: w.trigger, lines: w.lines.length });
    return;
  }
  void runObserver(w).catch((e) => survived("moments.observer", e));
}

async function runObserver(w: ObserverWindow): Promise<void> {
  const fresh = w.lines;
  if (!fresh.length) return;
  const models = usableModels(true);
  if (!models.length) return;
  const num = ++st.m.seq;
  st.m.obs = num;
  obsAc?.abort(); // the newer window covers the older one: its lines are the lead-in now
  const ac = (obsAc = new AbortController());
  const signal = AbortSignal.any([ac.signal, notesAbort.signal]);
  const turnId = `o${num}`;
  const last = fresh.at(-1) ?? w.lines.at(-1);
  const lineAt = last?.at ?? Date.now();
  const lat: Record<string, number | string> = {
    turnId,
    source: "observer",
    trigger: w.trigger,
    speechEnd: lineAt,
    finalAt: lineAt,
    text: (last?.text ?? "").slice(0, 200),
  };
  const lines = rawTail(40);
  const trigger = fresh
    .map((l) => l.text)
    .join(" / ")
    .slice(-400);
  const ctx = momentContext("observer", trigger, lines);
  const question = (last?.text ?? "").slice(0, 200);
  lat.reqAt = Date.now();
  noteModel(turnId, models[0]);
  let shown = false,
    skipped = false;
  const cardId = `${turnId}-m`;
  const fail = (e: ProviderError) => {
    if (ac.signal.aborted) return;
    log.write("events", { type: "moment.error", turnId, source: "observer", kind: e?.kind ?? "unknown", error: errBrief(e) });
    if (e?.kind !== "refusal") countFailure(e);
  };
  // Shows the card once the verdict, value, aim and (for a text card) the say-line are known.
  const tryShow = (p: ParsedMoment, final: boolean) => {
    if (shown || skipped || ac.signal.aborted || !p.tag) return;
    if (!lat.tagAt) {
      lat.tagAt = Date.now();
      lat.tag = p.tag.tag + (p.tag.bankId ? ` ${p.tag.bankId}` : "");
      sup.recordTag(Number(lat.tagAt) - Number(lat.reqAt));
    }
    if (p.tag.tag === "SKIP") {
      if (p.errors.length && !final) return; // a bad first line: wait for the end to see if it is garbage
      if (!p.errors.length) {
        skipped = true;
        logMomentRow("moment.skip", turnId, "observer", p.moment?.why || p.fields.why || "model-skip", { latencyMs: Date.now() - Number(lat.reqAt) });
      }
      return;
    }
    const f = p.fields;
    const textTag = p.tag.tag !== "BANK" && p.tag.tag !== "STALL";
    if (f.value === undefined || f.aim === undefined || (textTag && !p.sayComplete && !final)) return;
    const m: Moment = {
      tag: p.tag.tag,
      ...(p.tag.bankId ? { bankId: p.tag.bankId } : {}),
      ...(p.tag.stall ? { stall: p.tag.stall } : {}),
      value: f.value,
      aim: f.aim,
      say: f.say ?? "",
      why: f.why ?? "",
      more: f.more ?? [],
      ...(f.ref ? { ref: f.ref } : {}),
    };
    if (textTag && !m.say) return;
    shown = true;
    presentObserver(m, { turnId, cardId, question, lineAt, ctx: ctx.record, lat, hintText: last?.text ?? "" });
  };
  try {
    await runMoment({
      registry,
      models,
      role: "observer",
      ctx,
      cfg: { ...S.llm.reflex, timeoutMs: Math.min(S.llm.reflex.timeoutMs, 5000) },
      maxTokens: 160,
      signal,
      onFail: (m, e) => noteMomentFail(m, e),
      onSwitch: (a, b, e) => noteMomentSwitch(turnId, a, b, e),
      onHung: (m, e) => noteMomentFail(m, e),
      h: {
        onPartial: (p) => tryShow(p, false),
        onDone: (d) =>
          finishObserver(d, { turnId, ctx, lat, tryShow, shown: () => shown, skipped: () => skipped, aborted: () => ac.signal.aborted, question, cardId }),
        onAbortedUsage: (u) => bookMomentUsage("observer", turnId, u, undefined, true),
      },
    });
  } catch (e) {
    fail(e as ProviderError);
  } finally {
    if (obsAc === ac) obsAc = undefined;
    lat.aborted = ac.signal.aborted ? 1 : 0;
    recordLatency(lat);
  }
}

type FinishEnv = {
  turnId: string;
  ctx: ContextOutput;
  lat: Record<string, number | string>;
  tryShow: (p: ParsedMoment, final: boolean) => void;
  shown: () => boolean;
  skipped: () => boolean;
  aborted: () => boolean;
  question: string;
  cardId: string;
};
function finishObserver(d: MomentDone, e: FinishEnv) {
  if (e.aborted()) return;
  bookMomentUsage("observer", e.turnId, d, e.ctx.record);
  noteMomentOk(d.model);
  e.lat.doneAt = Date.now();
  const cutOff = d.truncated && !e.shown() && d.moment.tag !== "SKIP";
  if ((d.errors.length && d.moment.tag === "SKIP") || cutOff) {
    // Garbage or a cut-off reply: logged with the reason. An observer card is never an emergency, so there is no stall line.
    logMomentRow("moment.invalid", e.turnId, "observer", cutOff ? "truncated" : d.errors[0].reason, { sample: d.errors[0]?.sample });
    countFailure(new ProviderError("unknown", "moment", "unusable reply"));
    return;
  }
  if (!e.shown() && !e.skipped()) {
    if (d.moment.tag === "SKIP")
      logMomentRow("moment.skip", e.turnId, "observer", d.moment.why || "model-skip", { latencyMs: Date.now() - Number(e.lat.reqAt) });
    else
      e.tryShow(
        { tag: { tag: d.moment.tag, bankId: d.moment.bankId, stall: d.moment.stall }, fields: d.moment, sayComplete: true, moment: d.moment, errors: [] },
        true,
      );
  }
  // The card went up at the say-line; WHY and MORE come after it: the same card id, updated with the final text.
  const done = lastShown.get(e.cardId);
  lastShown.delete(e.cardId);
  if (!done || d.moment.tag === "SKIP" || done.card.badge === "bank" || done.card.badge === "stall") return;
  const up = momentCard(
    { ...done.m, why: d.moment.why, more: d.moment.more, ref: d.moment.ref ?? done.m.ref },
    { id: e.cardId, turnId: e.turnId, question: e.question, ctx: e.ctx.record, dim: done.dim, done: true },
  );
  emitCard({ ...up, say: done.card.say, at: done.card.at });
}
/** The observer cards that are on screen and may still get their WHY and MORE lines. */
const lastShown = new Map<string, { m: Moment; card: Card; dim?: boolean }>();

type ObsPresent = {
  turnId: string;
  cardId: string;
  question: string;
  lineAt: number;
  ctx: ContextOutput["record"];
  lat: Record<string, number | string>;
  hintText: string;
};
function presentObserver(m: Moment, o: ObsPresent) {
  const num = Number(o.turnId.slice(1));
  const d = decideMoment(m, { source: "observer", turnId: num, cardId: o.cardId, lineAt: o.lineAt });
  o.lat.value = m.value;
  if (d.action === "drop") {
    logMomentRow("moment.drop", o.turnId, "observer", d.reason, { tag: m.tag, value: m.value, aim: m.aim });
    return;
  }
  const chip = d.action === "chip";
  if (chip) logMomentRow("moment.chip", o.turnId, "observer", d.reason, { tag: m.tag, value: m.value });
  const q = o.question;
  let card: Card | undefined;
  if (m.tag === "BANK") {
    const c = resolveBankId(m.bankId, bank, st.m.lang);
    if (!c) return logMomentRow("moment.drop", o.turnId, "observer", "unknown-bank-id", { bankId: m.bankId });
    card = bankMomentCard(c, m, { id: o.cardId, turnId: o.turnId, question: q, ctx: o.ctx });
    st.q.bankShownAt.set(c.id, Date.now());
  } else if (m.tag === "STALL") {
    const gate = agencyGate({
      interview,
      kind: tracker.kind,
      kindIsAgency: !!tracker.kind && isAgencyKind(tracker.kind),
      agencyTopic: isAgencyTopic(o.hintText),
      agencyRecent: Date.now() - st.turn.lastAgencyTopicAt < 60_000,
      stallEnabled: S.reflex.stall,
    });
    if (gate.noStall) return logMomentRow("moment.drop", o.turnId, "observer", "stall-off", { tag: m.tag });
    card = {
      ...momentCard({ ...m, say: stallSay(stall, st.q.turnSeq, st.m.lang) }, { id: o.cardId, turnId: o.turnId, question: q, ctx: o.ctx }),
      badge: "stall",
    };
  } else {
    if (m.tag === "ANS" && !S.reflex.allowAns) return logMomentRow("moment.drop", o.turnId, "observer", "ans-off", { tag: m.tag });
    const ok = sayAllowed(m, q);
    if (!ok.ok) {
      log.write("events", { type: "guard", turnId: o.turnId, rule: ok.why, source: "observer" });
      return logMomentRow("moment.drop", o.turnId, "observer", ok.why ?? "guard", { tag: m.tag });
    }
    card = momentCard(m, { id: o.cardId, turnId: o.turnId, question: q, ctx: o.ctx, dim: chip || undefined });
  }
  if (chip && !card.dim) card.dim = true;
  if (st.voice.lastMeVoiced > o.lineAt && m.tag !== "CHECK") card.dim = true; // the user already spoke after that line
  if (d.replaces)
    emitCard({ id: d.replaces, turnId: o.turnId, badge: "ai", question: "", say: "", facts: [], at: Date.now(), withdraw: true, closes: "topic" } as Card);
  o.lat.cardAt = Date.now();
  emitCard(card);
  lastShown.set(o.cardId, { m, card, dim: card.dim });
}

// ---------------------------------------------------------------- lines from the user
/** Language of the newest line with letters (for the card texts of this turn). */
export function noteLang(l: "he" | "en" | undefined) {
  if (l) st.m.lang = l;
}
/** Intake: a structural noise filter and the features of a finished line. Returns true when the line is kept. */
export function keepLine(side: "me" | "them", text: string, at: number, speaker?: string): boolean {
  const r = intake.accept({ text, side, at, ...(speaker ? { speaker } : {}) });
  if (!r.keep) {
    log.write("events", { type: "intake.drop", side, why: r.why, text: text.slice(0, 80) });
    return false;
  }
  if (r.features.lang === "he" || r.features.lang === "en") noteLang(r.features.lang);
  return true;
}
/** For tests and for run.ts at shutdown. */
export const _resetMoments = () => {
  seeded = false;
  lineSeq = 0;
  lastShown.clear();
  stopObserver();
};
