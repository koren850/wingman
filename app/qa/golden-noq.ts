// Checks the "noq" label of a golden moment: the line the card follows (and the line before it) has no "?" and no question word, in English or Hebrew.
// The point of those moments: a card must show because of what was SAID (a problem, a number, a decision, an objection), not because the line is shaped
// like a question. Whatever replaces the word lists is judged by them.
// This file is test data tooling, not a detector: it must never be imported by the engine. The patterns below are the only word patterns in qa/.
// A Hebrew or English interrogative anywhere in the line, a sentence that starts with an auxiliary verb (inverted question), and the polite forms that
// ask a question without a question word ("tell me", "I wonder", "אשמח לדעת").
const EN_WORD = /\b(what|whats|who|whom|whose|when|where|why|which|how|wonder|whether|any idea)\b/i;
const EN_INVERTED = /(^|[.!;:]\s+)(do|does|did|is|are|was|were|can|could|will|would|should|shall|may|might|have|has|am|isn't|aren't|don't|doesn't)\b/i;
const EN_POLITE = /\b(tell me|let me know|i'd like to know|i would like to know|curious)\b/i;
// Hebrew: an interrogative as a whole token, with the optional glued prefixes ו (and) and ש (that).
const HE_WORD = /(^|[\s,.;:"'()-])[וש]?(מה|מי|מתי|איפה|איך|למה|מדוע|כמה|איזה|איזו|אילו|האם|לאן|מאיפה|מניין)(?=$|[\s,.;:"'()?-])/;
const HE_POLITE = /(אשמח לדעת|רוצה לדעת|תגיד לי|תגידי לי|תגידו לי|מעניין|סקרן|סקרנית)/;

/** Empty when the text is a plain statement; otherwise the reasons it is not. */
export function questionShape(text: string): string[] {
  const out: string[] = [];
  if (/\?/.test(text)) out.push("has a question mark");
  if (EN_WORD.test(text)) out.push(`English question word "${EN_WORD.exec(text)![0]}"`);
  if (EN_INVERTED.test(text)) out.push("sentence starts with an auxiliary verb");
  if (EN_POLITE.test(text)) out.push("polite question form");
  const he = HE_WORD.exec(text);
  if (he) out.push(`Hebrew question word "${he[2]}"`);
  if (HE_POLITE.test(text)) out.push("Hebrew polite question form");
  return out;
}

/** Problems of every moment tagged noq in a meeting: the line and the line before it must be plain statements. */
export function noqProblems(g: { id: string; lines: { id: string; text: string }[]; moments: { id: string; afterLine: string; tags?: string[] }[] }): string[] {
  const out: string[] = [];
  for (const m of g.moments) {
    if (!m.tags?.includes("noq")) continue;
    const i = g.lines.findIndex((l) => l.id === m.afterLine);
    for (const k of [i, i - 1]) {
      if (k < 0) continue;
      for (const r of questionShape(g.lines[k].text))
        out.push(`${g.id} ${m.id}: line ${g.lines[k].id} (${k === i ? "the moment line" : "the line before"}): ${r}`);
    }
  }
  return out;
}
