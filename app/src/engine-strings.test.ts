// Engine texts follow the UI language. No Hebrew letters in the string literals of src/engine/*.ts: the words live in src/htext.ts (EN and HE)
// and are picked in src/engine/strings.ts. Comments and regular expressions (the language word lists) are not checked.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { HKEYS, ht } from "./htext.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "engine");
const HEBREW = /[֐-׿]/;

/** Hebrew-letter string and template literals of one source file: [line, text]. */
function hebrewLiterals(file: string, src: string): [number, string][] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const out: [number, string][] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      if (HEBREW.test(n.text)) out.push([sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, n.text]);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

test("no Hebrew letters in the string literals of src/engine/*.ts", () => {
  const bad: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts") && !x.endsWith(".test.ts")))
    for (const [line, text] of hebrewLiterals(f, readFileSync(join(dir, f), "utf8"))) bad.push(`${f}:${line} ${text.slice(0, 40)}`);
  assert.deepEqual(bad, [], "move these texts to src/htext.ts and read them through src/engine/strings.ts");
});

test("the scanner sees Hebrew in a string and ignores comments and regular expressions", () => {
  const src = 'const a = "שלום"; // עברית\nconst b = /מה/; const c = `x ${a} שלום`;';
  assert.equal(hebrewLiterals("x.ts", src).length, 2);
});

test("every engine text exists in English and Hebrew and the English has no Hebrew letters", () => {
  for (const k of HKEYS.filter((x) => /^(ask|consent|tip|side|flow)\./.test(x))) {
    const en = ht("en", k, { n: 2, name: "Acme" }),
      he = ht("he", k, { n: 2, name: "Acme" });
    assert.ok(en && he, k);
    assert.ok(!HEBREW.test(en), `${k} (en) has Hebrew letters`);
    assert.ok(HEBREW.test(he), `${k} (he) has no Hebrew letters`);
  }
});
