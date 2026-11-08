// Call frame: the small shape the older parts of the app (tips, summary, shutdown) still read. Since round 12 (r3) it has NO model call of its own:
// the call memory (src/session/types.ts SessionMemory) is the one place that learns what a call is about, and the kind list lives there too.
// What stays here is pure: the Frame type, the parser for frames in old call folders, the stability rules, the agency-topic check and the text helpers.
//   - kind uses hysteresis in FrameTracker: it only changes after two consecutive updates agree on the new kind.
//   - the checklist keeps its text, `done` only goes false -> true, and at most one new item is added per update.
import { userName } from "./profile.ts";
import { loadTopics } from "./pack.ts";
import { KINDS, type MemoryKind } from "./session/types.ts";

/** The call kinds. The list itself is in session/types.ts (KINDS); this is only the old name of the type. */
export type Kind = MemoryKind;
export type ChecklistItem = { item: string; done: boolean; must: boolean };
export type Frame = { kind: Kind; topic: string; goal: string; people: { who: string; role: string }[]; entities: string[]; checklist: ChecklistItem[] };

/** Kinds where the agency answer bank is the right source. Everything else treats keyword bank hits as weak. */
export const AGENCY_KINDS: ReadonlySet<string> = new Set(["client", "support"]);
export const KIND_HE: Record<Kind, string> = {
  client: "לקוח",
  support: "תמיכה",
  vendor: "ספק",
  team: "צוות",
  consult: "ייעוץ",
  personal: "אישית",
  interview: "ראיון",
  other: "אחר",
};
export const KIND_EN: Record<Kind, string> = {
  client: "Client",
  support: "Support",
  vendor: "Vendor",
  team: "Team",
  consult: "Consulting",
  personal: "Personal",
  interview: "Interview",
  other: "Other",
};
/** Name of a call kind in the UI language (unknown language = Hebrew). */
export const kindLabel = (k: Kind, lang?: "he" | "en"): string => (lang === "en" ? KIND_EN : KIND_HE)[k];
/** Cap on checklist items kept in a frame. */
export const MAX_ITEMS = 10;

// Model output is untrusted: strip bidi overrides, control chars and markdown characters, collapse spaces, cap length.
const str = (x: unknown, max: number): string =>
  (typeof x === "string" || typeof x === "number" ? String(x) : "")
    .replace(/[‪-‮]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[*_#`>]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
// Light normalization for checklist comparison only (not the matching normalize() from normalize.ts).
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\s.,!?;:"'()־׳״-]+/g, " ")
    .trim();
const words = (s: string) =>
  new Set(
    norm(s)
      .split(" ")
      .filter((w) => w.length > 1),
  );
/** Same checklist item? Equal after normalising, or at least 70% word overlap. */
export function sameItem(a: string, b: string): boolean {
  const x = norm(a),
    y = norm(b);
  if (x === y) return true;
  const wa = words(a),
    wb = words(b);
  if (!wa.size || !wb.size) return false;
  const common = [...wa].filter((w) => wb.has(w)).length;
  return common / Math.min(wa.size, wb.size) >= 0.7;
}

/** Defensive parse of the model answer (object, JSON text, or prose / ``` fences around the JSON). Unknown kind becomes "other"; undefined when nothing usable is in it. */
export function parseFrame(input: unknown): Frame | undefined {
  let parsed: unknown = input;
  if (typeof input === "string") {
    const t = input.replace(/```(?:json)?/gi, ""),
      a = t.indexOf("{"),
      b = t.lastIndexOf("}");
    if (a < 0 || b <= a) return undefined;
    try {
      parsed = JSON.parse(t.slice(a, b + 1));
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const o = parsed as Record<string, unknown>;
  const kindRaw = str(o.kind, 20).toLowerCase();
  const kind: Kind = (KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as Kind) : "other";
  const people = (Array.isArray(o.people) ? o.people : [])
    .flatMap((p: { who?: unknown; role?: unknown } | string | null) => {
      const who = str((p as { who?: unknown } | null)?.who ?? p, 40),
        role = str((p as { role?: unknown } | null)?.role, 40);
      return who ? [{ who, role }] : [];
    })
    .slice(0, 6);
  const entities = (Array.isArray(o.entities) ? o.entities : [])
    .map((e: unknown) => str(e, 40))
    .filter(Boolean)
    .slice(0, 10);
  const checklist: ChecklistItem[] = [];
  for (const c of Array.isArray(o.checklist) ? o.checklist : []) {
    const item = str(typeof c === "string" ? c : c?.item, 80);
    if (!item || checklist.some((k) => sameItem(k.item, item))) continue;
    checklist.push({ item, done: typeof c === "object" && c?.done === true, must: typeof c === "object" ? c?.must !== false : true });
  }
  const f: Frame = { kind, topic: str(o.topic, 80), goal: str(o.goal, 120), people, entities, checklist: checklist.slice(0, MAX_ITEMS) };
  return f.topic || f.goal || f.checklist.length || f.kind !== "other" ? f : undefined;
}

/** Holds the frame of a running call and applies the stability rules to every model update. */
export class FrameTracker {
  current?: Frame;
  private pending?: { kind: Kind; n: number };
  /** How many consecutive updates must agree before the kind changes. */
  constructor(private flipAfter = 2) {}

  /** Merge a fresh model frame. Returns the new current frame, and whether anything visible changed. */
  apply(next: Frame): { frame: Frame; changed: boolean } {
    const before = JSON.stringify(this.current ?? null);
    if (!this.current) {
      this.current = { ...next, checklist: next.checklist.slice(0, MAX_ITEMS) };
      return { frame: this.current, changed: true };
    }
    const cur = this.current;
    // kind: hysteresis
    let kind = cur.kind;
    if (next.kind !== cur.kind) {
      if (this.pending?.kind === next.kind) this.pending.n++;
      else this.pending = { kind: next.kind, n: 1 };
      if (this.pending.n >= this.flipAfter || cur.kind === "other") {
        kind = next.kind;
        this.pending = undefined;
      } // "other" = not known yet: no need to wait
    } else this.pending = undefined;
    // checklist: stable text, done only goes up, at most one new item per update
    const checklist = !cur.checklist.length
      ? next.checklist.slice(0, MAX_ITEMS)
      : cur.checklist.map((c) => ({ ...c, done: c.done || next.checklist.some((n) => n.done && sameItem(n.item, c.item)) }));
    const fresh = cur.checklist.length ? next.checklist.find((n) => !checklist.some((c) => sameItem(c.item, n.item))) : undefined;
    if (fresh && checklist.length < MAX_ITEMS) checklist.push(fresh);
    const merged: Frame = {
      kind,
      topic: next.topic || cur.topic,
      goal: next.goal || cur.goal,
      people: mergeBy(cur.people, next.people, (p) => p.who, 6),
      entities: [...new Set([...cur.entities, ...next.entities])].slice(0, 10),
      checklist,
    };
    this.current = merged;
    return { frame: merged, changed: JSON.stringify(merged) !== before };
  }
  /** The kind the rest of the app may rely on (set after the first update; flips only after hysteresis). */
  get kind(): Kind | undefined {
    return this.current?.kind;
  }
}
function mergeBy<T>(a: T[], b: T[], key: (x: T) => string, max: number): T[] {
  const out = [...a];
  for (const x of b) if (!out.some((y) => key(y).toLowerCase() === key(x).toLowerCase())) out.push(x);
  return out.slice(0, max);
}

/**
 * The question is really about the user's own services (so the business bank and the price stall may apply even on a call that is not with their customer).
 * The words come from the pack's topics.txt (src/pack.ts). On a supplier or team call the general words are the subject of the whole call, not a sign that
 * someone is asking the user about THEIR services: only the unmistakable [strict] terms count there. Without this a supplier call about hosting contracts
 * kept pulling in the business bank and the price stall for every line.
 */
const STRICT_KINDS: ReadonlySet<string> = new Set(["vendor", "team"]);
/** Does the text talk about the user's own services (pack topics.txt)? Stricter word list on vendor/team calls. */
export const isAgencyTopic = (text: string, kind?: string): boolean => {
  const t = loadTopics();
  return !!(kind && STRICT_KINDS.has(kind) ? t.strict : t.loose)?.test(String(text ?? ""));
};
/** True for client/support calls, and when the kind is not known yet (so the agency bank stays on until a frame says otherwise). */
export const isAgencyKind = (k: string | undefined): boolean => !k || AGENCY_KINDS.has(k);
/** "6/8": how many checklist items are done. */
export const progress = (f: Frame | undefined): { done: number; total: number } => ({
  done: f?.checklist.filter((c) => c.done).length ?? 0,
  total: f?.checklist.length ?? 0,
});
/** Must-cover checklist items still not done. */
export const missedMust = (f: Frame | undefined): ChecklistItem[] => (f?.checklist ?? []).filter((c) => c.must && !c.done);

/** One compact paragraph for the reflex / tips / summary prompts. */
export function frameText(f: Frame | undefined): string {
  if (!f) return "";
  const open = f.checklist.filter((c) => !c.done).map((c) => c.item);
  return [
    `Kind: ${f.kind}`,
    f.topic && `Topic: ${f.topic}`,
    f.goal && `${userName()}'s goal: ${f.goal}`,
    f.people.length && `People: ${f.people.map((p) => `${p.who}${p.role ? ` (${p.role})` : ""}`).join("; ")}`,
    f.entities.length && `Named: ${f.entities.join(", ")}`,
    open.length && `Not covered yet: ${open.join("; ")}`,
  ]
    .filter(Boolean)
    .join("\n");
}
