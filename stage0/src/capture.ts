// Capture box (PLAN #42): phone numbers, emails and domains spoken in the call, as copyable text.
// Speech-to-text may write them as digits/Latin ("054-1234567", "gmail.com") or as Hebrew words
// ("אפס חמש ארבע...", "דן שטרודל ג'ימייל נקודה קום"); both are handled.

export type Capture = { kind: "phone" | "email" | "domain"; value: string };

const DIGITS: Record<string, string> = {
  אפס: "0", אחת: "1", אחד: "1", שתיים: "2", שתים: "2", שניים: "2", שנים: "2", שלוש: "3", שלש: "3", שלושה: "3",
  ארבע: "4", ארבעה: "4", חמש: "5", חמישה: "5", שש: "6", שישה: "6", שבע: "7", שבעה: "7", שמונה: "8", תשע: "9", תשעה: "9",
};
const TLDS = "com|net|org|io|co|il|info|biz|app|dev|me|shop|store|online|site|tech|ai|uk|de|eu|us|ru|fr";

/** Hebrew spoken forms of "@", "." and common domain words -> symbols/Latin. */
export function spokenToSymbols(s: string): string {
  return s
    // English "at ... dot": only when a dot-word follows the host ("dana at gmail dot com"), so "arrive at noon" stays text
    .replace(/(^|\s)at\s+([A-Za-z0-9-]+)\s+(?:dot|\.)(?=\s|$)/gi, " \u0001 $2 dot")
    .replace(/(^|\s)(שטרודל|כרוכית)(?=\s|$)/g, " \u0001 ")      // spoken "@" (English "at" is too common to trust)
    .replace(/(^|\s)(נקודה|דוט|dot)(?=\s|$)/g, " \u0002 ")
    .replace(/(^|\s)(ג'ימייל|גימייל|ג׳ימייל)(?=\s|$)/g, " gmail ")
    .replace(/(^|\s)(הוטמייל)(?=\s|$)/g, " hotmail ")
    .replace(/(^|\s)(קום)(?=\s|$)/g, " com ")
    .replace(/(^|\s)(קו)(?=\s|$)/g, " co ")
    .replace(/(^|\s)(איל|אי אל)(?=\s|$)/g, " il ")
    .replace(/(^|\s)(נט)(?=\s|$)/g, " net ")
    .replace(/(^|\s)(אורג)(?=\s|$)/g, " org ");
}

/** Runs of Hebrew digit words (and digit groups) -> one digit string. "אפס חמש ארבע 123" -> "054123". */
export function digitWords(s: string): string {
  const words = s.split(/\s+/);
  const out: string[] = [];
  let run = "";
  const flush = () => { if (run) { out.push(run); run = ""; } };
  for (const w of words) {
    const bare = w.replace(/^ו/, "").replace(/[,.\-]$/, "");
    if (DIGITS[bare] !== undefined) run += DIGITS[bare];
    else if (/^\d[\d-]*$/.test(bare)) {
      // A token that is already a whole number (9+ digits: "0541234567", "054-1234567") stands alone, so a stray
      // "אחת" before it or a "3" after it cannot glue onto it and break the phone. Short groups still join words.
      const d = bare.replace(/-/g, "");
      if (d.length >= 9) { flush(); out.push(d); } else run += d;
    }
    else { flush(); out.push(w); }
  }
  flush();
  return out.join(" ");
}

/** Israeli phone: 05X + 7 digits, 0[2-9] + 7 digits, 07X + 7 digits, or +972 forms. */
function phones(s: string): string[] {
  const found: string[] = [];
  for (const m of s.matchAll(/(?<![\d+])(?:\+?972[\s-]?|0)(?:5\d|7\d|[2-489])[\s-]?\d{3}[\s-]?\d{4}(?!\d)/g)) {
    let d = m[0].replace(/[^\d]/g, "");
    if (d.startsWith("972")) d = "0" + d.slice(3);
    if (d.length === 10) found.push(`${d.slice(0, 3)}-${d.slice(3)}`);
    else if (d.length === 9) found.push(`${d.slice(0, 2)}-${d.slice(2)}`);
  }
  return found;
}

export function extract(text: string): Capture[] {
  const out: Capture[] = [];
  const seen = new Set<string>();
  const add = (c: Capture) => { const k = `${c.kind}:${c.value}`; if (!seen.has(k)) { seen.add(k); out.push(c); } };
  // Join spacing only around SPOKEN "@"/"." ("gmail נקודה com" -> "gmail.com"); a written full stop before an
  // English word ("ChatGPT. AI") is a sentence end, not a domain.
  text = text.replace(/[\u200B-\u200F\u2060\uFEFF\u00AD\u202A-\u202E\u2066-\u2069]/g, "");   // zero-width and bidi marks inside numbers
  const sym = digitWords(spokenToSymbols(text)).replace(/\s*\u0001\s*/g, "@").replace(/\s*\u0002\s*/g, ".");
  for (const p of phones(sym)) add({ kind: "phone", value: p });
  const emailRe = new RegExp(`[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.(?:${TLDS})\\b`, "gi");
  const emails = [...sym.matchAll(emailRe)].map((m) => m[0].toLowerCase());
  for (const e of emails) add({ kind: "email", value: e });
  const domRe = new RegExp(`(?<![@A-Za-z0-9.-])(?:[A-Za-z0-9-]+\\.)+(?:${TLDS})(?![A-Za-z0-9])`, "gi");
  for (const m of sym.matchAll(domRe)) {
    const d = m[0].toLowerCase().replace(/^www\./, "");
    if (!emails.some((e) => e.endsWith("@" + d)) && /[a-z]/.test(d.split(".")[0])) add({ kind: "domain", value: d });
  }
  return out;
}
