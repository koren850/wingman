// Precision/recall of the Hebrew question detector on data/questions.tsv (pass/fail gate below). pnpm detector.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detect } from "./detector.ts";
import { DATA } from "./env.ts";

const rows = readFileSync(join(DATA, "questions.tsv"), "utf8").split("\n").filter((l) => l.trim()).map((l) => {
  const [text, label] = l.split("\t");
  return { text, label: label?.trim() };
}).filter((r) => r.label === "Q" || r.label === "N");

let tp = 0, fp = 0, fn = 0, tn = 0;
const misses: string[] = [];
for (const r of rows) {
  const d = detect(r.text);
  if (d.isQuestion && r.label === "Q") tp++;
  else if (d.isQuestion && r.label === "N") { fp++; misses.push(`FP  ${r.text}   (${d.reason})`); }
  else if (!d.isQuestion && r.label === "Q") { fn++; misses.push(`FN  ${r.text}   (${d.reason})`); }
  else tn++;
}
const precision = tp / (tp + fp || 1), recall = tp / (tp + fn || 1);
console.log(`lines ${rows.length}  TP ${tp} FP ${fp} FN ${fn} TN ${tn}`);
console.log(`precision ${(precision * 100).toFixed(0)}%  recall ${(recall * 100).toFixed(0)}%`);
if (misses.length) console.log("\n" + misses.join("\n"));
// Recall matters more (Haiku SKIP filters false positives). Gate: recall >= 90%, precision >= 70%.
process.exitCode = recall >= 0.9 && precision >= 0.7 ? 0 : 1;
