// All languages, in the order the detector and guards walk them (Hebrew first: it keeps the old match order).
import type { Language } from "./types.ts";
import { he } from "./he.ts";
import { en } from "./en.ts";

export type { Language, GuardPatterns } from "./types.ts";
export { he, en };
export { EN_SYNTAX } from "./en.ts";
export { SHARED_PRICE, SHARED_DATE, TECH_NOUN, CLAIMABLE } from "./shared.ts";
export const LANGUAGES: readonly Language[] = [he, en];
