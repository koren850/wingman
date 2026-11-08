// A cheap local score for a short line: is it worth a look by the observer even though no hint fired? It uses the shape of the line (TurnFeatures), the
// character 3-grams of the user's own prepared cards (bank-score.ts) and of the objections raised earlier in this call (the call memory). There is no word
// list: an "objection-like" line is one that shares most of its 3-grams with a card the user wrote, or with an objection that is still open. A line with a
// figure, or one that says the user's name, also counts. The score only decides WHEN the model looks; the model decides whether anything is shown.
import { grams, topCandidates } from "../bank-score.ts";
import type { BankCard } from "../bank.ts";
import type { TurnFeatures } from "./intake.ts";

export type Cue = "figure" | "objection" | "repeat" | "named";
/** Share of the line's (idf weighted) 3-grams that one card holds. The exact-match scorer needs 0.42 and a lead over the next card; a cue needs 0.55 because it has no lead test. */
export const CUE_COVERAGE = 0.55;
/** Share of 3-grams two lines have in common (Jaccard) for "the same objection again". */
export const CUE_REPEAT = 0.45;
const MIN_GRAMS = 8;

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const g of a) if (b.has(g)) both++;
  return both / (a.size + b.size - both);
}

export type CueCtx = {
  /** The user's name was said in this line. */
  named?: boolean;
  /** Texts of objections raised earlier in the call that are still open (call memory). */
  openObjections?: readonly string[];
};

/** The reason this line deserves a look, or undefined. Pure. Only lines from the other side have a cue. */
export function localCue(text: string, f: TurnFeatures, bank: BankCard[], ctx: CueCtx = {}): Cue | undefined {
  if (f.side !== "them") return undefined;
  if (f.hasDigits || f.hasCurrency) return "figure";
  if (ctx.named && f.words >= 1) return "named";
  const g = grams(text);
  if (g.length >= MIN_GRAMS) {
    const top = topCandidates(text, 1, bank)[0];
    if (top && top.coverage >= CUE_COVERAGE) return "objection";
    const mine = new Set(g);
    if (ctx.openObjections?.some((o) => jaccard(mine, new Set(grams(o))) >= CUE_REPEAT)) return "repeat";
  }
  return undefined;
}
