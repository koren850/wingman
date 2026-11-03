// Local, no-AI arithmetic for spoken questions: "כמה זה 36 ועוד 42?", "what's 15% of 200", "שלוש מאות חלקי שלוש".
// Understands digits and Hebrew / English number words (to millions), + - × ÷, percent-of, and normal precedence.
// Strict on purpose, because a wrong number on screen is worse than no card. The expression must END the clause (an unknown
// word after it rejects the text) and either follow a question cue ("?", כמה, what is...) or be a bare unambiguous expression
// ("3 כפול 450"). So "יש לי 3 ועוד 2 אנשים" and any text with a money word or price verb ("כמה זה 100 שקל ועוד 50") are never computed here.
// Used by detect() (math = a question), run.ts (calc cards, no AI call), assist.ts (math = for the assistant) and bank.ts (not a price).

const HEB_UNITS: Record<string, number> = {
  אפס: 0, אחד: 1, אחת: 1, שניים: 2, שנים: 2, שתיים: 2, שתים: 2, שני: 2, שתי: 2, שלוש: 3, שלושה: 3, ארבע: 4, ארבעה: 4, חמש: 5, חמישה: 5,
  שש: 6, שישה: 6, שבע: 7, שבעה: 7, שמונה: 8, תשע: 9, תשעה: 9, עשר: 10, עשרה: 10,
  שלושת: 3, ארבעת: 4, חמשת: 5, ששת: 6, שבעת: 7, שמונת: 8, תשעת: 9, עשרת: 10,
};
const HEB_TENS: Record<string, number> = { עשרים: 20, שלושים: 30, ארבעים: 40, חמישים: 50, שישים: 60, שבעים: 70, שמונים: 80, תשעים: 90 };
const EN_UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const EN_TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** One parsed word: a number (with flags for fractions/percent), an operator, or a marker word (%, "of", squared, discount, "on"). `null` elsewhere = an unknown word. */
type Tok =
  | { t: "num"; v: number; frac?: boolean; pct?: boolean; lbl?: string }
  | { t: "op"; v: "+" | "-" | "*" | "/"; sym?: boolean; weak?: boolean }
  | { t: "pct" } | { t: "of" } | { t: "sq" } | { t: "disc" } | { t: "on" };
type Num = Extract<Tok, { t: "num" }>;

// Words that mean an operator. Final-letter forms are not folded here: tokens are matched raw (after stripping a leading ו).
const OPS: Record<string, "+" | "-" | "*" | "/"> = {
  "+": "+", plus: "+", ועוד: "+", פלוס: "+", עוד: "+", added: "+",
  "-": "-", "−": "-", minus: "-", פחות: "-", מינוס: "-",
  "*": "*", "×": "*", x: "*", times: "*", כפול: "*", multiplied: "*", פי: "*",
  "/": "/", "÷": "/", over: "/", חלקי: "/", divided: "/",
};
const FILLER = new Set(["by", "to", "בבקשה", "please", "שווה", "equals", "equal", "is", "the", "של", "את", "לי", "יהיה", "יוצא", "יוצאת", "זה", "זו", "שזה", "בעצם", "בסך", "הכל", "what", "whats", "what's", "how", "much", "many", "calculate", "compute", "תחשב", "תחשבי", "חשב", "חשבי", "חשבו", "and", "ו"]);
const FRACS: Record<string, number> = { חצי: 0.5, רבע: 0.25, שליש: 1 / 3, half: 0.5, quarter: 0.25, third: 1 / 3 };
const FRAC_LBL: Record<string, string> = { חצי: "½", רבע: "¼", שליש: "⅓", half: "½", quarter: "¼", third: "⅓" };
const FRAC_VAV = /^ו(חצי|רבע|שליש)$/;

/** Question-style openers. Unused: intent is decided by INTENT/SOFT below (kept only as a reference list; `void` silences the unused warning). */
const LEADS = [
  "כמה זה יוצא", "כמה יוצא", "כמה זה יהיה", "כמה יהיה", "כמה זה שווה", "כמה שווה", "כמה זה", "כמה הוא", "כמה", "מה זה", "מה התוצאה של", "מה התוצאה", "מה הסכום של", "מה הסכום",
  "תחשב לי", "תחשבי לי", "תחשב", "תחשבי", "חשב לי", "חשב", "אפשר לחשב", "תגיד לי כמה זה", "תגיד לי כמה",
  "what is", "what's", "whats", "how much is", "how much are", "how much", "calculate", "compute", "what does", "what do",
];
void LEADS;

/**
 * A price verb or noun: the question is about what something costs, so a digit with "ועוד / כפול / פלוס" is part of the
 * service ("כמה עולה אתר ועוד אחסון ל-3 שנים", "כמה עולה 3 כפול 500"), never a sum to compute. run.ts uses this to skip calc cards.
 */
const PRICE_VERB = /(?<![א-ת])[והבכלמש]{0,2}(עולה|עולים|יעלה|יעלו|עלות|עלותו|מחיר|מחירו|מחירים|לשלם|אשלם|נשלם|תשלם|תעריף|תעריפים|תמחור|תמחר|שולם)(?![א-ת])|\b(cost|costs|price|prices|pricing|charge|charges|quote|fee|fees)\b/i;
/** True if the text is about what something costs. evalMath refuses these so a price question never gets a computed sum. */
export function hasPriceVerb(text: string): boolean { return PRICE_VERB.test(String(text ?? "")); }

/** Pre-tokenize cleanup: strips niqqud/bidi/zero-width marks and quotes, keeps "1,200" as one number, spaces out operators and %, and keeps "3/4" as one fraction token. */
const clean = (s: string) => s.toLowerCase()
  .replace(/[֑-ׇ​-‏‪-‮⁦-⁩]/g, "")      // niqqud, zero-width, bidi marks
  .replace(/[״"׳'`’]/g, "")
  .replace(/(\d),(?=\d{3}(?!\d))/g, "$1")                // 1,200 -> 1200 ; 1,200,000 -> 1200000
  .replace(/(?<![\d/.])(\d+)\/(\d+)(?![\d/])/g, "$1_$2")  // 3/4 stays one token (a fraction)
  .replace(/(\d)\s*%/g, "$1 % ")
  .replace(/%/g, " % ")
  .replace(/([×÷*\/+])/g, " $1 ")
  .replace(/(\d)\s*x\s*(\d)/g, "$1 x $2")
  .replace(/(?<=\d)-(?=\d)/g, " - ")                     // 5-3
  .replace(/(?<![\dא-ת])-(?=\s)/g, " - ")
  .replace(/(?<=[a-z])-(?=[a-z])/g, " ")                 // twenty-five
  .replace(/[?!.,;:]+(?=\s|$)/g, " ")
  .replace(/(?<![א-ת])ממ-?(?=\s?\d)/g, "מ ")                     // "ממ 2400": speech-to-text for "מ-2400"
  .replace(/(?<![א-ת])מ-?(?=\d)/g, "מ ")                         // מ-200 / מ200
  .replace(/\s+/g, " ").trim();

const MULT_WORDS: Record<string, number> = { מאה: 100, מאתיים: 200, מאות: 100, hundred: 100, אלף: 1000, thousand: 1000, אלפיים: 2000, אלפים: 1000, אלפי: 1000, מיליון: 1e6, מליון: 1e6, million: 1e6 };
/** Classify a spoken number word: a unit (1-19), tens (20-90) or a multiplier (100, 1000, 1e6). */
function numberWord(w: string): { kind: "unit" | "tens" | "mult"; v: number } | undefined {
  if (w in HEB_UNITS) return { kind: "unit", v: HEB_UNITS[w] };
  if (w in EN_UNITS) return { kind: "unit", v: EN_UNITS[w] };
  if (w in HEB_TENS) return { kind: "tens", v: HEB_TENS[w] };
  if (w in EN_TENS) return { kind: "tens", v: EN_TENS[w] };
  if (w in MULT_WORDS) return { kind: "mult", v: MULT_WORDS[w] };
  return undefined;
}
/** A leading vav ("ושלוש", "ועשרים") is "and": strip it when what remains is a number word. */
const stripVav = (w: string) => (w.length > 2 && w[0] === "ו" && !(w in OPS) && numberWord(w.slice(1)) ? w.slice(1) : w);
/** "ממאתיים", "משלושים", "מחצי": a fused מ- ("of / from") before a number word; split it. */
const splitFused = (w: string): string[] => (w.length > 2 && w[0] === "מ" && !numberWord(w) && !(w in OPS) && !(w in FRACS) && (numberWord(w.slice(1)) || w.slice(1) in FRACS) ? ["מ", w.slice(1)] : [w]);

/** Words that carry no arithmetic: question openers, hedges and fillers ("וכמה איזה", "נגיד", "תגיד לי", "רגע"). A leading ו is stripped first. */
const SOFT = new Set(["כמה", "מה", "איזה", "איזו", "בערך", "נגיד", "רגע", "אז", "טוב", "אוקיי", "אוקי", "אממ", "אהה", "תגיד", "תגידי", "לי", "נו", "סתם", "אמממ", "יאללה", "הנה", "ככה", "רק", "אפשר", "לחשב", "ל", "ב", "לדעת"]);
const INTENT = new Set(["כמה", "נגיד", "what", "whats", "how", "calculate", "compute", "תחשב", "תחשבי", "חשב", "חשבי", "לחשב", "מה"]);
const MONEY = /(שקל|שקלים|ש ח|₪|\$|דולר|דולרים|יורו|אירו|nis|usd|eur|dollars?|euros?|shekels?|bucks)/;
const stripSoftVav = (w: string) => (w.length > 2 && w[0] === "ו" && SOFT.has(w.slice(1)) ? w.slice(1) : w);

/** Cleaned text -> words, with fused prefixes undone: leading "ו" (and), "ממאתיים" -> "מ" + "מאתיים", STT "ממ" -> "מ". */
function prep(body: string): string[] {
  const out: string[] = [];
  for (let w of clean(body).split(" ").filter(Boolean)) {
    if (w === "ממ") w = "מ";
    if (FRAC_VAV.test(w)) { out.push(w); continue; }
    out.push(...splitFused(stripSoftVav(stripVav(w))));
  }
  return out;
}
const multOf = (w: string | undefined) => { const n = w ? numberWord(w) : undefined; return n?.kind === "mult" && n.v >= 1000 ? n.v : 0; };

/** One token per word: a number (digits or number words), an operator, "%", "of", "squared"; null for any other word. Fillers are skipped. */
function tokenize(s: string): (Tok | null)[] {
  const words = prep(s);
  const out: (Tok | null)[] = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    const prev = out.at(-1);
    if (/^\d+(\.\d+)?$/.test(w)) {       // "5", "2.5", and "5 אלף" / "2.5 מיליון"
      let v = Number(w); i++;
      const m = multOf(words[i]); if (m) { v *= m; i++; }
      out.push({ t: "num", v }); continue;
    }
    const fr = /^(\d+)_(\d+)$/.exec(w);
    if (fr) { i++; if (Number(fr[2]) === 0) { out.push(null); continue; } out.push({ t: "num", v: Number(fr[1]) / Number(fr[2]), frac: true, lbl: `${fr[1]}/${fr[2]}` }); continue; }
    const fv = FRAC_VAV.exec(w);
    if (fv) {                             // "שלוש וחצי", "אחוז וחצי", "שלושה אחוז וחצי"
      const f = FRACS[fv[1]]; i++;
      if (prev?.t === "num") prev.v += f;
      else if (prev?.t === "pct") { const b = out.at(-2); if (b && b.t === "num") b.v += f; else out.splice(out.length - 1, 0, { t: "num", v: 1 + f }); }
      else out.push(null);
      continue;
    }
    if (w === "%" || w === "אחוז" || w === "percent" || w === "אחוזים") { out.push({ t: "pct" }); i++; continue; }
    // "מהם" is what speech-to-text makes of "מ-" before a number
    if (w === "of" || w === "מ" || w === "מתוך" || w === "מהם" || w === "מהן") { out.push({ t: "of" }); i++; continue; }
    if (w === "בריבוע" || w === "squared") { out.push({ t: "sq" }); i++; continue; }
    if (w === "הנחה") { out.push({ t: "disc" }); i++; continue; }
    if (w === "על") { out.push({ t: "on" }); i++; continue; }
    if (w in FRACS) {                     // חצי / רבע / שליש ("חצי מיליון" is 500,000, a plain number)
      i++; const m = multOf(words[i]);
      if (m) { out.push({ t: "num", v: FRACS[w] * m }); i++; } else out.push({ t: "num", v: FRACS[w], frac: true, lbl: FRAC_LBL[w] });
      continue;
    }
    if (numberWord(w)) {
      // greedy run of number words ("שלוש מאות ארבעים ושתיים", "twenty five", "two thousand")
      let total = 0, cur = 0, n = 0;
      while (i < words.length) {
        const nw = numberWord(words[i]) ?? (words[i] === "and" && n && numberWord(words[i + 1] ?? "") ? { kind: "and" as const, v: 0 } : undefined);
        if (!nw) break;
        if (nw.kind === "and") { i++; continue; }
        if (nw.kind === "mult") {
          if (nw.v >= 1000) { total += (cur || 1) * nw.v; cur = 0; }
          else if (words[i] === "מאתיים") cur += 200;
          else cur = (cur || 1) * nw.v;
        } else cur += nw.v;      // units, teens ("אחד עשר" = 1 + 10) and tens add up
        n++; i++;
      }
      out.push({ t: "num", v: total + cur }); continue;
    }
    if (w === "לחלק") { out.push({ t: "op", v: "/" }); i++; if (words[i] === "ל") i++; continue; }   // "לחלק ל-5"
    if (w in OPS) { out.push({ t: "op", v: OPS[w], sym: w === "-" || w === "/" || w === "−" || w === "÷" ? true : undefined, weak: w === "עוד" || w === "added" ? true : undefined }); i++; continue; }
    if (FILLER.has(w) || SOFT.has(w)) { i++; continue; }
    out.push(null); i++;
  }
  return out;
}

/** Explicit shape: percent signs fold into the number, "10% הנחה על 350" becomes 350 − 10%, "חצי מ 2400" / "15% מ 2400" / "15 אחוז 2400" get an explicit ×. */
function shape(run: Tok[]): Tok[] | undefined {
  const a: Tok[] = [];
  for (let i = 0; i < run.length; i++) {
    const x = run[i];
    if (x.t === "num" && run[i + 1]?.t === "pct") { a.push({ ...x, pct: true }); i++; }
    else if (x.t === "pct") return undefined;
    else a.push(x);
  }
  const b: Tok[] = [];
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const isPct = (t?: Tok): t is Num => t?.t === "num" && !!t.pct;
    const skipOn = (j: number) => (a[j]?.t === "on" ? j + 1 : j);
    if (isPct(x) && a[i + 1]?.t === "disc") {                 // "10 אחוז הנחה על 350"
      const j = skipOn(i + 2), base = a[j];
      if (base?.t !== "num" || base.pct) return undefined;
      b.push(base, { t: "op", v: "-" }, x); i = j; continue;
    }
    if (x.t === "disc" && isPct(a[i + 1])) {                   // "הנחה של 10 אחוז על 350"
      const j = skipOn(i + 2), base = a[j];
      if (base?.t !== "num" || base.pct) return undefined;
      b.push(base, { t: "op", v: "-" }, a[i + 1] as Num); i = j; continue;
    }
    b.push(x);
  }
  const o: Tok[] = [];
  for (const x of b) {
    const last = o.at(-1);
    const lead = last?.t === "num" && (last.frac || last.pct);
    if (x.t === "of") { if (!lead) return undefined; o.push({ t: "op", v: "*" }); continue; }
    if (x.t === "num" && last?.t === "num") { if (!lead) return undefined; o.push({ t: "op", v: "*" }); }
    if (x.t === "disc" || x.t === "on" || x.t === "pct") return undefined;
    o.push(x);
  }
  return o;
}

/**
 * Evaluate alternating num/op tokens with normal precedence (* and / before + and -). "N% of M" is already a multiplication
 * by shape(). A percent after + or - is a percent OF the left side ("2400 ועוד 17 אחוז"). Returns undefined for division by
 * zero, a lone number, a malformed sequence or a non-finite result; rounds to 12 significant digits to hide float noise.
 */
function evaluate(toks: Tok[]): number | undefined {
  const t: Tok[] = [];
  let squared = false;
  for (const x of toks) {
    if (x.t === "sq") { squared = true; const l = t.at(-1); if (l?.t !== "num") return undefined; t[t.length - 1] = { t: "num", v: l.v * l.v, pct: l.pct }; continue; }
    t.push(x);
  }
  if (t.length < 1 || t.length % 2 === 0 || t.some((x, i) => (i % 2 === 0) !== (x.t === "num"))) return undefined;
  type V = { v: number; pct: boolean };
  const nums: V[] = [], ops: string[] = [];
  t.forEach((x, i) => (i % 2 === 0 ? nums.push({ v: (x as Num).v, pct: !!(x as Num).pct }) : ops.push((x as any).v)));
  if (ops.length === 0 && !squared) return undefined;                  // a lone number or lone percent is not a calculation
  const pv = (n: V) => (n.pct ? n.v / 100 : n.v);
  // × ÷ first, then + -
  for (let i = 0; i < ops.length;) {
    if (ops[i] === "*" || ops[i] === "/") {
      const d = pv(nums[i + 1]);
      if (ops[i] === "/" && d === 0) return undefined;
      nums.splice(i, 2, { v: ops[i] === "*" ? pv(nums[i]) * d : pv(nums[i]) / d, pct: false }); ops.splice(i, 1);
    } else i++;
  }
  let r = nums[0];
  for (let i = 0; i < ops.length; i++) {
    const n = nums[i + 1];
    if (r.pct) return undefined;                           // "10% + 5%" means nothing
    const add = n.pct ? r.v * (n.v / 100) : n.v;           // "2400 ועוד 17 אחוז" = 2400 + 17% of 2400
    r = { v: ops[i] === "+" ? r.v + add : r.v - add, pct: false };
  }
  return Number.isFinite(r.v) ? Number(r.v.toPrecision(12)) : undefined;
}

/** Plain machine form of a result (no separators, at most 4 decimals). */
export const fmtNum = (n: number): string => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10000) / 10000));
/** Display form: thousands separators, at most 4 decimals ("2,450", "12.5"). */
export const fmtShow = (n: number): string => {
  const r = Math.round(n * 10000) / 10000;
  return Math.abs(r) < 1e15 ? r.toLocaleString("en-US", { maximumFractionDigits: 4, useGrouping: true }).replace("-", "−") : fmtNum(r);
};

/** `expr` normalized expression ("350 × 7"), `value` number, `result` plain string, `say` the display line "expr = value" wrapped in LTR isolates. */
export type MathResult = { expr: string; value: number; result: string; say: string };

/**
 * If `text` is a spoken arithmetic question, its result; otherwise undefined.
 * Intent: a "?" or a question opener (כמה / what / calculate...), OR a bare expression that is the whole clause ("3 כפול 450", "15 אחוז מ 2400").
 * The expression may sit anywhere in the clause after fillers ("וכמה איזה 7 כפול 350?", "רגע, נגיד 12 ועוד 30"), but it must end the clause,
 * no money word may be in it, and no price verb ("כמה עולה אתר כפול 2" is a price, not a product).
 */
export function evalMath(text: string): MathResult | undefined {
  const raw = String(text ?? "").trim();
  if (!raw || raw.length > 200) return undefined;   // long text is conversation, not a sum
  const body = clean(raw);
  if (MONEY.test(body) || hasPriceVerb(body)) return undefined;
  const toks = tokenize(body);
  const intent = /\?/.test(raw) || body.split(" ").some((w) => INTENT.has(stripSoftVav(w)));
  // the expression is the last run of non-null tokens (fillers already skipped); unknown words may only come before it
  let end = toks.length; while (end > 0 && toks[end - 1] === null) end--;
  if (end < toks.length) return undefined;           // an unknown word after the expression: "3 ועוד 2 אנשים"
  let start = end; while (start > 0 && toks[start - 1] !== null) start--;
  const raws = toks.slice(start, end) as Tok[];
  if (toks.slice(0, start).length > 5) return undefined;   // too much unrelated talk before the expression: not a calculation request
  // No opener: only a bare, unambiguous expression ("3 כפול 450"). Not "5-3" (a date or phone), not "12/3", not a lone "עוד".
  if (!intent && (start !== 0 || raws.some((x) => x.t === "op" && (x.sym || x.weak)) || !raws.some((x) => x.t === "op" || x.t === "pct" || x.t === "sq" || x.t === "of"))) return undefined;
  const run = shape(raws);
  if (!run) return undefined;
  const nums = run.filter((x) => x.t === "num").length, hasOp = run.some((x) => x.t === "op" || x.t === "sq" || (x.t === "num" && x.pct));
  if (!hasOp || (nums < 2 && !run.some((x) => x.t === "sq" || (x.t === "num" && x.pct)))) return undefined;
  const value = evaluate(run);
  if (value === undefined) return undefined;
  const sym = (x: Tok) => (x.t === "num" ? (x.lbl ?? fmtShow(x.v)) + (x.pct ? "%" : "") : x.t === "op" ? ({ "+": "+", "-": "−", "*": "×", "/": "÷" } as const)[x.v] : x.t === "sq" ? "²" : "");
  const expr = run.map(sym).join(" ").replace(/ ²/g, "²");
  const result = fmtNum(value);
  // One left-to-right island (isolate marks): the overlay's bdi wrapping only covers digits, so without it a Hebrew line would show "2,450 = 350 × 7".
  return { expr, value, result, say: `⁦${expr} = ${fmtShow(value)}⁩` };
}

/** Service words: a digit near them is a quantity of a service ("אתר ועוד אחסון ל-3 שנים"), not a sum. */
const SERVICE_HINT = /(אתר|אתרים|אחסון|דומיין|וורדפרס|תחזוקה|חנות|עיצוב|פיתוח|שרת|חבילה|מייל|שנים|שנה|חודשים|חודש|wordpress|woocommerce|hosting|domain|website|\bsite\b|maintenance|package|years?|months?)/i;
/** Is this question arithmetic at all (even one we could not evaluate, e.g. "כמה זה 5 חלקי 0")? Used to keep it away from the price stall. */
export function looksArithmetic(text: string): boolean {
  const body = clean(String(text ?? ""));
  if (hasPriceVerb(body)) return false;
  if (evalMath(text)) return true;
  return /\d/.test(body) && /(^| )(ועוד|פלוס|מינוס|פחות|כפול|חלקי|plus|minus|times|divided|multiplied|[+×÷*\/])( |$)/.test(body)
    && !/(שקל|ש ח|₪|\$|דולר|יורו|nis|usd|eur)/.test(body) && !SERVICE_HINT.test(body);
}
