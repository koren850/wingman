// Loads the golden meetings. The dev split is free to read. The test and test-b splits are held out: each loads only with { final: true }
// (pnpm eval --final) and only when its sha256 matches its lock file (data/meetings/test.lock, data/meetings/test-b.lock). Tuning on dev, one final read.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { GoldenSchema, HELD_OUT, type Golden, type Split } from "./golden-schema.ts";

const MEETINGS = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "meetings");

/** sha256 over "<file name>\n<file bytes>\n" for each file, sorted by name. The same function builds test.lock. */
export function lockHash(files: { name: string; text: string }[]): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) h.update(f.name + "\n" + f.text + "\n");
  return h.digest("hex");
}
export const readSplitFiles = (split: Split, dir = MEETINGS) =>
  readdirSync(join(dir, split))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, split, name), "utf8") }));

/** The lock file of a held-out split: test.lock for test, test-b.lock for test-b. */
export const lockFileOf = (split: Split) => `${split}.lock`;

/** Throws when a held-out split does not match its lock file (a meeting was edited, added or removed after the lock). */
export function checkLock(split: Split, dir = MEETINGS): void {
  const lockFile = join(dir, lockFileOf(split));
  if (!existsSync(lockFile)) throw new Error(`data/meetings/${lockFileOf(split)} is missing: the ${split} split cannot be trusted`);
  const want = readFileSync(lockFile, "utf8").trim();
  const got = lockHash(readSplitFiles(split, dir));
  if (want !== got)
    throw new Error(
      `data/meetings/${lockFileOf(split)} does not match the ${split} meetings (lock ${want.slice(0, 12)}, files ${got.slice(0, 12)}). The held-out set was edited.`,
    );
}
/** Kept for the old callers: the lock of the test split. */
export const checkTestLock = (dir = MEETINGS) => checkLock("test", dir);

export function loadSplit(split: Split, opts: { final?: boolean; dir?: string } = {}): Golden[] {
  const dir = opts.dir ?? MEETINGS;
  if (HELD_OUT.includes(split)) {
    if (!opts.final) throw new Error(`the ${split} split is held out: read it only with pnpm eval --final`);
    checkLock(split, dir);
  }
  return readSplitFiles(split, dir).map((f) => GoldenSchema.parse(JSON.parse(f.text)));
}

/** What `pnpm eval --final` reads: the test split, then the test-b split, each behind its own lock file. Throws on the first lock that does not match. */
export function loadFinalSplits(dir?: string): Golden[] {
  return [...loadSplit("test", { final: true, dir }), ...loadSplit("test-b", { final: true, dir })];
}
