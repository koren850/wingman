// Call frame (what is this call about?) and live coaching tips: timer jobs plus the one place that emits a tip card.
import { eventError } from "../errtext.ts";
import { runFrame, progress, kindLabel, type Frame } from "../frame.ts";
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
  frameOn,
  lineOf,
  UI_LANG,
  speakers,
  brief,
  bank,
  noAi,
} from "./boot.ts";
import { st } from "./state.ts";
import { liveNotes } from "./side.ts";
import { emitCard, emitMoment, closeCards, cardSched } from "./cards.ts";
import { applyFeedback, topicChanged } from "./moments.ts";
import { parseTags } from "./cards-v2.ts";
import { recentWindow, capTail, frameDue } from "./rules.ts";
import { MemoryLoop, engineV2, makeModelRunner, memoryConfigFrom, memoryGate } from "./memory.ts";
import { emitMemoryView, safe } from "./out.ts";
import { loadMemory, saveMemory } from "../session/store.ts";
import { seedFromDigest } from "../session/seed.ts";
import { renderMemory } from "../session/render.ts";
import { isEmptyMemory, type SessionMemory } from "../session/types.ts";
import { briefNotes } from "../brief.ts";
import { memoryWrapUpTip, openLoopSay } from "../tips.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Moment } from "../moments/types.ts";

let frameBusy: Promise<void> | undefined,
  lastFrameAt = 0,
  frameWords = 0,
  tipSeq = 0,
  tipBusy = false,
  lastTipTryAt = 0,
  tipWords = 0,
  wrapNudged = false,
  lastTalkTipAt = 0;
/** The last `minutes` of the call as "me: …/them: …" lines, newest at the end, at most ~6000 characters. */
export function recentTranscript(minutes: number, maxLines = 80): string {
  return capTail(recentWindow(transcript, Date.now(), minutes, maxLines).map(lineOf).join("\n"));
}
const framePct = (f: Frame) => {
  const p = progress(f);
  return `${p.done}/${p.total}`;
};
/** Call-frame update: one model call that says what the call is about and which checklist items were covered. Single flight (returns the running promise).
 *  `final` = the last look at shutdown: ignores the shuttingDown check and needs fewer new words. */
export function frameRound(final = false): Promise<void> {
  if (engineV2(S)) return Promise.resolve(); // v2: the call memory replaces the frame
  if (frameBusy) return frameBusy;
  if (!frameOn || !st.call.consented || (!final && st.call.shuttingDown) || !sup.caps.llm || cost.llmState() === "capped") return Promise.resolve();
  const now = Date.now();
  // The very first frame comes early (half the usual words, no waiting): the first question of a call should already know what the call is about.
  if (!frameDue({ final, hasFrame: !!tracker.current, newWords: frameWords, minNewWords: S.frame.minNewWords, now, lastFrameAt, everyMs: S.frame.everyMs }))
    return Promise.resolve();
  lastFrameAt = now;
  frameWords = 0;
  const run = (async () => {
    try {
      const r = await runFrame({
        registry,
        model: S.frame.model,
        cache: S.llm.reflex.cache,
        transcript: recentTranscript(S.frame.windowMin),
        contextNotes,
        background,
        current: tracker.current,
        signal: new AbortController().signal,
        timeoutMs: S.frame.timeoutMs,
        sttLanguage: S.stt.language,
      });
      const c = cost.addLlm("frame", S.frame.model, r.usage, r.providerMetadata);
      log.write("usage", { role: "frame", model: S.frame.model, usage: r.usage, usd: c.usd });
      const { frame, changed } = tracker.apply(r.frame);
      if (!changed) return;
      log.write("events", { type: "frame", frame });
      log.write("cards", { type: "frame", frame, at: Date.now() });
      console.log(`\n[🧭 call] ${kindLabel(frame.kind, UI_LANG)} · ${frame.topic || "?"} · ${framePct(frame)}`);
    } catch (e) {
      log.write("events", { type: "frame.error", error: eventError(e).slice(0, 200) });
    } finally {
      frameBusy = undefined;
    }
  })();
  frameBusy = run;
  return run;
}

/** One tip card. Guards (price / date / promise) and the repeat check run here, for every source. */
function emitTip(tip: Tip, source: "ai" | "talk" | "wrapup"): boolean {
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
  if (
    tipBusy ||
    (frameOn && !tracker.current) ||
    tipWords < 30 ||
    now - lastTipTryAt < Math.max(30_000, S.tips.minGapMs / 2) ||
    !sup.caps.llm ||
    cost.llmState() === "capped"
  )
    return;
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

/** New transcript words since the last frame look and the last tip try (both are paced by word counts). */
export function addWords(n: number) {
  frameWords += n;
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
  v2Nudged = false;
/** The v2 memory loop of this call (created on first use), or undefined when the call is not v2, has no AI, or memory.enabled is false. */
export function memoryLoop(): MemoryLoop | undefined {
  if (!engineV2(S) || noAi || !memCfg.enabled) return undefined;
  if (loop) return loop;
  const now = Date.now();
  // A call that is resumed or restarted in its folder keeps what it learned; a new call starts from the pre-meeting brief (facts, agenda) or empty.
  let mem: SessionMemory = loadMemory(log.dir, now).mem;
  if (isEmptyMemory(mem) && brief)
    mem = seedFromDigest({ roster: [], agenda: brief.mustCover ?? [], facts: briefNotes(brief), likelyQuestions: [], chunks: [] }, now);
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
/** For a direct question: the memory as it is now plus the lines the updater has not read yet. Never waits for the updater. */
export function memoryContext() {
  return memoryLoop()?.contextFor();
}
/** The text that card figures may come from: the rendered memory, the raw tail of the call and the prepared cards. Used by the digit guard. */
export function allowedFigures(): string {
  const m = memoryLoop()?.memory;
  return [m ? renderMemory(m, 1800) : "", recentTranscript(10), ...bank.flatMap((c) => [c.say, ...c.facts]), background].join("\n");
}
function startV2Timer() {
  if (v2Timer || !memoryLoop()) return;
  v2Timer = setInterval(safe("memory", v2Tick), 1000);
  v2Timer.unref();
}
/** New transcript lines (both sides) into the loop. The loop reads the shared transcript by index, so ingest.ts needs no hook. */
function pullLines(l: MemoryLoop) {
  for (; pulled < transcript.length; pulled++) {
    const t = transcript[pulled];
    l.addLine({ side: t.ch === "me" ? "me" : "them", text: t.text, ...(t.who ? { name: speakers.name(t.who.spk) } : {}) });
  }
}
function v2Tick() {
  const l = memoryLoop();
  if (!l || !st.call.consented || st.call.shuttingDown) return;
  pullLines(l);
  l.tick();
  const now = Date.now();
  closeCards(cardSched.expire(now));
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
    emitTip(wrap, "wrapup");
    return;
  }
  if (!S.tips.talkRatio || now - lastTalkTipAt <= 10 * 60_000 || !tipGate.can(now, { quiet: st.call.quiet })) return;
  const t = interview ? talkTip(talkRatio(transcript, now), 0.85, true, lang) : talkTip(talkRatio(transcript, now), 0.75, false, lang);
  if (t) {
    lastTalkTipAt = now;
    emitTip(t, "talk");
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
    clearInterval(v2Timer);
    v2Timer = undefined;
  }
}
