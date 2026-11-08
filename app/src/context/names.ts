// Names heard by the speech-to-text are often a little wrong ("Denna" for "Dana", "דנה" for "דינה"). This maps a heard word to a name that is
// already on the roster by edit distance. There is no word list: the Hebrew fold is a table of letters, and every other script is only lower-cased
// and stripped of accents. Pure.

/** Final letter forms and look-alike sounds that STT mixes up, folded to one letter. Letters only, no words. */
const HEB_FOLD: Record<string, string> = {
  ם: "מ",
  ן: "נ",
  ץ: "צ",
  ף: "פ",
  ך: "כ",
  ט: "ת",
  ק: "כ",
  ע: "א",
  ש: "ס",
  "׳": "",
  "'": "",
};
const HEB_VOWEL_LETTERS = new Set(["ו", "י"]);

/** Comparison form of a name: lower case, no accents or niqqud, Hebrew letters folded, and inside a Hebrew word the vowel letters (vav, yod) dropped. */
export function foldName(s: string): string {
  const base = String(s)
    .normalize("NFKD")
    .replace(/[̀-֑ͯ-ׇ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
  const letters = Array.from(base).map((c) => HEB_FOLD[c] ?? c);
  const hebrew = letters.some((c) => c >= "א" && c <= "ת");
  return letters.filter((c, i) => !(hebrew && i > 0 && HEB_VOWEL_LETTERS.has(c))).join("");
}

/** Damerau-Levenshtein distance (adjacent swaps count 1). Strings are compared by code point. */
export function editDistance(a: string, b: string): number {
  const x = Array.from(a),
    y = Array.from(b);
  if (!x.length) return y.length;
  if (!y.length) return x.length;
  const d: number[][] = Array.from({ length: x.length + 1 }, (_, i) => [i, ...new Array<number>(y.length).fill(0)]);
  for (let j = 0; j <= y.length; j++) d[0][j] = j;
  for (let i = 1; i <= x.length; i++)
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[x.length][y.length];
}

/** Largest distance that still counts as the same name: 1 for short names, 2 for longer ones. */
export const maxNameDistance = (len: number): number => (len < 4 ? 0 : len < 7 ? 1 : 2);

/**
 * The roster name (one word of it) that `heard` is most likely a garbled form of, or undefined. A match needs the same first letter after folding,
 * so "data" does not turn into "Dana" by luck of one letter... except when the first letters agree and the distance is within the limit.
 * Ties go to the smaller distance, then to the first on the roster. An exact folded match counts as distance 0.
 */
export function matchRoster(heard: string, roster: readonly string[]): { name: string; dist: number } | undefined {
  const letters = (x: string) => Array.from(String(x).replace(/[^\p{L}\p{N}]/gu, "")).length;
  if (letters(heard) < 3) return undefined; // two letters say nothing
  const h = foldName(heard);
  let best: { name: string; dist: number } | undefined;
  for (const full of roster) {
    for (const part of String(full).split(/\s+/)) {
      const r = foldName(part);
      if (letters(part) < 3 || Array.from(r)[0] !== Array.from(h)[0]) continue;
      const dist = editDistance(h, r);
      if (dist > maxNameDistance(Math.min(Array.from(h).length, Array.from(r).length))) continue;
      if (!best || dist < best.dist) best = { name: part, dist };
    }
  }
  return best;
}
