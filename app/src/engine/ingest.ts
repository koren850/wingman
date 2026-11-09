// STT results into the call: foreign-script and echo drops, side features, transcript, the per-channel buffer, and flush() into questions ("them") or handleMe ("me").
import { cleanSttText } from "../stt-clean.ts";
import { speechRing } from "../session/coaching.ts";
import { eventError } from "../errtext.ts";
import { matchBank, matchBankFor, matchBankSmart } from "../bank.ts";
import { evalMath } from "../calc.ts";
import { checkScript } from "../lang.ts";
import { detect, addressesYou, isClearQuestion } from "../detector.ts";
import { introName } from "../speakers.ts";
import type { SttResult, Channel, Word } from "../providers/stt/types.ts";
import { joinSplit, isBareQuestionTail, type PrevUtterance } from "../split.ts";
import { splitMergedQuestions } from "../multiq.ts";
import { splitAtQuestionMarks } from "../moments/split.ts";
import { isFollowUp } from "../lang/followup.ts";
import { noteTopicLine } from "./vertical.ts";
import { floorQuestion, addressedElsewhere } from "../moments/floor.ts";
import { features as lineFeatures } from "../moments/intake.ts";
import { nameWords } from "../profile.ts";
import { normalize } from "../normalize.ts";
import { S, log, flow, flowOn, transcript, lineOf, notesOn, speakers, attendees, echo, ECHO, sup, bank, interview, UI_LANG } from "./boot.ts";
import { voiceName, flowEvents } from "./flowmode.ts";
import { st, mono } from "./state.ts";
import { queueNoteLine, nameSpeaker, spotFacts, capture, checkOwnLine } from "./side.ts";
import { addWords } from "./coach.ts";
import { wordCount } from "../text-util.ts";
import { survived, health, healthClear } from "./out.ts";
import { LangWatch } from "../langwatch.ts";
import { ht } from "../htext.ts";
import { onQuestion, openScope } from "./question.ts";
import { MAX_PARTS } from "./turn.ts";
import { handleMe } from "./me.ts";
import { v2Active, currentPause } from "./degrade.ts";
import { keepFeatures, routeThem } from "./moments.ts";
import { noteLine, noteMeLine, speedOf, speedCtx } from "./moments-observer.ts";
import type { HintLevel } from "../moments/types.ts";

// Buffer is_final segments per channel and handle the joined utterance on speech_final (or a short fallback timer, stt.flushFallbackMs,
// for when the end-of-speech mark never arrives).
type Pending = { texts: string[]; words: Word[]; last: SttResult; timer?: NodeJS.Timeout; spk?: number };
export const pending: Partial<Record<Channel, Pending>> = {};
let lastThem: (PrevUtterance & { spk?: number }) | undefined; // S10: the previous client utterance, for split questions
/** Handles one buffered utterance: "me" -> handleMe; "them" -> glue split questions, split merged ones, detect, onQuestion. */
function flush(ch: Channel) {
  try {
    flushCore(ch);
  } catch (e) {
    survived("flush", e);
  }
}
function flushCore(ch: Channel) {
  const p = pending[ch];
  if (!p) {
    // The final of an early-started utterance was dropped (foreign script, echo): its early turn must not stay, nor block the next utterance.
    if (ch === "them") {
      const ev = takeEarly();
      if (ev) abortEarly(ev, "final-dropped");
    }
    return;
  }
  clearTimeout(p.timer);
  delete pending[ch];
  const joined: SttResult = { ...p.last, text: p.texts.join(" "), words: p.words, speechFinal: true };
  if (st.call.shuttingDown) return;
  if (ch === "me") {
    if (v2Active() && keepFeatures("me", joined.text, joined.speechEndWall ?? Date.now())) {
      checkOwnLine(joined.text); // the user's own numbers against the notes and the memory
      noteMeLine({ text: joined.text, at: joined.speechEndWall ?? Date.now() }); // the question to the user got its answer; a coaching mode reads long answers
    }
    handleMe(joined);
    return;
  }
  if (ch !== "them") return;
  const now = Date.now();
  noteTopicLine(joined.text, now); // the vertical hook (engine/vertical.ts): a line on the vertical's topic keeps short follow-ups on topic
  const endWall = joined.speechEndWall ?? now;
  // Live reading (the default): the model decides what a line means. No question detector runs; the speed hint reads the shape of the line only.
  // Below: the legacy engine uses the old detector. While the AI is paused (no model can read the line) the floor decides: the shape of the line and the bank
  // (moments/floor.ts), with the old detector only as a tiebreak hint.
  if (v2Active() && !currentPause()) return flushNeutral(joined, p.spk, endWall);
  const lingering = takeEarly(); // the AI got paused or the engine is classic: an early turn of this utterance does not stay on screen
  if (lingering) abortEarly(lingering, "not-live");
  const w = joined.words;
  const startWall = w.length && joined.speechEndWall ? endWall - Math.max(0, (w[w.length - 1].end - w[0].start) * 1000) : now;
  const detectText = (t: string) => {
    const h = interview ? matchBank(t, bank) : matchBankFor(t, bank);
    const stall = !!h && h.card.id.startsWith("stall-");
    const legacy = detect(t, { bankScore: h?.score ?? 0, stall });
    return { hit: h, d: v2Active() ? floorDetect(t, h, stall, legacy) : legacy };
  };
  let { hit, d } = detectText(joined.text);
  // Interview: a line that matches one of the user's prepared cards is a question even without a question mark ("עבדת פעם עם טלפוניה").
  // Only when it is aimed at the user or matches a multi-word trigger: in review, most such cards fired while the other side described their own company
  // ("מפתחים פלטפורמה שמיועדת לארגונים גדולים" matched the one-word trigger "פלטפורמה").
  if (interview && !d.isQuestion && hit && wordCount(joined.text) >= 3 && (hit.score >= 2 || addressesYou(joined.text)))
    d = { ...d, isQuestion: true, reason: "interview-card" };
  // Glue the previous short fragment only when that turns a non-question into a question (a split question: "כמה זה" ... "עולה לחודש?").
  // Never glue two different voices: one person's fragment is not the start of another person's question.
  const otherVoice = p.spk !== undefined && lastThem?.spk !== undefined && p.spk !== lastThem.spk;
  const glued =
    otherVoice || (d.isQuestion && !isBareQuestionTail(joined.text, d.reason)) ? joined.text : joinSplit(lastThem, joined.text, startWall, S.stt.joinWindowMs);
  if (glued !== joined.text) {
    const g = detectText(glued);
    if (g.d.isQuestion) {
      log.write("events", { type: "split.join", prev: lastThem?.text, text: joined.text });
      joined.text = glued;
      hit = g.hit;
      d = g.d;
    }
  }
  // Interview follow-up: "Tell me about a time X failed." + "What did you do?" a moment later, same voice, is ONE question. Alone the short
  // part has no context, and as a new question it would cancel the answer to the first part.
  const followUp =
    interview &&
    !otherVoice &&
    d.isQuestion &&
    !!lastThem?.question &&
    startWall - lastThem.at < 3000 &&
    wordCount(joined.text) <= 6 &&
    isFollowUp(joined.text);
  if (followUp) {
    log.write("events", { type: "split.followup", prev: lastThem!.text, text: joined.text });
    joined.text = `${lastThem!.text} ${joined.text}`;
  }
  lastThem = { text: joined.text.split(/\s+/).slice(-30).join(" "), at: endWall, question: d.isQuestion, spk: p.spk };
  // Moment engine (moments.engine = v2): every kept line can get help; the model decides. The old gate is only a hint (strong, weak, none).
  // A strong hint asks the model now (the old path below, with its bank card, calc and stall line, and the moment call inside it).
  // A weak or no hint waits in the observer window. A paused AI keeps the old path for any question and does nothing for the rest.
  let toDirect = false;
  if (v2Active()) {
    const level: HintLevel = d.isQuestion ? (isClearQuestion(joined.text, d.reason) ? "strong" : "weak") : "none";
    if (!keepFeatures("them", joined.text, endWall, p.spk !== undefined ? `s${p.spk}` : undefined)) return;
    const r = routeThem(level);
    if (r.route !== "direct" && r.route !== "local") {
      log.write("events", { type: "moment.route", route: r.route, why: r.why, hint: level, text: joined.text.slice(0, 80) });
      if (r.route === "observer") noteLine({ text: joined.text, at: endWall, hint: level, hasFigure: /[\p{Nd}\p{Sc}]/u.test(joined.text) });
      return;
    }
    toDirect = r.route === "direct";
  }
  // Fast back-to-back questions merged into one final: one question (and one card) per piece.
  const parts = d.isQuestion && !followUp ? splitMergedQuestions(joined.text, bank) : [joined.text];
  if (parts.length > 1) {
    log.write("events", { type: "split.multi", text: joined.text, parts });
    // One cancel scope for the whole final: a newer final aborts every part, a part never aborts its sibling. At most MAX_PARTS run.
    const scope = openScope(true);
    parts.slice(0, MAX_PARTS).forEach((p, part) => {
      const pd = detectText(p).d;
      log.write("events", { type: "detect", text: p, part, ...pd });
      if (pd.isQuestion && sup.caps.detect) onQuestion({ ...joined, text: p }, pd.reason, scope);
    });
    return;
  }
  log.write("events", { type: "detect", text: joined.text, ...d });
  if (d.isQuestion && sup.caps.detect) {
    const started = onQuestion(joined, d.reason);
    // v2: a strong line the old filters skipped (a question between others, "if ..." talk) still reaches the model, through the observer.
    if (toDirect && !started) noteLine({ text: joined.text, at: endWall, hint: "weak", hasFigure: /[\p{Nd}\p{Sc}]/u.test(joined.text) });
  }
}

/** The paused-AI decision for a line (the floor): shape + bank, the legacy detector `legacy` only as a tiebreak. Same result shape as detect(). */
function floorDetect(text: string, hit: ReturnType<typeof matchBank>, stall: boolean, legacy: ReturnType<typeof detect>): ReturnType<typeof detect> {
  const f = lineFeatures({ text, side: "them", at: Date.now() });
  const level: HintLevel = legacy.isQuestion ? (isClearQuestion(text, legacy.reason) ? "strong" : "weak") : "none";
  const others = st.m.mem.roster.filter((p) => p.side !== "me").map((p) => p.name);
  const me = [...nameWords(), ...st.m.mem.roster.filter((p) => p.side === "me").map((p) => p.name)];
  const r = floorQuestion(f, {
    addressed: speedCtx(text).addressed,
    elsewhere: addressedElsewhere(text, others, me),
    bankScore: hit?.score ?? 0,
    stall,
    scorer: !hit && !!matchBankSmart(text, bank).hit,
    hint: level,
  });
  return { isQuestion: r.isQuestion, reason: r.via === "hint" ? legacy.reason : r.reason };
}

/** A finished line from the other side on the live-reading engine: intake, the language-neutral speed hint, then the direct path (fast) or the observer window (normal). */
function flushNeutral(joined: SttResult, spk: number | undefined, endWall: number) {
  const ev = takeEarly();
  const f = keepFeatures("them", joined.text, endWall, spk !== undefined ? `s${spk}` : undefined);
  const same = !!ev && normalize(joined.text) === ev.key;
  if (ev && !(same && f)) abortEarly(ev, f ? "text-changed" : "line-dropped");
  if (!f) return;
  if (ev && same) {
    // The early turn is already running on this very text: the final does not start a second one. The observer keeps the line for the "question, then silence" look.
    log.write("events", { type: "early.dedupe", text: joined.text.slice(0, 80) });
    lastThem = { text: joined.text.split(/\s+/).slice(-30).join(" "), at: endWall, question: true, spk };
    noteLine({ text: joined.text, at: endWall, hint: "none", features: f, asked: true });
    return;
  }
  const sp = speedOf(f, joined.text);
  const fast = sp.speed === "fast";
  lastThem = { text: joined.text.split(/\s+/).slice(-30).join(" "), at: endWall, question: fast, spk };
  const r = routeThem(fast ? "strong" : "none");
  if (r.route !== "direct") {
    log.write("events", { type: "moment.route", route: r.route, why: r.why, speed: sp.speed, text: joined.text.slice(0, 80) });
    if (r.route === "observer") noteLine({ text: joined.text, at: endWall, hint: "none", features: f, addressed: sp.ctx.addressed });
    return;
  }
  const reason = sp.reason === "question-mark" ? "question-mark" : "speed-hint"; // a "?" from the speech-to-text is a clear question; the other shapes are not
  log.write("events", { type: "detect", text: joined.text, isQuestion: true, reason, via: "speed-hint", speed: sp.speed });
  // Several marked questions in one final: one question (and one card) per piece, on one cancel scope.
  const parts = splitAtQuestionMarks(joined.text, MAX_PARTS);
  if (parts.length > 1 && sup.caps.detect) {
    log.write("events", { type: "split.multi", text: joined.text, parts });
    const scope = openScope(true);
    for (const part of parts) onQuestion({ ...joined, text: part }, "question-mark", scope);
    noteLine({ text: joined.text, at: endWall, hint: "none", features: f, asked: true });
    return;
  }
  const started = sup.caps.detect ? onQuestion(joined, reason) : false;
  // Started: the observer only keeps the line for the "question, then 2 s of silence" look. Not started (the old filters skipped it): the observer reads it.
  noteLine({ text: joined.text, at: endWall, hint: started ? "none" : "weak", features: f, ...(started ? { asked: true } : {}) });
}

// ---- Early start (moments.earlyStart, default off) ----
// A partial result of the other side that stops changing, and that the language-neutral speed hint calls fast, starts the direct path before the final arrives:
// after 300 ms when it ends in a "?", after a 600 ms pause otherwise. One early start per utterance (a flapping partial never starts twice). The final then
// either has the same text (deduped, no second call) or a different one (the early turn is aborted and the final runs the normal way).
export const EARLY_STABLE_MS = 300;
export const EARLY_PAUSE_MS = 600;
type Early = { text: string; timer?: NodeJS.Timeout; startedAt?: number; started?: { key: string; ac: AbortController | undefined } };
/** An early start whose final never came (lost, or never flushed) is forgotten after this long, so the next utterance can start early. */
const EARLY_STALE_MS = 15_000;
let early: Early = { text: "" };
/** The early turn of this utterance (if one started), and a clean slate for the next one. */
function takeEarly(): { key: string; ac: AbortController | undefined } | undefined {
  clearTimeout(early.timer);
  const s = early.started;
  early = { text: "" };
  return s;
}
function abortEarly(ev: { key: string; ac: AbortController | undefined }, why: string) {
  if (ev.ac && st.turn.current === ev.ac) {
    ev.ac.abort();
    st.turn.current = undefined;
  }
  log.write("events", { type: "early.abort", why });
}
function earlyPartial(r: SttResult) {
  if (!S.moments.earlyStart || r.channel !== "them" || !r.text || !v2Active() || currentPause()) return;
  if (st.call.shuttingDown || !st.call.consented || !sup.caps.detect) return;
  const text = r.text.trim();
  const key = normalize(text);
  if (early.started && early.startedAt !== undefined && Date.now() - early.startedAt > EARLY_STALE_MS) takeEarly();
  if (key === early.text) return; // the same text again: the timer of its first sighting keeps running
  clearTimeout(early.timer);
  early.text = key;
  if (early.started || !key) return; // one early start per utterance
  const f = lineFeatures({ text, side: "them", at: Date.now() });
  if (f.words < 2 || speedOf(f, text).speed !== "fast" || splitAtQuestionMarks(text, MAX_PARTS).length > 1) return; // several marked questions wait for the final (one card each)
  early.timer = setTimeout(
    () => {
      try {
        startEarly(r, text, key, f.endsWithQuestion);
      } catch (e) {
        survived("early.start", e);
      }
    },
    f.endsWithQuestion ? EARLY_STABLE_MS : EARLY_PAUSE_MS,
  );
}
function startEarly(r: SttResult, text: string, key: string, marked: boolean) {
  if (early.text !== key || early.started || st.call.shuttingDown || currentPause()) return;
  if (routeThem("strong").route !== "direct") return;
  const now = Date.now();
  const res: SttResult = { ...r, text, isFinal: true, speechFinal: true, arrivedAt: now, speechEndWall: now };
  log.write("events", { type: "detect", text, isQuestion: true, reason: marked ? "question-mark" : "speed-hint", via: "early-start" });
  if (onQuestion(res, marked ? "question-mark" : "speed-hint")) {
    early.started = { key, ac: st.turn.current };
    early.startedAt = Date.now();
  }
}

// Words while they are spoken: interim STT text goes to live.jsonl (at most 4 rows a second per channel) for the answer window's
// live strip. The final line in transcript.jsonl replaces it. live.jsonl is deleted when the call ends (the transcript has it all).
const lastPartialAt: Partial<Record<Channel, number>> = {};
function livePartial(r: SttResult) {
  if (!r.text || !st.call.consented || st.call.shuttingDown || !S.overlay.showLastLine) return;
  const now = Date.now();
  if (now - (lastPartialAt[r.channel] ?? 0) < 250) return;
  if (S.stt.dropForeignScript && !checkScript(r.text).ok) return;
  lastPartialAt[r.channel] = now;
  const who = r.channel === "them" && S.stt.speakers ? speakers.peek(r.words) : undefined; // peek: an interim id must not take a Speaker number
  log.write("live", { ch: r.channel, text: r.text.slice(-300), ...(who ? { spk: who.spk, ...(who.name ? { name: who.name } : {}) } : {}) });
}

/** Every STT result (both channels). Only finals matter. Drops foreign-script junk, logs, then routes "me" lines through the echo filter delay. */
export function onResult(r: SttResult) {
  try {
    onResultCore(r);
  } catch (e) {
    survived("onResult", e);
  }
}
/** Unsupported-language notice: a streak of foreign-script or non-English Latin finals shows ONE status line (health bar "lang"), see langwatch.ts. */
const langWatch = new LangWatch();
function watchLanguage(r: SttResult) {
  if (!r.text || st.call.closing || st.call.shuttingDown) return;
  const act = langWatch.note(r.text);
  if (act === "show") {
    log.write("events", { type: "lang.unsupported", ch: r.channel, ...langWatch.counts });
    health("lang", "amber", ht(UI_LANG, "lang.unsupported"));
  } else if (act === "clear") healthClear("lang");
}
function onResultCore(r: SttResult) {
  if (!r.isFinal) {
    livePartial(r);
    earlyPartial(r);
    return;
  }
  if (r.text) r.text = cleanSttText(r.text); // Hebrew numbers and weekdays that smart formatting wrote as "60 1000" and "יום 4º"
  watchLanguage(r);
  // Hebrew + English mixing sometimes hallucinates Telugu / Persian / Arabic on short clips: such a final triggers nothing.
  if (S.stt.dropForeignScript && r.text) {
    const sc = checkScript(r.text);
    if (!sc.ok) {
      st.stt.foreignDropped++;
      log.write("events", {
        type: "stt.foreign-script",
        ch: r.channel,
        text: r.text.slice(0, 80),
        ratio: Number(sc.ratio.toFixed(2)),
        n: st.stt.foreignDropped,
      });
      if (r.speechFinal) {
        flush(r.channel);
      } // the pending (good) text of this utterance still gets handled
      return;
    }
  }
  log.write("events", { type: "stt", ch: r.channel, final: true, speechFinal: r.speechFinal, text: r.text, speechEndWall: r.speechEndWall });
  if (r.channel === "them" && r.text) echo.noteThem(r.text, r.arrivedAt);
  // "me" lines wait briefly so the client line they may echo has arrived (the two channels' finals are not time-ordered), then go through the echo filter.
  // (No wait when the other side has not spoken within the filter window: there is nothing the mic could be echoing.)
  // Once one "me" final is waiting, the next one waits too (same delay, so timers fire in order): otherwise a later piece of one utterance would overtake the first.
  if (
    r.channel === "me" &&
    r.text &&
    st.echo.useFilter &&
    !st.call.shuttingDown &&
    (meTimers.size > 0 || Date.now() - st.voice.lastThemSpeech < ECHO.filterWindowMs + ECHO.filterDelayMs)
  ) {
    const t = setTimeout(() => {
      meTimers.delete(t);
      acceptResult(r, true);
    }, ECHO.filterDelayMs);
    meTimers.set(t, r);
    return;
  }
  // Stop was pressed and the STT sockets are still flushing: the last words are kept (transcript, summary); the echo filter still applies to the user's line.
  acceptResult(r, st.call.closing && r.channel === "me" && st.echo.useFilter);
}
/** Pending echo-filter delays: timer -> the "me" final it holds. Shutdown books them at once instead of dropping them (see closeLateFinals). */
export const meTimers = new Map<NodeJS.Timeout, SttResult>();
/** A final that arrives after Stop, while the STT channels flush (ws-base.ts waits ~1.5 s for them): it is part of the call, so it goes to transcript.jsonl and the summary input. */
function bookLate(r: SttResult) {
  const who = r.channel === "them" && S.stt.speakers ? speakers.of(r.words) : undefined;
  transcript.push({ ch: r.channel, text: r.text, at: Date.now(), ...(who ? { who } : {}) });
  log.write("transcript", {
    ch: r.channel,
    text: r.text,
    words: r.words,
    late: true,
    ...(who ? { spk: who.spk, ...(who.name ? { name: who.name } : {}) } : {}),
  });
}
/** Longest final text the engine reads. */
export const MAX_FINAL_CHARS = 2000;
/** A final over MAX_FINAL_CHARS keeps its newest words: the text starts at a word boundary and the word list is cut the same way (same words, same order), so the
 *  speaker book and the speech end time still read the words that are in the text. */
export function capFinal(r: SttResult): SttResult {
  if (r.text.length <= MAX_FINAL_CHARS) return r;
  let text = r.text.slice(-MAX_FINAL_CHARS);
  const sp = /\s/u.exec(text);
  if (sp && r.text[r.text.length - MAX_FINAL_CHARS - 1] !== " " && sp.index < 60) text = text.slice(sp.index + 1); // do not start in the middle of a word
  text = text.trim();
  let used = 0;
  let n = 0;
  for (let i = r.words.length - 1; i >= 0; i--) {
    used += r.words[i].word.length + (n ? 1 : 0);
    if (used > text.length) break;
    n++;
  }
  return { ...r, text, words: n ? r.words.slice(-n) : [] };
}
/** Takes a final into the call: echo drop, side features (capture, facts, notes), transcript, then buffers it for flush(). */
function acceptResult(r: SttResult, checkEcho: boolean) {
  try {
    acceptResultCore(r, checkEcho);
  } catch (e) {
    survived("acceptResult", e);
  }
}
export function acceptLate(r: SttResult, checkEcho: boolean) {
  acceptResult(r, checkEcho);
}
function acceptResultCore(r: SttResult, checkEcho: boolean) {
  if (st.call.shuttingDown && !st.call.closing) return;
  r = capFinal(r); // a runaway final must not stall the regex/matching
  if (checkEcho) {
    const e = echo.isEcho(r.text);
    if (e.echo) {
      st.echo.dropped++;
      log.write("events", { type: "echo.drop", text: r.text, score: Number(e.score.toFixed(2)) });
      return;
    }
  }
  if (st.call.shuttingDown) {
    if (r.text) bookLate(r);
    return;
  } // closing: only the transcript; no card, no question, no note, no capture
  if (r.text) {
    st.voice.lastSpeechMono = mono();
    if (r.channel === "them") {
      st.voice.lastThemText = Date.now();
      st.voice.lastThemSpeech = Date.now();
      st.voice.themHeard();
    }
    // Side features must never take the call down: a bad snapshot row or odd text only loses its own card.
    try {
      capture(r.channel, r.text);
    } catch (e) {
      log.write("events", { type: "capture.error", error: eventError(e) });
    }
    try {
      spotFacts(r.text);
    } catch (e) {
      log.write("events", { type: "facts.error", error: eventError(e) });
    }
    let who = r.channel === "them" && S.stt.speakers ? speakers.of(r.words) : undefined;
    // "היי, אני רות מצוות ה-IT" / "I'm Dana": the voice that introduces itself gets that name (the meeting's attendees first).
    if (who && !who.name) {
      const n = introName(r.text, attendees);
      if (n) {
        nameSpeaker(who.spk, n, "intro");
        who = speakers.of(r.words);
      }
    }
    if (notesOn) queueNoteLine(lineOf({ ch: r.channel, text: r.text, who }));
    if (r.channel === "me" && r.text.length >= 6 && r.text.split(/\s+/).length >= 2) st.voice.lastMeVoiced = Date.now();
    transcript.push({ ch: r.channel, text: r.text, at: Date.now(), ...(who ? { who } : {}) });
    speechRing.push({ ch: r.channel, text: r.text, t: Date.now(), words: r.words }); // live nudges (coach.nudges) read the last minutes of speech from here
    if (flowOn)
      try {
        flowEvents(flow.add({ ch: r.channel, spk: who?.spk, who: who ? voiceName(who) : undefined, text: r.text, at: Date.now() }));
      } catch (e) {
        log.write("events", { type: "flow.error", error: eventError(e) });
      }
    addWords(wordCount(r.text));
    log.write("transcript", { ch: r.channel, text: r.text, words: r.words, ...(who ? { spk: who.spk, ...(who.name ? { name: who.name } : {}) } : {}) });
    // A different voice starts a new turn: never glue two people's words into one question.
    if (who && pending[r.channel] && pending[r.channel]!.spk !== undefined && pending[r.channel]!.spk !== who.spk) flush(r.channel);
    const p = (pending[r.channel] ??= { texts: [], words: [], last: r });
    if (who) p.spk = who.spk;
    p.texts.push(r.text);
    p.words.push(...r.words);
    p.last = r;
    clearTimeout(p.timer);
    p.timer = setTimeout(() => flush(r.channel), S.stt.flushFallbackMs);
    // The user's own question: do not wait for the end-of-speech mark or the fallback timer when the text already ends in "?" or is a sum.
    if (r.channel === "me" && S.assist.answerMe !== "off" && (/\?\s*$/.test(r.text) || evalMath(p.texts.join(" ")))) {
      flush("me");
      return;
    }
  }
  if (r.speechFinal) flush(r.channel);
}
