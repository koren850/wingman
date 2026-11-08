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
  type SchedulerConfig,
  type SchedulerState,
} from "../moments/scheduler.ts";
import type { MomentTag } from "../moments/types.ts";
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
};

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
  /** Everything the card may quote numbers from: the rendered memory, the raw tail and the prepared cards. */
  allowed?: string;
  /** The prepared stall line, used when a guard rejects the model's text. */
  stall?: { say: string; facts?: string[] };
};
export type Offered =
  { action: "drop"; decision: Decision; why: string } | { action: "show" | "chip"; decision: Decision; row: CardRow; closes: CardRow[]; guarded?: string };

const clip = (s: string | undefined, n: number) => sanitize(String(s ?? "")).slice(0, n);

/** The guards a v2 card text passes. Only answers are checked: a check, a prompt and a fact quote what was said or the user's own data. */
export function guardAnswer(text: string, allowed: string | undefined): GuardResult {
  const g = guard(text);
  if (!g.ok) return g;
  return guardDigits(text, allowed ?? "");
}

/** The scheduler, the open cards and the feedback state of one call. Pure: `now` is passed in. */
export class CardScheduler {
  state: SchedulerState;
  private seq = 0;
  private readonly open = new Map<string, { row: CardRow; tag: MomentTag; shownAt: number }>();
  private tagsRead = 0;
  constructor(
    private readonly cfg: SchedulerConfig = DEFAULT_SCHEDULER,
    now = 0,
  ) {
    this.state = newSchedulerState(now);
  }

  /** Time, memory version and model health for the next decision. */
  tick(now: number, memVer: number, offline = false): void {
    this.state = { ...this.state, now, memVer, offline };
  }

  /** The model's moment in, a decision (and the rows to write) out. */
  offer(m: ScheduledMoment, meta: OfferMeta): Offered {
    this.state = { ...this.state, memVer: meta.memV };
    const decision = decide(m, this.state, this.cfg);
    if (decision.action === "drop") return { action: "drop", decision, why: decision.reason };
    const kind = KIND_OF_TAG[m.tag];
    if (!kind) return { action: "drop", decision, why: "no-kind" };
    let say = clip(meta.say ?? m.say, 400);
    let facts = (meta.facts ?? m.more).map((x) => clip(x, 200)).filter(Boolean);
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
      ...(m.more.length && !guarded ? { more: m.more.map((x) => clip(x, 120)).filter(Boolean) } : {}),
      ...(m.ref ? { ref: m.ref } : {}),
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
    const out: CardRow[] = [];
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
    const out: CardRow[] = [];
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
    return this.close(id, "dismissed");
  }
  pin(id: string, on: boolean): void {
    const o = this.open.get(id);
    if (o) o.row = { ...o.row, pinned: on };
  }

  /** New rows of tags.jsonl (the whole file text each time; rows already seen are skipped). Three "not useful" in a row for one tag raise its minimum VALUE. */
  feedback(tagsText: string): number {
    const rows = parseTags(tagsText);
    let n = 0;
    for (; this.tagsRead < rows.length; this.tagsRead++) {
      const r = rows[this.tagsRead];
      const o = this.open.get(r.id);
      if (!o) continue;
      this.state = recordFeedback(this.state, o.tag, r.rating, this.cfg);
      n++;
    }
    return n;
  }
  get openCards(): number {
    return [...this.open.values()].filter((o) => !o.row.closes).length;
  }
  tagBoost(): Readonly<Partial<Record<MomentTag, number>>> {
    return this.state.boost;
  }
}

/** tags.jsonl rows: {cardId, rating: "useful"|"not_useful"|"none"} (PLAN) or the older {id, useful: "y"|"n"}. Junk lines and "none" are skipped. */
export function parseTags(text: string): { id: string; rating: "useful" | "not-useful" }[] {
  const out: { id: string; rating: "useful" | "not-useful" }[] = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!r || typeof r !== "object") continue;
    const id = typeof r.cardId === "string" ? r.cardId : typeof r.id === "string" ? r.id : "";
    if (!id) continue;
    const v = typeof r.rating === "string" ? r.rating : typeof r.useful === "string" ? r.useful : "";
    if (v === "useful" || v === "y") out.push({ id, rating: "useful" });
    else if (v === "not_useful" || v === "not-useful" || v === "n") out.push({ id, rating: "not-useful" });
  }
  return out;
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
  if (r.ctx !== undefined) {
    const c = r.ctx as Record<string, unknown> | null;
    if (!c || typeof c !== "object" || typeof c.memV !== "number" || typeof c.tokens !== "number" || !c.parts || typeof c.parts !== "object") bad.push("ctx");
    else if (Object.values(c.parts as object).reduce((a: number, b) => a + (typeof b === "number" ? b : NaN), 0) !== c.tokens) bad.push("ctx.tokens");
  }
  return bad;
}
