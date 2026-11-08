// What every answer path of a question shares: the cancel scope, the Turn record, the "buy time" line and the failure count. The three paths are
// question.ts (routing, bank, calc), question-moment.ts (Live reading) and question-classic.ts (the Classic rollback).
import { stallSay, type BankHit } from "../bank.ts";
import { isFresh } from "./rules.ts";
import type { SttResult } from "../providers/stt/types.ts";
import { ProviderError } from "../providers/errors.ts";
import { chosenKind, type MemoryKind } from "../session/types.ts";
import { health, errBrief } from "./out.ts";
import { ht } from "../htext.ts";
import { emitCard, recordLatency, type Card } from "./cards.ts";
import { stall, log, S, UI_LANG } from "./boot.ts";
import type { Moment } from "../moments/types.ts";
import type { BankCandidate } from "../moments/prompt.ts";
import type { ContextOutput } from "../context/build.ts";
import { st } from "./state.ts";

// st.q: turnSeq, reflexErrors (consecutive model failures: 2 in a row raise the "AI not answering" bar, 1 for an ask by the user; a success clears it)
// and bankShownAt (per-call state, see state.ts).

/** The call kind the answer-bank gates may trust: the one the user chose. A kind the model only guessed does not gate the bank (see chosenKind). */
export const askKind = (): MemoryKind | undefined => chosenKind(st.m.mem);

/** The cancel scope of one final. A final that holds several questions opens one scope: a newer final aborts all of its parts, but a part never aborts a sibling. */
export interface QScope {
  ac: AbortController;
  parts: number;
  /** Several parts share this scope: one part finishing early (arithmetic) must not detach the scope from `st.turn.current`. */
  shared: boolean;
  /** v2: the id of the moment call round of this final. Parts of one final share it, so a part never counts a sibling's call as newer. */
  mid?: number;
  /** v2: how many parts of this final showed a card (a later part is not held back by a sibling's card). */
  cards?: number;
}
/** Most parts of one final that get a turn (and a model call) at the same time. */
export const MAX_PARTS = 3;

/** One question while its card is built. `shown` is the card on screen for this question; `modelIgnored` is set when the model's answer must not be shown. */
export interface Turn {
  id: string;
  scope: QScope;
  r: SttResult;
  reason: string;
  speechEnd: number;
  ac: AbortController;
  lat: Record<string, number | string>; // one row of latency.jsonl
  hit?: BankHit; // the prepared card matched by keywords
  agencyTopic: boolean;
  agencyRecent: boolean;
  noAgency: boolean;
  noStall: boolean;
  weak: boolean;
  weakBank: boolean;
  bgBank: boolean;
  bankOnly: boolean;
  allowAns: boolean;
  lang?: "he" | "en";
  shown?: Card;
  modelIgnored: boolean;
  stallTimer?: NodeJS.Timeout;
  stallId: string;
  ai: Card;
  /** moments.engine = v2 for this question: the model call is a moment call, not a reflex call. */
  v2: boolean;
  /** v2: top bank candidates for the prompt, the id of this model call, its context record, and what it showed. */
  cands?: BankCandidate[];
  mid?: number;
  ctxRec?: ContextOutput["record"];
  mshown?: Moment;
  mcard?: Card;
  mskip?: boolean;
}
/** Answers older than reflex.dropStaleMs are never shown. */
export const fresh = (t: Turn) => isFresh(t.speechEnd, Date.now(), S.reflex.dropStaleMs);
export const meSpokeSince = (t: Turn) => st.voice.lastMeVoiced > t.speechEnd;
/** The "buy time" line for this question. */
export const stallCardFor = (t: Turn): Card => ({
  id: t.stallId,
  turnId: t.id,
  badge: "stall",
  question: t.r.text,
  say: stallSay(stall, st.q.turnSeq, t.lang),
  facts: [],
  at: Date.now(),
});

/** The reflex call failed. */
export function onReflexError(t: Turn, e: ProviderError) {
  const { id: turnId, lat } = t;
  clearTimeout(t.stallTimer);
  lat.aborted = t.ac.signal.aborted ? 1 : 0;
  if (t.ac.signal.aborted) {
    recordLatency(lat);
    return;
  }
  const kind = e?.kind ?? "unknown";
  log.write("events", { type: kind === "refusal" ? "reflex.empty" : "reflex.error", turnId, kind, error: errBrief(e) });
  console.error("reflex error:", errBrief(e));
  showStallOrError(t, kind);
  recordLatency(lat);
  if (kind !== "refusal") countReflexFailure(e);
}

/** Error kinds that put the "buy time" line up when nothing else is on screen. Not auth, quota, spend cap or a bad request: those have their own red/amber bar and a
 *  stall line would pretend the AI is only slow. */
const STALL_ON = new Set(["refusal", "timeout", "network", "overload", "rate", "unknown", "garbage", "truncated"]);
/** A failed model call must never leave an empty screen: the stall line, once, if no card is up for this turn. */
export function showStallOrError(t: Turn, kind: string) {
  if (!STALL_ON.has(kind) || t.shown || t.noStall || !fresh(t)) return;
  t.shown = stallCardFor(t);
  emitCard(t.shown);
  t.lat.stallAt = Date.now();
}

/** Counts a failed model call. 2 in a row raise the "AI not answering" bar; an ask by the user (`userAsk`) raises it on the first one. */
export function countReflexFailure(e: ProviderError, userAsk = false) {
  if (++st.q.reflexErrors >= (userAsk ? 1 : 2)) health("ai", "amber", ht(UI_LANG, "ai.silent"), String(e?.message ?? e));
}
/** A model call worked: the failure count starts again. */
export function noteReflexOk() {
  st.q.reflexErrors = 0;
}
