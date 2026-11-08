// Tag-first parser for the moment reply (PLAN.md 3.2). Line 1 is the verdict (TAG), then labelled lines in any order:
//   VALUE: 0..3   AIM: me|other|all|unclear   SAY: <= 14 words   WHY: one line   MORE: up to 3 short lines   REF: memory id
// Rules: the verdict can be read as soon as line 1 is complete (parseMomentStream, MomentStream); anything that is not a clean moment
// (unknown tag, missing field, over-long say-line, garbage, a tag word inside the text) becomes SKIP plus an error.survived row.
// Nothing here throws and nothing returns raw model text beyond the capped fields. Text from the model is data: it is never used as an instruction.
import { AIMS, LIMITS, MOMENT_TAGS, SKIP_MOMENT, type Aim, type Moment, type MomentTag, type StallKind, type SurvivedRow, type Value } from "./types.ts";

/** The verdict from line 1. */
export type TagInfo = { tag: MomentTag; bankId?: string; stall?: StallKind };

export type ParsedMoment = {
  /** Known once line 1 is complete (or the reply is final). */
  tag?: TagInfo;
  /** Fields read so far (streaming view). `say` may still grow while `sayComplete` is false. */
  fields: Partial<Pick<Moment, "value" | "aim" | "say" | "why" | "more" | "ref">>;
  sayComplete: boolean;
  /** Only when `final`: the validated moment, always valid, SKIP when anything was wrong. */
  moment?: Moment;
  errors: SurvivedRow[];
};

const TAG_RE = new RegExp(`^(?:TAG\\s*[:=]\\s*)?(${MOMENT_TAGS.join("|")})(?![A-Za-z0-9])\\s*[:\\-–]?\\s*(.*)$`, "i");
const FIELD_RE = /^(VALUE|AIM|SAY|WHY|MORE|REF)\s*[:=]\s*(.*)$/i;
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
  if ("SAY" in f) out.fields.say = strip(f.SAY);
  if ("VALUE" in f && lines.some((l) => /^[\s>#]*VALUE\s*[:=]/i.test(l))) {
    const n = Number(f.VALUE.match(/^\s*([0-3])(?!\d)/)?.[1]);
    if (Number.isInteger(n)) out.fields.value = n as Value;
  }
  if ("AIM" in f) {
    const a = f.AIM.toLowerCase().match(/[a-z]+/)?.[0];
    if ((AIMS as readonly string[]).includes(a ?? "")) out.fields.aim = a as Aim;
  }
  if ("WHY" in f) out.fields.why = cut(strip(f.WHY), LIMITS.whyChars);
  if (more.length)
    out.fields.more = more
      .map((m) => cut(strip(m), LIMITS.moreChars))
      .filter(Boolean)
      .slice(0, LIMITS.moreLines);
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
  if (needsSay(tag.tag)) {
    if (!say) return skip("missing:SAY");
    if (words(say) > LIMITS.sayWords || say.length > LIMITS.sayChars) return skip("say-too-long");
  } else if (words(say) > LIMITS.sayWords || say.length > LIMITS.sayChars) return skip("say-too-long");
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
  };
  return out;
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
