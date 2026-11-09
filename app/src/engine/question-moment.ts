// Live reading (moments.engine = v2): the moment call for a direct question. question.ts decides that a question gets a turn and shows the local card (bank, calc);
// this file runs the model call and turns its verdict into a card.
import { stallSay, modelMayOverrideBank, STALL_TIER } from "../bank.ts";
import { resolveBankId } from "../reflex.ts";
import { ProviderError } from "../providers/errors.ts";
import { errBrief } from "./out.ts";
import { emitCard, recordLatency, noteModel } from "./cards.ts";
import { stall, log, bank, sup, S, registry } from "./boot.ts";
import {
  momentContext,
  rawTail,
  decideMoment,
  momentCard,
  bankMomentCard,
  sayAllowed,
  logMomentRow,
  bookMomentUsage,
  noteMomentOk,
  noteMomentFail,
  noteMomentSwitch,
  ensureSeeded,
} from "./moments.ts";
import { runMoment, type MomentDone } from "../moments/run.ts";
import { momentFromParsed, type ParsedMoment } from "../moments/parse.ts";
import type { Moment } from "../moments/types.ts";
import { st } from "./state.ts";
import { nameWords } from "../profile.ts";
import { addressedElsewhere } from "../moments/floor.ts";

// st.q: turnSeq, reflexErrors (consecutive model failures: 2 in a row raise the "AI not answering" bar, 1 for an ask by the user; a success clears it)
// and bankShownAt (per-call state, see state.ts).
import { type Turn, askKind, fresh, meSpokeSince, stallCardFor, onReflexError, showStallOrError, countReflexFailure } from "./turn.ts";

// ---------------------------------------------------------------- v2: the moment call for a direct question (a strong hint)
// The local card (bank, calc) is already up. The moment call decides: SKIP withdraws a weak local card and the stall line; a text card replaces the
// local one; BANK with the same id changes nothing. Every verdict passes the scheduler (value, aim, novelty, cap) and the guards. A stream of an
// older question (turn id) cannot show anything. A failed call, a cut-off reply or garbage never leaves a direct question with an empty screen
// when stall lines are on: the stall timer, showStallOrError.
export function askMoment(t: Turn, usable: string[]): Promise<void> {
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
  presentMoment(t, momentFromParsed(p.tag, f));
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

/** The line opens with the name of another person of the call ("Dana, can you ..."): a stall line under it would speak for the user to nobody. */
function askedOfSomeoneElse(t: Turn): boolean {
  const roster = st.m.mem.roster;
  const others = roster.filter((p) => p.side !== "me").map((p) => p.name);
  const me = [...nameWords(), ...roster.filter((p) => p.side === "me").map((p) => p.name)];
  return addressedElsewhere(t.r.text, others, me);
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
    log.write("events", { type: "agency.gated", turnId: t.id, kind: askKind(), tag: m.tag, model: true });
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
      // A blocked answer on a customer call becomes the stall line (as in the old path), unless the question opens with another person's name or a card is already up.
      if (t.shown?.id !== t.stallId && !t.shown && !t.mcard && fresh(t) && !askedOfSomeoneElse(t)) {
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
      ...((d.moment.about ?? t.mshown.about) ? { about: d.moment.about ?? t.mshown.about } : {}),
      ...((d.moment.val ?? t.mshown.val) ? { val: d.moment.val ?? t.mshown.val } : {}),
      ...((t.mshown.conf ?? d.moment.conf) ? { conf: t.mshown.conf ?? d.moment.conf } : {}),
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
