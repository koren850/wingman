// Small helpers for the shared context block (block A of buildContext) that need no engine state.
import type { BankCard } from "../bank.ts";

/** The answer bank as "id: title" lines (the index every model call can see; a card's text is not repeated). */
export const bankIndex = (bank: BankCard[]): string => bank.map((c) => `- ${c.id}: ${c.title}`).join("\n");
