// Cards about what the user himself said: interview claims and long answers (local), and the amber / red self-check cards (selfcheck.ts).
import { eventError } from "../errtext.ts";
import { getProfile } from "../profile.ts";
import { checkClaims, claimSay } from "../claims.ts";
import { detectCareful, looksFactual, runSelfCheck, checkFix, MIN_WORDS } from "../selfcheck.ts";
import { selfGate, S, log, cost, notesAbort, background, registry, noAi, sup, interview, brief, bank, claims } from "./boot.ts";
import { emitCard, emitSide } from "./cards.ts";
import { st } from "./state.ts";
import { longAnswerTip } from "./strings.ts";
import { nextAnswerStart } from "./rules.ts";
import { recentTranscript } from "./coach.ts";
import { currentPause, v2Active } from "./degrade.ts";

const claimShown = new Set<string>();
let answerStart = 0,
  longNudgedFor = 0,
  lastMeLineAt = 0;
/** What the user said in an interview: a quiet card when a number is bigger than the CV, and one nudge when an answer passes 90 seconds. */
function interviewSelfCheck(text: string) {
  const miss = checkClaims(text, claims);
  if (miss && !claimShown.has(`${miss.unit}:${miss.said}`)) {
    claimShown.add(`${miss.unit}:${miss.said}`);
    const n = ++selfSeq;
    emitCard({
      id: `sc-${n}`,
      turnId: `sc${n}`,
      badge: "careful",
      question: text.slice(0, 200),
      say: claimSay(miss, /[\u0590-\u05ff]/.test(text) ? "he" : "en"),
      facts: [],
      priority: true,
      at: Date.now(),
    });
    selfEvent("selfcheck.claim", { unit: miss.unit, said: miss.said, claim: miss.claim.text });
  }
  // One answer = the user talking since the other side last spoke.
  const now = Date.now();
  answerStart = nextAnswerStart({ answerStart, lastThemSpeech: st.voice.lastThemSpeech, lastMeLineAt, now });
  lastMeLineAt = now;
  if (now - answerStart > 90_000 && longNudgedFor !== answerStart) {
    longNudgedFor = answerStart;
    emitSide({ id: `long-${++selfSeq}`, badge: "tip", say: longAnswerTip(), facts: [] });
    selfEvent("selfcheck.long", {});
  }
}
/** Everything an interview answer may draw on: the profile, the prepared cards and the plan. Names a tool that is not here = not the user's. */
let allowedCache = "";
export function interviewAllowed(): string {
  if (allowedCache) return allowedCache;
  const p = getProfile();
  allowedCache = [
    p.about,
    p.business,
    ...p.claims,
    ...bank.flatMap((c) => [c.say, ...c.facts, ...(c.en ? [c.en.say, ...(c.en.facts ?? [])] : [])]),
    background,
    brief?.title,
    brief?.who,
    brief?.goal,
    ...(brief?.notes ?? []),
  ]
    .filter(Boolean)
    .join(" ");
  return allowedCache;
}
let selfSeq = 0;
const selfEvent = (type: string, extra: Record<string, unknown> = {}) => log.write("events", { type, ...extra });
/** A final "me" line that is not a question for Wingman: amber card on price / date / promise (no AI), red card on a contradiction of the briefing (cheap model). */
export function selfCheckLine(text: string) {
  const sc = S.selfCheck;
  if (interview && st.call.consented && !st.call.shuttingDown) {
    interviewSelfCheck(text);
    return;
  }
  if (!sc.enabled || interview || !st.call.consented || st.call.shuttingDown) return; // interview: a false red card mid-answer costs more than it saves (a misheard employer name became a red card in practice)
  if (text.split(/\s+/).filter(Boolean).length < MIN_WORDS) return;
  const now = Date.now();
  // Live reading: the model's CHECK cards and the number check (moments.checkPromises) replace this word-list card. It stays as the floor while the AI is paused, and in the classic engine.
  const wordListCard = sc.careful && (!v2Active() || !!currentPause());
  if (wordListCard) {
    const c = detectCareful(text, S.stt.language);
    if (c) {
      if (selfGate.canCareful(now)) {
        selfGate.noteCareful(now);
        const n = ++selfSeq;
        emitCard({ id: `sc-${n}`, turnId: `sc${n}`, badge: "careful", question: c.question, say: c.say, facts: [], priority: true, at: now });
        selfEvent("selfcheck.careful", { kind: c.kind });
      } else selfEvent("selfcheck.skip", { why: "careful-gap" });
    }
  }
  if (!sc.fix) return;
  if (!background.trim()) return; // no prepared meeting: nothing to check against
  if (!looksFactual(text)) return;
  if (noAi || !sup.caps.llm || cost.llmState() === "capped") {
    selfEvent("selfcheck.skip", { why: noAi ? "no-ai" : "ai-unavailable" });
    return;
  }
  if (!selfGate.canModel(now)) {
    selfEvent("selfcheck.skip", { why: "busy-or-gap" });
    return;
  }
  selfGate.startModel(now);
  void (async () => {
    try {
      const r = await runSelfCheck({
        registry,
        model: S.tips.model,
        cache: S.llm.reflex.cache,
        background,
        transcript: recentTranscript(S.frame.windowMin),
        line: text,
        signal: notesAbort.signal,
        timeoutMs: sc.timeoutMs,
        sttLanguage: S.stt.language,
      });
      const cu = cost.addLlm("selfcheck", S.tips.model, r.usage, r.providerMetadata);
      log.write("usage", { role: "selfcheck", model: S.tips.model, usage: r.usage, usd: cu.usd });
      if (st.call.shuttingDown) return;
      const v = r.verdict;
      if (v.verdict === "ok") {
        selfEvent("selfcheck.ok");
        return;
      }
      const g = checkFix(v);
      if (!g.ok) {
        selfEvent("selfcheck.skip", { why: "guard", rule: g.rule });
        return;
      }
      const t = Date.now();
      if (!selfGate.canFix(t, v.correct)) {
        selfEvent("selfcheck.skip", { why: "fix-gap-or-repeat" });
        return;
      }
      selfGate.noteFix(t, v.correct);
      const n = ++selfSeq;
      emitCard({ id: `sc-${n}`, turnId: `sc${n}`, badge: "fix", question: v.said, say: v.correct, facts: v.source ? [v.source] : [], priority: true, at: t });
      selfEvent("selfcheck.fix", {});
    } catch (e) {
      selfEvent("selfcheck.error", { error: eventError(e).slice(0, 200) });
    } finally {
      selfGate.endModel();
    }
  })();
}
