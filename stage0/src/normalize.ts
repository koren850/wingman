// Shared Hebrew/English normalization for matching (bank triggers, detector, gate).
const NIQQUD = /[֑-ׇ]/g;
const FINALS: Record<string, string> = { "ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ" };
// Hebrew prefixes that glue onto words: one letter (ה ו ב ל מ ש כ) or a valid pair. Pairs like "לה", "בה"
// are NOT stripped ("להעלות" is a verb, not ל+ה+עלות). The remainder must be 3+ Hebrew letters or a Latin/digit token.
const PREFIX_1 = new Set([..."והבלמשכ"]);
const PREFIX_2 = new Set(["וה", "וב", "ול", "ומ", "וכ", "וש", "שה", "שב", "של", "שמ", "שכ", "כש", "מש"]);
const REMAINDER_OK = /^(?:[א-ת]{3,}|[a-z0-9]{2,}$)/;
// Dropped from both sides when matching a phrase ("האתר שלי נפל" matches "האתר נפל").
const STOP = new Set(["שלי", "שלנו", "שלך", "כבר", "ממש"].map((w) => w.replace(/[ךםןףץ]/g, (c) => FINALS[c])));

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

export function tokens(s: string): string[] {
  return normalize(s).split(" ").filter(Boolean);
}

/** Token plus every valid prefix-stripped form, so "בדומיין" also matches "דומיין" and "מוויקס" matches "וויקס". */
// Words where the leading letter belongs to the word: "לעלות" (to go up / go live) must not match the price word "עלות".
const NO_STRIP = new Set(["לעלות"]);

export function tokenVariants(t: string): string[] {
  const v = [t];
  if (NO_STRIP.has(t)) return v;
  if (PREFIX_1.has(t[0]) && REMAINDER_OK.test(t.slice(1))) v.push(t.slice(1));
  if (t.length > 2 && PREFIX_2.has(t.slice(0, 2)) && REMAINDER_OK.test(t.slice(2))) v.push(t.slice(2));
  return v;
}

export function tokenSet(s: string): Set<string> {
  const set = new Set<string>();
  for (const t of tokens(s)) for (const v of tokenVariants(t)) set.add(v);
  return set;
}

/** True if every token of `phrase` appears (prefix-aware) in `text`, in order. Possessive/filler words are ignored. */
export function containsPhrase(text: string, phrase: string): boolean {
  const tt = tokens(text).filter((w) => !STOP.has(w)).map(tokenVariants);
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
