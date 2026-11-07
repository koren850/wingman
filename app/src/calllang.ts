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

/**
 * "he" or "en" for a call. `sttLanguage` is the stt.language setting ("he" | "en" | "multi" | "auto"); only "en" is decisive.
 * `text` is what was said (speaker labels left out). No text, or only a few Latin letters = "he".
 */
export function callLanguage(text: string, sttLanguage?: string): CallLang {
  if (sttLanguage === "en") return "en";
  text = text.replace(LABEL, "");
  const h = count(text, HE),
    l = count(text, LAT);
  if (l < MIN_LATIN) return "he";
  return h / (h + l) >= HEBREW_SHARE ? "he" : "en";
}
