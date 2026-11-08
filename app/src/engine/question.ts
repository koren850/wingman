// A question from the other side: prepared bank card, "buy time" line, calc, and the streamed Claude reflex answer behind them. One Turn per question.
import {
  getTurnLang,
  matchBank,
  matchBankFor,
  matchBankSmart,
  questionLang,
  priceOffTopic,
  stallSay,
  modelMayOverrideBank,
  STALL_TIER,
  type BankHit,
} from "../bank.ts";
import { evalMath } from "../calc.ts";
import { isClearQuestion, addressesYou } from "../detector.ts";
import { addressesUser, isFresh, isBankRepeat, agencyGate, questionSkip } from "./rules.ts";
import { guard, guardInterview } from "../guards.ts";
import { runReflex, resolveBankId, leakedTag, type Tag, type ReflexHandlers } from "../reflex.ts";
import type { SttResult } from "../providers/stt/types.ts";
import { describe, ProviderError } from "../providers/errors.ts";
import { frameText, isAgencyKind, isAgencyTopic } from "../frame.ts";
import { health, errBrief, healthClear, survived } from "./out.ts";
import { ht } from "../htext.ts";
import { emitCard, recordLatency, noteModel, type Card, focusWorthy } from "./cards.ts";
import {
  stall,
  log,
  interview,
  cost,
  breakers,
  bank,
  sup,
  tracker,
  contextNotes,
  prefix,
  S,
  registry,
  lineOf,
  transcript,
  noAi,
  background,
  flow,
  flowOn,
  UI_LANG,
  PROMPT_V,
} from "./boot.ts";
import { refreshSignals, llmFailed, usableModels, clearAiBar, v2Active, currentPause } from "./degrade.ts";
import {
  momentContext,
  rawTail,
  toCandidates,
  decideMoment,
  momentCard,
  bankMomentCard,
  sayAllowed,
  logMomentRow,
  bookMomentUsage,
  noteMomentOk,
  noteMomentFail,
  noteMomentSwitch,
  noteLang,
  ensureSeeded,
} from "./moments.ts";
import { runMoment, type MomentDone } from "../moments/run.ts";
import type { ParsedMoment } from "../moments/parse.ts";
import type { Moment } from "../moments/types.ts";
import type { BankCandidate } from "../moments/prompt.ts";
import type { ContextOutput } from "../context/build.ts";
import { interviewAllowed } from "./selfcheck.ts";
import { st } from "./state.ts";

// st.q: turnSeq, reflexErrors (consecutive model failures: 2 in a row raise the "AI not answering" bar, 1 for an ask by the user; a success clears it)
// and bankShownAt (per-call state, see state.ts).

/** The cancel scope of one final. A final that holds several questions opens one scope: a newer final aborts all of its parts, but a part never aborts a sibling. */
export interface QScope {
  ac: AbortController;
  parts: number;
  /** Several parts share this scope: one part finishing early (arithmetic) must not detach the scope from `st.turn.current`. */
  shared: boolean;
  /** v2: the id of the moment call round of this final. Parts of one final share it, so a part never counts a sibling's call as newer. */
  mid?: number;
  /** v2: how many parts of this final showed a card (a later part is not held back by a sibling's card). */
  cards?: number;
}
/** Most parts of one final that get a turn (and a model call) at the same time. */
export const MAX_PARTS = 3;

/** One question while its card is built. `shown` is the card on screen for this question; `modelIgnored` is set when the model's answer must not be shown. */
interface Turn {
  id: string;
  scope: QScope;
  r: SttResult;
  reason: string;
  speechEnd: number;
  ac: AbortController;
  lat: Record<string, number | string>; // one row of latency.jsonl
  hit?: BankHit; // the prepared card matched by keywords
  agencyTopic: boolean;
  agencyRecent: boolean;
  noAgency: boolean;
  noStall: boolean;
  weak: boolean;
  weakBank: boolean;
  bgBank: boolean;
  bankOnly: boolean;
  allowAns: boolean;
  lang?: "he" | "en";
  shown?: Card;
  modelIgnored: boolean;
  stallTimer?: NodeJS.Timeout;
  stallId: string;
  ai: Card;
  /** moments.engine = v2 for this question: the model call is a moment call, not a reflex call. */
  v2: boolean;
  /** v2: top bank candidates for the prompt, the id of this model call, its context record, and what it showed. */
  cands?: BankCandidate[];
  mid?: number;
  ctxRec?: ContextOutput["record"];
  mshown?: Moment;
  mcard?: Card;
  mskip?: boolean;
}
/** Answers older than reflex.dropStaleMs are never shown. */
const fresh = (t: Turn) => isFresh(t.speechEnd, Date.now(), S.reflex.dropStaleMs);
const meSpokeSince = (t: Turn) => st.voice.lastMeVoiced > t.speechEnd;
/** The "buy time" line for this question. */
const stallCardFor = (t: Turn): Card => ({
  id: t.stallId,
  turnId: t.id,
  badge: "stall",
  question: t.r.text,
  say: stallSay(stall, st.q.turnSeq, t.lang),
  facts: [],
  at: Date.now(),
});

/** A question from the other side. Order of work:
 *  1. calc: pure arithmetic is answered locally, no model.
 *  2. bank: a keyword match shows a prepared card at once (dimmed when "weak").
 *  3. no usable AI (degraded rungs): a stall line if nothing matched.
 *  4. AI: a stall timer (reflex.stallAfterMs) shows "buy time" if nothing is up yet; meanwhile the model streams a tag
 *     (BANK / ANS / STALL / SKIP) that can confirm, replace or withdraw the card, then the answer text, which passes the guards.
 *  A newer question aborts this one (`current`). Answers older than reflex.dropStaleMs are never shown (`fresh`). `reason` is the detector's reason string. */
export function onQuestion(r: SttResult, reason = "", scope?: QScope): boolean {
  try {
    return onQuestionCore(r, reason, scope);
  } catch (e) {
    survived("onQuestion", e);
    return false;
  }
}
/** Returns true when a turn started (false: the line was skipped before a turn). */
function onQuestionCore(r: SttResult, reason = "", scope?: QScope): boolean {
  if (skipQuestion(r, reason)) return false;
  const t = openTurn(r, reason, scope);
  pickBank(t);
  if (answerArithmetic(t)) return true;
  weighBank(t);

  // Degradation ladder (health.ts): the rung in force for this question (it only changes between questions).
  // beginQuestion/endQuestion tell the supervisor a question is in flight, so it does not change rung mid-answer.
  const caps = sup.caps,
    usable = usableModels();
  sup.beginQuestion();
  let ended = false;
  const end = () => {
    if (!ended) {
      ended = true;
      sup.endQuestion();
    }
  };
  try {
    answerOrAsk(t, caps, usable, end);
  } catch (e) {
    clearTimeout(t.stallTimer);
    end();
    throw e;
  } // a throw below must not leave the question "in flight": the ladder would never move again
  return true;
}
/** The part of a question that runs between beginQuestion and endQuestion: bank card, degraded stall line, or the model call (which calls `end` when it finishes). */
function answerOrAsk(t: Turn, caps: typeof sup.caps, usable: string[], end: () => void) {
  // A paused AI (v2: spend cap, model down, no network) takes the old path without a model: bank, calc, the stall line.
  const useAi = !noAi && !t.bankOnly && caps.llm && usable.length > 0 && !(v2Active() && currentPause());
  // Interview: a slow AI (reduced rung) still answers; a late answer is worth more than none there. Spend cap / no AI still stop it (caps.llm).
  t.allowAns = S.reflex.allowAns && (caps.ans || (interview && caps.llm));

  if (t.hit) showBank(t, t.hit);
  if (!useAi) {
    // Degraded (not by --no-ai): no LLM, so a question without a bank card gets the stall line, as the ladder promises.
    if (!noAi && !t.bankOnly && !t.noStall && !t.shown && fresh(t)) {
      t.shown = stallCardFor(t);
      emitCard(t.shown);
      t.lat.stallAt = Date.now();
    }
    recordLatency(t.lat);
    end();
    return;
  }

  // If neither the bank nor the model has put a card up by then, show the "buy time" line so the user is never left with a blank screen.
  t.stallTimer = setTimeout(() => {
    if (t.ac.signal.aborted) return;
    showStallOrError(t, "timeout");
  }, S.reflex.stallAfterMs);

  const reserved = usableModels(true); // takes a half-open probe slot only now, right before the request
  (t.v2 ? askMoment(t, reserved.length ? reserved : usable) : askModel(t, reserved.length ? reserved : usable)).finally(end);
}

/** Lines that are not questions for the user (or not worth a card): logged and dropped before a turn starts. */
function skipQuestion(r: SttResult, reason: string): boolean {
  // "If ..." openers in a work meeting are mostly people thinking aloud (in review, few were useful). Only when aimed at the user.
  // Interview: a line that only starts with a question word ("יש משימת בית", "צריך לקחת בחשבון") is the interviewer talking, not asking.
  // In real use, most such turns ended in SKIP. Ask the model only when it speaks to the user or matches a prepared card.
  // Their own discussion (flow mode): the question is for one of them, not the user. Price/date ("buy time") cards still show, and so does a question
  // aimed at the user (their name, "you", "מה דעתך"): flow mode holds only what the others ask each other.
  const why = questionSkip({
    interview,
    reason,
    aimedAtYou: () => addressesYou(r.text),
    hasBankHit: () => !!matchBank(r.text, bank),
    focusOn: S.cards.focus,
    focusWorthy: () => focusWorthy(r.text, reason),
    flowHolds: () => flowOn && S.flow.holdCards && flow.internal && !addressesUser(r.text) && !matchBankFor(r.text, bank)?.card.id.startsWith("stall-"),
  });
  if (!why) return false;
  log.write(
    "events",
    why === "focus.skip" || why === "flow.hold" ? { type: why, reason, text: r.text.slice(0, 120) } : { type: why, text: r.text.slice(0, 120) },
  );
  return true;
}

/** Opens the cancel scope for a final: aborts the answers to the previous final (all of its parts). */
export function openScope(shared = false): QScope {
  st.turn.current?.abort();
  return { ac: (st.turn.current = new AbortController()), parts: 0, shared };
}

/** Starts the turn: ids, the latency row, and aborts the answer to the previous final (a part of the same final is left alone). */
function openTurn(r: SttResult, reason: string, given?: QScope): Turn {
  const id = `q${++st.q.turnSeq}`;
  const speechEnd = r.speechEndWall ?? r.arrivedAt;
  const lat: Record<string, number | string> = { turnId: id, speechEnd, finalAt: r.arrivedAt, text: r.text };
  const scope = given ?? openScope();
  scope.parts++;
  // Own controller per turn, linked to the scope: the scope's abort (a newer final) reaches every part.
  const ac = new AbortController();
  if (scope.ac.signal.aborted) ac.abort();
  else scope.ac.signal.addEventListener("abort", () => ac.abort(), { once: true });
  return {
    scope,
    id,
    r,
    reason,
    speechEnd,
    ac,
    lat,
    agencyTopic: false,
    agencyRecent: false,
    noAgency: false,
    noStall: false,
    weak: false,
    weakBank: false,
    bgBank: false,
    bankOnly: reason.startsWith("problem"),
    allowAns: false, // a "problem" is a guessed question (not a clear one): never an AI answer on it
    modelIgnored: false,
    stallId: `${id}-stall`,
    ai: { id: `${id}-ai`, turnId: id, badge: "ai", question: r.text, say: "", facts: [], at: 0 },
    v2: v2Active() && !currentPause(), // fixed for this question; a paused AI keeps the old path (bank, calc, stall line)
  };
}

/** Finds the prepared card for this question, and decides whether Wingman may speak for the user here at all (noAgency, noStall). */
function pickBank(t: Turn) {
  const { r, reason, id: turnId } = t;
  // Not a client / support call (frame, after hysteresis) and the question is not about the user's web / hosting services: Wingman never
  // speaks for the user here. No agency bank card and no stall line, whatever the keywords say (team meeting, interview, friend, supplier).
  // A short follow-up ("יהיה מוכן?", "את הדומיין?") has no topic word of its own: it counts as agency talk for 60 s after one that did (the frame can also guess "vendor" wrongly).
  t.agencyTopic = isAgencyTopic(r.text);
  t.agencyRecent = Date.now() - st.turn.lastAgencyTopicAt < 60_000;
  if (t.agencyTopic) st.turn.lastAgencyTopicAt = Date.now();
  ({ noAgency: t.noAgency, noStall: t.noStall } = agencyGate({
    interview,
    kind: tracker.kind,
    kindIsAgency: !!tracker.kind && isAgencyKind(tracker.kind),
    agencyTopic: t.agencyTopic,
    agencyRecent: t.agencyRecent,
    stallEnabled: S.reflex.stall,
  })); // an interview never gets a "buy time" line; elsewhere only when reflex.stall is on
  // v2: the turn language is explicit (no global); the local scorer may find a card the trigger words miss, and offers the model its top candidates.
  if (t.v2) {
    const l = questionLang(r.text);
    if (l && r.text.trim().split(/\s+/).length >= 3) noteLang(l);
    t.lang = l ?? st.m.lang ?? "he";
  }
  let hit = interview ? matchBank(r.text, bank) : t.noAgency ? undefined : t.v2 ? smartHit(t) : matchBankFor(r.text, bank); // stall-price is dropped for arithmetic and for prices that are not the user's services
  // The same prepared card twice in one call is almost always a keyword echo (one card fired three times while the other side talked about their own team).
  // A repeat shows only for a clear question at least 2 minutes after the last time.
  if (!t.v2) t.lang = getTurnLang(); // fixed for this turn: a newer question must not flip a reply that is still streaming
  if (hit && !STALL_TIER.has(hit.card.id)) {
    if (isBankRepeat({ shownAt: st.q.bankShownAt.get(hit.card.id), now: Date.now(), clearQuestion: isClearQuestion(r.text, reason) })) {
      log.write("events", { type: "bank.repeat", turnId, bank: hit.card.id });
      hit = undefined;
    }
  }
  if (t.noAgency && matchBank(r.text, bank)) log.write("events", { type: "agency.gated", turnId, kind: tracker.kind });
  if (!hit && !t.noAgency && matchBank(r.text, bank)?.card.id === "stall-price")
    log.write("events", { type: "stall.suppressed", turnId, why: priceOffTopic(r.text) ?? "off-topic" });
  t.hit = hit;
}

function smartHit(t: Turn): BankHit | undefined {
  const sm = matchBankSmart(t.r.text, bank, t.lang);
  t.cands = toCandidates(sm.candidates);
  return sm.hit;
}

/** Arithmetic from the other side ("כמה זה 36 ועוד 42?"): the local answer, instantly, no model. Returns true when it answered. */
function answerArithmetic(t: Turn): boolean {
  // A price verb ("כמה זה יעלה 3 כפול 450") already makes evalMath return nothing (calc.ts hasPriceVerb), so no calc card reaches a price question.
  const math = evalMath(t.r.text);
  if (!math || !fresh(t)) return false;
  const card: Card = { id: `${t.id}-calc`, turnId: t.id, badge: "ai", source: "calc", question: t.r.text, say: math.say, facts: [], at: Date.now() };
  emitCard(card);
  t.lat.cardAt = Date.now();
  t.lat.tag = "CALC";
  log.write("events", { type: "calc", turnId: t.id, expr: math.expr, result: math.result });
  recordLatency(t.lat);
  if (!t.scope.shared && t.scope.parts <= 1 && st.turn.current === t.scope.ac) st.turn.current = undefined; // a sibling part may still run on this scope
  return true;
}

/** Decides whether a keyword hit is "weak": dimmed on screen, and the model may withdraw it. */
function weighBank(t: Turn) {
  const { hit, reason } = t;
  // Not a client / support call (frame, after hysteresis): a keyword hit on the agency bank is weak (dimmed, the model may drop it),
  // except the price / timeline / guarantee stall tier, which always stays.
  const offKind = !interview && !!tracker.kind && !isAgencyKind(tracker.kind);
  // A prepared meeting with background files: a general topical card (SEO basics, "move a site") may be the wrong card for this meeting,
  // so it shows dimmed and an AI answer from the background replaces it ("old links and Google ranking" got the generic SEO card).
  t.bgBank = !interview && !!background && !!hit && !STALL_TIER.has(hit.card.id);
  t.weakBank = offKind && !!hit && !STALL_TIER.has(hit.card.id) && !t.agencyTopic && !t.agencyRecent;
  // weak = a bank card may be the wrong card, so it is dimmed and the model may withdraw it. Before the first call frame a topical card
  // may belong to a call that is not a customer call.
  t.weak =
    (reason.startsWith("head:") && !(hit && hit.score >= 2)) ||
    reason.startsWith("problem") ||
    t.weakBank ||
    (!interview && !tracker.kind && !!hit && !STALL_TIER.has(hit.card.id) && !t.agencyTopic && !t.agencyRecent) ||
    t.bgBank;
}

/** The prepared card goes up at once. */
function showBank(t: Turn, hit: BankHit) {
  t.shown = {
    id: `${t.id}-bank`,
    turnId: t.id,
    badge: "bank",
    question: t.r.text,
    say: hit.card.say,
    facts: hit.card.facts,
    dim: t.weak || undefined,
    priority: hit.card.id.startsWith("stall-") || undefined,
    at: Date.now(),
  };
  emitCard(t.shown);
  t.lat.bankAt = Date.now();
  t.lat.bankId = hit.card.id;
  st.q.bankShownAt.set(hit.card.id, Date.now());
}

/** Streams the model's answer for this question. */
function askModel(t: Turn, usable: string[]): Promise<void> {
  const { r } = t;
  const recent = transcript.slice(-12).map(lineOf).join("\n");
  t.lat.reqAt = Date.now();
  noteModel(t.id, usable[0]);
  return runReflex({
    registry,
    models: usable,
    cfg: S.llm.reflex,
    prefix,
    transcript: recent,
    question: r.text,
    context: contextNotes,
    signal: t.ac.signal,
    frame: frameText(tracker.current) || undefined,
    weakBank: t.weakBank ? t.hit!.card.id : undefined,
    noAgency: t.noAgency,
    anyLanguage: interview,
    onFail: (model, err) => llmFailed(model, err),
    onHung: (model, err) => {
      if (st.call.shuttingDown) return;
      log.write("events", { type: "reflex.hung", turnId: t.id, model, error: errBrief(err) });
      llmFailed(model, err);
      countReflexFailure(err);
    },
    onSwitch: (from, to, err) => {
      noteModel(t.id, to);
      log.write("events", { type: "llm.switch", turnId: t.id, from, to, kind: err.kind });
      console.log(`\n↪ AI ${from} -> ${to} (${describe(err)})`);
    },
    h: reflexHandlers(t),
  }).then(
    () => {},
    (e: ProviderError) => onReflexError(t, e),
  );
}

// ---------------------------------------------------------------- v2: the moment call for a direct question (a strong hint)
// The local card (bank, calc) is already up. The moment call decides: SKIP withdraws a weak local card and the stall line; a text card replaces the
// local one; BANK with the same id changes nothing. Every verdict passes the scheduler (value, aim, novelty, cap) and the guards. A stream of an
// older question (turn id) cannot show anything. A failed call, a cut-off reply or garbage never leaves a direct question with an empty screen
// when stall lines are on: the stall timer, showStallOrError.
function askMoment(t: Turn, usable: string[]): Promise<void> {
  st.m.directBusy++; // the silence look in moments.ts waits for a direct call that is still on its way
  const done = () => void (st.m.directBusy = Math.max(0, st.m.directBusy - 1));
  try {
    return askMomentCall(t, usable).finally(done);
  } catch (e) {
    done();
    throw e;
  }
}
function askMomentCall(t: Turn, usable: string[]): Promise<void> {
  ensureSeeded();
  const num = (t.scope.mid ??= ++st.m.seq);
  st.m.direct = num;
  t.mid = num;
  const ctx = momentContext("moment", t.r.text, rawTail(40), t.cands);
  t.ctxRec = ctx.record;
  t.lat.reqAt = Date.now();
  t.lat.source = "direct";
  noteModel(t.id, usable[0]);
  return runMoment({
    registry,
    models: usable,
    role: "moment",
    ctx,
    cfg: S.llm.reflex,
    signal: t.ac.signal,
    onFail: (model, err) => noteMomentFail(model, err),
    onHung: (model, err) => {
      if (st.call.shuttingDown) return;
      log.write("events", { type: "reflex.hung", turnId: t.id, model, error: errBrief(err) });
      noteMomentFail(model, err);
      countReflexFailure(err);
    },
    onSwitch: (from, to, err) => noteMomentSwitch(t.id, from, to, err),
    h: {
      onPartial: (p) => onMomentPartial(t, p, false),
      onDone: (d) => onMomentDone(t, d),
      onAbortedUsage: (u) => bookMomentUsage("moment", t.id, u, undefined, true),
    },
  }).then(
    () => {},
    (e: ProviderError) => onReflexError(t, e),
  );
}

/** Reads the stream so far. The verdict line alone settles SKIP; a card waits for VALUE, AIM and (for a text card) the finished say-line. */
function onMomentPartial(t: Turn, p: ParsedMoment, final: boolean) {
  if (t.ac.signal.aborted || !p.tag) return;
  if (!t.lat.tagAt) {
    t.lat.tagAt = Date.now();
    t.lat.tag = p.tag.tag + (p.tag.bankId ? ` ${p.tag.bankId}` : "");
    sup.recordTag(Number(t.lat.tagAt) - Number(t.lat.reqAt));
  }
  if (p.tag.tag === "SKIP") {
    if (p.errors.length || t.mskip) return; // a bad first line is judged at the end: garbage is a failure, not a SKIP
    momentSkip(t, p.fields.why || "model-skip");
    return;
  }
  if (t.mshown) return;
  const f = p.fields,
    textTag = p.tag.tag !== "BANK" && p.tag.tag !== "STALL";
  if (f.value === undefined || f.aim === undefined || (textTag && !p.sayComplete && !final)) return;
  if (textTag && !f.say) return;
  presentMoment(t, {
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
  });
}

/** The model stays silent: the stall line (if one was shown) and a weak local card go away, the reason is logged. */
function momentSkip(t: Turn, why: string, rowType: "moment.skip" | "moment.drop" = "moment.skip", extra: Record<string, unknown> = {}) {
  t.mskip = true;
  clearTimeout(t.stallTimer);
  if (t.shown?.id === t.stallId) {
    emitCard({ ...t.shown, withdraw: true });
    log.write("events", { type: "withdraw", turnId: t.id, why: "stall-then-skip" });
    t.shown = undefined;
  }
  if (t.weak && t.shown?.badge === "bank" && t.shown.turnId === t.id) {
    emitCard({ ...t.shown, withdraw: true });
    log.write("events", { type: "withdraw", turnId: t.id, why: "haiku-skip" });
  }
  logMomentRow(rowType, t.id, "direct", why, { latencyMs: Date.now() - Number(t.lat.reqAt), ...extra });
}

/** One verdict with its value and aim is known: scheduler, guards, then the card. */
function presentMoment(t: Turn, m0: Moment) {
  let m = m0;
  t.mshown = m;
  if (t.ac.signal.aborted || t.mid !== st.m.direct) return momentSkip(t, "stale-turn", "moment.drop", { tag: m.tag }); // a newer question owns the screen
  if (!fresh(t) && t.shown?.id !== t.stallId) return momentSkip(t, "stale-answer", "moment.drop", { tag: m.tag });
  const text = m.tag !== "BANK" && m.tag !== "STALL";
  const overrides = m.tag === "ANS" || m.tag === "REPLY";
  const kindForBank = m.tag === "BANK" ? "BANK" : overrides ? "ANS" : m.tag === "STALL" ? "STALL" : "NOTE";
  if (t.hit && !modelMayOverrideBank(t.hit.card.id, { kind: kindForBank, bankId: m.bankId })) {
    clearTimeout(t.stallTimer);
    log.write("events", { type: "stall-tier.kept", turnId: t.id, tag: m.tag, bank: t.hit.card.id });
    t.lat.tag = `${t.lat.tag} (ignored: ${t.hit.card.id} stays)`;
    return;
  }
  if (t.noAgency && (m.tag === "STALL" || m.tag === "BANK")) {
    log.write("events", { type: "agency.gated", turnId: t.id, kind: tracker.kind, tag: m.tag, model: true });
    return momentSkip(t, "agency-gated", "moment.drop", { tag: m.tag });
  }
  if (m.tag === "ANS" && !t.allowAns) {
    m = { ...m, tag: "STALL", stall: "other" };
    t.lat.tag = "STALL (ans-off)";
    log.write("events", { type: "ans.suppressed", turnId: t.id, rung: sup.rung });
  }
  const d = decideMoment(m, {
    source: "direct",
    turnId: t.mid!,
    cardId: m.tag === "BANK" ? `${t.id}-bank2` : `${t.id}-m`,
    lineAt: t.speechEnd,
    hint: "strong",
  });
  if (d.action === "drop") return momentSkip(t, d.reason, "moment.drop", { tag: m.tag, value: m.value, aim: m.aim });
  const chip = d.action === "chip";
  if (chip) logMomentRow("moment.chip", t.id, "direct", d.reason, { tag: m.tag, value: m.value });
  clearTimeout(t.stallTimer);

  if (m.tag === "BANK") {
    const card = resolveBankId(m.bankId, bank, t.lang);
    if (card && t.hit?.card.id === card.id) return; // the model agrees with the card on screen
    if (!card) return momentSkip(t, "unknown-bank-id", "moment.drop", { bankId: m.bankId });
    if (t.shown?.badge === "bank") emitCard({ ...t.shown, withdraw: true });
    if (t.shown?.id === t.stallId) emitCard({ ...t.shown, withdraw: true });
    t.shown = bankMomentCard(card, m, { id: `${t.id}-bank2`, turnId: t.id, question: t.r.text, ctx: t.ctxRec });
    if (chip) t.shown.dim = true;
    emitCard(t.shown);
    t.lat.bankAt ??= Date.now();
    t.lat.cardAt = Date.now();
    st.q.bankShownAt.set(card.id, Date.now());
    return;
  }
  if (m.tag === "STALL") {
    if (!t.shown && !t.noStall && fresh(t)) {
      t.shown = {
        ...momentCard({ ...m, say: stallSay(stall, st.q.turnSeq, t.lang) }, { id: t.stallId, turnId: t.id, question: t.r.text, ctx: t.ctxRec }),
        badge: "stall",
      };
      emitCard(t.shown);
      t.lat.stallAt = Date.now();
    }
    return;
  }
  // A text card. ANS and REPLY are lines the user may say aloud: they pass the guards (price, date, promise) and the language check.
  const ok = sayAllowed(m, t.r.text);
  if (!ok.ok) {
    log.write("events", { type: ok.why!.startsWith("guard") ? "guard" : "reflex.discard", turnId: t.id, rule: ok.why, why: ok.why });
    if (ok.why!.startsWith("guard") && !t.noStall) {
      // A blocked answer on a customer call becomes the stall line (as in the old path).
      if (t.shown?.id !== t.stallId && !t.shown && fresh(t)) {
        t.shown = stallCardFor(t);
        emitCard(t.shown);
        t.lat.stallAt = Date.now();
      }
      return;
    }
    return momentSkip(t, ok.why!, "moment.drop", { tag: m.tag });
  }
  if (t.shown?.id === t.stallId && text && overrides) emitCard({ ...t.shown, withdraw: true }); // the real answer replaces the "buy time" line (never both)
  if (overrides && t.shown?.badge === "bank" && t.shown.turnId === t.id && !(t.hit && STALL_TIER.has(t.hit.card.id))) {
    emitCard({ ...t.shown, withdraw: true }); // the model card replaces the local card
    log.write("events", { type: "withdraw", turnId: t.id, why: "model-card-replaces" });
  }
  const card = momentCard(m, { id: `${t.id}-m`, turnId: t.id, question: t.r.text, ctx: t.ctxRec, dim: chip || meSpokeSince(t) || undefined });
  if (overrides) t.shown = card;
  t.mcard = card;
  if (!t.lat.firstWordAt) t.lat.firstWordAt = Date.now();
  emitCard(card);
  t.lat.cardAt = Date.now();
}

/** The reply is complete: book the cost, mark the model healthy, judge a bad reply, and upsert the card with its WHY and MORE lines. */
function onMomentDone(t: Turn, d: MomentDone) {
  if (t.ac.signal.aborted) return;
  clearTimeout(t.stallTimer);
  bookMomentUsage("moment", t.id, d, t.ctxRec);
  noteMomentOk(d.model);
  log.write("events", { type: "reflex.raw", turnId: t.id, text: d.text });
  t.lat.doneAt = Date.now();
  const bad = d.errors.length > 0 && d.moment.tag === "SKIP";
  const cutOff = d.truncated && !t.mshown && d.moment.tag !== "SKIP";
  if (bad || cutOff) {
    // Garbage, an empty reply or a cut-off one: a failed call. The old rule applies: a stall line when none is up, and the failure counts.
    logMomentRow("moment.invalid", t.id, "direct", cutOff ? "truncated" : (d.errors[0]?.reason ?? "invalid"), { sample: d.errors[0]?.sample });
    t.modelIgnored = true;
    showStallOrError(t, cutOff ? "truncated" : "garbage");
    countReflexFailure(new ProviderError("unknown", "moment", "unusable reply"));
    recordLatency(t.lat);
    return;
  }
  if (!t.mshown && !t.mskip) {
    if (d.moment.tag === "SKIP") momentSkip(t, d.moment.why || "model-skip");
    else
      onMomentPartial(
        t,
        { tag: { tag: d.moment.tag, bankId: d.moment.bankId, stall: d.moment.stall }, fields: d.moment, sayComplete: true, moment: d.moment, errors: [] },
        true,
      );
  }
  if (t.mcard && t.mshown) {
    // WHY and MORE come after the say-line: the same card id, updated.
    const fin = {
      ...t.mshown,
      why: d.moment.why,
      more: d.moment.more,
      ref: d.moment.ref ?? t.mshown.ref,
      ...((d.moment.label ?? t.mshown.label) ? { label: d.moment.label ?? t.mshown.label } : {}),
    };
    const up = {
      ...momentCard(fin, { id: t.mcard.id, turnId: t.id, question: t.r.text, ctx: t.ctxRec, dim: t.mcard.dim, done: true }),
      say: t.mcard.say,
      at: t.mcard.at,
    };
    t.mcard = up;
    if (t.shown?.id === up.id) t.shown = up;
    emitCard(up);
  }
  recordLatency(t.lat);
}

function reflexHandlers(t: Turn): ReflexHandlers {
  const { ac, ai } = t;
  return {
    onTag: (tag) => onTag(t, tag),
    onDiscard: (why) => onDiscard(t, why),
    onSay(text) {
      if (ac.signal.aborted) return;
      if (!t.lat.firstWordAt) t.lat.firstWordAt = Date.now();
      ai.say = text;
    },
    onFacts(f) {
      if (!ac.signal.aborted) ai.facts = f;
    },
    onSayComplete: (say) => onSayComplete(t, say),
    onDone: (info) => onDone(t, info),
    onAbortedUsage: (info) => onAbortedUsage(t, info),
  };
}

/** The model's first token: its decision for this question. The code, not the prompt, enforces the stall tier and the off-topic gate. */
function onTag(t: Turn, tagIn: Tag) {
  const { id: turnId, lat, hit, ai, ac } = t;
  let tag = tagIn;
  if (ac.signal.aborted) return;
  lat.tagAt = Date.now();
  lat.tag = tag.kind + (tag.bankId ? ` ${tag.bankId}` : "");
  sup.recordTag(Number(lat.tagAt) - Number(lat.reqAt));
  if (!modelMayOverrideBank(hit?.card.id, tag)) {
    clearTimeout(t.stallTimer);
    log.write("events", { type: "stall-tier.kept", turnId, tag: tag.kind + (tag.bankId ? ` ${tag.bankId}` : ""), bank: hit?.card.id });
    lat.tag = `${lat.tag} (ignored: ${hit?.card.id} stays)`;
    t.modelIgnored = true;
    return;
  }
  // Off-kind call, not about the user's services: BANK and STALL are not for this question. The code enforces what the prompt asks.
  if (t.noAgency && (tag.kind === "STALL" || tag.kind === "BANK")) {
    clearTimeout(t.stallTimer);
    t.modelIgnored = true;
    lat.tag = `${lat.tag} (gated: ${tracker.kind})`;
    log.write("events", { type: "agency.gated", turnId, kind: tracker.kind, tag: tag.kind, model: true });
    return;
  }
  if (tag.kind === "ANS" && !t.allowAns) {
    tag = { kind: "STALL" };
    lat.tag = "STALL (ans-off)";
    log.write("events", { type: "ans.suppressed", turnId, rung: sup.rung });
  }
  // Off-kind call: the model prefers an answer or a stall over the weak keyword card, so that card goes away.
  // Interview: the prepared card (the user's own words) stays; the model's own version of the same answer is not shown.
  if (interview && hit && t.shown?.badge === "bank" && t.shown.turnId === turnId && tag.kind === "ANS") {
    clearTimeout(t.stallTimer);
    t.modelIgnored = true;
    lat.tag = `${lat.tag} (kept prepared ${hit.card.id})`;
    log.write("events", { type: "interview.kept", turnId, bank: hit.card.id });
    return;
  }
  if ((t.weakBank || t.bgBank) && t.shown?.badge === "bank" && t.shown.turnId === turnId && (tag.kind === "ANS" || tag.kind === "STALL")) {
    emitCard({ ...t.shown, withdraw: true });
    log.write("events", { type: "withdraw", turnId, why: "off-kind" });
    t.shown = undefined;
  }
  if (tag.kind === "SKIP") {
    clearTimeout(t.stallTimer);
    if (t.shown?.id === t.stallId) {
      emitCard({ ...t.shown, withdraw: true });
      log.write("events", { type: "withdraw", turnId, why: "stall-then-skip" });
      t.shown = undefined;
    }
    if (t.weak && t.shown?.badge === "bank" && t.shown.turnId === turnId) {
      emitCard({ ...t.shown, withdraw: true });
      log.write("events", { type: "withdraw", turnId, why: "haiku-skip" });
    }
    return;
  }
  if (tag.kind === "STALL") {
    clearTimeout(t.stallTimer);
    if (!t.shown && !t.noStall && fresh(t)) {
      t.shown = { ...ai, id: t.stallId, badge: "stall", say: stallSay(stall, st.q.turnSeq, t.lang), at: Date.now() };
      emitCard(t.shown);
    }
    return;
  }
  if (tag.kind === "BANK" && tag.bankId && hit?.card.id !== tag.bankId) {
    const card = resolveBankId(tag.bankId, bank, t.lang);
    if (card && hit?.card.id === card.id) {
      clearTimeout(t.stallTimer);
      return;
    } // the model bent the id of the card already on screen
    if (card && fresh(t)) {
      clearTimeout(t.stallTimer);
      if (t.shown?.badge === "bank") emitCard({ ...t.shown, withdraw: true }); // Haiku disagrees with the keyword hit
      t.shown = {
        ...ai,
        id: `${turnId}-bank2`,
        badge: "bank",
        say: card.say,
        facts: card.facts,
        priority: card.id.startsWith("stall-") || undefined,
        at: Date.now(),
      };
      emitCard(t.shown);
      lat.bankAt ??= Date.now();
    }
  }
}

/** The model contradicted its own tag (BANK/STALL/ANS, then SKIP) or answered in the wrong language: the card it made goes away. */
function onDiscard(t: Turn, why: string) {
  if (t.ac.signal.aborted) return;
  clearTimeout(t.stallTimer);
  t.modelIgnored = true;
  t.lat.tag = `${t.lat.tag} (discarded: ${why})`;
  log.write("events", { type: "reflex.discard", turnId: t.id, why });
  if (t.shown && t.shown.turnId === t.id && !(t.shown.badge === "bank" && t.shown.id === `${t.id}-bank` && !t.weak)) {
    emitCard({ ...t.shown, withdraw: true });
    t.shown = undefined;
  }
}

/** Full answer text is ready: guard it, then show it (a guard hit becomes a stall line instead). */
function onSayComplete(t: Turn, say: string) {
  const { id: turnId, lat, ai } = t;
  if (t.ac.signal.aborted || t.modelIgnored) return;
  ai.say = say;
  // A late answer still replaces the "buy time" line already on screen for this question; otherwise a stale answer is dropped.
  if (!/^(ANS|BANK)/.test(String(lat.tag ?? "")) || (!fresh(t) && t.shown?.id !== t.stallId)) return;
  if (String(lat.tag).startsWith("BANK") && t.shown?.badge === "bank") return; // bank card already up
  // The model leaked its own control words into the say-line ("... לכן SKIP עדיף כרגע"): it was not sure, so no card.
  if (leakedTag(ai.say)) {
    clearTimeout(t.stallTimer);
    t.modelIgnored = true;
    log.write("events", { type: "reflex.discard", turnId, why: "leaked-tag" });
    if (t.shown?.id === t.stallId) {
      emitCard({ ...t.shown, withdraw: true });
      t.shown = undefined;
    }
    return;
  }
  const g = interview ? guardInterview(ai.say, interviewAllowed()) : guard(ai.say);
  if (!g.ok) log.write("events", { type: "guard", turnId, rule: g.rule });
  if (!g.ok && t.noStall) {
    clearTimeout(t.stallTimer);
    return;
  } // a blocked answer on a call that is not with a customer: nothing, never a stall line
  const card: Card = g.ok
    ? { ...ai, at: Date.now() }
    : { ...ai, id: t.stallId, badge: "stall", say: stallSay(stall, st.q.turnSeq, t.lang), facts: [], at: Date.now() };
  if (meSpokeSince(t)) card.dim = true;
  clearTimeout(t.stallTimer);
  // The "buy time" line went up while the model was still deciding; the real answer replaces it (never both on screen).
  if (g.ok && t.shown?.id === t.stallId) emitCard({ ...t.shown, withdraw: true });
  t.shown = card;
  emitCard(card);
  lat.cardAt = Date.now();
}

/** Usage the SDK still reported for a reply that was aborted by the next question: it was billed, so it counts toward the cost and the budget. */
function onAbortedUsage(t: Turn, { usage, providerMetadata, model }: { usage: unknown; providerMetadata: unknown; model: string }) {
  const c = cost.addLlm("reflex", model, usage, providerMetadata);
  log.write("usage", {
    role: "reflex",
    model,
    prompt: PROMPT_V,
    turnId: t.id,
    usage,
    providerMetadata,
    usd: c.usd,
    roleTotalUsd: cost.roles.reflex.usd,
    aborted: true,
  });
}

/** Stream finished: book the cost, mark the model healthy, and upsert the card with its (guarded) facts. */
function onDone(t: Turn, { usage, providerMetadata, text, model }: Parameters<ReflexHandlers["onDone"]>[0]) {
  const { id: turnId, ai } = t;
  // A turn aborted by the next question does not get here; its usage is booked by onAbortedUsage, but only if the SDK reports it after the abort
  // (ai 7 normally rejects the usage promise on abort, so those tokens stay an undercount in budget.maxUsdPerCall; see docs).
  if (t.ac.signal.aborted) return;
  clearTimeout(t.stallTimer);
  st.q.reflexErrors = 0;
  healthClear("ai");
  clearAiBar(model);
  breakers.get(model)?.success();
  sup.noteLlmOk();
  refreshSignals();
  const c = cost.addLlm("reflex", model, usage, providerMetadata);
  log.write("usage", { role: "reflex", model, prompt: PROMPT_V, turnId, usage, providerMetadata, usd: c.usd, roleTotalUsd: cost.roles.reflex.usd });
  log.write("events", { type: "reflex.raw", turnId, text });
  if (t.shown && t.shown.badge === "ai") {
    // Upsert the same id: it carries "done" (the stream ended) and, when they pass the guard, the facts.
    let facts = t.shown.facts;
    if (ai.facts.length) {
      const g = (interview ? guardInterview : guard)(ai.facts.join(" "));
      if (g.ok) facts = ai.facts;
      else log.write("events", { type: "guard", turnId, rule: g.rule, where: "facts" });
    }
    t.shown = { ...t.shown, facts, done: true };
    emitCard(t.shown);
  }
  t.lat.doneAt = Date.now();
  recordLatency(t.lat);
}

/** The reflex call failed. */
function onReflexError(t: Turn, e: ProviderError) {
  const { id: turnId, lat } = t;
  clearTimeout(t.stallTimer);
  lat.aborted = t.ac.signal.aborted ? 1 : 0;
  if (t.ac.signal.aborted) {
    recordLatency(lat);
    return;
  }
  const kind = e?.kind ?? "unknown";
  log.write("events", { type: kind === "refusal" ? "reflex.empty" : "reflex.error", turnId, kind, error: errBrief(e) });
  console.error("reflex error:", errBrief(e));
  showStallOrError(t, kind);
  recordLatency(lat);
  if (kind !== "refusal") countReflexFailure(e);
}

/** Error kinds that put the "buy time" line up when nothing else is on screen. Not auth, quota, spend cap or a bad request: those have their own red/amber bar and a
 *  stall line would pretend the AI is only slow. */
const STALL_ON = new Set(["refusal", "timeout", "network", "overload", "rate", "unknown", "garbage", "truncated"]);
/** A failed model call must never leave an empty screen: the stall line, once, if no card is up for this turn. */
function showStallOrError(t: Turn, kind: string) {
  if (!STALL_ON.has(kind) || t.shown || t.noStall || !fresh(t)) return;
  t.shown = stallCardFor(t);
  emitCard(t.shown);
  t.lat.stallAt = Date.now();
}

/** Counts a failed model call. 2 in a row raise the "AI not answering" bar; an ask by the user (`userAsk`) raises it on the first one. */
export function countReflexFailure(e: ProviderError, userAsk = false) {
  if (++st.q.reflexErrors >= (userAsk ? 1 : 2)) health("ai", "amber", ht(UI_LANG, "ai.silent"), String(e?.message ?? e));
}
/** A model call worked: the failure count starts again. */
export function noteReflexOk() {
  st.q.reflexErrors = 0;
}
