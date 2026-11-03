// Script filter for speech-to-text finals. Hebrew + English mixing ("multi") sometimes hallucinates Telugu, Persian or
// Arabic text on short or quiet clips. A final whose letters are mostly neither Hebrew nor Latin is dropped (logged,
// counted; run.ts, setting stt.dropForeignScript), so it can never trigger a question, a card, a note or a summary line.

// HEBREW = Hebrew block (U+0590-05FF) + presentation forms (U+FB1D-FB4F). LATIN = A-Z plus accented Latin up to U+024F.
const HEBREW = /[֐-׿יִ-ﭏ]/u;
const LATIN = /[A-Za-zÀ-ɏ]/u;
const LETTER = /\p{L}/u;

/** Result of checkScript: counts of all letters and of letters in another script, and their share. */
export type ScriptCheck = { ok: boolean; letters: number; foreign: number; ratio: number };

/** ok = the text is Hebrew, Latin or digits (at most `maxForeign` of its letters in another script). */
export function checkScript(text: string, maxForeign = 0.4): ScriptCheck {
  let letters = 0, foreign = 0;
  for (const ch of String(text ?? "")) {
    if (!LETTER.test(ch)) continue;
    letters++;
    if (!HEBREW.test(ch) && !LATIN.test(ch)) foreign++;
  }
  const ratio = letters ? foreign / letters : 0;
  return { ok: letters === 0 || ratio <= maxForeign, letters, foreign, ratio };
}
