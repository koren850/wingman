// A language pack: everything the question detector and the guards need to know about one spoken language.
// Adding a language = one file here that satisfies this type, plus one line in lang/index.ts. The type has no optional
// fields, so a language cannot compile without its guard patterns (price, date, promise, salary). lang.test.ts also
// checks that the guard families are not empty.

export type GuardPatterns = {
  /** Any money figure or price statement. A hit blocks the AI text. */
  price: RegExp[];
  /** Any date, deadline or clock time. */
  date: RegExp[];
  /** First-person promises and unhedged certainty. */
  promise: RegExp[];
  /** Practice mode: a word that marks a salary talk (a figure next to it is blocked). */
  salaryWords: RegExp;
  /** Practice mode: salary figures that need no salary word ("25k", "thirty thousand"). */
  salaryFigure: RegExp[];
};

export type Language = {
  id: "he" | "en";
  /** Number words as a regex alternation ("one|two|..."), used inside the language's own patterns. */
  numberWords: string;

  // ---- question detector ----
  /** Question openers (Hebrew: "מה", "איך"; English: wh-words). */
  questionHeads: readonly string[];
  /** Multi-word cues that make an utterance a question. */
  questionPhrases: readonly string[];
  /** Requests that are questions in practice ("תסביר", "send me", "explain"). */
  requestCues: readonly string[];
  /** Greetings and statements that look like questions ("מה נשמע"). */
  notQuestionOpeners: readonly string[];
  /** Acknowledgements and hesitations, never answered. */
  fillers: readonly string[];
  fillerPatterns: readonly RegExp[];
  /** "Give me a second": asking for time, removed before the filler check (global regexes). */
  timeAskPatterns: readonly RegExp[];
  /** "Send me ..." phrases and the message-like things that turn them into a task, not a question. */
  sendPhrases: readonly string[];
  sendThings: readonly string[];
  sendStopWords: readonly string[];
  /** "We want / we are considering": a statement of need. */
  intentWords: readonly string[];
  intentPatterns: readonly RegExp[];
  interjections: readonly string[];
  /** "Right?" / "sure?" words that make a question only at the edges. */
  confirmWords: readonly string[];

  // ---- guards ----
  guards: GuardPatterns;
};
