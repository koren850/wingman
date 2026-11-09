// Over-promise check on the user's own lines. Language neutral: it looks at digits, currency signs and the word right after a number (a time unit,
// a count word), never at a list of words. A number the user says is compared with the numbers in the briefing notes and the call memory.
// It reports a mismatch only when it can pair the two: the same unit AND (a currency sign or %, or a shared content word). With nothing to
// compare against (no briefing, no memory) it reports nothing. Pure: no clock, no state, no globals.

/** One number in a text with the unit that goes with it. `unit` is "" when there is none; a currency sign or % is kept as it is; a word is cut to 3 letters. */
export type Quantity = { value: number; unit: string; money: boolean; raw: string; words: string[] };
/** A number from the notes or the memory, with where it came from (shown on the card). */
export type RefQuantity = Quantity & { source: string };
export type Mismatch = { said: Quantity; ref: RefQuantity };

const NUM = /(?:(\p{Sc})\s?)?(\d{1,3}(?:[,.]\d{3})+|\d+(?:[.,]\d+)?)\s?(%|\p{Sc}|\p{L}+)?/gu;
const WORD = /\p{L}{4,}/gu;
const HEB_PREFIX = /^[בכלמהו]{1,2}(?=\p{L}{3,})/u;

function toNumber(s: string): number {
  // "1,200" and "1.200" are thousands; "2.5" and "2,5" are decimals.
  if (/^\d{1,3}([,.]\d{3})+$/.test(s)) return Number(s.replace(/[,.]/g, ""));
  return Number(s.replace(",", "."));
}
const unitStem = (w: string): string => {
  const x = w.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(HEB_PREFIX, "");
  return Array.from(x).slice(0, 3).join("");
};
const contentWords = (text: string): string[] => {
  const out = new Set<string>();
  for (const m of text.matchAll(WORD)) out.add(unitStem(m[0]));
  return [...out];
};

// Money written as a word or an abbreviation counts as the same currency as its sign ("4000 שקל", 5000 ש״ח, "200 dollars"), so a figure said in words meets a figure
// in the notes written with a sign. A short unit table, not a language model: anything else keeps its own unit.
const CURRENCY_WORDS: [RegExp, string][] = [
  [/ש["'״׳]?ח(?!\p{L})|שקל(?:ים)?(?!\p{L})|\b(?:nis|ils|shekels?)\b/giu, "₪"],
  [/דולר(?:ים)?(?!\p{L})|\bdollars?\b|\busd\b/giu, "$"],
  [/אירו(?!\p{L})|יורו(?!\p{L})|\beuros?\b/giu, "€"],
];
const withSigns = (s: string): string =>
  CURRENCY_WORDS.reduce((t, [re, sign]) => t.replace(new RegExp(`(\\d)\\s?(?:${re.source})`, re.flags), `$1 ${sign}`), s);

/** Every number in `text` with its unit and the content words of its sentence (a number inside a longer word, like a version tag, is skipped). */
export function quantities(text: string): Quantity[] {
  const out: Quantity[] = [];
  for (const sentence of withSigns(String(text ?? "")).split(/(?<=[.!?؟])\s+|\n+/)) {
    const words = contentWords(sentence.replace(NUM, " "));
    for (const m of sentence.matchAll(NUM)) {
      const value = toNumber(m[2]);
      if (!Number.isFinite(value)) continue;
      const before = sentence[(m.index ?? 0) - 1];
      if (before && /\p{L}/u.test(before) && !m[1]) continue; // "v2", "mp3": part of a word
      const sign = m[1] || (m[3] && /^(%|\p{Sc})$/u.test(m[3]) ? m[3] : "");
      const word = !sign && m[3] ? unitStem(m[3]) : "";
      out.push({ value, unit: sign || word, money: !!sign && sign !== "%", raw: m[0].trim(), words });
    }
  }
  return out;
}

const eq = (a: number, b: number) => Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/** Two figures this far apart (more than this factor) are not one figure said wrong: a price per month and a budget, a rate and a total. A slip of one zero (10x) still counts. */
export const MAX_SLIP_FACTOR = 12;
const comparable = (a: number, b: number) => {
  const hi = Math.max(Math.abs(a), Math.abs(b)),
    lo = Math.min(Math.abs(a), Math.abs(b));
  return lo > 0 && hi / lo <= MAX_SLIP_FACTOR;
};

/** Numbers the user said that do not fit any paired number in `refs`. A number with no pair is never a mismatch. */
export function mismatches(said: Quantity[], refs: RefQuantity[]): Mismatch[] {
  const out: Mismatch[] = [];
  for (const q of said) {
    if (!q.unit || q.value === 0) continue;
    // A pair needs the same unit and a figure of about the same size. Round 14: "$1,200" was held against "budget: $85,000" and "8,000 shekels" against "250 shekels a month".
    const paired = refs.filter(
      (r) => r.unit === q.unit && comparable(r.value, q.value) && (q.money || q.unit === "%" || r.words.some((w) => q.words.includes(w))),
    );
    if (!paired.length || paired.some((r) => eq(r.value, q.value))) continue;
    out.push({ said: q, ref: paired[0] });
  }
  return out;
}

/** The numbers of the notes and of the memory as reference quantities. `numbers` are memory items: `what` is the label, `value` the figure ("5000 ₪", "3 weeks"). */
export function refQuantities(o: {
  notes?: readonly string[];
  numbers?: readonly { what: string; value: string }[];
  facts?: readonly string[];
}): RefQuantity[] {
  const out: RefQuantity[] = [];
  for (const n of o.numbers ?? []) for (const q of quantities(`${n.what}: ${n.value}`)) out.push({ ...q, source: `${n.what}: ${n.value}`.slice(0, 80) });
  for (const t of [...(o.notes ?? []), ...(o.facts ?? [])]) for (const q of quantities(t)) out.push({ ...q, source: t.slice(0, 80) });
  return out;
}
