// A question from the other side: prepared bank card, "buy time" line, calc, and the model answer behind them. One Turn per question.
// This file routes (skip, open a turn, bank, calc, rung); the model call is in question-moment.ts (Live reading) or question-classic.ts (the rollback).
import { getTurnLang, matchBank, matchBankFor, matchBankSmart, questionLang, priceOffTopic, STALL_TIER, type BankHit } from "../bank.ts";
import { evalMath } from "../calc.ts";
import { isClearQuestion } from "../detector.ts";
import { addressesYou, addressesUser } from "../lang/address.ts";
import { isBankRepeat, agencyGate, questionSkip } from "./rules.ts";
import type { SttResult } from "../providers/stt/types.ts";
import { isAgencyKind, isAgencyTopic } from "../frame.ts";
import { survived } from "./out.ts";
import { emitCard, recordLatency, type Card, focusWorthy } from "./cards.ts";
import { log, interview, bank, sup, S, noAi, background, flow, flowOn } from "./boot.ts";
import { usableModels, v2Active, currentPause } from "./degrade.ts";
import { toCandidates, noteLang } from "./moments.ts";
import { st } from "./state.ts";

// st.q: turnSeq, reflexErrors (consecutive model failures: 2 in a row raise the "AI not answering" bar, 1 for an ask by the user; a success clears it)
// and bankShownAt (per-call state, see state.ts).
import { type Turn, type QScope, askKind, fresh, stallCardFor, showStallOrError } from "./turn.ts";
import { askMoment } from "./question-moment.ts";
import { askModel } from "./question-classic.ts";

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
  t.agencyTopic = isAgencyTopic(r.text, askKind());
  t.agencyRecent = Date.now() - st.turn.lastAgencyTopicAt < 60_000;
  if (t.agencyTopic) st.turn.lastAgencyTopicAt = Date.now();
  ({ noAgency: t.noAgency, noStall: t.noStall } = agencyGate({
    interview,
    kind: askKind(),
    kindIsAgency: !!askKind() && isAgencyKind(askKind()),
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
  if (t.noAgency && matchBank(r.text, bank)) log.write("events", { type: "agency.gated", turnId, kind: askKind() });
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
  const offKind = !interview && !!askKind() && !isAgencyKind(askKind());
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
    (!interview && !askKind() && !!hit && !STALL_TIER.has(hit.card.id) && !t.agencyTopic && !t.agencyRecent) ||
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
