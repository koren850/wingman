// A question from the other side: prepared bank card, "buy time" line, calc, and the streamed Claude reflex answer behind them. One Turn per question.
import { getTurnLang, matchBank, matchBankFor, priceOffTopic, stallSay, modelMayOverrideBank, STALL_TIER, type BankHit } from "../bank.ts";
import { evalMath } from "../calc.ts";
import { isClearQuestion, addressesYou } from "../detector.ts";
import { guard, guardInterview } from "../guards.ts";
import { runReflex, resolveBankId, leakedTag, type Tag, type ReflexHandlers } from "../reflex.ts";
import type { SttResult } from "../providers/stt/types.ts";
import { describe, type ProviderError } from "../providers/errors.ts";
import { frameText, isAgencyKind, isAgencyTopic } from "../frame.ts";
import { health, errBrief, healthClear, survived } from "./out.ts";
import { emitCard, recordLatency, type Card, focusWorthy } from "./cards.ts";
import { stall, log, interview, cost, breakers, bank, sup, tracker, contextNotes, prefix, S, registry, lineOf, transcript, noAi, background, flow, flowOn } from "./boot.ts";
import { refreshSignals, llmFailed, usableModels } from "./degrade.ts";
import { interviewAllowed } from "./selfcheck.ts";
import { st } from "./state.ts";

let turnSeq = 0;
let reflexErrors = 0;   // consecutive reflex failures; 2 in a row raise the "AI not answering" bar, a success clears it
const bankShownAt = new Map<string, number>();

/** One question while its card is built. `shown` is the card on screen for this question; `modelIgnored` is set when the model's answer must not be shown. */
interface Turn {
  id: string; r: SttResult; reason: string; speechEnd: number; ac: AbortController;
  lat: Record<string, number | string>;   // one row of latency.jsonl
  hit?: BankHit;                           // the prepared card matched by keywords
  agencyTopic: boolean; agencyRecent: boolean;
  noAgency: boolean; noStall: boolean;
  weak: boolean; weakBank: boolean; bgBank: boolean; bankOnly: boolean; allowAns: boolean;
  lang?: "he" | "en"; shown?: Card; modelIgnored: boolean; stallTimer?: NodeJS.Timeout; stallId: string; ai: Card;
}
/** Answers older than reflex.dropStaleMs are never shown. */
const fresh = (t: Turn) => Date.now() - t.speechEnd < S.reflex.dropStaleMs;
const meSpokeSince = (t: Turn) => st.voice.lastMeVoiced > t.speechEnd;
/** The "buy time" line for this question. */
const stallCardFor = (t: Turn): Card => ({ id: t.stallId, turnId: t.id, badge: "stall", question: t.r.text, say: stallSay(stall, turnSeq, t.lang), facts: [], at: Date.now() });

/** A question from the other side. Order of work:
 *  1. calc: pure arithmetic is answered locally, no model.
 *  2. bank: a keyword match shows a prepared card at once (dimmed when "weak").
 *  3. no usable AI (degraded rungs): a stall line if nothing matched.
 *  4. AI: a stall timer (reflex.stallAfterMs) shows "buy time" if nothing is up yet; meanwhile the model streams a tag
 *     (BANK / ANS / STALL / SKIP) that can confirm, replace or withdraw the card, then the answer text, which passes the guards.
 *  A newer question aborts this one (`current`). Answers older than reflex.dropStaleMs are never shown (`fresh`). `reason` is the detector's reason string. */
export function onQuestion(r: SttResult, reason = "") { try { onQuestionCore(r, reason); } catch (e) { survived("onQuestion", e); } }
function onQuestionCore(r: SttResult, reason = "") {
  if (skipQuestion(r, reason)) return;
  const t = openTurn(r, reason);
  pickBank(t);
  if (answerArithmetic(t)) return;
  weighBank(t);

  // Degradation ladder (health.ts): the rung in force for this question (it only changes between questions).
  // beginQuestion/endQuestion tell the supervisor a question is in flight, so it does not change rung mid-answer.
  const caps = sup.caps, usable = usableModels();
  sup.beginQuestion();
  let ended = false;
  const end = () => { if (!ended) { ended = true; sup.endQuestion(); } };
  const useAi = !noAi && !t.bankOnly && caps.llm && usable.length > 0;
  // Interview: a slow AI (reduced rung) still answers; a late answer is worth more than none there. Spend cap / no AI still stop it (caps.llm).
  t.allowAns = S.reflex.allowAns && (caps.ans || (interview && caps.llm));

  if (t.hit) showBank(t, t.hit);
  if (!useAi) {
    // Degraded (not by --no-ai): no LLM, so a question without a bank card gets the stall line, as the ladder promises.
    if (!noAi && !t.bankOnly && !t.noStall && !t.shown && fresh(t)) { t.shown = stallCardFor(t); emitCard(t.shown); t.lat.stallAt = Date.now(); }
    recordLatency(t.lat); end(); return;
  }

  // If neither the bank nor the model has put a card up by then, show the "buy time" line so the user is never left with a blank screen.
  t.stallTimer = setTimeout(() => {
    if (t.ac.signal.aborted) return;
    if (!t.shown && !t.noStall && fresh(t)) { t.shown = stallCardFor(t); emitCard(t.shown); t.lat.stallAt = Date.now(); }
  }, S.reflex.stallAfterMs);

  askModel(t, usable).finally(end);
}

/** Lines that are not questions for the user (or not worth a card): logged and dropped before a turn starts. */
function skipQuestion(r: SttResult, reason: string): boolean {
  // "If ..." openers in a work meeting are mostly people thinking aloud (in review, few were useful). Only when aimed at the user.
  if (!interview && reason.startsWith("if-open") && !addressesYou(r.text)) { log.write("events", { type: "ifopen.skip", text: r.text.slice(0, 120) }); return true; }
  // Interview: a line that only starts with a question word ("יש משימת בית", "צריך לקחת בחשבון") is the interviewer talking, not asking.
  // In real use, most such turns ended in SKIP. Ask the model only when it speaks to the user or matches a prepared card.
  if (interview && reason.startsWith("head") && !addressesYou(r.text) && !matchBank(r.text, bank)) { log.write("events", { type: "head.skip", text: r.text.slice(0, 120) }); return true; }
  if (S.cards.focus && !interview && !focusWorthy(r.text, reason)) { log.write("events", { type: "focus.skip", reason, text: r.text.slice(0, 120) }); return true; }
  // Their own discussion: the question is for one of them, not the user. Price/date ("buy time") cards still show.
  if (flowOn && S.flow.holdCards && flow.internal && !matchBankFor(r.text, bank)?.card.id.startsWith("stall-")) { log.write("events", { type: "flow.hold", reason, text: r.text.slice(0, 120) }); return true; }
  return false;
}

/** Starts the turn: ids, the latency row, and aborts the answer to the previous question. */
function openTurn(r: SttResult, reason: string): Turn {
  const id = `q${++turnSeq}`;
  const speechEnd = r.speechEndWall ?? r.arrivedAt;
  const lat: Record<string, number | string> = { turnId: id, speechEnd, finalAt: r.arrivedAt, text: r.text };
  st.turn.current?.abort();
  const ac = (st.turn.current = new AbortController());
  return {
    id, r, reason, speechEnd, ac, lat, agencyTopic: false, agencyRecent: false, noAgency: false, noStall: false,
    weak: false, weakBank: false, bgBank: false, bankOnly: reason.startsWith("problem"), allowAns: false,   // a "problem" is a guessed question (not a clear one): never an AI answer on it
    modelIgnored: false, stallId: `${id}-stall`, ai: { id: `${id}-ai`, turnId: id, badge: "ai", question: r.text, say: "", facts: [], at: 0 },
  };
}

/** Finds the prepared card for this question, and decides whether Wingman may speak for the user here at all (noAgency, noStall). */
function pickBank(t: Turn) {
  const { r, reason, id: turnId } = t;
  // Not a client / support call (frame, after hysteresis) and the question is not about the user's web / hosting services: Wingman never
  // speaks for the user here. No agency bank card and no stall line, whatever the keywords say (team meeting, interview, friend, supplier).
  // A short follow-up ("יהיה מוכן?", "את הדומיין?") has no topic word of its own: it counts as agency talk for 60 s after one that did (the frame can also guess "vendor" wrongly).
  t.agencyTopic = isAgencyTopic(r.text); t.agencyRecent = Date.now() - st.turn.lastAgencyTopicAt < 60_000;
  if (t.agencyTopic) st.turn.lastAgencyTopicAt = Date.now();
  t.noAgency = !interview && !!tracker.kind && !isAgencyKind(tracker.kind) && !t.agencyTopic && !t.agencyRecent;
  t.noStall = t.noAgency || interview || !S.reflex.stall;   // an interview never gets a "buy time" line; elsewhere only when reflex.stall is on
  let hit = interview ? matchBank(r.text, bank) : t.noAgency ? undefined : matchBankFor(r.text, bank);   // stall-price is dropped for arithmetic and for prices that are not the user's services
  // The same prepared card twice in one call is almost always a keyword echo (one card fired three times while the other side talked about their own team).
  // A repeat shows only for a clear question at least 2 minutes after the last time.
  t.lang = getTurnLang();   // fixed for this turn: a newer question must not flip a reply that is still streaming
  if (hit && !STALL_TIER.has(hit.card.id)) {
    const seen = bankShownAt.get(hit.card.id);
    if (seen !== undefined && !(isClearQuestion(r.text, reason) && Date.now() - seen > 120_000)) { log.write("events", { type: "bank.repeat", turnId, bank: hit.card.id }); hit = undefined; }
  }
  if (t.noAgency && matchBank(r.text, bank)) log.write("events", { type: "agency.gated", turnId, kind: tracker.kind });
  if (!hit && !t.noAgency && matchBank(r.text, bank)?.card.id === "stall-price") log.write("events", { type: "stall.suppressed", turnId, why: priceOffTopic(r.text) ?? "off-topic" });
  t.hit = hit;
}

/** Arithmetic from the other side ("כמה זה 36 ועוד 42?"): the local answer, instantly, no model. Returns true when it answered. */
function answerArithmetic(t: Turn): boolean {
  // A price verb ("כמה זה יעלה 3 כפול 450") already makes evalMath return nothing (calc.ts hasPriceVerb), so no calc card reaches a price question.
  const math = evalMath(t.r.text);
  if (!math || !fresh(t)) return false;
  const card: Card = { id: `${t.id}-calc`, turnId: t.id, badge: "ai", source: "calc", question: t.r.text, say: math.say, facts: [], at: Date.now() };
  emitCard(card); t.lat.cardAt = Date.now(); t.lat.tag = "CALC";
  log.write("events", { type: "calc", turnId: t.id, expr: math.expr, result: math.result });
  recordLatency(t.lat); st.turn.current = undefined; return true;
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
  t.weak = (reason.startsWith("head:") && !(hit && hit.score >= 2)) || reason.startsWith("problem") || t.weakBank || (!interview && !tracker.kind && !!hit && !STALL_TIER.has(hit.card.id) && !t.agencyTopic && !t.agencyRecent) || t.bgBank;
}

/** The prepared card goes up at once. */
function showBank(t: Turn, hit: BankHit) {
  t.shown = { id: `${t.id}-bank`, turnId: t.id, badge: "bank", question: t.r.text, say: hit.card.say, facts: hit.card.facts, dim: t.weak || undefined, priority: hit.card.id.startsWith("stall-") || undefined, at: Date.now() };
  emitCard(t.shown); t.lat.bankAt = Date.now(); t.lat.bankId = hit.card.id; bankShownAt.set(hit.card.id, Date.now());
}

/** Streams the model's answer for this question. */
function askModel(t: Turn, usable: string[]): Promise<void> {
  const { r } = t;
  const recent = transcript.slice(-12).map(lineOf).join("\n");
  t.lat.reqAt = Date.now();
  return runReflex({
    registry, models: usable, cfg: S.llm.reflex, prefix, transcript: recent, question: r.text, context: contextNotes, signal: t.ac.signal,
    frame: frameText(tracker.current) || undefined, weakBank: t.weakBank ? t.hit!.card.id : undefined, noAgency: t.noAgency, anyLanguage: interview,
    onFail: (model, err) => llmFailed(model, err),
    onSwitch: (from, to, err) => { log.write("events", { type: "llm.switch", turnId: t.id, from, to, kind: err.kind }); console.log(`\n↪ AI ${from} -> ${to} (${describe(err)})`); },
    h: reflexHandlers(t),
  }).then(() => {}, (e: ProviderError) => onReflexError(t, e));
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
    onFacts(f) { if (!ac.signal.aborted) ai.facts = f; },
    onSayComplete: (say) => onSayComplete(t, say),
    onDone: (info) => onDone(t, info),
  };
}

/** The model's first token: its decision for this question. The code, not the prompt, enforces the stall tier and the off-topic gate. */
function onTag(t: Turn, tagIn: Tag) {
  const { id: turnId, lat, hit, ai, ac } = t;
  let tag = tagIn;
  if (ac.signal.aborted) return;
  lat.tagAt = Date.now(); lat.tag = tag.kind + (tag.bankId ? ` ${tag.bankId}` : "");
  sup.recordTag(Number(lat.tagAt) - Number(lat.reqAt));
  if (!modelMayOverrideBank(hit?.card.id, tag)) {
    clearTimeout(t.stallTimer); log.write("events", { type: "stall-tier.kept", turnId, tag: tag.kind + (tag.bankId ? ` ${tag.bankId}` : ""), bank: hit?.card.id });
    lat.tag = `${lat.tag} (ignored: ${hit?.card.id} stays)`; t.modelIgnored = true; return;
  }
  // Off-kind call, not about the user's services: BANK and STALL are not for this question. The code enforces what the prompt asks.
  if (t.noAgency && (tag.kind === "STALL" || tag.kind === "BANK")) {
    clearTimeout(t.stallTimer); t.modelIgnored = true; lat.tag = `${lat.tag} (gated: ${tracker.kind})`;
    log.write("events", { type: "agency.gated", turnId, kind: tracker.kind, tag: tag.kind, model: true }); return;
  }
  if (tag.kind === "ANS" && !t.allowAns) { tag = { kind: "STALL" }; lat.tag = "STALL (ans-off)"; log.write("events", { type: "ans.suppressed", turnId, rung: sup.rung }); }
  // Off-kind call: the model prefers an answer or a stall over the weak keyword card, so that card goes away.
  // Interview: the prepared card (the user's own words) stays; the model's own version of the same answer is not shown.
  if (interview && hit && t.shown?.badge === "bank" && t.shown.turnId === turnId && tag.kind === "ANS") {
    clearTimeout(t.stallTimer); t.modelIgnored = true; lat.tag = `${lat.tag} (kept prepared ${hit.card.id})`; log.write("events", { type: "interview.kept", turnId, bank: hit.card.id }); return;
  }
  if ((t.weakBank || t.bgBank) && t.shown?.badge === "bank" && t.shown.turnId === turnId && (tag.kind === "ANS" || tag.kind === "STALL")) { emitCard({ ...t.shown, withdraw: true }); log.write("events", { type: "withdraw", turnId, why: "off-kind" }); t.shown = undefined; }
  if (tag.kind === "SKIP") {
    clearTimeout(t.stallTimer);
    if (t.shown?.id === t.stallId) { emitCard({ ...t.shown, withdraw: true }); log.write("events", { type: "withdraw", turnId, why: "stall-then-skip" }); t.shown = undefined; }
    if (t.weak && t.shown?.badge === "bank" && t.shown.turnId === turnId) { emitCard({ ...t.shown, withdraw: true }); log.write("events", { type: "withdraw", turnId, why: "haiku-skip" }); }
    return;
  }
  if (tag.kind === "STALL") {
    clearTimeout(t.stallTimer);
    if (!t.shown && !t.noStall && fresh(t)) { t.shown = { ...ai, id: t.stallId, badge: "stall", say: stallSay(stall, turnSeq, t.lang), at: Date.now() }; emitCard(t.shown); }
    return;
  }
  if (tag.kind === "BANK" && tag.bankId && hit?.card.id !== tag.bankId) {
    const card = resolveBankId(tag.bankId, bank, t.lang);
    if (card && hit?.card.id === card.id) { clearTimeout(t.stallTimer); return; }   // the model bent the id of the card already on screen
    if (card && fresh(t)) {
      clearTimeout(t.stallTimer);
      if (t.shown?.badge === "bank") emitCard({ ...t.shown, withdraw: true }); // Haiku disagrees with the keyword hit
      t.shown = { ...ai, id: `${turnId}-bank2`, badge: "bank", say: card.say, facts: card.facts, priority: card.id.startsWith("stall-") || undefined, at: Date.now() }; emitCard(t.shown); lat.bankAt ??= Date.now();
    }
  }
}

/** The model contradicted its own tag (BANK/STALL/ANS, then SKIP) or answered in the wrong language: the card it made goes away. */
function onDiscard(t: Turn, why: string) {
  if (t.ac.signal.aborted) return;
  clearTimeout(t.stallTimer); t.modelIgnored = true; t.lat.tag = `${t.lat.tag} (discarded: ${why})`;
  log.write("events", { type: "reflex.discard", turnId: t.id, why });
  if (t.shown && t.shown.turnId === t.id && !(t.shown.badge === "bank" && t.shown.id === `${t.id}-bank` && !t.weak)) { emitCard({ ...t.shown, withdraw: true }); t.shown = undefined; }
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
    clearTimeout(t.stallTimer); t.modelIgnored = true; log.write("events", { type: "reflex.discard", turnId, why: "leaked-tag" });
    if (t.shown?.id === t.stallId) { emitCard({ ...t.shown, withdraw: true }); t.shown = undefined; }
    return;
  }
  const g = interview ? guardInterview(ai.say, interviewAllowed()) : guard(ai.say);
  if (!g.ok) log.write("events", { type: "guard", turnId, rule: g.rule });
  if (!g.ok && t.noStall) { clearTimeout(t.stallTimer); return; }   // a blocked answer on a call that is not with a customer: nothing, never a stall line
  const card: Card = g.ok ? { ...ai, at: Date.now() } : { ...ai, id: t.stallId, badge: "stall", say: stallSay(stall, turnSeq, t.lang), facts: [], at: Date.now() };
  if (meSpokeSince(t)) card.dim = true;
  clearTimeout(t.stallTimer);
  // The "buy time" line went up while the model was still deciding; the real answer replaces it (never both on screen).
  if (g.ok && t.shown?.id === t.stallId) emitCard({ ...t.shown, withdraw: true });
  t.shown = card; emitCard(card); lat.cardAt = Date.now();
}

/** Stream finished: book the cost, mark the model healthy, and upsert the card with its (guarded) facts. */
function onDone(t: Turn, { usage, providerMetadata, text, model }: Parameters<ReflexHandlers["onDone"]>[0]) {
  const { id: turnId, ai } = t;
  if (t.ac.signal.aborted) return;
  clearTimeout(t.stallTimer);
  reflexErrors = 0; healthClear("ai"); breakers.get(model)?.success(); refreshSignals();
  const c = cost.addLlm("reflex", model, usage, providerMetadata);
  log.write("usage", { role: "reflex", model, turnId, usage, providerMetadata, usd: c.usd, roleTotalUsd: cost.roles.reflex.usd });
  log.write("events", { type: "reflex.raw", turnId, text });
  if (t.shown && t.shown.badge === "ai" && ai.facts.length) {
    const g = (interview ? guardInterview : guard)(ai.facts.join(" "));
    if (g.ok) emitCard({ ...t.shown, facts: ai.facts }); // upsert same id with facts
    else log.write("events", { type: "guard", turnId, rule: g.rule, where: "facts" });
  }
  t.lat.doneAt = Date.now();
  recordLatency(t.lat);
}

/** The reflex call failed. */
function onReflexError(t: Turn, e: ProviderError) {
  const { id: turnId, lat } = t;
  clearTimeout(t.stallTimer);
  lat.aborted = t.ac.signal.aborted ? 1 : 0; recordLatency(lat);
  if (t.ac.signal.aborted) return;
  const kind = e?.kind ?? "unknown";
  log.write("events", { type: kind === "refusal" ? "reflex.empty" : "reflex.error", turnId, kind, error: errBrief(e) });
  console.error("reflex error:", errBrief(e));
  // L5/L6: refusal, empty answer or timeout: show the stall line if nothing is up yet.
  if ((kind === "refusal" || kind === "timeout") && !t.shown && !t.noStall && fresh(t)) { t.shown = stallCardFor(t); emitCard(t.shown); }
  if (kind !== "refusal" && ++reflexErrors >= 2) health("ai", "amber", "AI לא עונה: מוצגים רק כרטיסים מוכנים מראש. בדוק חיבור לאינטרנט ומפתח ב-Settings", String(e?.message ?? e));
}
