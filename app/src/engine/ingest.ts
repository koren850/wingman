// STT results into the call: foreign-script and echo drops, side features, transcript, the per-channel buffer, and flush() into questions ("them") or handleMe ("me").
import { matchBank, matchBankFor } from "../bank.ts";
import { evalMath } from "../calc.ts";
import { checkScript } from "../lang.ts";
import { detect, addressesYou } from "../detector.ts";
import { introName } from "../speakers.ts";
import type { SttResult, Channel, Word } from "../providers/stt/types.ts";
import { joinSplit, isBareQuestionTail, type PrevUtterance } from "../split.ts";
import { splitMergedQuestions } from "../multiq.ts";
import { isAgencyTopic } from "../frame.ts";
import { S, log, flow, flowOn, transcript, lineOf, notesOn, speakers, attendees, echo, ECHO, sup, bank, interview, UI_LANG } from "./boot.ts";
import { voiceName, flowEvents } from "./flowmode.ts";
import { st, mono } from "./state.ts";
import { queueNoteLine, nameSpeaker, spotFacts, capture } from "./side.ts";
import { addWords } from "./coach.ts";
import { wordCount } from "../text-util.ts";
import { survived, health, healthClear } from "./out.ts";
import { LangWatch } from "../langwatch.ts";
import { ht } from "../htext.ts";
import { onQuestion } from "./question.ts";
import { handleMe } from "./me.ts";

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
  if (!p) return;
  clearTimeout(p.timer);
  delete pending[ch];
  const joined: SttResult = { ...p.last, text: p.texts.join(" "), words: p.words, speechFinal: true };
  if (st.call.shuttingDown) return;
  if (ch === "me") {
    handleMe(joined);
    return;
  }
  if (ch !== "them") return;
  const now = Date.now();
  if (isAgencyTopic(joined.text)) st.turn.lastAgencyTopicAt = now; // any customer line about sites / hosting keeps short follow-ups on topic
  const endWall = joined.speechEndWall ?? now;
  const w = joined.words;
  const startWall = w.length && joined.speechEndWall ? endWall - Math.max(0, (w[w.length - 1].end - w[0].start) * 1000) : now;
  const detectText = (t: string) => {
    const h = interview ? matchBank(t, bank) : matchBankFor(t, bank);
    return { hit: h, d: detect(t, { bankScore: h?.score ?? 0, stall: !!h && h.card.id.startsWith("stall-") }) };
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
  const FOLLOW_UP =
    /^(and\b|so\b|what did\b|how did\b|why\??$|what was\b|what happened\b|what was the (result|outcome)|ו?מה עשית|ו?איך פתרת|ולמה|ומה|ואיך|ומה היה)/i; // openers that continue the last question
  // Interview follow-up: "Tell me about a time X failed." + "What did you do?" a moment later, same voice, is ONE question. Alone the short
  // part has no context, and as a new question it would cancel the answer to the first part.
  const followUp =
    interview &&
    !otherVoice &&
    d.isQuestion &&
    !!lastThem?.question &&
    startWall - lastThem.at < 3000 &&
    wordCount(joined.text) <= 6 &&
    FOLLOW_UP.test(joined.text.trim());
  if (followUp) {
    log.write("events", { type: "split.followup", prev: lastThem!.text, text: joined.text });
    joined.text = `${lastThem!.text} ${joined.text}`;
  }
  lastThem = { text: joined.text.split(/\s+/).slice(-30).join(" "), at: endWall, question: d.isQuestion, spk: p.spk };
  // Fast back-to-back questions merged into one final: one question (and one card) per piece.
  const parts = d.isQuestion && !followUp ? splitMergedQuestions(joined.text, bank) : [joined.text];
  if (parts.length > 1) {
    log.write("events", { type: "split.multi", text: joined.text, parts });
    parts.forEach((p, part) => {
      const pd = detectText(p).d;
      log.write("events", { type: "detect", text: p, part, ...pd });
      if (pd.isQuestion && sup.caps.detect) onQuestion({ ...joined, text: p }, pd.reason);
    });
    return;
  }
  log.write("events", { type: "detect", text: joined.text, ...d });
  if (d.isQuestion && sup.caps.detect) onQuestion(joined, d.reason);
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
    return;
  }
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
  if (r.text.length > 2000) r = { ...r, text: r.text.slice(-2000) }; // a runaway final must not stall the regex/matching
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
      log.write("events", { type: "capture.error", error: String((e as Error)?.message ?? e) });
    }
    try {
      spotFacts(r.text);
    } catch (e) {
      log.write("events", { type: "facts.error", error: String((e as Error)?.message ?? e) });
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
    if (flowOn)
      try {
        flowEvents(flow.add({ ch: r.channel, spk: who?.spk, who: who ? voiceName(who) : undefined, text: r.text, at: Date.now() }));
      } catch (e) {
        log.write("events", { type: "flow.error", error: String((e as Error)?.message ?? e) });
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
