// Number check: the user's own numbers (profile.yaml `claims`, for example "4+ years", "30+ client sites") against what the user just said.
// In an interview a number that grows under pressure ("almost 5 years", "70-80 customers", "over 100 sites") is checked later against
// the CV. This is local (no AI): find "<number> <unit>" in the user's line, compare with the claim for the same unit, and return a
// quiet correction when the spoken number is clearly bigger (or, for an exact claim, different).
export type Claim = { text: string; value: number; plus: boolean; unit: string };
export type ClaimMiss = { unit: string; said: number; claim: Claim };

/** Units both languages use. Each group is one meaning; the key is what the card names. */
const UNITS: [string, RegExp][] = [
  ["years", /^(שנים|שנה|שנות|שנתיים|years?|yrs?)$/i],
  ["sites", /^(אתרים|אתרי|אתר|sites?|websites?)$/i],
  ["customers", /^(לקוחות|לקוח|customers?|clients?)$/i],
  ["juniors", /^(ג'וניורים|ג׳וניורים|גוניורים|ג'וניור|juniors?)$/i],
  ["tools", /^(כלים|tools?)$/i],
  ["tasks", /^(משימות|tasks?)$/i],
  ["people", /^(אנשים|עובדים|people|employees)$/i],
];
const HEB_NUM: Record<string, number> = { שתיים: 2, שניים: 2, שלוש: 3, שלושה: 3, ארבע: 4, ארבעה: 4, חמש: 5, חמישה: 5, שש: 6, שישה: 6, שבע: 7, שבעה: 7, שמונה: 8, תשע: 9, תשעה: 9, עשר: 10, עשרה: 10, עשרים: 20, שלושים: 30, ארבעים: 40, חמישים: 50, מאה: 100 };

const strip = (w: string) => w.replace(/^[והבלשכמ]{1,2}(?=[א-ת]{2})/, "").replace(/[.,?!:;"()]/g, "");
function unitOf(word: string): string | undefined {
  const w = word.replace(/[.,?!:;"()]/g, "");
  for (const [u, re] of UNITS) if (re.test(w) || re.test(strip(w))) return u;
  return undefined;
}
function numOf(word: string): number | undefined {
  const w = word.replace(/[,+]/g, "").replace(/[.?!:;"()]$/g, "");
  if (/^\d{1,5}$/.test(w)) return Number(w);
  const h = HEB_NUM[strip(w)] ?? HEB_NUM[w];
  return h;
}

/** Parses one claim line: "4+ years", "30+ client sites", "60+ MCP tools", "3+ juniors mentored". Undefined when there is no number + unit. */
export function parseClaim(text: string): Claim | undefined {
  const words = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const m = /^(\d{1,5})(\+?)$/.exec(words[i].replace(/,/g, ""));
    if (!m) continue;
    // The noun is the last unit word right after the number ("30+ client sites" is sites, not clients).
    let unit: string | undefined;
    for (let j = i + 1; j < Math.min(words.length, i + 4); j++) { const u = unitOf(words[j]); if (u) unit = u; else if (unit) break; }
    if (unit) return { text: text.trim(), value: Number(m[1]), plus: m[2] === "+", unit };
  }
  return undefined;
}

/** Numbers the user said, each with the unit that follows within 3 words ("70 80 לקוחות" gives 70 and 80 for customers). */
export function spokenNumbers(line: string): { unit: string; n: number }[] {
  const words = line.split(/\s+/).filter(Boolean), out: { unit: string; n: number }[] = [];
  for (let i = 0; i < words.length; i++) {
    const u = unitOf(words[i]);
    if (!u) continue;
    for (let j = Math.max(0, i - 4); j < i; j++) { const n = numOf(words[j]); if (n !== undefined && n > 0) out.push({ unit: u, n }); }
  }
  return out;
}

/** Is `said` clearly more than the claim? "N+" allows a little more (small numbers: +1; bigger ones: up to 1.5x); an exact N allows nothing else. */
export function tooBig(said: number, c: Claim): boolean {
  if (!c.plus) return said !== c.value;
  return c.value < 10 ? said >= c.value + 2 : said > c.value * 1.5;
}

/** The first number in `line` that does not fit the user's claims, or undefined. */
export function checkClaims(line: string, claims: Claim[]): ClaimMiss | undefined {
  if (!claims.length) return undefined;
  for (const s of spokenNumbers(line)) {
    const c = claims.find((x) => x.unit === s.unit);
    if (c && tooBig(s.n, c)) return { unit: s.unit, said: s.n, claim: c };
  }
  return undefined;
}

/** Card text for a miss: what the CV says, in the line's language. */
export function claimSay(miss: ClaimMiss, lang: "he" | "en"): string {
  return lang === "en" ? `Your CV says: ${miss.claim.text}. Keep to that number.` : `בקורות החיים: ${miss.claim.text}. תישאר עם המספר הזה.`;
}
