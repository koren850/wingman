// Classic (moments.engine = legacy, the rollback): the reflex call for a question from the other side, with its tag handlers.
// question.ts decides that a question gets a turn and shows the local card (bank, calc); this file streams the model answer behind it.
import { stallSay, modelMayOverrideBank } from "../bank.ts";
import { guard, guardInterview } from "../guards.ts";
import { runReflex, resolveBankId, leakedTag, type Tag, type ReflexHandlers } from "../reflex.ts";
import { describe, ProviderError } from "../providers/errors.ts";
import { localTail, memoryForAsk } from "./tail.ts";
import { errBrief, healthClear } from "./out.ts";
import { emitCard, recordLatency, noteModel, type Card } from "./cards.ts";
import { stall, log, interview, cost, breakers, bank, sup, contextNotes, prefix, S, registry, lineOf, transcript, PROMPT_V } from "./boot.ts";
import { refreshSignals, llmFailed, clearAiBar } from "./degrade.ts";
import { interviewAllowed } from "./selfcheck.ts";
import { st } from "./state.ts";

// st.q: turnSeq, reflexErrors (consecutive model failures: 2 in a row raise the "AI not answering" bar, 1 for an ask by the user; a success clears it)
// and bankShownAt (per-call state, see state.ts).
import { type Turn, askKind, fresh, meSpokeSince, onReflexError, countReflexFailure } from "./turn.ts";

/** Streams the model's answer for this question. */
export function askModel(t: Turn, usable: string[]): Promise<void> {
  const { r } = t;
  // The paused-AI and legacy path has no memory loop: it reads what the call memory knows (session.json, kept by the v2 loop when it ran) and a plain tail.
  const recent = localTail(transcript.map(lineOf));
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
    frame: memoryForAsk(st.m.mem) || undefined,
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
    lat.tag = `${lat.tag} (gated: ${askKind()})`;
    log.write("events", { type: "agency.gated", turnId, kind: askKind(), tag: tag.kind, model: true });
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
