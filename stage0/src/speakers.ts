// Speakers on the other side. The other side's audio is one mixed stream (a Zoom call with four people is still one "them"
// channel), so the STT provider's diarization tells the voices apart and gives each word a raw speaker id. This module turns
// those ids into stable call-local numbers ("Speaker 1" is the first voice heard) and, when known, names.
// Nothing is kept across calls: no voice prints, only the numbers and names of this call.
import type { Word } from "./providers/stt/types.ts";

/** The raw speaker id most of a final's words belong to, or undefined when the provider gave none. */
export function dominantSpeaker(words: Word[]): number | undefined {
  const n = new Map<number, number>();
  for (const w of words) if (typeof w.speaker === "number") n.set(w.speaker, (n.get(w.speaker) ?? 0) + 1);
  let best: number | undefined, most = 0;
  for (const [id, c] of n) if (c > most) { best = id; most = c; }
  return best;
}

export type SpeakerInfo = { spk: number; name?: string };

/** Call-local speaker numbers (1, 2, 3... in order of first appearance) and optional names. */
export class SpeakerBook {
  private nums = new Map<number, number>();
  private names = new Map<number, string>();
  private manual = new Set<number>();   // named by the user: an introduction never overrides it
  /** The call-local number for a raw provider id (a new id gets the next number). */
  number(raw: number): number {
    let n = this.nums.get(raw);
    if (n === undefined) { n = this.nums.size + 1; this.nums.set(raw, n); }
    return n;
  }
  /** Speaker info for a final's words, or undefined when the words carry no speaker. */
  of(words: Word[]): SpeakerInfo | undefined {
    const raw = dominantSpeaker(words);
    if (raw === undefined) return undefined;
    const spk = this.number(raw);
    const name = this.names.get(spk);
    return name ? { spk, name } : { spk };
  }
  /** Name call-local speaker `spk` (empty name clears it). */
  setName(spk: number, name: string, byUser = false) {
    const n = name.trim().slice(0, 40);
    if (n) this.names.set(spk, n); else this.names.delete(spk);
    if (byUser) this.manual.add(spk);
  }
  name(spk: number): string | undefined { return this.names.get(spk); }
  isManual(spk: number): boolean { return this.manual.has(spk); }
  get count(): number { return this.nums.size; }
}

/** How a line is labelled for the models: "me", "them" or "them (Speaker 2)" / "them (Dana)". */
export function lineLabel(ch: "me" | "them", who?: SpeakerInfo): string {
  if (ch === "me" || !who) return ch;
  return `them (${who.name ?? `Speaker ${who.spk}`})`;
}


/**
 * First names of the people on the call, from a prepared meeting's "who" line ("Dana Levi, Pierre (IT), רות כהן / Levi Studio").
 * Parts are split on , ; / & "and" "ו"; the first word of each part that starts with a letter is the first name.
 */
export function attendeeNames(who: string | undefined): string[] {
  if (!who) return [];
  const out = new Set<string>();
  for (const part of who.replace(/\([^)]*\)/g, " ").split(/[,;/&\n]|\s+and\s+|\s+ו(?=[א-ת])/i)) {
    const first = part.trim().split(/\s+/)[0]?.replace(/[^\p{L}'-]/gu, "");
    if (first && first.length >= 2 && /^\p{L}/u.test(first)) out.add(first);
  }
  return [...out];
}

// Introductions. Strong cues name the speaker on their own; "אני X" / "I'm X" only when X is one of the attendees, because
// "אני מבינה", "אני מרים את זה" or "I'm sure" are not names.
const STRONG_INTRO = [/(?:^|[\s,.])(?:קוראים לי|שמי)\s+([א-ת][א-ת'"]+)/, /\bmy name is\s+([A-Z][a-z'-]+)/i];
const WEAK_INTRO = [/(?:^|[\s,.])(?:אני|זאת|זו|זה|מדברת|מדבר|כאן)\s+([א-ת][א-ת'"]+)/, /\b(?:[Ii]'m|[Ii] am|[Tt]his is|[Ii]t's)\s+([A-Z][a-z'-]+)/];
const NOT_NAMES = new Set(["sorry", "here", "fine", "good", "not", "just", "the", "sure", "okay", "ok", "glad", "happy", "back", "going", "trying", "still", "also", "really", "so"]);
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}]/gu, "");

/** Edit distance (small strings only). */
function dist(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
/** The attendee a misheard name stands for ("Donna" for Dana): same first letter, at most 2 edits, and only one attendee that close. */
function nearAttendee(cand: string, attendees: string[]): string | undefined {
  const c = norm(cand);
  if (c.length < 3) return undefined;
  const close = attendees.filter((a) => { const n = norm(a); return n[0] === c[0] && dist(n, c) <= (Math.min(n.length, c.length) >= 4 ? 2 : 1); });
  return close.length === 1 ? close[0] : undefined;
}

// Words that follow "this is" / "it's" / "I'm" but are not names: days, months, products and companies, nationalities and languages.
const STOP_NAMES = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "zoom", "teams", "meet", "skype", "slack", "whatsapp", "google", "microsoft", "apple", "amazon", "facebook", "meta", "linkedin", "outlook", "gmail", "excel", "word", "windows", "mac", "macbook", "iphone", "android", "chrome", "safari", "wordpress", "shopify", "github", "wingman", "claude", "chatgpt", "openai", "anthropic",
  "israel", "israeli", "american", "english", "hebrew", "arabic", "russian", "french", "german", "jewish", "christian", "muslim", "european", "canadian", "british",
  "yes", "yeah", "no", "hello", "hi", "hey", "thanks", "thank", "please", "great", "nice", "right", "true", "late", "early", "today", "tomorrow", "yesterday", "morning", "evening", "noon", "night", "time", "again", "ready", "done", "free", "busy",
  "ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת", "זום", "גוגל", "ישראלי", "ישראל", "אמריקאי", "עברית", "אנגלית", "בסדר", "נכון", "מצוין", "טוב", "היום", "מחר", "אתמול", "עכשיו",
]);
/** Hebrew: a word after the candidate that shows it was a verb ("אני מרים את זה"), not a name. */
const HE_VERB_NEXT = new Set(["את", "אותו", "אותה", "אותם", "אותך", "כבר", "גם", "מאוד", "עכשיו", "פה", "שם", "מיד"]);
const wordCount = (t: string) => t.split(/\s+/).filter(Boolean).length;

/**
 * An English weak cue ("I'm Dana", "this is Dana") may name a voice that is NOT on the attendee list only when the sentence it sits in is short (6 words
 * at most) and starts with the cue, after at most a greeting of two words ("Hi everyone, I'm Pierre").
 */
function startsShort(text: string, m: RegExpExecArray): boolean {
  const before = text.slice(0, m.index);
  const sentStart = Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?")) + 1;
  const lead = before.slice(sentStart).replace(/[,;:\-]+/g, " ");
  if (wordCount(lead) > 2) return false;
  let end = text.slice(m.index + m[0].length).search(/[.!?]/);
  end = end < 0 ? text.length : m.index + m[0].length + end;
  return wordCount(text.slice(sentStart, end)) <= 6;
}

/** The name a speaker gives for themself in this line, or undefined. Attendee names win; a strong cue alone is enough. */
export function introName(text: string, attendees: string[] = []): string | undefined {
  const known = new Map(attendees.map((a) => [norm(a), a]));
  for (const re of [...STRONG_INTRO, ...WEAK_INTRO]) {
    const m = re.exec(text);
    if (!m) continue;
    if (/'s$/i.test(m[1])) continue;   // "it's Dana's turn" is not an introduction
    const cand = m[1].replace(/['"]+$/, "");
    const strong = STRONG_INTRO.includes(re);
    const stop = NOT_NAMES.has(norm(cand)) || STOP_NAMES.has(norm(cand));
    if (!strong && stop) continue;
    if (re === WEAK_INTRO[0]) {   // Hebrew weak cue: only an attendee, and not when the next word shows a verb
      const next = text.slice(m.index + m[0].length).trim().split(/\s+/)[0]?.replace(/[^\p{L}]/gu, "") ?? "";
      if (HE_VERB_NEXT.has(next)) continue;
    }
    const hit = known.get(norm(cand)) ?? nearAttendee(cand, attendees);
    if (hit) return hit;
    if (strong && !stop) return cand;
    if (re === WEAK_INTRO[1] && startsShort(text, m)) return cand;   // English "I'm Dana": STT capitalises names, not "sure" or "fine"
  }
  return undefined;
}
