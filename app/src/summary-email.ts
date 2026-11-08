// The follow-up email of a summary goes through the same guards as the answer cards: a price, a date or a promise becomes a visible gap
// ("[להשלים: ...]" or "[fill in: ...]"), and links, phone numbers and addresses that nobody said on the call are made harmless.
import { guard, guardDigits } from "./guards.ts";
import { type CallLang } from "./calllang.ts";

// Guard rule name -> the visible gap the user must fill by hand before sending.
const PH_HE = {
  price: "[להשלים: מחיר]",
  date: "[להשלים: תאריך]",
  promise: "[להשלים: התחייבות]",
  link: "[להשלים: קישור]",
  email: "[להשלים: אימייל]",
  phone: "[להשלים: טלפון]",
  other: "[להשלים]",
};
const PH_EN: typeof PH_HE = {
  price: "[fill in: price]",
  date: "[fill in: date]",
  promise: "[fill in: promise]",
  link: "[fill in: link]",
  email: "[fill in: email]",
  phone: "[fill in: phone]",
  other: "[fill in]",
};
/** The gap marks the user must fill in by hand, in the language of the email. */
export const placeholders = (lang: CallLang = "he"): typeof PH_HE => (lang === "en" ? PH_EN : PH_HE);

// File extensions that look like a TLD ("notes.md", "deck.pdf", "index.ts") and must not be treated as a host. Real abusable TLDs
// that double as file types (.zip, .mov, .sh, .py, .rs) are deliberately NOT listed: "evil.zip" is neutralised.
const FILE_EXT = new Set(
  "ts tsx js jsx mjs cjs json md txt pdf doc docx xls xlsx ppt pptx csv tsv png jpg jpeg gif svg webp heic html htm css rb go java yml yaml xml log mp3 mp4 wav rtf pages key numbers gz tar tgz lock toml ini env bak tmp".split(
    " ",
  ),
);
// A scheme URL, a "www." host, or a bare dotted host on ANY TLD of 2-24 letters ("login.evil.ru/x", "evil.tk"), with an optional path.
const URL_RE = /(?<![@\w.-])(?:(?:https?:\/\/|www\.)[^\s<>"')\]]+|[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.([a-z]{2,24})(?:\/[^\s<>"')\]]*)?(?![\w@-]))/gi;
const EMAIL_RE = /(?<![\w.+-])[a-z0-9][a-z0-9._%+-]*@(?:[a-z0-9-]+\.)+[a-z]{2,24}(?![\w-])/gi;
const PHONE_RE = /(?<![\w.@])\+?\d[\d\s().-]{5,}\d(?![\w@])/g;
// Other things that open as links: scheme:// of any kind, javascript:/data:/file:/mailto:, a bare IPv4 address with an optional port and path.
const SCHEME_RE = /(?<![\w.-])(?:[a-z][a-z0-9+.-]{1,15}:\/\/|(?:javascript|vbscript|data|file|mailto):)[^\s<>"')\]]*/gi;
const IPV4_RE = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.]*\d)(?::\d{1,5})?(?:\/[^\s<>"')\]]*)?/g;
/** Undoes tricks that hide a host from the patterns but not from a mail app or browser: zero-width characters inside a host, ideographic and
 *  fullwidth dots, fullwidth Latin letters and "@". Only touches runs next to ASCII host characters, so Hebrew text and emoji are left alone. */
function unhide(t: string): string {
  return t
    .replace(/(?<=[a-z0-9.@-])[\u200b-\u200d\u2060\ufeff\u00ad]+(?=[a-z0-9.@/-])/gi, "")
    .replace(/(?<=[a-z0-9])[\u3002\uff0e\uff61](?=[a-z0-9])/gi, ".")
    .replace(/[\uff10-\uff19\uff21-\uff3a\uff41-\uff5a\uff20\uff0e\uff0f\uff1a]+/g, (m) => String.fromCharCode(...[...m].map((c) => c.charCodeAt(0) - 0xfee0)));
}
const trimUrl = (u: string) => u.replace(/[.,;:!?]+$/, "");
/**
 * Link neutraliser, the last defence on the follow-up email draft (prompt injection: the other side can say "send the invoice to
 * billing@evil.com" or "confirm at evil.tk" and the model may write it into the email). Layers: (1) the card guards in guards.ts
 * (prices, dates, promises); (2) this function, which replaces every link, bare domain (any TLD, unless it is a file extension),
 * email address and phone number that is NOT in `trusted` (the user's own text: brief, typed notes) with a visible placeholder the
 * user must fill in by hand; (3) the user reads the draft before sending. Summary, decisions and next-steps fields are display only
 * and are not neutralised. Returns the new text and which kinds were replaced.
 */
export function neutralizeLinks(email: string, trusted: string, lang: CallLang = "he"): { text: string; kinds: string[] } {
  const kinds: string[] = [];
  const ph = placeholders(lang);
  const t = trusted.toLowerCase(),
    tDigits = trusted.replace(/\D/g, "");
  const known = (u: string) => {
    const x = trimUrl(u)
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/$/, "");
    return x.length > 0 && t.includes(x);
  };
  let text = unhide(email).replace(SCHEME_RE, (u) => {
    if (known(u)) return u;
    kinds.push("url");
    return ph.link + (/[.,;:!?]$/.test(u) ? u.slice(-1) : "");
  });
  text = text.replace(IPV4_RE, (ip) => {
    if (known(ip)) return ip;
    kinds.push("url");
    return ph.link;
  });
  text = text.replace(URL_RE, (u, tld?: string) => {
    if (tld && FILE_EXT.has(tld.toLowerCase())) return u;
    if (known(u)) return u;
    kinds.push("url");
    return ph.link + (/[.,;:!?]$/.test(u) ? u.slice(-1) : "");
  });
  text = text.replace(EMAIL_RE, (e) => {
    if (t.includes(e.toLowerCase())) return e;
    kinds.push("email");
    return ph.email;
  });
  text = text.replace(PHONE_RE, (n) => {
    const d = n.replace(/\D/g, "");
    if (d.length < 7 || d.length > 15 || /^\d{4}-\d{2}-\d{2}$/.test(n) || (/^\d+$/.test(n) && d.length < 9 && !n.startsWith("+"))) return n;
    if (tDigits.includes(d) || tDigits.includes(d.replace(/^(972|00972)/, "0"))) return n;
    kinds.push("phone");
    return ph.phone;
  });
  return { text, kinds };
}

/** Runs the card guards over every sentence of the email; a flagged sentence is replaced by a placeholder for the user to fill in.
 *  With `trusted` (the user's own notes) links and phone numbers that are not in it are replaced too (neutralizeLinks). */
export function guardEmail(email: string, trusted?: string, lang: CallLang = "he", figures?: string): { text: string; replaced: number; rules: string[] } {
  let replaced = 0;
  const rules: string[] = [];
  const PH = placeholders(lang);
  const text = email
    .split("\n")
    .map((line) => {
      if (!line.trim()) return line;
      const parts = line.split(/(?<=[.!?…])\s+/);
      const out: string[] = [];
      for (const s of parts) {
        // With `figures` (the call memory and the tail), a number that nobody said is a promise too: any language, digits only (guards.ts guardDigits).
        const g = guard(s).ok && figures !== undefined ? guardDigits(s, figures) : guard(s);
        if (g.ok) {
          out.push(s);
          continue;
        }
        replaced++;
        rules.push(g.rule ?? "?");
        const mark = (PH[g.rule as "price" | "date" | "promise"] ?? (g.rule === "number" ? PH.price : PH.other)) as string;
        if (out.at(-1) !== mark) out.push(mark);
      }
      return out.join(" ");
    })
    .join("\n");
  if (trusted === undefined) return { text, replaced, rules };
  const n = neutralizeLinks(text, trusted, lang);
  return { text: n.text, replaced: replaced + n.kinds.length, rules: [...rules, ...n.kinds] };
}
