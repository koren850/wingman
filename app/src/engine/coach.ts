// Live coaching tips and the v2 memory loop wiring: timer jobs plus the one place that emits a tip card. (The old call frame model call is gone: the call memory knows what the call is about.)
import { eventError } from "../errtext.ts";
import { callLanguage } from "../calllang.ts";
import { runTip, checkTip, talkRatio, talkTip, wrapUpTip, type Tip } from "../tips.ts";
import {
  transcript,
  interview,
  S,
  tipGate,
  callStart,
  tracker,
  tipsOn,
  log,
  cost,
  notesAbort,
  tipsGiven,
  background,
  contextNotes,
  registry,
  sup,
  lineOf,
  speakers,
  brief,
  briefArg,
  noAi,
} from "./boot.ts";
import { st, callKind } from "./state.ts";
import { onStop } from "./lifecycle.ts";
import { liveNotes } from "./side.ts";
import { emitCard, emitMoment, closeCards, cardSched } from "./cards.ts";
import { applyFeedback } from "./moments.ts";
import { topicChanged } from "./moments-observer.ts";
import { parseTags } from "./cards-v2.ts";
import { recentWindow, capTail } from "./rules.ts";
import { MemoryLoop, engineV2, makeModelRunner, memoryConfigFrom, memoryGate } from "./memory.ts";
import { emitMemoryView, safe, survived } from "./out.ts";
import { loadMemory, saveMemory } from "../session/store.ts";
import { seedForCall } from "../session/callseed.ts";
import { PEOPLE_FILE } from "../session/people.ts";
import { CALLS, USER_DATA } from "../env.ts";
import { toView } from "../session/view.ts";
import { isEmptyMemory, type SessionMemory } from "../session/types.ts";
import { briefNotes, briefKind } from "../brief.ts";
import { setMode } from "../session/patch.ts";
import { loadCustomModes, type CustomMode } from "../pack.ts";
import { memoryWrapUpTip, openLoopSay, timeLeftTip, wrapUpItems } from "../tips.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Moment } from "../moments/types.ts";
import { modeProfile, setCustomMode } from "../moments/modes.ts";
import { DEFAULT_NUDGE_CFG, Nudger, speechRing } from "../session/coaching.ts";

let tipSeq = 0,
  tipBusy = false,
  lastTipTryAt = 0,
  tipWords = 0,
  wrapNudged = false,
  lastTalkTipAt = 0;
/** The last `minutes` of the call as "me: …/them: …" lines, newest at the end, at most ~6000 characters. */
export function recentTranscript(minutes: number, maxLines = 80): string {
  return capTail(recentWindow(transcript, Date.now(), minutes, maxLines).map(lineOf).join("\n"));
}
/** One tip card. Guards (price / date / promise) and the repeat check run here, for every source. */
function emitTip(tip: Tip, source: "ai" | "talk" | "wrapup" | "time"): boolean {
  const chk = checkTip(tip, tipsGiven);
  if (!chk.ok) {
    log.write("events", { type: "tip.dropped", source, why: chk.why, rule: chk.rule });
    return false;
  }
  tipsGiven.push(tip.text);
  tipGate.noteTip(Date.now());
  emitCard({ id: `tip-${++tipSeq}`, turnId: "tips", badge: "tip", tipType: tip.type, question: "", say: tip.text, facts: [], at: Date.now() });
  log.write("events", { type: "tip", source, tipType: tip.type });
  return true;
}
/** Asks the model for one coaching tip. Rate-limited (30 s between tries, 30 new words, TipGate); the result is dropped if an answer card appeared meanwhile. */
async function aiTip() {
  const now = Date.now();
  if (tipBusy || tipWords < 30 || now - lastTipTryAt < Math.max(30_000, S.tips.minGapMs / 2) || !sup.caps.llm || cost.llmState() === "capped") return;
  tipBusy = true;
  lastTipTryAt = now;
  tipWords = 0;
  try {
    const r = await runTip({
      registry,
      model: S.tips.model,
      cache: S.llm.reflex.cache,
      frame: tracker.current,
      transcript: recentTranscript(S.frame.windowMin),
      contextNotes,
      background,
      factLines: liveNotes.slice(-6),
      given: tipsGiven.slice(-6),
      elapsedMin: (now - callStart) / 60000,
      signal: notesAbort.signal,
      timeoutMs: S.tips.timeoutMs,
      sttLanguage: S.stt.language,
    });
    const c = cost.addLlm("tips", S.tips.model, r.usage, r.providerMetadata);
    log.write("usage", { role: "tips", model: S.tips.model, usage: r.usage, usd: c.usd });
    // An answer card may have appeared while the model was thinking.
    if (st.call.shuttingDown || !r.tip || !tipGate.can(Date.now(), { quiet: st.call.quiet })) {
      if (!r.tip) log.write("events", { type: "tip.none" });
      return;
    }
    emitTip(r.tip, "ai");
  } catch (e) {
    log.write("events", { type: "tip.error", error: eventError(e).slice(0, 200) });
  } finally {
    tipBusy = false;
  }
}
/** Every 5 s: wrap-up nudge first, then the talk-ratio tip (at most every 10 min), then an AI tip. Silent in quiet mode. */
export function tipsTick() {
  if (engineV2(S)) {
    startV2Timer(); // v2: no AI tip timer. The memory loop, the open-loop prompts, the talk-ratio tip and the wrap-up cue run on their own 1 s timer
    return;
  }
  if (!tipsOn || !st.call.consented || st.call.shuttingDown || st.call.quiet) return;
  const now = Date.now();
  const latest = transcript
    .filter((l) => now - l.at < 20_000)
    .map((l) => l.text)
    .join(" ");
  const lang = callLanguage(
    transcript
      .slice(-40)
      .map((l) => l.text)
      .join("\n"),
    S.stt.language,
  );
  const wrap = wrapUpTip(tracker.current, {
    latestText: latest,
    elapsedMin: (now - callStart) / 60_000,
    wrapUpAfterMin: S.tips.wrapUpAfterMin,
    alreadyNudged: wrapNudged,
    lang,
  });
  if (wrap && tipGate.can(now, { quiet: st.call.quiet, ignoreGap: true })) {
    wrapNudged = true;
    emitTip(wrap, "wrapup");
    return;
  }
  if (!tipGate.can(now, { quiet: st.call.quiet })) return;
  if (S.tips.talkRatio && now - lastTalkTipAt > 10 * 60_000) {
    const t = interview ? talkTip(talkRatio(transcript, now), 0.85, true, lang) : talkTip(talkRatio(transcript, now), 0.75, false, lang);
    if (t) {
      lastTalkTipAt = now;
      emitTip(t, "talk");
      return;
    }
  }
  void aiTip();
}

/** New transcript words since the last tip try (paced by a word count). */
export function addWords(n: number) {
  tipWords += n;
}

// ---------------------------------------------------------------- v2: the memory loop, open loops, local tips
const memCfg = memoryConfigFrom(S, S.notes.model);
let loop: MemoryLoop | undefined,
  pulled = 0,
  v2Timer: NodeJS.Timeout | undefined,
  lastLocalTipAt = 0,
  lastTagsAt = 0,
  tagRowsRead = 0,
  v2Nudged = false,
  timeCardShown = false;
// ---- the call mode: a built-in kind or a custom mode from the pack (modes.yaml), chosen by the user or by the prepared meeting
let customModes: CustomMode[] | undefined;
/** The user's custom modes (read once per call). */
export const customModeList = (): CustomMode[] => (customModes ??= loadCustomModes());
/** Puts the custom mode text and numbers of the memory's `modeId` into force for the prompts and the scheduler (moments/modes.ts). */
function syncCustomMode(m: SessionMemory): void {
  setCustomMode(m.modeId ? customModeList().find((c) => c.id === m.modeId) : undefined);
}
/** `mode <id>`: the user picks the mode. Returns ok:false with a reason for an id nobody knows. Works with or without the v2 loop. */
export function setCallMode(mode: string): { ok: boolean; reason?: string } {
  const l = memoryLoop();
  const cur = l ? l.memory : st.m.mem;
  const next = setMode(
    cur,
    mode,
    Date.now(),
    customModeList().map((c) => c.id),
  );
  if (!next) return { ok: false, reason: "unknown mode" };
  if (next === cur) return { ok: true };
  if (l) l.replaceMemory(next, "mode");
  else {
    st.m.mem = next;
    emitMemoryView(toView(next));
    try {
      saveMemory(log.dir, next);
    } catch {
      /* best effort */
    }
  }
  syncCustomMode(next);
  return { ok: true };
}

/** The v2 memory loop of this call (created on first use), or undefined when the call is not v2, has no AI, or memory.enabled is false. */
export function memoryLoop(): MemoryLoop | undefined {
  if (!engineV2(S) || noAi || !memCfg.enabled) return undefined;
  if (loop) return loop;
  if (st.call.shuttingDown && !st.call.consented) return undefined; // a call that never went live learns nothing and writes no session.json
  const now = Date.now();
  // A call that is resumed or restarted in its folder keeps what it learned; a new call starts from the pre-meeting brief (facts, agenda) or empty.
  let mem: SessionMemory = loadMemory(log.dir, now).mem;
  if (isEmptyMemory(mem) && brief)
    mem = seedForCall({
      mustCover: brief.mustCover ?? [],
      ...(brief.who ? { who: brief.who } : {}),
      notes: briefNotes(brief),
      ...(briefArg ? { briefFile: briefArg } : {}),
      now,
      pastCalls: S.context.pastCalls,
      callsDir: CALLS,
      peopleFile: join(USER_DATA, PEOPLE_FILE),
      callId: log.id,
    });
  // A prepared meeting stores the mode its owner chose ("Call kind:" in the plan). That is a choice, so it is locked; the model's guess in the digest is not.
  const planned = !mem.kindLocked ? briefKind(brief) : "";
  if (planned) {
    const locked = setMode(
      mem,
      planned,
      now,
      customModeList().map((c) => c.id),
    );
    if (locked) mem = locked;
  }
  syncCustomMode(mem);
  const run = makeModelRunner({
    registry,
    model: memCfg.model,
    onUsage: (role, model, usage, pm, record) => {
      const c = cost.addLlm(role, model, usage, pm);
      log.write("usage", { role, model, usage, providerMetadata: pm, usd: c.usd, ctx: record });
    },
  });
  loop = new MemoryLoop(
    {
      now: () => Date.now(),
      run,
      localNumbers: interview,
      onTopicChange: () => topicChanged(),
      save: (m) => saveMemory(log.dir, m),
      sendView: emitMemoryView,
      log: (stream, row) => log.write(stream, row),
      allowed: (role) =>
        memoryGate(role, {
          consented: st.call.consented,
          shuttingDown: st.call.shuttingDown,
          discarding: st.call.discardNow || st.call.crashed,
          llmUp: sup.caps.llm,
          capped: cost.llmState() === "capped",
        }),
      onChange: (m, prev) => {
        syncCustomMode(m);
        st.m.mem = m; // the moment and observer calls read st.m.mem: they must see what the call has taught the memory
        // A resolved item closes the cards that point at it.
        const open = new Set([
          ...m.openQuestions.filter((q) => q.status === "open").map((q) => q.id),
          ...m.commitments.filter((c) => c.status === "open").map((c) => c.id),
        ]);
        const gone = [
          ...prev.openQuestions.filter((q) => q.status === "open").map((q) => q.id),
          ...prev.commitments.filter((c) => c.status === "open").map((c) => c.id),
        ].filter((id) => !open.has(id));
        if (gone.length) closeCards(cardSched.resolved(gone));
      },
    },
    memCfg,
    mem,
  );
  st.m.mem = mem;
  try {
    saveMemory(log.dir, mem); // the seed is on disk from the first second
  } catch (e) {
    log.write("events", { type: "memory.save.error", error: eventError(e).slice(0, 160) });
  }
  return loop;
}
function stopV2Timer() {
  clearInterval(v2Timer);
  v2Timer = undefined;
}
onStop(stopV2Timer);
function startV2Timer() {
  if (v2Timer || st.call.shuttingDown || !memoryLoop()) return;
  v2Timer = setInterval(safe("memory", v2Tick), 1000);
  v2Timer.unref();
}
/** New transcript lines (both sides) into the loop. The loop reads the shared transcript by index, so ingest.ts needs no hook. */
function pullLines(l: MemoryLoop) {
  // `pulled` is a call-wide index: the transcript drops middle lines on a long call, so read it with lineAt, not by array index.
  for (; pulled < transcript.absLength; pulled++) {
    const t = transcript.lineAt(pulled);
    if (!t) continue;
    // The other side's voices are named by the speaker book. A voice on the "me" side (a mic source that tells two people apart) gets its own label
    // ("Voice 2"); the first voice has no label, so a call with one person on the user's side reads as before.
    const name = t.ch === "me" ? (t.who && t.who.spk > 1 ? `Voice ${t.who.spk}` : undefined) : t.who ? speakers.name(t.who.spk) : undefined;
    l.addLine({ side: t.ch === "me" ? "me" : "them", text: t.text, ...(name ? { name } : {}) });
  }
}
function v2Tick() {
  const l = memoryLoop();
  if (!l || !st.call.consented || st.call.shuttingDown) return;
  pullLines(l);
  l.tick();
  const now = Date.now();
  closeCards(cardSched.expire(now));
  // Last time: the first time a person from an earlier call is named, one Fact card says what was remembered (no model call).
  const past = !st.call.quiet ? l.firstMention() : undefined;
  if (past) {
    const m: Moment & { source: "observer"; lineAt: number } = {
      tag: "NOTE",
      value: 2,
      aim: "me",
      say: past.text,
      why: past.who,
      more: [],
      ref: past.id,
      source: "observer",
      lineAt: now,
    };
    emitMoment(m, { question: past.who, memV: l.memory.ver, src: "past" });
    log.write("events", { type: "past.card", id: past.id });
  }
  // Open loop: a question or promise nobody picked up. The code decides when; the text is the memory's own wording.
  const p = !st.call.quiet ? l.openLoopPrompt() : undefined;
  if (p) {
    const m: Moment & { source: "observer"; lineAt: number } = {
      tag: "PROMPT",
      value: 2,
      aim: "me",
      say: openLoopSay(
        p,
        callLanguage(
          transcript
            .slice(-40)
            .map((x) => x.text)
            .join("\n"),
          S.stt.language,
        ),
      ),
      why: p.who,
      more: [],
      ref: p.id,
      source: "observer",
      lineAt: now,
    };
    emitMoment(m, { question: p.text, memV: l.memory.ver });
    log.write("events", { type: "openloop.prompt", id: p.id, kind: p.kind });
  }
  // Ratings the user gave (tags.jsonl) tune the card thresholds. Every 10 s.
  if (now - lastTagsAt > 10_000) {
    lastTagsAt = now;
    try {
      const text = readFileSync(join(log.dir, "tags.jsonl"), "utf8");
      const n = cardSched.feedback(text);
      if (n) log.write("events", { type: "cards.feedback", rows: n, boost: cardSched.tagBoost() });
      // The moment engine's own scheduler (observer and direct cards) learns from the same rows. Only rows it has not seen yet.
      const rows = parseTags(text);
      const fresh = rows.slice(tagRowsRead);
      tagRowsRead = rows.length;
      if (fresh.length) applyFeedback(fresh);
    } catch {
      /* no ratings yet */
    }
  }
  nudgeTick(now);
  // Local cues that need no model: wrap-up from the memory, and the talk ratio.
  if (now - lastLocalTipAt < 5000 || st.call.quiet) return;
  lastLocalTipAt = now;
  const latest = transcript
    .filter((x) => now - x.at < 20_000)
    .map((x) => x.text)
    .join(" ");
  const lang = callLanguage(
    transcript
      .slice(-40)
      .map((x) => x.text)
      .join("\n"),
    S.stt.language,
  );
  const wrap = memoryWrapUpTip(l.memory, {
    latestText: latest,
    elapsedMin: (now - callStart) / 60_000,
    wrapUpAfterMin: S.tips.wrapUpAfterMin,
    alreadyNudged: v2Nudged,
    lang,
  });
  if (wrap && tipGate.can(now, { quiet: st.call.quiet, ignoreGap: true })) {
    v2Nudged = true;
    l.markShown(wrapUpItems(l.memory)); // the same items must not come again as "still open" prompts
    emitTip(wrap, "wrapup");
    return;
  }
  // The one time-left card against the planned length (settings tips.plannedMin). The mode decides how early; a standup shows it when the time is up.
  const timeLeft = timeLeftTip({
    plannedMin: S.tips.plannedMin,
    elapsedMin: (now - callStart) / 60_000,
    leadMin: modeProfile(callKind()).timeCardLeadMin,
    alreadyShown: timeCardShown,
    lang,
  });
  if (timeLeft && tipGate.can(now, { quiet: st.call.quiet, ignoreGap: true })) {
    timeCardShown = true;
    emitTip(timeLeft, "time");
    return;
  }
  if (!S.tips.talkRatio || S.coach.nudges || now - lastTalkTipAt <= 10 * 60_000 || !tipGate.can(now, { quiet: st.call.quiet })) return; // with live nudges on, the talk share is a nudge, not a tip
  const t = interview ? talkTip(talkRatio(transcript, now), 0.85, true, lang) : talkTip(talkRatio(transcript, now), 0.75, false, lang);
  if (t) {
    lastTalkTipAt = now;
    emitTip(t, "talk");
  }
}
// ---- live nudges (settings coach.nudges, off by default): a thin bar from numbers the app already has. No model call. ----
const nudger = new Nudger();
let nudgeSeq = 0;
const CHECK_HOLD_MS = 30_000;
/** At most one nudge per 5 minutes, never while a Check is on screen. The row goes to the answer window as a `nudge` row; it is not a card. */
function nudgeTick(now: number) {
  try {
    nudger.cfg = { ...DEFAULT_NUDGE_CFG, enabled: S.coach.nudges, talkShareMax: S.coach.talkShareMax, paceMax: S.coach.paceMax };
    if (!nudger.cfg.enabled) return;
    const checkHold = st.m.sched.shown.some((r) => r.tag === "CHECK" && now - r.at < CHECK_HOLD_MS);
    const n = nudger.check(now, speechRing.rows(), { checkHold, quiet: st.call.quiet });
    if (!n) return;
    log.write("cards", { type: "nudge", id: `nudge${++nudgeSeq}`, ...n, at: now });
    log.write("events", { type: "nudge", kind: n.kind, value: n.value, limit: n.limit });
  } catch (e) {
    survived("nudge", e);
  }
}

/** Shutdown and crash. Without `maxMs`: write session.json now (sync, no model call). With `maxMs`: also learn the last lines if there is time, write, and stop the loop. Never throws. */
export async function flushMemory(maxMs?: number): Promise<void> {
  const l = loop;
  if (!l) return;
  try {
    pullLines(l);
    if (maxMs !== undefined && maxMs > 0) await l.finalPass(maxMs);
  } catch {
    /* the last pass is a bonus */
  }
  l.flush();
  if (maxMs !== undefined) {
    l.stop();
    stopV2Timer();
  }
}
