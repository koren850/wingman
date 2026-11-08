// Round 12 guard: no NEW Hebrew or English word list (a list of words as an array, a Set, or a regex with many alternatives) outside src/lang/.
// Word lists were the owner's concern: the model decides meaning now, and the legacy lists stay only as an offline hint.
// Existing lists are counted per file in LEGACY below. A file may not get more lists than its number. When a list is removed, lower the number.
// To add words for a new language, put them in src/lang/. Do not raise a number to make this test pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(import.meta.dirname);

/** A word-like string: letters (Hebrew or Latin), apostrophe, hyphen, spaces; at most 4 words. */
const WORDLIKE = /^[\p{L}][\p{L}'’\- ]{0,40}$/u;
const MIN_ARRAY = 5;
const MIN_ALT = 5;

/** Counts word lists in source text: string arrays/Sets of 5+ word-like strings, and regex literals or RegExp strings with 5+ word alternatives. */
export function countWordLists(code: string): number {
  let n = 0;
  // Array or Set literal of plain strings: ["a", "b", ...] (a string on one line, no template holes).
  for (const m of code.matchAll(/\[\s*((?:(?:"[^"\n]*"|'[^'\n]*')\s*,\s*){4,}(?:"[^"\n]*"|'[^'\n]*')\s*,?\s*)\]/g)) {
    const items = [...m[1].matchAll(/"([^"\n]*)"|'([^'\n]*)'/g)].map((x) => x[1] ?? x[2]);
    if (items.length >= MIN_ARRAY && items.filter((s) => WORDLIKE.test(s)).length >= MIN_ARRAY) n++;
  }
  // Regex literal or "a|b|c" string with many alternatives that are words.
  for (const m of code.matchAll(/(?:\/(?![/*])((?:\\.|[^/\n\\])+)\/[a-z]*|"((?:\\.|[^"\n\\])*)"|'((?:\\.|[^'\n\\])*)')/g)) {
    const body = m[1] ?? m[2] ?? m[3] ?? "";
    if (!body.includes("|")) continue;
    // the biggest group of alternatives: take each "(...|...)" or the whole body
    const groups = [...body.matchAll(/\(\??:?([^()]*\|[^()]*)\)/g)].map((g) => g[1]);
    groups.push(body);
    const best = Math.max(
      ...groups.map((g) => g.split("|").filter((a) => WORDLIKE.test(a.replace(/\\s\+?/g, " ").replace(/[?\\]/g, "")) && a.length > 1).length),
    );
    if (best >= MIN_ALT) n++;
  }
  // A long string of words cut with .split(" "): "a b c d e f g h".split(" ")
  for (const m of code.matchAll(/(?:"([^"\n]*)"|'([^'\n]*)')\s*\.split\(\s*(?:" "|' ')/g)) {
    const words = (m[1] ?? m[2]).split(" ").filter((w) => WORDLIKE.test(w));
    if (words.length >= 8) n++;
  }
  return n;
}

function files(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      if (f === "node_modules" || f === "lang" || f === "e2e") continue;
      files(p, out);
    } else if (/\.(ts|cjs)$/.test(f) && !/\.test\.ts$/.test(f)) out.push(p);
  }
  return out;
}

/** Legacy files that already hold word lists (a few are only enums of identifiers, such as settings values), with how many. Do not raise a number. */
const LEGACY: Record<string, number> = {
  "assist.ts": 8,
  "bank-cases.ts": 1,
  "bank.ts": 4,
  "brief.ts": 1,
  "calc.ts": 9,
  "calllang.ts": 1,
  "capture.ts": 1,
  "claims.ts": 2,
  "context/budget.ts": 1,
  "context/build.ts": 3,
  "cost.ts": 1,
  "detector.ts": 9,
  "devices.ts": 1,
  "diagnose.ts": 6,
  "echo.ts": 1,
  "engine/ingest.ts": 1,
  "engine/question.ts": 1,
  "entities.ts": 3,
  "frame.ts": 2,
  "langwatch.ts": 1,
  "moments/parse.ts": 2,
  "moments/types.ts": 1,
  "normalize.ts": 2,
  "phone.ts": 1,
  "profile-edit-cli.ts": 1,
  "providers/errors.ts": 2,
  "providers/scripted.ts": 2,
  "reflex.ts": 2,
  "selfcheck.ts": 2,
  "session/ask.ts": 1,
  "session/patch.ts": 4,
  "session/prompt.ts": 1,
  "session/render.ts": 2,
  "session/types.ts": 2,
  "session/useredit.ts": 2,
  "settings.ts": 2,
  "speakers.ts": 4,
  "summary.ts": 3,
  "tips.ts": 3,
};

test("word-list scanner: finds lists and ignores ordinary code", () => {
  assert.equal(countWordLists(`const A = ["how", "what", "when", "why", "can", "do"];`), 1);
  assert.equal(countWordLists(`const R = /\\b(price|cost|quote|budget|invoice|refund)\\b/i;`), 1);
  assert.equal(countWordLists(`const A = new Set(["כמה", "מתי", "איך", "למה", "מה"]);`), 1);
  assert.equal(countWordLists(`const R = new RegExp("(price|cost|quote|budget|invoice)");`), 1);
  assert.equal(countWordLists(`const KINDS = ["a1", "b/2", "c.3", "d4", "e5"]; const x = [1, 2, 3, 4, 5];`), 0);
  assert.equal(countWordLists(`const R = /^(auth|quota)$/; const S = ["one", "two"];`), 0);
  assert.equal(countWordLists(`const W = "the and is are was were you your to of".split(" ");`), 1);
  assert.equal(countWordLists(`const P = "a b c".split(" ");`), 0);
  assert.equal(countWordLists(`const URL_RE = /https?:\\/\\/\\S+/;`), 0);
});

test("no new word list outside src/lang/ (legacy files are counted)", () => {
  const found: Record<string, number> = {};
  for (const f of files(SRC)) {
    const n = countWordLists(readFileSync(f, "utf8"));
    if (n) found[relative(SRC, f).split(sep).join("/")] = n;
  }
  const bad = Object.entries(found).filter(([f, n]) => n > (LEGACY[f] ?? 0));
  assert.deepEqual(bad, [], "new word list outside src/lang/ (put words in src/lang/, or remove the list). Found: " + JSON.stringify(found));
  const stale = Object.entries(LEGACY).filter(([f, n]) => (found[f] ?? 0) < n);
  assert.deepEqual(stale, [], "a legacy list was removed: lower its number in LEGACY");
});

test("negative: a file with a new word list is flagged", () => {
  const added = `// new\nexport const GREETINGS = ["hello", "hi", "hey", "welcome", "greetings"];\n`;
  assert.ok(countWordLists(added) > (LEGACY["new-file.ts"] ?? 0));
  const addedRe = `export const Q = /(מה|איך|כמה|למה|מתי|איפה)/u;`;
  assert.ok(countWordLists(addedRe) >= 1);
});
