// Openers that continue the last question ("and what did you do?", "ומה עשית"). Moved here unchanged from engine/ingest.ts so the engine core holds no word list.
// Used for the interview follow-up glue: "Tell me about a time X failed." + "What did you do?" a moment later, same voice, is ONE question. No new words.
const EN = /^(and\b|so\b|what did\b|how did\b|why\??$|what was\b|what happened\b|what was the (result|outcome))/i;
const HE = /^(ו?מה עשית|ו?איך פתרת|ולמה|ומה|ואיך|ומה היה)/;

/** Does this short line open as a continuation of the previous question? `lang` limits the check to one language; without it both are tried. */
export function isFollowUp(text: string, lang?: "he" | "en"): boolean {
  const t = String(text ?? "").trim();
  return (lang !== "he" && EN.test(t)) || (lang !== "en" && HE.test(t));
}
