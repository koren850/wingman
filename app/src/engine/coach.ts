// Call frame (what is this call about?) and live coaching tips: timer jobs plus the one place that emits a tip card.
import { runFrame, progress, KIND_HE, type Frame } from "../frame.ts";
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
} from "./boot.ts";
import { st } from "./state.ts";
import { liveNotes } from "./side.ts";
import { emitCard } from "./cards.ts";
import { wordCount, recentWindow, capTail, frameDue } from "./rules.ts";

let frameBusy: Promise<void> | undefined,
  lastFrameAt = 0,
  frameWords = 0,
  tipSeq = 0,
  tipBusy = false,
  lastTipTryAt = 0,
  tipWords = 0,
  wrapNudged = false,
  lastTalkTipAt = 0;
export { wordCount };
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
      });
      const c = cost.addLlm("frame", S.frame.model, r.usage, r.providerMetadata);
      log.write("usage", { role: "frame", model: S.frame.model, usage: r.usage, usd: c.usd });
      const { frame, changed } = tracker.apply(r.frame);
      if (!changed) return;
      log.write("events", { type: "frame", frame });
      log.write("cards", { type: "frame", frame, at: Date.now() });
      console.log(`\n[🧭 call] ${KIND_HE[frame.kind]} · ${frame.topic || "?"} · ${framePct(frame)}`);
    } catch (e) {
      log.write("events", { type: "frame.error", error: String((e as Error)?.message ?? e).slice(0, 200) });
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
    log.write("events", { type: "tip.error", error: String((e as Error)?.message ?? e).slice(0, 200) });
  } finally {
    tipBusy = false;
  }
}
/** Every 5 s: wrap-up nudge first, then the talk-ratio tip (at most every 10 min), then an AI tip. Silent in quiet mode. */
export function tipsTick() {
  if (!tipsOn || !st.call.consented || st.call.shuttingDown || st.call.quiet) return;
  const now = Date.now();
  const latest = transcript
    .filter((l) => now - l.at < 20_000)
    .map((l) => l.text)
    .join(" ");
  const wrap = wrapUpTip(tracker.current, {
    latestText: latest,
    elapsedMin: (now - callStart) / 60_000,
    wrapUpAfterMin: S.tips.wrapUpAfterMin,
    alreadyNudged: wrapNudged,
  });
  if (wrap && tipGate.can(now, { quiet: st.call.quiet, ignoreGap: true })) {
    wrapNudged = true;
    emitTip(wrap, "wrapup");
    return;
  }
  if (!tipGate.can(now, { quiet: st.call.quiet })) return;
  if (S.tips.talkRatio && now - lastTalkTipAt > 10 * 60_000) {
    const t = interview ? talkTip(talkRatio(transcript, now), 0.85, true) : talkTip(talkRatio(transcript, now));
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
