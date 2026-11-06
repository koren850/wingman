// Shared Hebrew/English normalization for matching (bank triggers, detector, gate, entities, calc helpers).
// Everything compares text AFTER normalize(): no niqqud, no bidi/zero-width marks, no punctuation, final letters folded
// (ך->כ ...), lower case. Phrases are matched token by token, tolerating one glued Hebrew prefix (ב ל ה ו מ ש כ).
const NIQQUD = /[֑-ׇ]/g;
const FINALS: Record<string, string> = { ך: "כ", ם: "מ", ן: "נ", ף: "פ", ץ: "צ" };
// Hebrew prefixes that glue onto words: one letter (ה ו ב ל מ ש כ) or a valid pair. Pairs like "לה", "בה"
// are NOT stripped ("להעלות" is a verb, not ל+ה+עלות). The remainder must be 3+ Hebrew letters or a Latin/digit token.
const PREFIX_1 = new Set([..."והבלמשכ"]);
const PREFIX_2 = new Set(["וה", "וב", "ול", "ומ", "וכ", "וש", "שה", "שב", "של", "שמ", "שכ", "כש", "מש"]);
const REMAINDER_OK = /^(?:[א-ת]{3,}|[a-z0-9]{2,}$)/;
// Dropped from both sides when matching a phrase ("האתר שלי נפל" matches "האתר נפל"). Folded the same way as normalize(),
// because tokens are compared after final-letter folding.
const STOP = new Set(["שלי", "שלנו", "שלך", "כבר", "ממש"].map((w) => w.replace(/[ךםןףץ]/g, (c) => FINALS[c])));

/**
 * Canonical form for matching. Strips niqqud, bidi marks and zero-width characters (speech-to-text and pasted text carry them
 * invisibly), drops quotes/geresh, turns separators into spaces, folds final letters (ם->מ: matching is by base letter),
 * lower-cases and collapses spaces. Both sides of any comparison must go through this.
 */
export function normalize(s: string): string {
  return s
    .normalize("NFKC")
    .replace(NIQQUD, "")
    .replace(/[‎‏‪-‮⁦-⁩]/g, "") // bidi marks
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, "") // zero-width space/joiners, word joiner, BOM, soft hyphen
    .replace(/[״"׳'`]/g, "")
    .replace(/[-–—_/\\.,!?;:()[\]{}<>]/g, " ")
    .replace(/[ךםןףץ]/g, (c) => FINALS[c])
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** normalize() split into words. */
export function tokens(s: string): string[] {
  return normalize(s).split(" ").filter(Boolean);
}

// Words where the leading letter belongs to the word: "לעלות" (to go up / go live) must not match the price word "עלות".
const NO_STRIP = new Set(["לעלות"]);

/** Token plus every valid prefix-stripped form, so "בדומיין" also matches "דומיין" and "מוויקס" matches "וויקס". */
export function tokenVariants(t: string): string[] {
  const v = [t];
  if (NO_STRIP.has(t)) return v;
  if (PREFIX_1.has(t[0]) && REMAINDER_OK.test(t.slice(1))) v.push(t.slice(1));
  if (t.length > 2 && PREFIX_2.has(t.slice(0, 2)) && REMAINDER_OK.test(t.slice(2))) v.push(t.slice(2));
  return v;
}

/** True if every token of `phrase` appears (prefix-aware) in `text`, in order. Possessive/filler words are ignored. */
export function containsPhrase(text: string, phrase: string): boolean {
  const tt = tokens(text)
    .filter((w) => !STOP.has(w))
    .map(tokenVariants);
  const pt = tokens(phrase).filter((w) => !STOP.has(w));
  if (!pt.length) return false;
  outer: for (let i = 0; i <= tt.length - pt.length; i++) {
    for (let j = 0; j < pt.length; j++) {
      const pv = tokenVariants(pt[j]);
      if (!tt[i + j].some((v) => pv.includes(v))) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Index of the whitespace-separated raw word where `phrase` starts in `text` (same matching as containsPhrase), or -1.
 * Each raw word is tokenized on its own so the index points at the original word even when normalize() splits it
 * ("a-b" becomes two tokens) or drops it (filler words are skipped, like in containsPhrase).
 */
export function phraseWordIndex(text: string, phrase: string): number {
  const tt: { v: string[]; raw: number }[] = [];
  text
    .trim()
    .split(/\s+/)
    .forEach((w, raw) => {
      for (const t of tokens(w)) if (!STOP.has(t)) tt.push({ v: tokenVariants(t), raw });
    });
  const pt = tokens(phrase).filter((w) => !STOP.has(w));
  if (!pt.length) return -1;
  outer: for (let i = 0; i <= tt.length - pt.length; i++) {
    for (let j = 0; j < pt.length; j++) if (!tt[i + j].v.some((v) => tokenVariants(pt[j]).includes(v))) continue outer;
    return tt[i].raw;
  }
  return -1;
}
