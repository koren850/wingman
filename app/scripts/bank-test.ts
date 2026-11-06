// Bank top-1 accuracy on held-out utterances (NOT copied from the card triggers). pnpm banktest
// Gate: at least 75% right and at most 5% wrong-card (a wrong card is worse than none). Exit code 1 if missed.
// right = expected card id; wrong = a different card; miss = no card (expected "-" means no card is correct).
import { loadBank, matchBank } from "../src/bank.ts";
import { BANK_CASES as CASES } from "../src/bank-cases.ts";

const bank = loadBank();
let right = 0,
  wrong = 0,
  miss = 0;
const lines: string[] = [];
for (const [text, want] of CASES) {
  const got = matchBank(text, bank)?.card.id ?? "-";
  if (got === want) right++;
  else if (got === "-") {
    miss++;
    lines.push(`MISS   want ${want}   ${text}`);
  } else {
    wrong++;
    lines.push(`WRONG  want ${want} got ${got}   ${text}`);
  }
}
const n = CASES.length;
console.log(
  `bank top-1: ${right}/${n} right (${((100 * right) / n).toFixed(0)}%), ${wrong} wrong-card (${((100 * wrong) / n).toFixed(0)}%), ${miss} no card (${((100 * miss) / n).toFixed(0)}%)`,
);
if (lines.length) console.log("\n" + lines.join("\n"));
process.exitCode = right / n >= 0.75 && wrong / n <= 0.05 ? 0 : 1;
