// Fits the token estimate factors (src/context/calibration.ts) from saved usage rows and prints the table.
//   tsx scripts/calibrate-tokens.ts [callsDir] [lastNCalls]
// Reads usage.jsonl of the newest calls (default: the app's calls folder, last 20). Needs rows that carry `ctx.chars` and `input_tokens`
// (written by calls made after round 12 r3). Prints the default and the fitted numbers and the drift of both. It writes nothing:
// to use a fitted table, copy its numbers into DEFAULT_CALIBRATION in src/context/calibration.ts (and set fitted: true) in a commit.
import { CALLS } from "../src/env.ts";
import { recentUsageRows } from "../src/cost.ts";
import { fitCalibration, formatCalibration, samplesFromRows } from "../src/context/calibration.ts";

const dir = process.argv[2] || CALLS;
const n = Number(process.argv[3]) || 20;
const samples = samplesFromRows(recentUsageRows(dir, n));
const fit = fitCalibration(samples);
console.log(formatCalibration(samples, fit).join("\n"));
if (fit) console.log("\n" + JSON.stringify(fit, null, 2));
