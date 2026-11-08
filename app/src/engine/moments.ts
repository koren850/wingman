// The moment engine wired to the call (moments.engine = v2). Three jobs:
//   1. Context and presentation shared by both ways to ask the model: momentContext (buildContext with the call memory), decideMoment (the
//      scheduler: minimum value, aim, novelty, per-minute cap, late and stale drops), momentCard (the card row v2), usage and SKIP rows.
//   2. The observer path: lines without a clear question wait in the observer window; a due window becomes one `observer` model call.
//      (The direct path, a strong hint, is in question.ts: it keeps the bank card, calc, stall line and the turn state of the old engine.)
//   3. The routing decision for a finished line from the other side (routeThem), the "AI paused" state, and the first memory seed.
// The model decides meaning; this file decides timing, budgets, safety and fallbacks. A hint from the old gate never silences a line.
import { emitCard, recordLatency, noteModel, cardSched, checkBook, closeCards, type Card } from "./cards.ts";
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
import { userName, nameRegex } from "../profile.ts";
import { buildContext, type ContextOutput, type RawLine } from "../context/build.ts";
import { buildMomentPrompt, type BankCandidate } from "../moments/prompt.ts";
import { decide, recordShown, clearHero, type Decision, type ScheduledMoment } from "../moments/scheduler.ts";
import { normalizeTagRows, type CardSrc } from "./cards-v2.ts";
import { modeInstructions, modeProfile } from "../moments/modes.ts";
import { estimateTokens } from "../context/budget.ts";
import { localCue } from "../moments/cue.ts";
import { speedHint, speedReason, SHORT_LINE_WORDS, type SpeedCtx } from "../moments/hint.ts";
import type { TurnFeatures } from "../moments/intake.ts";
import type { HintLevel, Moment, MomentMeta, MomentSource, MomentTag } from "../moments/types.ts";
import { runMoment, type MomentDone, type MomentRole } from "../moments/run.ts";
import type { ParsedMoment } from "../moments/parse.ts";
import type { ObserverWindow } from "../moments/observer.ts";
import { seedForCall } from "../session/callseed.ts";
import { PEOPLE_FILE } from "../session/people.ts";
import { CALLS, USER_DATA } from "../env.ts";
import { join } from "node:path";
import { isEmptyMemory } from "../session/types.ts";
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
  const base = { ...st.m.sched, now: Date.now(), memVer: st.m.mem.ver, kind: callKind(), currentTurnId: o.source === "observer" ? st.m.obs : st.m.direct };
  // A direct question (a strong hint) is the job: it may take the screen from an observer card and is not held back by the per-minute cap
  // (its card still counts for the observer cards that follow, so a busy minute stays calm).
  const state = o.sibling || o.source === "direct" ? clearHero(base) : base;
  const d = decide(sm, state, o.source === "direct" ? { ...schedCfg, maxPerMinute: 99 } : schedCfg);
  st.m.sched = d.action === "show" ? recordShown(state, sm, o.cardId, d) : state;
  if (d.action !== "drop") cardSched.know(o.cardId, m.tag); // a rating on this card (shown or small) finds its kind
  return d;
}
/** The user rated a card (useful or not useful). Three "not useful" in a row for one kind raise that kind's minimum VALUE for the rest of the call, for direct,
 *  observer and open-loop cards alike (one scheduler state). */
export function noteFeedback(cardId: string, rating: "useful" | "not-useful"): void {
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
    ...(m.label ? { label: m.label } : {}),
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
/** A line without a hint that still deserves a look when the speaker pauses: a sentence of some length. The observer cap bounds the cost. */
const WORTH_A_LOOK_WORDS = 6;

/** The neutral inputs of the speed hint for a line: who is addressed. The user's name (and its spellings) from the profile or the roster, or a call with one other voice. No word list. */
export function speedCtx(text: string, opts: { final?: boolean } = {}): SpeedCtx {
  const named =
    nameRegex().test(text) || st.m.mem.roster.some((p) => p.side === "me" && p.name.length > 1 && text.toLowerCase().includes(p.name.toLowerCase()));
  return { addressed: named || speakers.count <= 1, ...(opts.final === false ? { final: false } : {}) };
}
/** Speed of a finished line from the other side, with the reason for the log. */
export function speedOf(f: TurnFeatures, text: string): { speed: "fast" | "normal"; reason?: string; ctx: SpeedCtx } {
  const ctx = speedCtx(text);
  const reason = speedReason(f, ctx);
  return { speed: speedHint(f, ctx), ...(reason ? { reason } : {}), ctx };
}

/** A kept line from the other side enters the observer window. `hint` "strong" fires at once (a direct call that did not start, the old path). A line the speed hint
 *  sent to the direct path comes here too (`asked`): it starts the "question, then 2 s of silence" timer and its words do not count. A short line with a local cue (a figure, the user's name,
 *  a likeness to one of the user's cards or to an open objection) is pushed with `cue`: it fires after a short quiet, from the reserved calls. A short line aimed at the user waits as a weak line. What the model reads is
 *  the transcript tail, so a line that was not pushed is still in its context. */
export function noteLine(o: {
  text: string;
  at: number;
  hint: HintLevel;
  features?: TurnFeatures;
  hasFigure?: boolean;
  asked?: boolean;
  addressed?: boolean;
}): void {
  if (!v2Active() || st.call.shuttingDown) return;
  try {
    applyModeToObserver();
    const id = `l${++lineSeq}`;
    const f = o.features;
    const figure = o.hasFigure ?? (f ? f.hasDigits || f.hasCurrency : /[\p{Nd}\p{Sc}]/u.test(o.text));
    const cue =
      f && !o.asked
        ? localCue(o.text, f, bank, { named: nameRegex().test(o.text), openObjections: st.m.mem.objections.filter((x) => !x.handled).map((x) => x.text) })
        : figure
          ? "figure"
          : undefined;
    const long = wordsIn(o.text) >= WORTH_A_LOOK_WORDS;
    // A long line (or one the old gate flagged) waits for a short quiet (weak). A short line that only carries a cue uses the reserved calls (cue), not the general weak trigger.
    // A short line aimed at the user (their name, or the only other voice) waits the same short quiet: a question without a mark ends in a full stop in many languages.
    const toYou = !!o.addressed && !!f && f.words >= 3 && f.words <= SHORT_LINE_WORDS;
    const hint: HintLevel | undefined = o.hint === "strong" ? "strong" : o.hint === "weak" || long || toYou ? "weak" : undefined;
    const w = observer.push({
      id,
      text: o.text,
      side: "them",
      at: o.at,
      ...(o.asked ? { asked: true } : { hint }),
      ...(cue && !o.asked ? { cue: true } : {}),
      ...(!hint && !cue && !o.asked ? { quiet: true } : {}),
    });
    if (w) dispatch(w);
    arm();
  } catch (e) {
    survived("moments.noteLine", e);
  }
}
/** The mode of the call may lower the observer calls a minute (a standup or a one-to-one is calmer). It never raises them above the setting, so the cost cannot grow. */
function applyModeToObserver(): void {
  const want = modeProfile(callKind()).observerPerMinute;
  if (S.moments.observerPerMinute <= 0) return;
  observer.setPerMinute(want === undefined ? S.moments.observerPerMinute : Math.min(want, S.moments.observerPerMinute));
}
/** A line from the user. A question to the user is no longer waiting. In a coaching mode (practice interview) the line also goes into the observer window, and a long answer makes a look. */
export function noteMeLine(o: { text: string; at: number }): void {
  if (!v2Active() || st.call.shuttingDown) return;
  try {
    applyModeToObserver();
    observer.userSpoke();
    const words = modeProfile(callKind()).monologueWords ?? 0;
    observer.setMonologueWords(words);
    if (!words) return;
    const w = observer.push({ id: `l${++lineSeq}`, text: o.text, side: "me", at: o.at });
    if (w) dispatch(w);
    arm();
  } catch (e) {
    survived("moments.noteMeLine", e);
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
  closeCards(checkBook.closeAll("topic", Date.now())); // the checks of the old topic go with it
  const w = observer.topicChange();
  if (w) dispatch(w);
  arm();
}
export function stopObserver() {
  clearTimeout(obsTimer);
  obsAc?.abort();
}

function dispatch(w: ObserverWindow) {
  if (w.trigger === "silence") {
    // The question to the user got no answer in 2 s. If a card was shown since that line, the direct call did its job: nothing to add.
    const askedAt = w.lines.findLast((l) => l.asked)?.at ?? 0;
    // A direct call that is still on its way (a slow model) will answer: a second call would give a duplicate card and cost.
    if (st.m.directBusy > 0 || st.m.sched.shown.some((r) => r.at >= askedAt)) {
      log.write("events", { type: "moment.observer-drop", why: st.m.directBusy > 0 ? "answering" : "answered", trigger: w.trigger, lines: w.lines.length });
      observer.unfire(w); // no call was made: the slot and the waiting lines come back
      arm();
      return;
    }
  }
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
      ...(f.label ? { label: f.label } : {}),
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
    { ...done.m, why: d.moment.why, more: d.moment.more, ref: d.moment.ref ?? done.m.ref, ...labelOf(d.moment.label ?? done.m.label) },
    { id: e.cardId, turnId: e.turnId, question: e.question, ctx: e.ctx.record, dim: done.dim, done: true },
  );
  emitCard({ ...up, say: done.card.say, at: done.card.at });
}
const labelOf = (label: string | undefined) => (label ? { label } : {});
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
  lineSeq = 0;
  lastShown.clear();
  cardSched.reset();
  stopObserver();
};
