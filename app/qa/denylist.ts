// The "no real names" check for data the eval tools write or ship: judgement cases, memory-eval calls and the case files that `pnpm replay --to-case` exports.
// The same list as the golden corpus test (src/golden.test.ts), plus the maintainer's private list (WINGMAN_DENYLIST or data/private/denylist.txt, never in the repo),
// plus e-mail addresses and phone numbers.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../src/env.ts";

// Well-known companies a test author might reach for. Personal and client names live only in the private list.
export const DENY_WORDS = [
  "google",
  "microsoft",
  "amazon",
  "facebook",
  "apple inc",
  "paypal",
  "stripe",
  "wix",
  "shopify",
  "monday.com",
  "deepgram",
  "anthropic",
  "openai",
  "wingman-public",
] as const;

function privateWords(env: NodeJS.ProcessEnv): string[] {
  const file = join(ROOT, "data", "private", "denylist.txt");
  return [...(env.WINGMAN_DENYLIST ?? "").split(","), ...(existsSync(file) ? readFileSync(file, "utf8").split("\n") : [])]
    .map((w) => w.trim())
    .filter((w) => w && !w.startsWith("#"));
}

/** What in `text` breaks the rule (empty = clean). Names are matched as lower-case substrings; the private list may hold regular expressions. */
export function denylistHits(text: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const low = text.toLowerCase();
  const hits: string[] = DENY_WORDS.filter((w) => low.includes(w)).map((w) => `name "${w}"`);
  for (const w of privateWords(env)) {
    try {
      if (new RegExp(w, "i").test(text)) hits.push("a word from the private denylist");
    } catch {
      if (low.includes(w.toLowerCase())) hits.push("a word from the private denylist");
    }
  }
  if (/[\w.+-]+@[\w-]+\.\w{2,}/.test(text)) hits.push("an e-mail address");
  if (/\b0\d{1,2}-?\d{7}\b|\+972|\b\d{3}[- ]\d{3}[- ]\d{4}\b/.test(text)) hits.push("a phone number");
  return hits;
}
