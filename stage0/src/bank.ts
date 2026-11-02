// Keyword answer bank (no embeddings in Stage 0).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { containsPhrase } from "./normalize.ts";
import { DATA } from "./env.ts";

export type BankCard = { id: string; title: string; triggers: string[]; say: string; facts: string[]; tags?: string[]; alts?: string[]; priority?: number };
export type BankHit = { card: BankCard; score: number; matched: string[] };

export function loadBank(file = join(DATA, "bank.yaml")): BankCard[] {
  const cards = YAML.parse(readFileSync(file, "utf8")) as BankCard[];
  const ids = new Set<string>();
  for (const c of cards) {
    if (!c.id || !c.say || !Array.isArray(c.triggers)) throw new Error(`bad bank card: ${JSON.stringify(c).slice(0, 80)}`);
    if (ids.has(c.id)) throw new Error(`duplicate bank id ${c.id}`);
    ids.add(c.id);
  }
  return cards;
}

/** Stall cards that always win when they match: a price, timeline or guarantee must never get a topical answer instead. */
export const STALL_TIER = new Set(["stall-price", "stall-timeline", "stall-guarantee"]);

/**
 * A price/timeline/guarantee bank hit is authoritative: the model may not replace it with an answer or a topical card.
 * (It may still say STALL, or SKIP a weak hit.) Found by the synthetic QA: Haiku answered an English price question with ANS.
 */
export function modelMayOverrideBank(hitId: string | undefined, tag: { kind: string; bankId?: string }): boolean {
  if (!hitId || !STALL_TIER.has(hitId)) return true;
  if (tag.kind === "ANS") return false;
  if (tag.kind === "BANK" && tag.bankId !== hitId) return false;
  return true;
}

/**
 * Best keyword match. Multi-word triggers score their word count; a single-word trigger scores 0.5 unless it is the
 * card's only match (then 1). Stall-tier cards beat everything. Ties: more distinct triggers, then card priority, then file order.
 */
export function matchBank(text: string, bank: BankCard[], minScore = 1): BankHit | undefined {
  let best: BankHit | undefined, bestTier = false;
  for (const card of bank) {
    if (card.id === "stall") continue;
    const matched = card.triggers.filter((tr) => containsPhrase(text, tr));
    if (!matched.length) continue;
    const words = (m: string) => m.split(/\s+/).length;
    const score = matched.length === 1 ? words(matched[0]) : matched.reduce((s, m) => s + (words(m) === 1 ? 0.5 : words(m)), 0);
    if (score < minScore) continue;
    const tier = STALL_TIER.has(card.id);
    const hit: BankHit = { card, score, matched };
    if (!best || beats(hit, tier, best, bestTier)) { best = hit; bestTier = tier; }
  }
  return best;
}
function beats(a: BankHit, aTier: boolean, b: BankHit, bTier: boolean): boolean {
  if (aTier !== bTier) return aTier;
  if (a.score !== b.score) return a.score > b.score;
  if (a.matched.length !== b.matched.length) return a.matched.length > b.matched.length;
  return (a.card.priority ?? 0) > (b.card.priority ?? 0);
}

/** The stall line, rotating through the card's `alts` so repeated stalls do not look canned. */
export function stallSay(card: BankCard, n: number): string {
  const all = [card.say, ...(card.alts ?? [])];
  return all[Math.abs(n) % all.length];
}

export function stallCard(bank: BankCard[]): BankCard {
  return (
    bank.find((c) => c.id === "stall") ?? {
      id: "stall", title: "stall", triggers: [], facts: [],
      say: "שאלה טובה, אני רוצה לבדוק את זה כמו שצריך ולחזור עם תשובה מדויקת.",
    }
  );
}
