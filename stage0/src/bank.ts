// Keyword answer bank (no embeddings in Stage 0).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { containsPhrase, phraseWordIndex } from "./normalize.ts";
import { DATA } from "./env.ts";
import { looksArithmetic } from "./calc.ts";

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
  const best = matchBankWhole(text, bank, minScore);
  // A merged turn ("אני רוצה אתר חנות. תגיד לי מחיר מדויק. כמה זה יעלה בשקלים?") is about what it ends with: the LAST sentence
  // outweighs an earlier topic. A stall-tier card (price / timeline / guarantee) already wins on its own, so this only changes topical picks.
  const last = lastSentence(text);
  if (last && !(best && STALL_TIER.has(best.card.id))) {
    const l = matchBankWhole(last, bank, minScore);
    if (l && l.card.id !== best?.card.id) return l;
  }
  return best;
}
/** The final sentence of a multi-sentence turn (sentence ends: . ? ! …), or undefined for a single sentence. */
export function lastSentence(text: string): string | undefined {
  const parts = text.trim().split(/(?<=[.?!…])\s+/).map((p) => p.trim()).filter((p) => p.split(/\s+/).filter(Boolean).length >= 2);
  return parts.length >= 2 ? parts[parts.length - 1] : undefined;
}
function matchBankWhole(text: string, bank: BankCard[], minScore = 1): BankHit | undefined {
  const hits: BankHit[] = [];
  for (const card of bank) {
    if (card.id === "stall") continue;
    const matched = card.triggers.filter((tr) => containsPhrase(text, tr));
    if (!matched.length) continue;
    const words = (m: string) => m.split(/\s+/).length;
    const score = matched.length === 1 ? words(matched[0]) : matched.reduce((s, m) => s + (words(m) === 1 ? 0.5 : words(m)), 0);
    if (score < minScore) continue;
    hits.push({ card, score, matched });
  }
  // A stall-tier match that is only part of a longer topical phrase does not count: "תעודת הבטחה" (STT for "תעודת אבטחה")
  // is an SSL question, not a guarantee.
  const inner = (h: BankHit) => STALL_TIER.has(h.card.id) && h.matched.every((m) =>
    hits.some((o) => !STALL_TIER.has(o.card.id) && o.matched.some((om) => om.length > m.length && om.includes(m))));
  let best: BankHit | undefined, bestTier = false;
  for (const hit of hits) {
    if (inner(hit)) continue;
    const tier = STALL_TIER.has(hit.card.id);
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
      say: "אני רוצה לבדוק את זה כמו שצריך ולחזור עם תשובה מדויקת.",
    }
  );
}

/** Where each matching card's earliest trigger starts (raw word index), one entry per card; used to cut merged questions. */
export function bankStarts(text: string, bank: BankCard[]): { id: string; at: number }[] {
  const out: { id: string; at: number }[] = [];
  for (const card of bank) {
    if (card.id === "stall") continue;
    const at = card.triggers.map((tr) => phraseWordIndex(text, tr)).filter((i) => i >= 0);
    if (at.length) out.push({ id: card.id, at: Math.min(...at) });
  }
  return out;
}


// ---- price stall: only for a price of Dan's services ----
/** Words that mean the question is about what Dan sells. */
const SERVICE_WORDS = /(אתר|אתרים|אחסון|דומיין|וורדפרס|תחזוקה|חנות|עיצוב|פיתוח|הצעה|שירות|שרת|חבילה|מייל|העברה|שדרוג|בנייה|בניית|קמפיין|wordpress|woocommerce|hosting|domain|website|\bsite\b|maintenance|package|\bplan\b|\bssl\b|cloudflare|migration|retainer|your (service|price|rate)|שלכם|אצלכם)/i;
/** Things whose price has nothing to do with Dan's work. */
const GENERAL_PRICE = /(דולר|יורו|אירו|ביטקוין|בנזין|דלק|זהב|קפה|טיסה|טיסות|מלון|אייפון|מניה|מניות|חשמל|\bdollar|\beuro|bitcoin|\bgas\b|petrol|coffee|flight|hotel|iphone|\bstock|share price|exchange rate|שער)/i;
/** How much memory / time / space: "how much" without money. */
const RESOURCE_HOW_MUCH = /how much (memory|storage|space|bandwidth|traffic|ram|disk|cpu|time|data|load|power|water|sleep)|כמה (זיכרון|מקום|זמן|נפח|רוחב פס)(?! זה (יעלה|עולה))/i;

/** Why a price/stall-price match should be ignored: arithmetic ("כמה זה 36 ועוד 42") or a price that is not for Dan's services. undefined = it is a real price question. */
export function priceOffTopic(text: string): "arithmetic" | "general" | undefined {
  if (looksArithmetic(text)) return "arithmetic";
  if (SERVICE_WORDS.test(text)) return undefined;
  if (GENERAL_PRICE.test(text) || RESOURCE_HOW_MUCH.test(text)) return "general";
  return undefined;
}

/** matchBank, except that stall-price is dropped when the question is arithmetic or clearly not about a price for Dan's services. */
export function matchBankFor(text: string, bank: BankCard[]): BankHit | undefined {
  const hit = matchBank(text, bank);
  if (hit?.card.id === "stall-price" && priceOffTopic(text)) return matchBank(text, bank.filter((c) => c.id !== "stall-price"));
  return hit;
}
