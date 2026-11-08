// Tag-first parser for the moment reply. Line 1 is the verdict (TAG), then labelled lines in any order:
//   VALUE: 0..3   AIM: me|other|all|unclear   CONF: high|low   SAY: <= 12 words (up to 14 accepted)   LABEL: 2-4 word topic   ABOUT: <= 8 words   VAL: <= 4 words
//   WHY: one line   MORE: up to 3 short lines   REF: memory id
// CONF, LABEL, ABOUT and VAL are optional for the parser (the prompt asks for LABEL). CONF comes before SAY in the prompt, so the scheduler knows it when the say-line completes.
// Rules: the verdict can be read as soon as line 1 is complete (parseMomentStream, MomentStream); anything that is not a clean moment
// (unknown tag, missing field, garbage, a tag word inside the text) becomes SKIP plus an error.survived row.
// A SAY of 15 to 40 words is not garbage: it is cut at a clause end (fitSay), `fit` is false, the rest goes first into `more`, and `long` tells the caller (the observer asks once for a
// shorter one). A SAY over 40 words, or one that has no word break and is long, is garbage: SKIP.
// Nothing here throws and nothing returns raw model text beyond the capped fields. Text from the model is data: it is never used as an instruction.
import {
  AIMS,
  LIMITS,
  MOMENT_TAGS,
  SKIP_MOMENT,
  type Aim,
  type Conf,
  type Moment,
  type MomentTag,
  type StallKind,
  type SurvivedRow,
  type Value,
} from "./types.ts";

/** The verdict from line 1. */
export type TagInfo = { tag: MomentTag; bankId?: string; stall?: StallKind };

export type ParsedMoment = {
  /** Known once line 1 is complete (or the reply is final). */
  tag?: TagInfo;
  /** Fields read so far (streaming view). `say` may still grow while `sayComplete` is false. */
  fields: Partial<Pick<Moment, "value" | "aim" | "say" | "why" | "more" | "ref" | "label" | "conf" | "about" | "val" | "fit">>;
  sayComplete: boolean;
  /** The SAY had more than 14 words and was cut by fitSay (`fields.say` is the cut text). The observer holds such a card back and asks once for a shorter one. */
  long?: boolean;
  /** Only when `final`: the validated moment, always valid, SKIP when anything was wrong. */
  moment?: Moment;
  errors: SurvivedRow[];
};

const TAG_RE = new RegExp(`^(?:TAG\\s*[:=]\\s*)?(${MOMENT_TAGS.join("|")})(?![A-Za-z0-9])\\s*[:\\-–]?\\s*(.*)$`, "i");
const FIELD_RE = /^(VALUE|AIM|CONF|SAY|LABEL|ABOUT|VAL|WHY|MORE|REF)\s*[:=]\s*(.*)$/i;
const CONTROL_WORD = /(^|[^A-Za-z])(SKIP|STALL|BANK|ANS|REPLY|CHECK|PROMPT)(?![A-Za-z])/;
const STALL_KINDS: readonly StallKind[] = ["price", "guarantee", "timeline", "other"];
/** Characters that never belong in a card: C0/C1 controls (not newline), bidi overrides, zero-width marks. */
const JUNK = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

const clean = (s: string) =>
  s
    .replace(JUNK, "")
    .replace(/<\/?[A-Za-z_][^>]*>/g, " ") // tag-like text from the call cannot close or open a wrapper
    .replace(/[`*_]{1,3}/g, "")
    .replace(/\s+/g, " ")
    .trim();
const strip = (s: string) =>
  clean(s)
    .replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, "")
    .trim();
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() : s);
const sample = (s: string) => s.replace(JUNK, "").replace(/\s+/g, " ").trim().slice(0, LIMITS.sampleChars);

/** A topic label of 2 to 4 words. Over 5 words, or a sentence (ends with . ! ? or has a sentence break inside), is cut to the first 4 words. Empty when nothing usable is left. */
export function cleanLabel(raw: string): string {
  let t = strip(raw).replace(/^[-–—:;,.\s]+/, "");
  const sentence = /[.!?…]\s*$/.test(t) || /[.!?…]\s+\S/.test(t);
  let w = t.split(/\s+/).filter(Boolean);
  if (sentence)
    w = t
      .split(/[.!?…]+\s+/)[0]
      .split(/\s+/)
      .filter(Boolean); // the first sentence only
  if (w.length > LIMITS.labelMaxWords || sentence) w = w.slice(0, LIMITS.labelCutWords);
  t = w
    .join(" ")
    .replace(/[\s.!?…:;,\-–—]+$/, "")
    .trim();
  if (t.length > LIMITS.labelChars)
    t = t
      .slice(0, LIMITS.labelChars)
      .replace(/\s+\S*$/, "")
      .trim();
  return CONTROL_WORD.test(t) ? "" : t; // a label is a topic, never a verdict word
}

/** Characters at the end of a clause that are not part of the text when the line is cut there. */
const CLAUSE_PUNCT = /[,;:،؛]+$/;
const SENTENCE_END = /[.!?…]$/;
const DASH = /^[-–—]+$/;
/** Connectors that start a new clause in English. The Hebrew ones are found by punctuation only (no word list for Hebrew). */
const CLAUSE_OPENER = /^(and|but)$/i;

/** Cuts `say` to a line that fits: at most `maxWords` words and `maxChars` characters, ending where a clause ends (a comma, colon, semicolon, dash, full stop, or just before "and" or "but").
 *  With no clause end in the first words, it cuts at `hardWords` words. Never adds an ellipsis. `rest` is what was cut off (for `more`). `fit` is true when nothing was cut. */
export function fitSay(
  say: string,
  maxWords: number = LIMITS.sayWords,
  maxChars: number = LIMITS.sayChars,
  hardWords: number = LIMITS.sayAskWords,
): { say: string; rest: string; fit: boolean } {
  const t = String(say ?? "").trim();
  const w = t.split(/\s+/).filter(Boolean);
  if (w.length <= maxWords && t.length <= maxChars) return { say: t, rest: "", fit: true };
  const clauseEnd = (k: number): boolean => {
    // the head is w[0..k): it ends at a clause end when its last word carries punctuation, the next word opens a clause, or the last word is a dash
    const last = w[k - 1];
    return !!last && (CLAUSE_PUNCT.test(last) || SENTENCE_END.test(last) || DASH.test(last) || (k < w.length && CLAUSE_OPENER.test(w[k])));
  };
  const lengthOf = (k: number) => w.slice(0, k).join(" ").length;
  let k = 0;
  for (let c = Math.min(maxWords, w.length - 1); c >= 3; c--)
    if (clauseEnd(c) && lengthOf(c) <= maxChars) {
      k = c;
      break;
    }
  if (!k) {
    k = Math.max(1, Math.min(hardWords, maxWords, w.length - 1));
    while (k > 1 && lengthOf(k) > maxChars) k--;
  }
  let head = w.slice(0, k);
  while (head.length > 1 && DASH.test(head[head.length - 1])) head = head.slice(0, -1);
  const text = head
    .join(" ")
    .replace(CLAUSE_PUNCT, "")
    .replace(/[\s\-–—]+$/, "");
  const rest = w
    .slice(k)
    .join(" ")
    .replace(/^[\s,;:\-–—،؛]+/, "")
    .trim();
  return { say: text, rest, fit: false };
}
/** A short free-text field (ABOUT, VAL): cleaned, cut to `maxWords` words and `maxChars` characters, empty when it holds a verdict word. */
function cleanShort(raw: string, maxWords: number, maxChars: number): string {
  let t = strip(raw).replace(/^[-–—:;,.\s]+/, "");
  const w = t.split(/\s+/).filter(Boolean);
  if (w.length > maxWords) t = w.slice(0, maxWords).join(" ");
  if (t.length > maxChars)
    t = t
      .slice(0, maxChars)
      .replace(/\s+\S*$/, "")
      .trim();
  t = t.replace(/[\s.!?…:;,\-–—]+$/, "").trim();
  return CONTROL_WORD.test(t) ? "" : t;
}

const needsSay = (t: MomentTag) => t !== "SKIP" && t !== "BANK" && t !== "STALL";

function parseTagLine(line: string): TagInfo | undefined {
  const m = clean(line.replace(/^[\s>#\-•]+/, "")).match(TAG_RE);
  if (!m) return undefined;
  const tag = m[1].toUpperCase() as MomentTag;
  const rest = m[2].trim();
  if (tag === "BANK") {
    const id = rest.match(/^[<[]?([A-Za-z0-9][\w-]{0,63})[>\]]?(?:\s|$)/)?.[1];
    return id ? { tag, bankId: id.toLowerCase() } : undefined; // a BANK verdict with no id is not usable
  }
  if (tag === "STALL") {
    const kind = rest
      .split(/\s+/)[0]
      ?.toLowerCase()
      .replace(/[^a-z]/g, "");
    return { tag, stall: STALL_KINDS.find((k) => k === kind) ?? "other" };
  }
  return { tag };
}

/** Reads `buf` (everything streamed so far). `final` = the stream ended. Never throws. */
export function parseMomentStream(buf: string, final: boolean): ParsedMoment {
  const out: ParsedMoment = { fields: {}, sayComplete: false, errors: [] };
  try {
    return parseInner(buf, final, out);
  } catch (e) {
    // Defensive only: the code below has no known throwing path.
    out.errors.push({ type: "error.survived", where: "moments.parse", reason: `exception:${(e as Error)?.name ?? "error"}`, sample: "" });
    out.tag = { tag: "SKIP" };
    out.moment = final ? { ...SKIP_MOMENT, more: [] } : undefined;
    return out;
  }
}

function parseInner(buf: string, final: boolean, out: ParsedMoment): ParsedMoment {
  const fail = (reason: string, text = buf) => {
    out.errors.push({ type: "error.survived", where: "moments.parse", reason, sample: sample(text) });
  };
  let text = String(buf ?? "");
  if (text.length > LIMITS.inputChars) {
    text = text.slice(0, LIMITS.inputChars);
    fail("input-capped");
  }
  const raw = text.split(/\r?\n/);
  const complete = final ? raw : raw.slice(0, -1);
  const partial = final ? "" : (raw.at(-1) ?? "");
  let i = 0;
  while (i < complete.length && /^[\s`~]*$/.test(complete[i])) i++; // blank lines and a code fence before the verdict
  const first = complete[i];
  if (first === undefined) {
    // No complete line yet. Nothing to say until line 1 ends; a final empty reply is a SKIP.
    if (final) {
      fail("empty");
      out.tag = { tag: "SKIP" };
      out.moment = { ...SKIP_MOMENT, more: [] };
    }
    return out;
  }
  const tag = parseTagLine(first);
  if (!tag) {
    fail("bad-tag", first);
    out.tag = { tag: "SKIP" };
    if (final) out.moment = { ...SKIP_MOMENT, more: [] };
    return out;
  }
  out.tag = tag;

  // Field lines. MORE may continue on "- item" lines. The last, unfinished line is a partial value (SAY streams).
  const f: Record<string, string> = {};
  const more: string[] = [];
  let current: string | undefined;
  const lines = complete.slice(i + 1);
  const feed = (line: string, isComplete: boolean) => {
    const t = line.trim();
    if (!t) return;
    const m = t.replace(/^[\s>#]+/, "").match(FIELD_RE);
    if (m) {
      current = m[1].toUpperCase();
      const v = m[2].trim();
      if (current === "MORE") {
        if (v) more.push(v.replace(/^[-•*]\s*/, ""));
      } else if (!(current in f)) f[current] = v;
      if (!isComplete && current === "SAY") out.fields.say = strip(v);
      return;
    }
    if (current === "MORE" && /^[-•*]\s*\S/.test(t)) more.push(t.replace(/^[-•*]\s*/, ""));
    else current = undefined; // a stray line (preamble, chatter) ends the open field and is ignored
  };
  for (const l of lines) feed(l, true);
  if (partial.trim()) feed(partial, false);

  out.sayComplete = lines.some((l) => /^[\s>#]*SAY\s*[:=]/i.test(l)); // the SAY line is among the finished lines
  const done = (name: string) => name in f && lines.some((l) => new RegExp(`^[\\s>#]*${name}\\s*[:=]`, "i").test(l)); // a half-streamed line is not read
  let sayRest = "";
  if ("SAY" in f) {
    const say = strip(f.SAY);
    if (needsSay(tag.tag) && (words(say) > LIMITS.sayWords || say.length > LIMITS.sayChars)) {
      const fit = fitSay(say);
      out.fields.say = fit.say;
      out.fields.fit = false;
      out.long = true;
      sayRest = fit.rest;
    } else out.fields.say = say;
  }
  if (done("CONF")) {
    const c = f.CONF.toLowerCase().match(/[a-z]+/)?.[0];
    if (c === "high" || c === "low") out.fields.conf = c as Conf;
  }
  if (done("ABOUT")) {
    const a = cleanShort(f.ABOUT, LIMITS.aboutWords, LIMITS.aboutChars);
    if (a) out.fields.about = a;
  }
  if (done("VAL")) {
    const v = cleanShort(f.VAL, LIMITS.valWords, LIMITS.valChars);
    if (v) out.fields.val = v;
  }
  if ("VALUE" in f && lines.some((l) => /^[\s>#]*VALUE\s*[:=]/i.test(l))) {
    const n = Number(f.VALUE.match(/^\s*([0-3])(?!\d)/)?.[1]);
    if (Number.isInteger(n)) out.fields.value = n as Value;
  }
  if ("AIM" in f) {
    const a = f.AIM.toLowerCase().match(/[a-z]+/)?.[0];
    if ((AIMS as readonly string[]).includes(a ?? "")) out.fields.aim = a as Aim;
  }
  if ("LABEL" in f && lines.some((l) => /^[\s>#]*LABEL\s*[:=]/i.test(l))) {
    const l = cleanLabel(f.LABEL);
    if (l) out.fields.label = l;
  }
  if ("WHY" in f) out.fields.why = cut(strip(f.WHY), LIMITS.whyChars);
  const moreAll = [...(sayRest ? [sayRest] : []), ...more]
    .map((m) => cut(strip(m), LIMITS.moreChars))
    .filter(Boolean)
    .slice(0, LIMITS.moreLines);
  if (moreAll.length) out.fields.more = moreAll;
  if ("REF" in f) {
    const r = f.REF.trim().match(/^[a-z]{1,2}\d{1,6}$/i)?.[0];
    if (r) out.fields.ref = r.toLowerCase().slice(0, LIMITS.refChars);
  }
  if (!final) return out;

  // ---- validation (final) ----
  const skip = (reason: string): ParsedMoment => {
    fail(reason, text);
    out.moment = { ...SKIP_MOMENT, more: [], why: cut(out.fields.why ?? "", LIMITS.whyChars) };
    return out;
  };
  if (tag.tag === "SKIP") {
    out.moment = { ...SKIP_MOMENT, more: [], why: cut(out.fields.why ?? "", LIMITS.whyChars) };
    return out;
  }
  if (out.fields.value === undefined) return skip("missing:VALUE");
  if (out.fields.aim === undefined) return skip("missing:AIM");
  const say = out.fields.say ?? "";
  if (needsSay(tag.tag) && !say) return skip("missing:SAY");
  // A runaway SAY is garbage, not a long line: more than sayCutWords words, or text far over the character limit.
  if (rawSayGarbage(f.SAY) || say.length > LIMITS.sayChars) return skip("say-too-long"); // the second test: one long word with no break to cut at
  if (say && CONTROL_WORD.test(say)) return skip("leaked-tag"); // the model talking about its own verdict
  out.moment = {
    tag: tag.tag,
    ...(tag.bankId ? { bankId: tag.bankId } : {}),
    ...(tag.stall ? { stall: tag.stall } : {}),
    value: out.fields.value,
    aim: out.fields.aim,
    say,
    why: out.fields.why ?? "",
    more: out.fields.more ?? [],
    ...(out.fields.ref ? { ref: out.fields.ref } : {}),
    ...(out.fields.label ? { label: out.fields.label } : {}),
    ...(out.fields.conf ? { conf: out.fields.conf } : {}),
    ...(out.fields.about ? { about: out.fields.about } : {}),
    ...(out.fields.val ? { val: out.fields.val } : {}),
    ...(out.fields.fit === false ? { fit: false } : {}),
  };
  return out;
}

/** True when the raw SAY text is not a long line but garbage: over sayCutWords words, or over 2.5 times the character limit. */
function rawSayGarbage(raw: string | undefined): boolean {
  if (!raw) return false;
  const t = strip(raw);
  return words(t) > LIMITS.sayCutWords || t.length > LIMITS.sayChars * 2.5;
}

/** A moment from the verdict and the fields read so far (what the card path needs when it shows the card at the say-line). */
export function momentFromParsed(tag: TagInfo, f: ParsedMoment["fields"]): Moment {
  return {
    tag: tag.tag,
    ...(tag.bankId ? { bankId: tag.bankId } : {}),
    ...(tag.stall ? { stall: tag.stall } : {}),
    value: f.value ?? 0,
    aim: f.aim ?? "unclear",
    say: f.say ?? "",
    why: f.why ?? "",
    more: f.more ?? [],
    ...(f.ref ? { ref: f.ref } : {}),
    ...(f.label ? { label: f.label } : {}),
    ...(f.conf ? { conf: f.conf } : {}),
    ...(f.about ? { about: f.about } : {}),
    ...(f.val ? { val: f.val } : {}),
    ...(f.fit === false ? { fit: false } : {}),
  };
}

/** Convenience for a complete reply: always a valid moment. */
export function parseMoment(reply: string): { moment: Moment; errors: SurvivedRow[] } {
  const p = parseMomentStream(reply, true);
  return { moment: p.moment ?? { ...SKIP_MOMENT, more: [] }, errors: p.errors };
}

export type MomentStreamHandlers = {
  /** Once, as soon as line 1 is complete (or at the end for a reply with no usable line 1: then SKIP). */
  onTag?(tag: TagInfo): void;
  /** The say-line so far; called again as it grows. */
  onSay?(text: string, complete: boolean): void;
  /** Once, at the end: the validated moment. */
  onDone?(moment: Moment, errors: SurvivedRow[]): void;
};

/** Feeds chunks, fires handlers. The handlers are called inside try/catch: a throwing handler never breaks the stream. */
export class MomentStream {
  private buf = "";
  private tagged = false;
  private lastSay = "";
  private done = false;
  constructor(private h: MomentStreamHandlers = {}) {}
  write(chunk: string): void {
    if (this.done) return;
    this.buf += String(chunk ?? "");
    if (this.buf.length > LIMITS.inputChars * 2) this.buf = this.buf.slice(0, LIMITS.inputChars * 2); // a runaway stream cannot grow memory
    this.emit(parseMomentStream(this.buf, false));
  }
  end(): { moment: Moment; errors: SurvivedRow[] } {
    const p = parseMomentStream(this.buf, true);
    if (!this.done) {
      this.emit(p);
      this.done = true;
      this.safe(() => this.h.onDone?.(p.moment!, p.errors));
    }
    return { moment: p.moment ?? { ...SKIP_MOMENT, more: [] }, errors: p.errors };
  }
  private emit(p: ParsedMoment) {
    if (!this.tagged && p.tag) {
      this.tagged = true;
      this.safe(() => this.h.onTag?.(p.tag!));
    }
    const say = p.fields.say;
    if (say !== undefined && say !== this.lastSay && p.tag?.tag !== "SKIP") {
      this.lastSay = say;
      this.safe(() => this.h.onSay?.(say, p.sayComplete));
    }
  }
  private safe(fn: () => void) {
    try {
      fn();
    } catch {
      /* a handler error must not stop the parser */
    }
  }
}
