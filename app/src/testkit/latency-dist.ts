// A committed model-delay distribution (qa/latency-dist.json) for the latency tests, so the p95 budget is not set by delays the test itself picked.
// The samples are STRATIFIED, not random: sample i of n sits at quantile (i + 0.5) / n, so the sample p50 and p95 land on the file's p50 and p95 for any n.
// The file is ASSUMED until a recorded run replaces it with recorded timings; every test that uses it says so in its output.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type LatencyDist = { v: 1; basis: "assumed" | "recorded"; about: string; quantiles: [number, number][] };
const FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "qa", "latency-dist.json");
export const readLatencyDist = (file = FILE): LatencyDist => JSON.parse(readFileSync(file, "utf8")) as LatencyDist;

/** The delay at quantile q (0..1), linear between the points of the file. */
export function delayAt(d: LatencyDist, q: number): number {
  const xs = d.quantiles;
  if (q <= xs[0][0]) return xs[0][1];
  for (let i = 1; i < xs.length; i++) {
    const [q1, v1] = xs[i];
    if (q <= q1) {
      const [q0, v0] = xs[i - 1];
      return Math.round(v0 + ((v1 - v0) * (q - q0)) / (q1 - q0 || 1));
    }
  }
  return xs[xs.length - 1][1];
}
/** n stratified delays, in a fixed shuffled order (so slow and fast ones alternate like real traffic). */
export function stratified(d: LatencyDist, n: number): number[] {
  const out = Array.from({ length: n }, (_, i) => delayAt(d, (i + 0.5) / n));
  const order = Array.from({ length: n }, (_, i) => (i * 7919) % n); // 7919 is prime: a permutation when n is not a multiple of it
  return new Set(order).size === n ? order.map((i) => out[i]) : out;
}
