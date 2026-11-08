// Answers for the user's own questions (the ask key, a typed `ask`, or a detected question on the "me" channel). A "me" card is only for the user.
import { eventError } from "../errtext.ts";
import { evalMath } from "../calc.ts";
import { audienceByCues, classify, decideAudience, guardMe } from "../assist.ts";
import { detect } from "../detector.ts";
import { runReflex, type Tag } from "../reflex.ts";
import type { SttResult } from "../providers/stt/types.ts";
import { type ProviderError } from "../providers/errors.ts";
import { frameText } from "../frame.ts";
import { log, cost, breakers, S, tracker, contextNotes, lineOf, transcript, prefix, registry, noAi, meGate, sup, PROMPT_V } from "./boot.ts";
import { refreshSignals, llmFailed, usableModels, clearAiBar } from "./degrade.ts";
import { emitCard, noteModel } from "./cards.ts";
import { st } from "./state.ts";
import { askNotSure, askError } from "./strings.ts";
import { countReflexFailure, noteReflexOk } from "./question.ts";
import { selfCheckLine } from "./selfcheck.ts";
import { survived, status } from "./out.ts";

// ---- Answers for the user's own questions ("me" channel) ----
// A "me" card is only for the user. Whether a line is for Wingman or for the other person is decided by audienceByCues (rules),
// then a quick classifier model when unsure and the other side is talking; MeGate rate-limits the cards.
/** Deferred "me" card retries (cleared in shutdown). */
export const meTimers2 = new Set<NodeJS.Timeout>();
const isSolo = () => !st.voice.themSoundSeen && !transcript.some((l) => l.ch === "them");
/** Answers for the user need a working model and budget; they do NOT need the other side to be heard (rung 4 still allows them). */
const canMeAi = () => !noAi && st.call.consented && !st.call.shuttingDown && sup.caps.meAns && usableModels().length > 0 && cost.llmState() !== "capped";
const meLog = (turnId: string, text: string, decision: string, why: string, extra: Record<string, unknown> = {}) =>
  log.write("events", { type: "me.decision", turnId, text, decision, why, ...extra });
/** Ctrl+Opt+A / the "ask" control command: the next thing the user says (within assist.askWindowMs) is a question for Wingman. */
export function armAsk() {
  if (st.call.shuttingDown) return;
  if (!st.call.consented) {
    console.log("\n(ask ignored: listening has not started yet)");
    return;
  }
  st.ask.until = Date.now() + S.assist.askWindowMs;
  log.write("events", { type: "ask.armed", ms: S.assist.askWindowMs });
  log.write("cards", { type: "ask", on: true, until: st.ask.until, at: Date.now() });
  status("ask", { on: true, until: st.ask.until });
  console.log(`\n🙋 Listening for your question (${Math.round(S.assist.askWindowMs / 1000)} s)…`);
  clearTimeout(st.ask.timer);
  st.ask.timer = setTimeout(() => disarmAsk("timeout"), S.assist.askWindowMs + 2500); // small grace: a sentence that started inside the window may finish after it
}
/** Ends the ask window ("used" = a question took it; "timeout" = nothing came). */
function disarmAsk(why: string) {
  if (!st.ask.until) return;
  st.ask.until = 0;
  clearTimeout(st.ask.timer);
  log.write("cards", { type: "ask", on: false, at: Date.now() });
  status("ask", { on: false });
  if (why === "timeout") log.write("events", { type: "ask.expired" });
}

/** `ask <question>` on the control channel (the wingman CLI): a typed question, handled like a spoken one that followed the ask key. */
export function askTyped(q: string) {
  if (st.call.shuttingDown || !st.call.consented) {
    console.log("\n(ask ignored: listening has not started yet)");
    return;
  }
  const text = q.replace(/\s+/g, " ").trim().slice(0, 300),
    now = Date.now();
  log.write("events", { type: "me.detect", text, forced: true, reason: "typed" });
  void onMeQuestion({ channel: "me", text, isFinal: true, speechFinal: true, words: [], arrivedAt: now, speechEndWall: now } as SttResult, true).catch((e) =>
    log.write("events", { type: "me.error", error: eventError(e).slice(0, 200) }),
  );
}
/** A "me" utterance has ended. Decide whether it is a question for Wingman and answer it. */
export function handleMe(joined: SttResult) {
  try {
    handleMeCore(joined);
  } catch (e) {
    survived("handleMe", e);
  }
}
function handleMeCore(joined: SttResult) {
  const text = joined.text.trim();
  if (!text || st.call.shuttingDown || !st.call.consented) return;
  const speechEnd = joined.speechEndWall ?? joined.arrivedAt;
  const nWords = text.split(/\s+/).filter(Boolean).length;
  const forced = st.ask.until > 0 && speechEnd <= st.ask.until + 1500 && nWords >= 2; // the ask key was pressed: this is for Wingman
  if (forced) disarmAsk("used");
  if (!forced) selfCheckLine(text); // what he said himself (not an ask to Wingman); a tag question ("יש לכם 200 עמודים, נכון?") is still a claim
  const mode = S.assist.answerMe;
  if (!forced && mode !== "always") return;
  const math = evalMath(text);
  const d = detect(text);
  if (!forced && !d.isQuestion && !math) return;
  log.write("events", { type: "me.detect", text, forced, reason: forced ? "hotkey" : math ? "math" : d.reason });
  void onMeQuestion(joined, forced).catch((e) => log.write("events", { type: "me.error", error: eventError(e).slice(0, 200) }));
}
/** Answers one "me" question. `forced` = the ask key / typed ask was used, so it is surely for Wingman and may wait for a protected card slot.
 *  Steps: 1 audience decision (rules, maybe classifier in parallel with the answer), 2 show gate (meGate, stale check), 2a arithmetic, 2b model. */
async function onMeQuestion(r: SttResult, forced: boolean) {
  const tStart = Date.now();
  const text = r.text.trim();
  const turnId = `m${++st.me.seq}`;
  const speechEnd = r.speechEndWall ?? r.arrivedAt;
  st.me.current?.abort();
  const ac = (st.me.current = new AbortController());
  const dead = () => ac.signal.aborted || st.call.shuttingDown;
  const quietFor = Date.now() - Math.max(st.voice.lastThemSound, st.voice.lastThemText),
    solo = isSolo();

  // 1. Is it for Wingman or for the other person?
  const ignoreOther = Date.now() - st.voice.lastThemSpeech > 60_000; // nobody else spoke lately: "you / can you" is for Wingman
  const cue = audienceByCues(text, { forced, ignoreOther });
  let verdict: "ASSIST" | "OTHER" | "NEITHER" | undefined;
  // Speculative: when the rules are unsure and others are talking, the classifier and the answer run in PARALLEL; the card waits for the verdict.
  let verdictP: Promise<void> | undefined;
  if (cue.audience === "unsure" && canMeAi() && !solo) {
    verdictP = (async () => {
      try {
        const c = await classify({
          registry,
          model: S.assist.model,
          cache: S.llm.reflex.cache,
          system: prefix,
          text,
          frame: frameText(tracker.current) || undefined,
          recent: transcript
            .slice(-8)
            .map((l) => `${l.ch}: ${l.text}`)
            .join("\n"),
          solo,
          themQuietMs: quietFor,
          signal: ac.signal,
          timeoutMs: S.assist.classifyTimeoutMs,
        });
        const cu = cost.addLlm("assist", S.assist.model, c.usage, c.providerMetadata);
        log.write("usage", { role: "assist", model: S.assist.model, turnId, usage: c.usage, usd: cu.usd });
        verdict = c.verdict;
      } catch (e) {
        if (!dead()) log.write("events", { type: "me.classify-error", turnId, error: eventError(e).slice(0, 160) });
      }
    })();
  }
  let dec = decideAudience(cue, { verdict, themQuietMs: quietFor, solo, quietNeededMs: S.assist.themQuietMs });
  let tDecide = Date.now();
  const settle = async (): Promise<boolean> => {
    // true = answer for the user
    if (verdictP) {
      await verdictP;
      verdictP = undefined;
      dec = decideAudience(cue, {
        verdict,
        themQuietMs: Date.now() - Math.max(st.voice.lastThemSound, st.voice.lastThemText),
        solo,
        quietNeededMs: S.assist.themQuietMs,
      });
      tDecide = Date.now();
      if (!dead() && !dec.answer) meLog(turnId, text, "skip", dec.why);
    }
    return !dead() && dec.answer;
  };
  if (!verdictP && !dec.answer) {
    meLog(turnId, text, "skip", dec.why);
    return;
  }

  // 2. Show an answer, unless it would push a fresh card for the other side off the screen (an asked-for answer waits instead).
  const giveUpAt = Date.now() + 30_000;
  let cardOut = false;
  const show = (say: string, facts: string[], source: "calc" | "ai") => {
    const tryShow = () => {
      if (dead()) return;
      const now = Date.now();
      if (verdictP) {
        void settle().then((ok) => {
          if (ok) tryShow();
        });
        return;
      } // classifier still out: hold the card
      if (!dec.answer) return;
      const g = meGate.check(now, { forced, lastThemCardAt: st.cards.lastThemCardAt, calc: source === "calc", solo: isSolo() }); // arithmetic is instant and tiny: it ignores the protect-them window
      if (!g.ok) {
        if (g.why === "protect-them" && forced && now + g.waitMs < giveUpAt) {
          meLog(turnId, text, "defer", g.why, { waitMs: Math.round(g.waitMs) });
          const t = setTimeout(() => {
            meTimers2.delete(t);
            tryShow();
          }, g.waitMs + 50);
          meTimers2.add(t);
          return;
        }
        meLog(turnId, text, "skip", g.why);
        return;
      }
      if (!forced && now - speechEnd > S.reflex.dropStaleMs * 2) {
        meLog(turnId, text, "skip", "stale");
        return;
      }
      meGate.note(now);
      st.me.shown++;
      {
        const total = now - speechEnd;
        st.me.lat.push({ total, source });
        log.write("events", {
          type: "me.latency",
          turnId,
          source,
          stt: Math.max(0, r.arrivedAt - speechEnd),
          detect: Math.max(0, tStart - r.arrivedAt),
          decide: Math.max(0, tDecide - tStart),
          firstCard: Math.max(0, now - tDecide),
          total,
        });
      }
      emitCard({ id: `${turnId}-me`, turnId, badge: "me", forMe: true, source, question: text, say, facts, at: now });
      cardOut = true;
      meLog(turnId, text, "answer", dec.why, { source });
    };
    tryShow();
  };

  // 2a. arithmetic: local, instant, no model
  const math = evalMath(text);
  if (math) {
    show(math.say, [], "calc");
    return;
  }
  // 2b. everything else needs the model
  if (!canMeAi()) {
    meLog(turnId, text, "skip", noAi ? "no-ai" : "ai-unavailable");
    return;
  }
  const reserved = usableModels(true),
    usable = reserved.length ? reserved : usableModels(); // a half-open probe slot is taken only right before the request
  let tag: Tag | undefined,
    shownOnce = false;
  noteModel(turnId, usable[0]);
  await runReflex({
    registry,
    models: usable,
    cfg: S.llm.reflex,
    prefix,
    transcript: transcript.slice(-12).map(lineOf).join("\n"),
    question: text,
    context: contextNotes,
    signal: ac.signal,
    frame: frameText(tracker.current) || undefined,
    asker: "me",
    solo,
    maxTokens: Math.min(S.llm.reflex.maxTokens, 100),
    onFail: (model, err) => llmFailed(model, err),
    onSwitch: (from, to, err) => {
      noteModel(turnId, to);
      log.write("events", { type: "llm.switch", turnId, from, to, kind: err.kind });
    },
    h: {
      onTag(t) {
        tag = t;
      },
      onSay() {},
      onFacts() {},
      onSayComplete(say) {
        if (dead() || tag?.kind !== "ANS") return;
        const g = guardMe(say, text);
        if (!g.ok) {
          meLog(turnId, text, "skip", `guard:${g.rule}`);
          return;
        }
        shownOnce = true;
        show(say, [], "ai");
      },
      onDone({ usage, providerMetadata, text: raw, model }) {
        if (dead()) return;
        clearAiBar(model);
        noteReflexOk();
        breakers.get(model)?.success();
        sup.noteLlmOk();
        refreshSignals();
        const c = cost.addLlm("me", model, usage, providerMetadata);
        log.write("usage", { role: "me", model, prompt: PROMPT_V, turnId, usage, providerMetadata, usd: c.usd, roleTotalUsd: cost.roles.me.usd });
        log.write("events", { type: "reflex.raw", turnId, text: raw });
        if (!shownOnce && tag?.kind !== "ANS") meLog(turnId, text, "skip", `model:${tag?.kind ?? "none"}`);
        // The user pressed the ask key (or typed `ask`) and nothing came back: say so, never leave an empty screen.
        if (forced && !cardOut && !shownOnce) {
          meLog(turnId, text, "unsure", "forced-no-answer");
          show(askNotSure(), [], "ai");
        }
      },
    },
  }).catch((e: ProviderError) => {
    if (dead()) return;
    log.write("events", { type: "me.error", turnId, kind: e?.kind ?? "unknown", error: eventError(e) });
    // The model call failed (network, 529, 429, timeout). The user pressed the ask key (or typed `ask`): never leave an empty screen, and raise the bar at once.
    if (forced && !cardOut && !shownOnce) {
      meLog(turnId, text, "unsure", "forced-error", { kind: e?.kind ?? "unknown" });
      show(askError(), [], "ai");
    }
    if (e?.kind !== "refusal") countReflexFailure(e, forced);
  });
}
