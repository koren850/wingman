// The single exit for every card (cards.jsonl and the answer window): sanitizing, quiet mode, the per-minute cap, and the latency rows written per question.
import { matchBankFor } from "../bank.ts";
import { isClearQuestion } from "../detector.ts";
import { sanitize } from "../guards.ts";
import { st } from "./state.ts";
import { log, tipGate, S, bank, interview, PROMPT_V } from "./boot.ts";

/** Card kinds. "info"/"warn"/"tip" are system cards; "me" is an answer for the user's own question. */
type Badge = "bank" | "ai" | "stall" | "info" | "warn" | "tip" | "me" | "careful" | "fix";
/** One row of cards.jsonl as the answer window sees it. Same id = update of that card; withdraw = remove it; clear (health only) = remove the bar. */
export type Card = {
  tipType?: string;
  id: string;
  turnId: string;
  badge: Badge;
  question: string;
  say: string;
  facts: string[];
  dim?: boolean;
  at: number;
  health?: boolean;
  level?: "red" | "amber" | "info";
  clear?: boolean;
  withdraw?: boolean;
  forMe?: boolean;
  source?: "calc" | "ai"; // badge "me": an answer for the user (their own question). source "calc" on an "ai" card: local arithmetic, no model
  done?: boolean; // the model finished writing this answer (the answer window stops showing "Writing…")
  priority?: boolean; // "don't commit yet" bank cards (stall-price, stall-guarantee…): never hidden by the per-minute cap
  // Card row v2 (PLAN 3.3): set by the moment engine, whose scheduler already limits the cards per minute (so emitCard's own cap does not apply to them).
  kind?: "answer" | "prompt" | "check" | "fact";
  value?: 0 | 1 | 2 | 3;
  why?: string;
  more?: string[];
  ref?: string;
  ctx?: { memV: number; tokens: number; parts: Record<string, number> };
  pinned?: boolean;
  closes?: "answered" | "topic" | "time" | "dismissed"; // an update row that closes a card
};
/** Writes a side card (fact, note, reminder, client proposal) that is not tied to a question. */
export function emitSide(row: Record<string, unknown>) {
  // Quiet mode: "cards are kept but not shown". Fact, note and reminder cards are kept and flagged like every other card; only system cards (info: the client proposal) show.
  const quiet = st.call.quiet && row.badge !== "info";
  log.write("cards", { type: "card", turnId: "side", question: "", at: Date.now(), ...row, ...(quiet ? { hidden: true, hiddenReason: "quiet" } : {}) });
}
/** Model that answers a turn (set when the request goes out, updated when the fallback takes over). Model cards log it with the prompt id. */
const turnModel = new Map<string, string>();
export const noteModel = (turnId: string, model: string) => void turnModel.set(turnId, model);
const decided = new Map<string, { hidden: boolean; reason?: string }>(); // card id -> was it hidden from the overlay (a card keeps its first decision when it is updated, so it never flips)
const turnsWithCard = new Set<string>();
let lastCardAt = 0,
  shownTimes: { id: string; t: number }[] = [];
/** The single exit for every card. Sanitizes text, decides hidden (quiet mode, or the per-minute cap unless priority), appends to cards.jsonl
 *  (hidden cards are logged too, flagged) and prints to the terminal. Health/info/tip cards are never hidden or counted. */
// "Important cards only" (cards.focus): 2 cards per 2 minutes, and only for clear questions. The detector's weaker cues ("head": a
// question word at the start, over half of all detections in a real call, mostly statements) do not count; price/date cards and cards about
// what the user said are not affected.
const capMax = () => (interview ? 99 : S.cards.focus ? Math.min(2, S.cards.maxPerMinute) : S.cards.maxPerMinute); // an interview: every question gets its card
const capWindow = () => (S.cards.focus && !interview ? 120_000 : S.cards.windowMs);
export function focusWorthy(text: string, reason: string): boolean {
  return isClearQuestion(text, reason) || !!matchBankFor(text, bank)?.card.id.startsWith("stall-");
}
export function emitCard(c: Card) {
  c.say = sanitize(c.say);
  c.facts = c.facts.map(sanitize);
  const special = c.health || c.badge === "info" || c.badge === "tip";
  const forMe = c.badge === "me"; // answers to the user's own questions: hidden in quiet mode, but never counted against (or hidden by) the per-minute cap of cards for the other side
  let hidden = false,
    reason: string | undefined;
  if (c.withdraw) shownTimes = shownTimes.filter((s) => s.id !== c.id);
  if (!special) {
    const prev = decided.get(c.id);
    if (prev) {
      hidden = prev.hidden;
      reason = prev.reason;
    } else {
      const now = Date.now();
      shownTimes = shownTimes.filter((s) => now - s.t < Math.max(S.cards.windowMs, capWindow()));
      if (st.call.quiet) {
        hidden = true;
        reason = "quiet";
      } else if (forMe || c.badge === "careful" || c.badge === "fix" || c.badge === "stall" || c.kind !== undefined) {
        /* no cap, not counted */
      } else if (shownTimes.filter((s) => now - s.t < capWindow()).length >= capMax() && !c.priority) {
        hidden = true;
        reason = "cap";
      } else shownTimes.push({ id: c.id, t: now });
      decided.set(c.id, { hidden, reason });
      if (!turnsWithCard.has(c.turnId)) {
        turnsWithCard.add(c.turnId);
        if (now - lastCardAt < S.cards.lockoutMs) log.write("events", { type: "lockout_would_apply", turnId: c.turnId });
        lastCardAt = now;
      }
    }
  }
  const model = !special && c.source !== "calc" ? turnModel.get(c.turnId) : undefined;
  log.write("cards", { type: "card", ...c, ...(model ? { model, prompt: PROMPT_V } : {}), ...(hidden ? { hidden: true, hiddenReason: reason } : {}) });
  if (c.clear) return;
  if (!hidden && !c.withdraw && (c.badge === "bank" || c.badge === "ai" || c.badge === "stall" || forMe)) tipGate.noteAnswer(Date.now()); // no tip right after an answer card
  if (!hidden && !c.withdraw && (c.badge === "bank" || c.badge === "ai" || c.badge === "stall")) st.cards.lastThemCardAt = Date.now(); // a fresh answer for the other side: answers for the user must not push it off the screen
  const badge = {
    bank: "📗 prepared",
    ai: "🤖 AI",
    stall: "⏸ buy time",
    info: "ℹ️ info",
    warn: "⚠️ HEALTH",
    tip: "💡 tip",
    me: "🙋 for you",
    careful: "🟠 careful",
    fix: "🔴 correction",
  }[c.badge];
  console.log(
    `\n[${badge}${c.dim ? " · dimmed" : ""}${hidden ? ` · HIDDEN (${reason})` : ""}] ${c.say}${c.facts.length ? "\n   • " + c.facts.join("\n   • ") : ""}`,
  );
}

// One row per question; also written to latency.jsonl. Times are epoch ms: speechEnd (when they stopped talking), finalAt, bankAt/stallAt/cardAt, tagAt...
const latRows: Record<string, number | string>[] = [];
export function recordLatency(lat: Record<string, number | string>) {
  latRows.push(lat);
  log.write("latency", lat);
}

/** One-line speed summary: speech end -> first card on screen, bank cards, and Haiku first tag. */
export function speedSummary(): string {
  const pct = (a: number[], p: number) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : NaN;
  };
  const ms = (n: number) => (Number.isFinite(n) ? `${(n / 1000).toFixed(1)}s` : "-");
  const since = (k: string) => latRows.filter((l) => typeof l[k] === "number").map((l) => (l[k] as number) - (l.speechEnd as number));
  const first = latRows
    .map((l) => Math.min(...["bankAt", "stallAt", "cardAt"].map((k) => (typeof l[k] === "number" ? (l[k] as number) : Infinity))) - (l.speechEnd as number))
    .filter(Number.isFinite);
  const bank = since("bankAt"),
    tag = since("tagAt");
  return `Speed: ${latRows.length} questions · first card p50 ${ms(pct(first, 50))} / p95 ${ms(pct(first, 95))} · Prepared cards ${bank.length} (p50 ${ms(pct(bank, 50))}) · Haiku first tag p50 ${ms(pct(tag, 50))}${
    st.me.lat.length
      ? ` · For you ${st.me.lat.length} answers (speech end to card p50 ${ms(
          pct(
            st.me.lat.map((m) => m.total),
            50,
          ),
        )} / p95 ${ms(
          pct(
            st.me.lat.map((m) => m.total),
            95,
          ),
        )}${
          st.me.lat.some((m) => m.source === "calc")
            ? `, math p50 ${ms(
                pct(
                  st.me.lat.filter((m) => m.source === "calc").map((m) => m.total),
                  50,
                ),
              )}`
            : ""
        })`
      : ""
  }`;
}
