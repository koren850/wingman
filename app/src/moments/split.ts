// Several questions in one final, found by the question marks the speech-to-text wrote. Language-neutral: punctuation only, no word list.
// "איך DNS עובד? ומה זה SSL ולמה צריך אותו?" -> two parts. A part needs 2 or more tokens. Text after the last mark joins the last part.
import { tokenCount } from "./intake.ts";

const PART = /[^?؟]*[?؟]+/gu;

/** The parts of a final, or just [text] when it is not two or more marked questions. */
export function splitAtQuestionMarks(text: string, maxParts = 3): string[] {
  const t = String(text ?? "").trim();
  const marked = t.match(PART)?.map((s) => s.trim()) ?? [];
  if (marked.length < 2 || marked.some((s) => tokenCount(s) < 2)) return [t];
  const rest = t.slice(marked.join(" ").length).trim();
  const parts = marked.slice();
  if (rest && /\S/.test(rest)) parts[parts.length - 1] = `${parts[parts.length - 1]} ${rest}`.trim();
  return parts.slice(0, maxParts);
}
