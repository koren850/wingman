// Card pipeline v2, the pure part: card rows (PLAN 3.3), the cap decision, the scheduler hookup (rank, topic lifetime, closing rows) and the
// feedback loop from tags.jsonl. No globals and no clock of its own: engine/cards.ts is the thin glue that writes the rows.
//
// A v2 row is a normal cards.jsonl row (all v1 fields stay: id, turnId, badge, question, say, facts, at) plus: kind, value, why, more, ref,
// closes, ctx, pinned, chip. The badge is chosen so that old tools still show a sensible card:
//   answer -> "ai" (or "bank" for a prepared card)   prompt -> "tip" (tipType "ask")   check -> "careful"   fact -> "info"
import {
  decide,
  recordFeedback,
  recordShown,
  clearHero,
  isExempt,
  DEFAULT_SCHEDULER,
  newSchedulerState,
  type Decision,
  type ScheduledMoment,
  type Rating,
  type SchedulerConfig,
  type SchedulerState,
} from "../moments/scheduler.ts";
import type { Conf, MomentTag } from "../moments/types.ts";
import { cleanLabel, fitSay } from "../moments/parse.ts";
import { learnedOffsets } from "../moments/learn.ts";
import type { CtxRecord } from "../context/record.ts";
import { guard, guardDigits, sanitize, type GuardResult } from "../guards.ts";

export type CardKind = "answer" | "prompt" | "check" | "fact";
export type CardCloses = "answered" | "topic" | "time" | "dismissed";
export type CardBadge = "bank" | "ai" | "stall" | "info" | "warn" | "tip" | "me" | "careful" | "fix";

/** The v2 fields of a row (PLAN 3.3). `chip` is an addition: the scheduler wanted this card small (it is still shown). */
export type CardV2Extra = {
  kind?: CardKind;
  value?: 0 | 1 | 2 | 3;
  why?: string;
  more?: string[];
  ref?: string;
  closes?: CardCloses;
  ctx?: CtxRecord | { memV: number; tokens: number; parts: Record<string, number> };
  pinned?: boolean;
  chip?: boolean;
  /** 2 to 4 words, the topic of the card (from the LABEL line). When the model sent none: the bank card title, then the call memory's topic, then nothing (never the first words of the line). */
  label?: string;
  /** At most 8 words: the question or topic this card answers ("PHP version"). */
  about?: string;
  /** Fact cards: the value itself, at most 4 words ("WooCommerce 8.2"). */
  val?: string;
  /** `low`: the model was not sure; the scheduler showed it only as a chip. */
  conf?: Conf;
  /** `false`: the SAY text was cut at a clause end; the rest is in `more` and the overlay shows "More". */
  fit?: boolean;
  /** Where a fact comes from: the prepared brief, this call, the user's own words, the notes, or an earlier call. */
  src?: CardSrc;
};
export type CardSrc = "brief" | "call" | "you" | "notes" | "past";
export const CARD_SRCS: readonly CardSrc[] = ["brief", "call", "you", "notes", "past"];

export const KIND_OF_TAG: Record<MomentTag, CardKind | undefined> = {
  SKIP: undefined,
  ANS: "answer",
  BANK: "answer",
  STALL: "answer",
  REPLY: "answer",
  CHECK: "check",
  TERM: "fact",
  PROMPT: "prompt",
  NOTE: "fact",
};
const BADGE_OF_KIND: Record<CardKind, CardBadge> = { answer: "ai", prompt: "tip", check: "careful", fact: "info" };

/** Card kind of a legacy badge (same rule as the overlay: careful and fix are checks). */
export function kindOfBadge(badge: string): CardKind {
  if (badge === "careful" || badge === "fix") return "check";
  if (badge === "info") return "fact";
  if (badge === "tip") return "prompt";
  return "answer";
}

// ---------------------------------------------------------------- the cap
export type CapInput = {
  now: number;
  quiet: boolean;
  special: boolean; // health, info and tip rows: never counted, never capped
  forMe: boolean;
  badge: string;
  kind?: CardKind;
  priority?: boolean;
  /** The scheduler already decided this card (rank, per-minute cap, topic lifetime): the old cap does not apply a second time. */
  scheduled?: boolean;
  capMax: number;
  capWindowMs: number;
  shown: readonly { id: string; t: number }[];
};
export type CapResult = { hidden: boolean; reason?: string; counted: boolean };
/** Whether a new card is hidden. A check is never dropped by the cap, in any mode but quiet. */
export function capDecision(i: CapInput): CapResult {
  if (i.special) return { hidden: false, counted: false };
  if (i.quiet) return { hidden: true, reason: "quiet", counted: false };
  if (i.kind === "check" || i.badge === "careful" || i.badge === "fix") return { hidden: false, counted: false };
  if (i.forMe || i.badge === "stall" || i.scheduled) return { hidden: false, counted: false };
  const recent = i.shown.filter((s) => i.now - s.t < i.capWindowMs).length;
  if (recent >= i.capMax && !i.priority) return { hidden: true, reason: "cap", counted: false };
  return { hidden: false, counted: true };
}

// ---------------------------------------------------------------- rows
export type CardRow = {
  id: string;
  turnId: string;
  badge: CardBadge;
  question: string;
  say: string;
  facts: string[];
  at: number;
  tipType?: string;
  dim?: boolean;
  priority?: boolean;
  scheduled?: boolean;
  source?: "calc" | "ai";
} & CardV2Extra;

export type OfferMeta = {
  /** The line that caused the card (shown small as "question"). */
  question?: string;
  /** Text the code supplies for BANK and STALL moments (the prepared card), or an override. */
  say?: string;
  facts?: string[];
  ctx?: CtxRecord;
  memV: number;
  /** Where the fact comes from (a card from the notes or a past call says so). */
  src?: CardSrc;
  /** Label fallbacks: the title of the bank card behind the moment, and the call memory's current topic label. */
  bankTitle?: string;
  topic?: string;
  /** Everything the card may quote numbers from: the rendered memory, the raw tail and the prepared cards. */
  allowed?: string;
  /** The prepared stall line, used when a guard rejects the model's text. */
  stall?: { say: string; facts?: string[] };
};
export type Offered =
  { action: "drop"; decision: Decision; why: string } | { action: "show" | "chip"; decision: Decision; row: CardRow; closes: CardRow[]; guarded?: string };

const clip = (s: string | undefined, n: number) => sanitize(String(s ?? "")).slice(0, n);

/** The label of a card: what the model wrote, else the title of the bank card, else the topic of the call memory, else none. The first words of the line are never a label. */
export function pickLabel(o: { label?: string; bankTitle?: string; topic?: string }): string | undefined {
  for (const c of [o.label, o.bankTitle, o.topic]) {
    const l = c ? cleanLabel(c) : "";
    if (l) return l;
  }
  return undefined;
}

/** The guards a v2 card text passes. Only answers are checked: a check, a prompt and a fact quote what was said or the user's own data. */
export function guardAnswer(text: string, allowed: string | undefined): GuardResult {
  const g = guard(text);
  if (!g.ok) return g;
  return guardDigits(text, allowed ?? "");
}

/** The scheduler, the open cards and the feedback state of one call. Pure: `now` is passed in. */
export class CardScheduler {
  private own: SchedulerState;
  private seq = 0;
  private readonly open = new Map<string, { row: CardRow; tag: MomentTag; shownAt: number }>();
  /** Tag of every card that was shown, from any path (open-loop prompts here, direct and observer cards through know()). Feedback finds its tag here. */
  private readonly known = new Map<string, MomentTag>();
  /** The last rating applied per card. tags.jsonl keeps one row per card and is rewritten on every rating, so this makes a replay of the file harmless. */
  private readonly rated = new Map<string, Rating>();
  /** `store`: where the scheduler state lives. The engine passes its one shared state (st.m.sched), so direct, observer and open-loop cards share one per-minute count, one hero and one feedback boost. */
  constructor(
    private readonly cfg: SchedulerConfig = DEFAULT_SCHEDULER,
    now = 0,
    private readonly store?: { get(): SchedulerState; set(s: SchedulerState): void },
    /** Closing of checks (cap, merge, topic, time) lives in a CheckBook the engine shares with its card exit. */
    readonly checks: CheckBook = new CheckBook(),
  ) {
    this.own = newSchedulerState(now);
  }
  get state(): SchedulerState {
    return this.store ? this.store.get() : this.own;
  }
  set state(s: SchedulerState) {
    if (this.store) this.store.set(s);
    else this.own = s;
  }

  /** Time, memory version and model health for the next decision. */
  tick(now: number, memVer: number, offline = false): void {
    this.state = { ...this.state, now, memVer, offline };
  }

  /** The model's moment in, a decision (and the rows to write) out. */
  offer(m: ScheduledMoment, meta: OfferMeta): Offered {
    this.state = { ...this.state, memVer: meta.memV, ...(this.state.learn ? {} : { learn: learnedOffsets() }) };
    const decision = decide(m, this.state, this.cfg);
    if (decision.action === "drop") return { action: "drop", decision, why: decision.reason };
    const kind = KIND_OF_TAG[m.tag];
    if (!kind) return { action: "drop", decision, why: "no-kind" };
    let say = clip(meta.say ?? m.say, 400);
    let facts = (meta.facts ?? m.more).map((x) => clip(x, 200)).filter(Boolean);
    let more = m.more;
    let fit = m.fit;
    // A text that is too long for a card (a memory line from the open-loop path, or a model line the parser did not see) is cut at a clause end; the rest goes into `more`.
    if (meta.say === undefined && m.tag !== "BANK" && m.tag !== "STALL") {
      const f = fitSay(say);
      if (!f.fit) {
        say = f.say;
        fit = false;
        if (f.rest) {
          facts = [clip(f.rest, 200), ...facts].slice(0, 3);
          more = [clip(f.rest, 120), ...more].slice(0, 3);
        }
      }
    }
    let guarded: string | undefined;
    // A prepared card (BANK, STALL) is the user's own text; a model answer is checked. A hit swaps in the stall line, or drops the card.
    if (kind === "answer" && m.tag !== "BANK" && m.tag !== "STALL" && meta.say === undefined) {
      const g = guardAnswer([say, ...facts].join("\n"), meta.allowed);
      if (!g.ok) {
        if (!meta.stall) return { action: "drop", decision, why: `guard:${g.rule}` };
        guarded = g.rule;
        say = clip(meta.stall.say, 400);
        facts = (meta.stall.facts ?? []).map((x) => clip(x, 200));
      }
    }
    if (!say) return { action: "drop", decision, why: "empty" };
    const id = `m${++this.seq}`;
    const label = pickLabel({ label: m.label, bankTitle: meta.bankTitle, topic: meta.topic });
    const prepared = m.tag === "BANK" || m.tag === "STALL";
    const row: CardRow = {
      id,
      turnId: m.turnId !== undefined ? `t${m.turnId}` : (m.source ?? "observer"),
      badge: m.tag === "STALL" || guarded ? "stall" : m.tag === "BANK" ? "bank" : BADGE_OF_KIND[kind],
      question: clip(meta.question, 200),
      say,
      facts,
      at: this.state.now,
      kind,
      value: m.value,
      ...(m.why ? { why: clip(m.why, 120) } : {}),
      ...(more.length && !guarded ? { more: more.map((x) => clip(x, 120)).filter(Boolean) } : {}),
      ...(m.ref ? { ref: m.ref } : {}),
      ...(label ? { label: clip(label, 40) } : {}),
      ...(m.about ? { about: clip(m.about, 60) } : {}),
      ...(m.val ? { val: clip(m.val, 30) } : {}),
      ...(m.conf ? { conf: m.conf } : {}),
      ...(fit === false ? { fit: false } : {}),
      ...(meta.src ? { src: meta.src } : {}),
      ctx: meta.ctx ?? { memV: meta.memV, tokens: 0, parts: {} },
      ...(kind === "prompt" ? { tipType: "ask" } : {}),
      ...(isExempt(m) || prepared ? { priority: true } : {}),
      scheduled: true,
      ...(decision.action === "chip" ? { chip: true } : {}),
    };
    const closes: CardRow[] = [];
    if (decision.action === "show") {
      if (decision.replaces) {
        const c = this.close(decision.replaces, "topic");
        if (c) closes.push(c);
      }
      this.state = recordShown(this.state, m, id, decision);
    }
    this.open.set(id, { row, tag: m.tag, shownAt: this.state.now });
    this.know(id, m.tag);
    return { action: decision.action, decision, row, closes, guarded };
  }

  /** The closing row of a card: its full last version plus `closes`, so a reader that replaces by id keeps the text. */
  close(id: string, closes: CardCloses): CardRow | undefined {
    const o = this.open.get(id);
    if (!o || o.row.closes) return undefined;
    o.row = { ...o.row, closes, at: this.state.now };
    this.state = clearHero(this.state, id);
    return o.row;
  }

  /** Cards older than the topic lifetime close with "time" (not a pinned one, not a check: a check stays until it is dealt with). */
  expire(now: number): CardRow[] {
    const out: CardRow[] = this.checks.expire(now);
    for (const [id, o] of this.open) {
      if (o.row.closes || o.row.pinned || o.row.kind === "check") continue;
      if (now - o.shownAt >= this.cfg.topicLifetimeMs) {
        this.state = { ...this.state, now };
        const c = this.close(id, "time");
        if (c) out.push(c);
      }
    }
    return out;
  }

  /** Memory items that were resolved: the cards that point at them (`ref`) close with "answered". */
  resolved(refs: Iterable<string>): CardRow[] {
    const set = new Set(refs);
    const out: CardRow[] = this.checks.resolved(set, this.state.now);
    for (const [id, o] of this.open) {
      if (o.row.ref && set.has(o.row.ref) && !o.row.closes) {
        const c = this.close(id, "answered");
        if (c) out.push(c);
      }
    }
    return out;
  }

  /** The user dismissed or pinned a card in the overlay (the engine learns it from tags or events). */
  dismissed(id: string): CardRow | undefined {
    this.checks.dismissed(id);
    return this.close(id, "dismissed");
  }
  pin(id: string, on: boolean): void {
    const o = this.open.get(id);
    if (o) o.row = { ...o.row, pinned: on };
  }

  /** For tests: forget the open cards, the known tags and the ratings (a new call). */
  reset(): void {
    this.open.clear();
    this.known.clear();
    this.rated.clear();
    this.checks.reset();
  }
  /** A card was shown by some other path (direct or observer): remember its tag so a rating on it reaches the scheduler. */
  know(id: string, tag: MomentTag): void {
    this.known.set(id, tag);
    if (this.known.size > 500) this.known.delete(this.known.keys().next().value as string);
  }
  tagOf(id: string): MomentTag | undefined {
    return this.known.get(id) ?? this.open.get(id)?.tag;
  }
  /** Ratings of the user. Three "not useful" in a row for one kind raise that kind's minimum VALUE for every path. A rating already applied is skipped; a changed one counts again.
   *  Rows may be the whole tags.jsonl or only the new ones. Returns how many were applied. */
  applyFeedback(rows: readonly { id: string; rating: Rating }[]): number {
    let n = 0;
    for (const r of rows) {
      const tag = this.tagOf(r.id);
      if (!tag || this.rated.get(r.id) === r.rating) continue;
      this.rated.set(r.id, r.rating);
      this.state = recordFeedback(this.state, tag, r.rating, this.cfg);
      n++;
    }
    return n;
  }
  /** The text of tags.jsonl (the whole file each time). */
  feedback(tagsText: string): number {
    return this.applyFeedback(parseTags(tagsText));
  }
  get openCards(): number {
    return [...this.open.values()].filter((o) => !o.row.closes).length + this.checks.open;
  }
  tagBoost(): Readonly<Partial<Record<MomentTag, number>>> {
    return this.state.boost;
  }
  /** Negative ratings (not useful or fewer) per tag, counted once per card, for learn.ts at the end of the call. A card whose rating was changed to useful no longer counts. */
  negatives(): Partial<Record<MomentTag, number>> {
    const out: Partial<Record<MomentTag, number>> = {};
    for (const [id, r] of this.rated) {
      if (r === "useful") continue;
      const tag = this.known.get(id) ?? this.open.get(id)?.tag;
      if (tag) out[tag] = (out[tag] ?? 0) + 1;
    }
    return out;
  }
}

/** tags.jsonl rows: {cardId, rating: "useful"|"not_useful"|"fewer"|"none"} (PLAN) or the older {id, useful: "y"|"n"}. A "fewer" row may also carry useful "n". Junk lines and "none" are skipped. */
export function parseTags(text: string): { id: string; rating: Rating }[] {
  const objs: unknown[] = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      objs.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return normalizeTagRows(objs);
}
/** The same for rows that are already objects (what the engine gets from the reader of tags.jsonl). Rows with no card id or an unknown rating are skipped. */
export function normalizeTagRows(rows: readonly unknown[]): { id: string; rating: Rating }[] {
  const out: { id: string; rating: Rating }[] = [];
  for (const row of rows ?? []) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.cardId === "string" ? r.cardId : typeof r.id === "string" ? r.id : "";
    if (!id) continue;
    const v = typeof r.rating === "string" ? r.rating : typeof r.useful === "string" ? r.useful : "";
    if (v === "fewer") out.push({ id, rating: "fewer" });
    else if (v === "useful" || v === "y") out.push({ id, rating: "useful" });
    else if (v === "not_useful" || v === "not-useful" || v === "n") out.push({ id, rating: "not-useful" });
  }
  return out;
}

// ---------------------------------------------------------------- checks
/** At most this many checks are open at once. A new one closes the oldest. */
export const MAX_OPEN_CHECKS = 3;
/** A check that nobody dealt with closes after this long. */
export const CHECK_LIFETIME_MS = 300_000;
type BookRow = { id: string; badge: string; at: number; kind?: CardKind; ref?: string; closes?: CardCloses; withdraw?: boolean };
export const isCheckRow = (r: { kind?: string; badge: string }) => r.kind === "check" || r.badge === "careful" || r.badge === "fix";

/** The open check cards of a call (every path: model checks, over-promise checks, open-loop checks). Rules: at most 3 open (a new one closes the oldest), a check with the
 *  same `ref` as an open one is merged into it (same card id, newest text), and checks close with the topic, when the memory resolves their item, and after 5 minutes. */
export class CheckBook {
  private readonly rows = new Map<string, { row: BookRow; shownAt: number }>();
  reset(): void {
    this.rows.clear();
  }
  /** Number of open checks. */
  get open(): number {
    return this.rows.size;
  }
  /** A row on its way to the screen. Returns the row to write (its id may be an open check's id) and the closing rows to write first. Rows that are not checks pass through. */
  admit<R extends BookRow>(row: R, now: number): { row: R; closes: R[]; merged?: string } {
    if (!isCheckRow(row)) return { row, closes: [] };
    if (row.closes || row.withdraw) {
      this.rows.delete(row.id);
      return { row, closes: [] };
    }
    const same = this.rows.get(row.id);
    if (same) {
      same.row = row;
      return { row, closes: [] };
    }
    if (row.ref) {
      for (const [id, o] of this.rows)
        if (o.row.ref === row.ref) {
          const merged = { ...row, id };
          this.rows.set(id, { row: merged, shownAt: now });
          return { row: merged, closes: [], merged: id };
        }
    }
    const closes: R[] = [];
    while (this.rows.size >= MAX_OPEN_CHECKS) {
      const [oldId, old] = [...this.rows].sort((a, b) => a[1].shownAt - b[1].shownAt)[0];
      this.rows.delete(oldId);
      closes.push({ ...(old.row as R), closes: "time", at: now });
    }
    this.rows.set(row.id, { row, shownAt: now });
    return { row, closes };
  }
  private closeWhere<R extends BookRow>(pred: (o: { row: BookRow; shownAt: number }) => boolean, why: CardCloses, now: number): R[] {
    const out: R[] = [];
    for (const [id, o] of [...this.rows]) {
      if (!pred(o)) continue;
      this.rows.delete(id);
      out.push({ ...(o.row as R), closes: why, at: now });
    }
    return out;
  }
  /** The topic changed: every open check closes. */
  closeAll<R extends BookRow = CardRow>(why: CardCloses, now: number): R[] {
    return this.closeWhere<R>(() => true, why, now);
  }
  /** Checks older than 5 minutes. */
  expire<R extends BookRow = CardRow>(now: number): R[] {
    return this.closeWhere<R>((o) => now - o.shownAt >= CHECK_LIFETIME_MS, "time", now);
  }
  /** The memory item a check points at was resolved. */
  resolved<R extends BookRow = CardRow>(refs: ReadonlySet<string>, now: number): R[] {
    return this.closeWhere<R>((o) => !!o.row.ref && refs.has(o.row.ref), "answered", now);
  }
  /** The user dismissed this card in the overlay. */
  dismissed(id: string): void {
    this.rows.delete(id);
  }
}

// ---------------------------------------------------------------- the schema test
/** Problems of a row against the v2 contract (empty = fine). A row without any v2 field is a legacy row and passes if its v1 fields are right. */
export function validateRowV2(row: unknown): string[] {
  const bad: string[] = [];
  if (!row || typeof row !== "object") return ["not an object"];
  const r = row as Record<string, unknown>;
  const isStr = (v: unknown) => typeof v === "string";
  if (!isStr(r.id) || !r.id) bad.push("id");
  if (!isStr(r.turnId)) bad.push("turnId");
  if (!isStr(r.badge)) bad.push("badge");
  if (!isStr(r.say)) bad.push("say");
  if (!Array.isArray(r.facts) || r.facts.some((f) => !isStr(f))) bad.push("facts");
  if (typeof r.at !== "number" || !Number.isFinite(r.at)) bad.push("at");
  if (r.kind !== undefined && !["answer", "prompt", "check", "fact"].includes(r.kind as string)) bad.push("kind");
  if (r.value !== undefined && ![0, 1, 2, 3].includes(r.value as number)) bad.push("value");
  if (r.why !== undefined && !isStr(r.why)) bad.push("why");
  if (r.more !== undefined && (!Array.isArray(r.more) || r.more.length > 3 || r.more.some((f) => !isStr(f)))) bad.push("more");
  if (r.ref !== undefined && !isStr(r.ref)) bad.push("ref");
  if (r.closes !== undefined && !["answered", "topic", "time", "dismissed"].includes(r.closes as string)) bad.push("closes");
  if (r.pinned !== undefined && typeof r.pinned !== "boolean") bad.push("pinned");
  if (r.chip !== undefined && typeof r.chip !== "boolean") bad.push("chip");
  if (r.label !== undefined && (!isStr(r.label) || (r.label as string).length > 40)) bad.push("label");
  if (r.about !== undefined && (!isStr(r.about) || (r.about as string).split(/\s+/).length > 8)) bad.push("about");
  if (r.val !== undefined && (!isStr(r.val) || (r.val as string).split(/\s+/).length > 4)) bad.push("val");
  if (r.conf !== undefined && r.conf !== "high" && r.conf !== "low") bad.push("conf");
  if (r.fit !== undefined && typeof r.fit !== "boolean") bad.push("fit");
  if (r.ctx !== undefined) {
    const c = r.ctx as Record<string, unknown> | null;
    if (!c || typeof c !== "object" || typeof c.memV !== "number" || typeof c.tokens !== "number" || !c.parts || typeof c.parts !== "object") bad.push("ctx");
    else if (Object.values(c.parts as object).reduce((a: number, b) => a + (typeof b === "number" ? b : NaN), 0) !== c.tokens) bad.push("ctx.tokens");
  }
  return bad;
}
