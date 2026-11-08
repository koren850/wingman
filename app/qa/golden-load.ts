// Loads the golden meetings. The dev split is free to read. The test split is held out: it loads only with { final: true }
// (pnpm eval --final) and only when its sha256 matches data/meetings/test.lock. Tuning on dev, one final read on test.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { GoldenSchema, type Golden } from "./golden-schema.ts";

const MEETINGS = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "meetings");

/** sha256 over "<file name>\n<file bytes>\n" for each file, sorted by name. The same function builds test.lock. */
export function lockHash(files: { name: string; text: string }[]): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) h.update(f.name + "\n" + f.text + "\n");
  return h.digest("hex");
}
export const readSplitFiles = (split: "dev" | "test", dir = MEETINGS) =>
  readdirSync(join(dir, split))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, split, name), "utf8") }));

/** Throws when the test split does not match test.lock (a meeting was edited after the lock). */
export function checkTestLock(dir = MEETINGS): void {
  const lockFile = join(dir, "test.lock");
  if (!existsSync(lockFile)) throw new Error("data/meetings/test.lock is missing: the test split cannot be trusted");
  const want = readFileSync(lockFile, "utf8").trim();
  const got = lockHash(readSplitFiles("test", dir));
  if (want !== got)
    throw new Error(
      `data/meetings/test.lock does not match the test meetings (lock ${want.slice(0, 12)}, files ${got.slice(0, 12)}). The held-out set was edited.`,
    );
}

export function loadSplit(split: "dev" | "test", opts: { final?: boolean; dir?: string } = {}): Golden[] {
  const dir = opts.dir ?? MEETINGS;
  if (split === "test") {
    if (!opts.final) throw new Error("the test split is held out: read it only with pnpm eval --final");
    checkTestLock(dir);
  }
  return readSplitFiles(split, dir).map((f) => GoldenSchema.parse(JSON.parse(f.text)));
}
