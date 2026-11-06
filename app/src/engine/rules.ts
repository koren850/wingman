// Small decisions the engine modules share, kept free of call state (no imports from boot.ts) so tests can call them directly.
import { addressesYou } from "../detector.ts";

/** Second-person forms that detector.addressesYou does not cover: feminine and "opinion" forms ("מה דעתך", "תוכלי", "את חושבת"), English contractions and texting forms.
 *  Plural forms (אתם, לכם) are left out on purpose: inside their own discussion two of them say "אתם" to each other. */
const MORE_YOU =
  /(^|[\s,.?!"'])(דעתך|לדעתך|בעיניך|ניסיונך|מניסיונך|תוכלי|תגיד|תגידי|ספרי|תספרי|תארי|תסבירי|עבדת|את\s+(?:יכולה|חושבת|מכירה|יודעת|רוצה|מוכנה|עובדת|רואה|שומעת|מסכימה|הייתי?)|u|ya|you'?(?:re|ll|ve|d)|yourself)(?![\p{L}])/iu;

/** Is this line aimed at the user ("you", their name, Hebrew masculine/feminine forms)? Used by flow mode, which holds questions the others ask each other. */
export function addressesUser(text: string): boolean {
  return addressesYou(text) || MORE_YOU.test(text);
}

/** How many of the AI notes written so far go back to the notes model each round (it only needs the recent ones to avoid repeating itself). */
export const NOTES_EXISTING_MAX = 40;
export function recentNotes(notes: readonly string[]): string[] {
  return notes.slice(-NOTES_EXISTING_MAX);
}

/** Interview: when the current answer of the user began. An answer is the user talking since the other side last spoke; a pause of more than 10 s
 *  between the user's lines starts a new one (if the interviewer's audio is dead, the other-side clock never moves and the answer would never end). */
export const ANSWER_PAUSE_MS = 10_000;
export function nextAnswerStart(o: { answerStart: number; lastThemSpeech: number; lastMeLineAt: number; now: number }): number {
  if (!o.answerStart || o.lastThemSpeech > o.answerStart || (o.lastMeLineAt > 0 && o.now - o.lastMeLineAt > ANSWER_PAUSE_MS))
    return Math.max(o.lastThemSpeech, o.now - 5000);
  return o.answerStart;
}
