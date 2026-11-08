// Opt-in lookup of one term on a public web page. Off by default (settings lookup.enabled). Used by `wingman lookup "<term>"` and the Ask tab; no live card yet.
//   - One request per use. The page is read with the same safe reader as the Meeting context box (shared/inputs.cjs): https only, port 443, no credentials, private and
//     local addresses refused (also after a redirect), 8 s and 1.5 MB at most. The reader is `o.fetch` in tests: no test touches the network.
//   - The answer is one line, the address it came from and the sentence of the page it was taken from. By default the line IS that sentence (nothing is written by a model).
//     A model may shorten it (`o.shorten`), at most `maxUsd` dollars; its text is kept only when every number in it is in the page text (the number guard).
//   - The fetched text is untrusted: control characters and markup are removed here, and the windows show it with textContent.
// A term that looks like an https address is read as that page. Anything else is looked up in the free encyclopedia summary service for the language of the term.
import { fetchSafe, checkUrl, htmlToText, type ReadOptions } from "./inputs.ts";
import { numbersGrounded } from "./ask.ts";

export type LookupOk = {
  ok: true;
  term: string;
  /** the address the sentence came from (the page, not the service address) */
  url: string;
  /** the one line to show */
  line: string;
  /** the sentence of the page the line came from */
  sentence: string;
  /** true when a model wrote `line` (shorter than the sentence) */
  ai: boolean;
  usd: number;
};
export type LookupFail = { ok: false; code: "off" | "bad-term" | "refused" | "not-found" | "failed" | "timeout"; message: string };
export type LookupResult = LookupOk | LookupFail;

export type LookupOptions = {
  enabled: boolean;
  /** most one lookup may cost when a model shortens the sentence (0 = never use one) */
  maxUsd?: number;
  fetch?: ReadOptions["fetch"];
  dns?: ReadOptions["lookup"];
  timeoutMs?: number;
  maxBytes?: number;
  /** a model that writes a shorter line from the sentence; `estimateUsd` is checked against maxUsd before it is called, `usd` after */
  shorten?: { estimateUsd: (sentence: string) => number; run: (sentence: string, term: string) => Promise<{ text: string; usd: number }> };
};

const MAX_TERM = 80;
const MAX_SENTENCE = 400;
const MAX_LINE = 220;
const HE = /[֐-׿]/;
const ctrl = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;
/** Plain text from fetched text: no markup, no control or direction characters, single spaces. */
export const plain = (s: unknown, max: number): string =>
  String(s ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(ctrl, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const fail = (code: LookupFail["code"], message: string): LookupFail => ({ ok: false, code, message });

/** Sentences of a text (full stop, question mark, exclamation mark, or a CJK stop, followed by a space or the end). A decimal point does not end one. */
export function sentences(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    cur += chars[i];
    const c = chars[i],
      next = chars[i + 1];
    if (/[.!?。]/.test(c) && (next === undefined || /\s/.test(next)) && !/(^|\s)[A-Z]\.$/.test(cur.slice(-3))) {
      out.push(cur.trim());
      cur = "";
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter((s) => s.length >= 8);
}

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2);
/** The sentence that mentions the most words of the term (ties: the earliest); the first sentence when none does. */
export function pickSentence(text: string, term: string): string {
  const ss = sentences(text);
  if (!ss.length) return "";
  const want = new Set(words(term));
  let best = ss[0],
    bestN = -1;
  for (const s of ss) {
    const have = new Set(words(s));
    let n = 0;
    for (const w of want) if (have.has(w) || [...have].some((h) => h.length > 3 && w.length > 3 && (h.endsWith(w) || w.endsWith(h)))) n++;
    if (n > bestN) {
      best = s;
      bestN = n;
    }
  }
  return best.slice(0, MAX_SENTENCE);
}

/** The address to read for a term: an https address as it is, else the encyclopedia summary address for the language of the term. */
export function lookupAddress(term: string): { api: string; page: (title: string) => string } | { direct: string } {
  if (/^https:\/\//i.test(term)) return { direct: term };
  const host = HE.test(term) ? "he.wikipedia.org" : "en.wikipedia.org";
  const slug = encodeURIComponent(term.replace(/\s+/g, "_"));
  return {
    api: `https://${host}/api/rest_v1/page/summary/${slug}?redirect=true`,
    page: (title) => `https://${host}/wiki/${encodeURIComponent(plain(title, 120).replace(/\s+/g, "_"))}`,
  };
}

export async function lookup(termRaw: string, o: LookupOptions): Promise<LookupResult> {
  if (!o.enabled) return fail("off", "Lookup is off. Turn it on in Settings (Lookup) or in the Ask tab first.");
  const term = plain(termRaw, MAX_TERM);
  if (term.length < 2 || !/[\p{L}\p{N}]/u.test(term)) return fail("bad-term", "Type a word or a short phrase to look up.");
  // anything that looks like an address but is not https is refused, never searched as a word
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(term) && !/^https:\/\//i.test(term)) return fail("refused", "Only https:// addresses can be read.");
  const addr = lookupAddress(term);
  const opts = { ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.dns ? { lookup: o.dns } : {}), timeoutMs: o.timeoutMs ?? 8000, maxBytes: o.maxBytes ?? 400_000 };
  try {
    let pageUrl: string, text: string;
    if ("direct" in addr) {
      checkUrl(addr.direct);
      const r = await fetchSafe(addr.direct, opts);
      pageUrl = r.url;
      text = plain(r.type.includes("html") ? htmlToText(r.body) : r.body, 20_000);
    } else {
      const r = await fetchSafe(addr.api, { ...opts, accept: "application/json" });
      let j: { title?: unknown; extract?: unknown; type?: unknown } = {};
      try {
        j = JSON.parse(r.body);
      } catch {
        return fail("failed", "The answer of the page could not be read.");
      }
      text = plain(j.extract, 4000);
      if (!text || j.type === "disambiguation") return fail("not-found", "Nothing clear was found for that term.");
      pageUrl = addr.page(typeof j.title === "string" && j.title ? j.title : term);
    }
    const sentence = pickSentence(text, term);
    if (!sentence) return fail("not-found", "Nothing clear was found for that term.");
    // the shown address must be one the reader accepts as well (it is shown and may be clicked)
    checkUrl(pageUrl);
    let line = sentence.length > MAX_LINE ? sentence.slice(0, MAX_LINE).replace(/\s+\S*$/, "") + "…" : sentence;
    let ai = false,
      usd = 0;
    const cap = o.maxUsd ?? 0;
    if (o.shorten && cap > 0 && o.shorten.estimateUsd(sentence) <= cap) {
      try {
        const m = await o.shorten.run(sentence, term);
        const t = plain(m.text, MAX_LINE);
        usd = Number.isFinite(m.usd) && m.usd > 0 ? m.usd : 0;
        // kept only when it cost no more than the cap and its numbers are in the page text
        if (t && usd <= cap && numbersGrounded(t, text)) {
          line = t;
          ai = true;
        }
      } catch {
        /* the sentence itself is the answer */
      }
    }
    return { ok: true, term, url: pageUrl, line, sentence, ai, usd };
  } catch (e) {
    const code = (e as { code?: string })?.code;
    const msg = plain((e as Error)?.message, 200) || "The lookup failed.";
    if (code === "timeout") return fail("timeout", msg);
    if (code === "refused" || code === "badurl") return fail("refused", msg);
    return fail("failed", msg);
  }
}
