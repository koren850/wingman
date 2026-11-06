// Keyword answer bank: prepared cards (the pack's bank.yaml, see pack.ts) matched against what the other side said, with no model call.
// Scoring is by trigger word count; "stall" cards (price / timeline / guarantee) always win so a commitment is never answered
// by a topical card. Used by run.ts (card or hint for the model), doctor.ts and the detector's context. No embeddings in this stage.
import { readFileSync, existsSync } from "node:fs";
import {} from "node:path";
import YAML from "yaml";
import { containsPhrase, phraseWordIndex } from "./normalize.ts";
import { packPath } from "./pack.ts";
import { looksArithmetic } from "./calc.ts";

export type BankCard = {
  id: string;
  title: string;
  triggers: string[];
  say: string;
  facts: string[];
  tags?: string[];
  alts?: string[];
  priority?: number;
  en?: { say: string; facts?: string[]; alts?: string[] };
};
export type BankHit = { card: BankCard; score: number; matched: string[] };

/** Reads and validates the YAML bank. Throws on a card without id/say/triggers or a duplicate id. */
export function loadBank(file = packPath("bank.yaml") ?? ""): BankCard[] {
  if (!file) throw new Error("no bank.yaml in the pack (~/.config/wingman/pack or data/example-pack)");
  const parsed = YAML.parse(readFileSync(file, "utf8")) as BankCard[] | null; // an empty file parses to null: no cards
  const cards = parsed ?? [];
  if (!Array.isArray(cards)) throw new Error("bank.yaml must be a list of cards");
  // YAML turns bare 2024 / 404 / yes into numbers and booleans: ids and triggers are always strings.
  for (const c of cards) {
    if (c && typeof c === "object") {
      if (c.id !== undefined && c.id !== null) c.id = String(c.id);
      if (Array.isArray(c.triggers)) c.triggers = c.triggers.map((t) => String(t));
    }
  }
  // English versions live next to the bank (bank.en.yaml: id -> {say, facts, alts}); a missing file just means no English cards.
  const enFile = file.replace(/\.yaml$/, ".en.yaml");
  if (enFile !== file && existsSync(enFile)) {
    const en = (YAML.parse(readFileSync(enFile, "utf8")) ?? {}) as Record<string, BankCard["en"]>;
    for (const c of cards) if (en[c.id]?.say) c.en = en[c.id];
    englishIds = cards.filter((c) => c.en).map((c) => c.id);
  }
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
/** May the model's tag replace this bank hit? False when a stall-tier hit would be replaced by an ANS or by another card's BANK id. */
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
  const parts = text
    .trim()
    .split(/(?<=[.?!…])\s+/)
    .map((p) => p.trim())
    .filter((p) => p.split(/\s+/).filter(Boolean).length >= 2);
  return parts.length >= 2 ? parts[parts.length - 1] : undefined;
}
/**
 * Words speech-to-text reliably garbles in this domain, spelled the way the bank knows them. The result is appended to the text for
 * matching only: "ואיך מגדירים ss על הדומיין" (SSL cut short), "מה עם קש" (cache heard as a Hebrew word), "האתר גם איתי" (איטי heard as the name איתי,
 * only right after a site word so a person called Itay does not turn into a slow-site hit).
 */
export function sttAliases(text: string): string {
  const extra: string[] = [];
  if (/(^|[\s,.?!])ss(?=$|[\s,.?!])/i.test(text)) extra.push("ssl");
  if (/(^|[\s,.?!])(קש|קאש'?ינג|קאשינג)(?=$|[\s,.?!])/.test(text)) extra.push("cache");
  if (
    /(^|\s)[והבלשכמ]{0,2}(?:אתר|אתרים|דף|חנות|עמוד|נטען)\S*(?:\s+(?:גם|לפעמים|נהיה|נעשה|מאוד|ממש|כל|כך|עכשיו|הרבה|פתאום|שוב|די|קצת)){0,3}\s+(?:ה)?איתי(?=$|[\s,.?!])/.test(
      text,
    )
  )
    extra.push("איטי");
  return extra.length ? `${text} ${extra.join(" ")}` : text;
}

/** matchBank on one piece of text, without the last-sentence rule. Applies sttAliases first. */
// Known limit, left as is on purpose: a pack whose only trigger for a card is one common word ("transfer", "update") matches any question that
// contains it. A higher global minScore would also drop cards whose single trigger is the right one ("ssl", "dns"), and a per-card rule needs a
// topic-word list the pack format does not have. The model's tag still decides: it replies BANK <id> only when the card answers that question.
function matchBankWhole(raw: string, bank: BankCard[], minScore = 1): BankHit | undefined {
  const text = sttAliases(raw);
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
  const inner = (h: BankHit) =>
    STALL_TIER.has(h.card.id) &&
    h.matched.every((m) => hits.some((o) => !STALL_TIER.has(o.card.id) && o.matched.some((om) => om.length > m.length && om.includes(m))));
  let best: BankHit | undefined,
    bestTier = false;
  for (const hit of hits) {
    if (inner(hit)) continue;
    const tier = STALL_TIER.has(hit.card.id);
    if (!best || beats(hit, tier, best, bestTier)) {
      best = hit;
      bestTier = tier;
    }
  }
  return best;
}
/** Ranking: stall tier first, then score, then number of matched triggers, then card priority (file order breaks the rest: the first hit wins ties). */
function beats(a: BankHit, aTier: boolean, b: BankHit, bTier: boolean): boolean {
  if (aTier !== bTier) return aTier;
  if (a.score !== b.score) return a.score > b.score;
  if (a.matched.length !== b.matched.length) return a.matched.length > b.matched.length;
  return (a.card.priority ?? 0) > (b.card.priority ?? 0);
}

/** The stall line, rotating through the card's `alts` so repeated stalls do not look canned. */
export function stallSay(card: BankCard, n: number, lang: "he" | "en" = turnLang): string {
  const en = lang === "en" && card.en;
  const all = en ? [en.say, ...(en.alts ?? [])] : [card.say, ...(card.alts ?? [])];
  return all[Math.abs(n) % all.length];
}

/** "he" when the text has Hebrew letters (a Hebrew question with English terms is Hebrew), "en" when it is Latin only, undefined otherwise. */
export function questionLang(s: string): "he" | "en" | undefined {
  if ((s.match(/[\u0590-\u05ff]/g) ?? []).length >= 2) return "he";
  return (s.match(/[A-Za-z]/g) ?? []).length >= 3 ? "en" : undefined;
}
/**
 * Language of the question being handled. matchBankFor() sets it from the other side's text (English-only = "en", anything with
 * Hebrew = "he"; unclear or very short text keeps the last value), and stallSay() / localizeCard() read it, so run.ts needs no change.
 * A cheap hack that assumes one question is handled at a time; run.ts should eventually pass the language explicitly.
 */
let turnLang: "he" | "en" = "he";
export const getTurnLang = () => turnLang;
export const setTurnLang = (l: "he" | "en") => {
  turnLang = l;
};
/** The card as it should be shown for the current question: English text for an English question, undefined when the card has no English version. */
export function localizeCard(card: BankCard, lang: "he" | "en" = turnLang): BankCard | undefined {
  if (lang !== "en") return card;
  return card.en ? { ...card, say: card.en.say, facts: card.en.facts ?? [], alts: card.en.alts } : undefined;
}
/** Ids of the cards that have an English version (the model is told which BANK ids it may use in an English turn). */
export const englishCardIds = () => englishIds;
let englishIds: string[] = [];

/** The generic "stall" card from the bank, or a built-in fallback line if the bank has none. */
export function stallCard(bank: BankCard[]): BankCard {
  return (
    bank.find((c) => c.id === "stall") ?? {
      id: "stall",
      title: "stall",
      triggers: [],
      facts: [],
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

// ---- price stall: only for a price of the owner's own services ----
/** Words that mean the question is about what the owner sells. */
const SERVICE_WORDS =
  /(אתר|אתרים|אחסון|דומיין|וורדפרס|תחזוקה|חנות|עיצוב|פיתוח|הצעה|שירות|שרת|חבילה|מייל|העברה|שדרוג|בנייה|בניית|קמפיין|wordpress|woocommerce|hosting|domain|website|\bsite\b|maintenance|package|\bplan\b|\bssl\b|cloudflare|migration|retainer|your (service|price|rate)|שלכם|אצלכם)/i;
/** Things whose price has nothing to do with the owner's work. */
const GENERAL_PRICE =
  /(דולר|יורו|אירו|ביטקוין|בנזין|דלק|זהב|קפה|טיסה|טיסות|מלון|אייפון|מניה|מניות|חשמל|\bdollar|\beuro|bitcoin|\bgas\b|petrol|coffee|flight|hotel|iphone|\bstock|share price|exchange rate|שער)/i;
/** How much memory / time / space: "how much" without money. */
const RESOURCE_HOW_MUCH =
  /how much (memory|storage|space|bandwidth|traffic|ram|disk|cpu|time|data|load|power|water|sleep)|כמה (זיכרון|מקום|זמן|נפח|רוחב פס)(?! זה (יעלה|עולה))/i;

/** Why a price/stall-price match should be ignored: arithmetic ("כמה זה 36 ועוד 42") or a price that is not for the owner's services. undefined = it is a real price question. */
export function priceOffTopic(text: string): "arithmetic" | "general" | undefined {
  if (looksArithmetic(text)) return "arithmetic";
  if (SERVICE_WORDS.test(text)) return undefined;
  if (GENERAL_PRICE.test(text) || RESOURCE_HOW_MUCH.test(text)) return "general";
  return undefined;
}

/** matchBank, except that stall-price is dropped when the question is arithmetic or clearly not about a price for the owner's services. */
export function matchBankFor(text: string, bank: BankCard[]): BankHit | undefined {
  const l = questionLang(text);
  if (l && text.trim().split(/\s+/).length >= 3) turnLang = l;
  let hit = matchBank(text, bank);
  if (hit?.card.id === "stall-price" && priceOffTopic(text))
    hit = matchBank(
      text,
      bank.filter((c) => c.id !== "stall-price"),
    );
  if (!hit || turnLang !== "en") return hit;
  const card = localizeCard(hit.card, "en");
  return card ? { ...hit, card } : undefined; // English question and no English card: the model answers (in English) instead of a Hebrew card
}
