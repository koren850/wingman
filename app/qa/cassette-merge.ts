// Merges the per-meeting cassette parts written by scripts/cassette-record.ts into one sorted file, and deletes the parts.
import { unlinkSync } from "node:fs";
import { Cassette } from "../src/providers/cassette.ts";

/** Returns the number of entries in the merged cassette. A key that appears twice keeps the later part. */
export function mergeParts(out: string, parts: string[], pace?: number): number {
  const merged = new Cassette(out);
  if (pace !== undefined) merged.pace = pace;
  for (const p of parts) {
    for (const e of new Cassette(p).entries()) merged.put(e);
    unlinkSync(p);
  }
  merged.save(out);
  return merged.size;
}
