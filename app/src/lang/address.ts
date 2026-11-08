// Who is a line aimed at? The "you" and question-opener patterns that used to be copied in detector.ts, engine/rules.ts and flow.ts live here, unchanged.
// They are NOT one pattern on purpose: each caller needs a different strictness (see the notes). Nothing was added or reworded when they moved.
// No new words (round 12): the detector is frozen as an offline hint, and the model decides who a line is aimed at.
import { nameRegex } from "../profile.ts";

/** A question head counts as aimed at the user when this matches: plural and singular "you", "can you", "possible". Used by detector.isClearQuestion (cards.focus). */
export const YOU_GROUP = /(^|[\s,])(לכם|לך|אתם|אתה|תוכל|תוכלו|אפשר|you|your)(?![\p{L}])/iu;

/** Second person singular aimed at the user (Hebrew masculine/neutral forms, English you/your): "עבדת פעם עם", "ספר לי", "what's your". Used by detector.addressesYou. */
export const YOU_SINGLE = /(^|[\s,.?!"'])(אתה|לך|שלך|אותך|עליך|ממך|איתך|ספר|תספר|תאר|תסביר|עבדת|היית|ניסית|יצא לך|you|your|yourself)(?![\p{L}])/iu;

/** Second-person forms YOU_SINGLE does not cover: feminine and "opinion" forms ("מה דעתך", "תוכלי", "את חושבת"), English contractions and texting forms.
 *  Plural forms (אתם, לכם) are left out on purpose: inside their own discussion two of them say "אתם" to each other. Used by engine/rules.ts addressesUser. */
export const YOU_MORE =
  /(^|[\s,.?!"'])(דעתך|לדעתך|בעיניך|ניסיונך|מניסיונך|תוכלי|תגיד|תגידי|ספרי|תספרי|תארי|תסבירי|עבדת|את\s+(?:יכולה|חושבת|מכירה|יודעת|רוצה|מוכנה|עובדת|רואה|שומעת|מסכימה|הייתי?)|u|ya|you'?(?:re|ll|ve|d)|yourself)(?![\p{L}])/iu;

/** "Turning to the user" right after their colleagues' own discussion (flow mode). Used by flow.ts. */
export const YOU_FLOW = /(^|[\s,])(לך|אתה|תוכל|מה דעתך|what do you think|can you|could you|you)(?![\p{L}])/iu;

/** The line speaks to the user: second person singular, or the user's name (profile.ts). */
export function addressesYou(text: string): boolean {
  return YOU_SINGLE.test(text) || nameRegex().test(text);
}
/** Same as addressesYou plus the feminine/opinion forms. */
export function addressesUser(text: string): boolean {
  return addressesYou(text) || YOU_MORE.test(text);
}
/** A question head (the detector's weak cue) aimed at the user or the group. */
export function headAimedAtYou(text: string): boolean {
  return YOU_GROUP.test(text);
}
