// Output language of the helper model prompts (summary, notes, tips, frame, topic, self-check).
// One rule for all of them: stt.language "en" means English; otherwise the share of Hebrew letters in the call text decides.
// Hebrew stays the default (no text, or too little to judge), so a Hebrew call never changes.

export type CallLang = "he" | "en";

const HE = /[֐-׿יִ-ﭏ]/gu;
const LAT = /[A-Za-z]/g;
// Speaker labels at the start of a line ("me:", "them (Dana):", "אני:", "לקוח:") are not speech.
const LABEL = /^(?:me|them|אני|לקוח|הצד השני)(?: \([^)\n]*\))?:[ \t]?/gmu;
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

/** Share of Hebrew letters (of Hebrew + Latin letters) at or above which a call counts as Hebrew; a Hebrew call with English terms stays far above it. */
export const HEBREW_SHARE = 0.25;
/** Fewer Latin letters than this is too little to call a text English. */
const MIN_LATIN = 8;

// With stt.language "multi" or "auto" the language of one call is decided once and then kept (one process = one call), so notes, topic, tips, frame and
// summary prompts do not flip between batches and the prompt cache prefix stays the same. It changes only after two different, strong verdicts in a row.
const DECIDE_LETTERS = 40; // Hebrew + Latin letters needed before the first verdict
const STRONG_EN = 0.1; // Hebrew share at or below this is clearly English
const STRONG_HE = 0.45; // Hebrew share at or above this is clearly Hebrew
let sticky: CallLang | undefined;
let against = 0;
let lastText = "";
/** Forget the decision (tests, or a new call in the same process). */
export function resetCallLang(): void {
  sticky = undefined;
  against = 0;
  lastText = "";
}
function stickyLanguage(text: string): CallLang {
  const h = count(text, HE),
    l = count(text, LAT);
  if (h + l < DECIDE_LETTERS) return sticky ?? "he";
  const share = h / (h + l);
  if (!sticky) return (sticky = share >= HEBREW_SHARE ? "he" : "en");
  if (text === lastText) return sticky; // the same text asked by another helper is not new evidence
  lastText = text;
  const contrary = sticky === "he" ? share <= STRONG_EN : share >= STRONG_HE;
  against = contrary ? against + 1 : 0;
  if (against >= 2) {
    sticky = sticky === "he" ? "en" : "he";
    against = 0;
  }
  return sticky;
}

/**
 * "he" or "en" for a call. `sttLanguage` is the stt.language setting ("he" | "en" | "multi" | "auto"); only "en" is decisive.
 * `text` is what was said (speaker labels left out). No text, or only a few Latin letters = "he".
 */
export function callLanguage(text: string, sttLanguage?: string): CallLang {
  if (sttLanguage === "en") return "en";
  text = text.replace(LABEL, "");
  if (sttLanguage === "multi" || sttLanguage === "auto") return stickyLanguage(text);
  const h = count(text, HE),
    l = count(text, LAT);
  if (l < MIN_LATIN) return "he";
  return h / (h + l) >= HEBREW_SHARE ? "he" : "en";
}
