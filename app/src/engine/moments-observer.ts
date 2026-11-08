// The observer path of the moment engine (moments.engine = v2): lines without a clear question wait in the observer window; a due window becomes
// one `observer` model call, and its verdict becomes a card through the same scheduler and guards as the direct path (moments.ts).
import { emitCard, recordLatency, noteModel, checkBook, closeCards, type Card } from "./cards.ts";
import { st, callKind } from "./state.ts";
import { S, log, sup, tracker, speakers, interview, registry, bank, stall, observer, notesAbort } from "./boot.ts";
import { nameRegex } from "../profile.ts";
import { type ContextOutput } from "../context/build.ts";
import { SHORTER } from "../moments/prompt.ts";
import { momentFromParsed } from "../moments/parse.ts";
import { modeProfile } from "../moments/modes.ts";
import { localCue } from "../moments/cue.ts";
import { speedHint, speedReason, SHORT_LINE_WORDS, type SpeedCtx } from "../moments/hint.ts";
import type { TurnFeatures } from "../moments/intake.ts";
import type { HintLevel, Moment } from "../moments/types.ts";
import { runMoment, type MomentDone } from "../moments/run.ts";
import type { ParsedMoment } from "../moments/parse.ts";
import type { ObserverWindow } from "../moments/observer.ts";
import { resolveBankId } from "../reflex.ts";
import { stallSay } from "../bank.ts";
import { isAgencyKind, isAgencyTopic } from "../frame.ts";
import { ProviderError } from "../providers/errors.ts";
import { errBrief, survived } from "./out.ts";
import { agencyGate } from "./rules.ts";
import { usableModels, v2Active } from "./degrade.ts";

import { wordCount } from "../text-util.ts";
import {
  routeThem,
  rawTail,
  countFailure,
  momentContext,
  decideMoment,
  momentCard,
  logMomentRow,
  bookMomentUsage,
  noteMomentOk,
  noteMomentFail,
  noteMomentSwitch,
  sayAllowed,
  bankMomentCard,
} from "./moments.ts";

// ---------------------------------------------------------------- the observer path
let lineSeq = 0;
let obsTimer: NodeJS.Timeout | undefined;
let obsAc: AbortController | undefined;
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
    const long = wordCount(o.text) >= WORTH_A_LOOK_WORDS;
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
  // Any trigger: when the newest line of the window is a question the direct path already took, a second call would show a second card for one line.
  if (w.trigger === "silence" || w.lines.at(-1)?.asked) {
    // The question to the user got no answer in 2 s. If a card was shown since that line, the direct call did its job: nothing to add.
    const askedAt = w.lines.findLast((l) => l.asked)?.at ?? 0;
    // A direct call that is still on its way (a slow model) will answer: a second call would give a duplicate card and cost.
    if (st.m.directBusy > 0 || st.m.sched.shown.some((r) => r.at >= askedAt)) {
      log.write("events", { type: "moment.observer-drop", why: st.m.directBusy > 0 ? "answering" : "answered", trigger: w.trigger, lines: w.lines.length });
      // A silence window gives its slot and lines back and waits. Any other trigger just ends: giving the lines back would fire the same window again at once.
      if (w.trigger === "silence") {
        observer.unfire(w); // no call was made: the slot and the waiting lines come back
        arm();
      }
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
    skipped = false,
    allowLong = false; // true on the retry: a SAY that is still long is taken as cut
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
    // A SAY over 14 words waits for the end of the reply: one retry asks for a shorter one (an observer card is not in a hurry). On the retry the cut text is taken as it is.
    if (textTag && p.long && !allowLong && !final) return;
    const m: Moment = momentFromParsed(p.tag, f);
    if (textTag && !m.say) return;
    shown = true;
    presentObserver(m, { turnId, cardId, question, lineAt, ctx: ctx.record, lat, hintText: last?.text ?? "" });
  };
  const env: FinishEnv = { turnId, ctx, lat, tryShow, shown: () => shown, skipped: () => skipped, aborted: () => ac.signal.aborted, question, cardId };
  const attempt = (c: ContextOutput, retry: boolean) =>
    runMoment({
      registry,
      models,
      role: "observer",
      ctx: c,
      cfg: { ...S.llm.reflex, timeoutMs: Math.min(S.llm.reflex.timeoutMs, 5000) },
      maxTokens: 200,
      signal,
      onFail: (m, e) => noteMomentFail(m, e),
      onSwitch: (a, b, e) => noteMomentSwitch(turnId, a, b, e),
      onHung: (m, e) => noteMomentFail(m, e),
      h: {
        onPartial: (p) => tryShow(p, false),
        onDone: (d) => {
          if (!retry && wantsShorter(d, shown, skipped)) return void (tooLong = d); // the retry runs after this call is closed
          finishObserver(d, env);
        },
        onAbortedUsage: (u) => bookMomentUsage("observer", turnId, u, undefined, true),
      },
    });
  let tooLong: MomentDone | undefined;
  try {
    await attempt(ctx, false);
    if (tooLong && !ac.signal.aborted) {
      // The card text had more than 14 words. One more call, with a short "shorter" instruction. Its cost is booked; the first reply is never shown.
      bookMomentUsage("observer", turnId, tooLong, ctx.record);
      logMomentRow("moment.retry", turnId, "observer", "say-too-long", { tag: tooLong.moment.tag });
      allowLong = true;
      try {
        await attempt({ ...ctx, system: [...ctx.system, { name: "data", text: SHORTER }] }, true);
      } catch (e) {
        // The retry failed (slow or down): the first reply, cut at a clause end, is better than nothing.
        if (ac.signal.aborted) throw e;
        finishObserver({ ...tooLong, usage: undefined, providerMetadata: undefined }, env);
      }
    }
  } catch (e) {
    fail(e as ProviderError);
  } finally {
    if (obsAc === ac) obsAc = undefined;
    lat.aborted = ac.signal.aborted ? 1 : 0;
    recordLatency(lat);
  }
}

/** An observer reply whose SAY was cut because it had more than 14 words, and no card is up yet: ask once for a shorter one. */
export const wantsShorter = (d: Pick<MomentDone, "long" | "moment">, shown: boolean, skipped: boolean): boolean =>
  d.long && !shown && !skipped && d.moment.tag !== "SKIP" && d.moment.tag !== "BANK" && d.moment.tag !== "STALL";

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
    logMomentRow("moment.invalid", e.turnId, "observer", cutOff ? "truncated" : (d.errors[0]?.reason ?? "invalid"), { sample: d.errors[0]?.sample });
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
    {
      ...done.m,
      why: d.moment.why,
      more: d.moment.more,
      ref: d.moment.ref ?? done.m.ref,
      ...labelOf(d.moment.label ?? done.m.label),
      ...((d.moment.about ?? done.m.about) ? { about: d.moment.about ?? done.m.about } : {}),
      ...((d.moment.val ?? done.m.val) ? { val: d.moment.val ?? done.m.val } : {}),
      ...((done.m.conf ?? d.moment.conf) ? { conf: done.m.conf ?? d.moment.conf } : {}),
    },
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

/** For tests: forget the observer state of the previous call. */
export const resetObserver = () => {
  lineSeq = 0;
  lastShown.clear();
  stopObserver();
};
