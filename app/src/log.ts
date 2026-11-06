// Plain JSONL call log: calls/<ulid>/{events,transcript,cards,latency,usage}.jsonl plus call.json (metadata).
// Written by run.ts; read by the answer window (it tails cards.jsonl and call.json via the calls/latest link),
// the dashboard, the CLI and the summary. Audio is never saved. Files are private to the user (umask 077).
// Delete with `pnpm purge`.
import { mkdirSync, appendFileSync, writeFileSync, rmSync, symlinkSync, readdirSync, statSync, existsSync, lstatSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { CALLS, USER_DATA } from "./env.ts";

/** Cap on rows kept in memory for the rescue copy (about 3 hours of a busy call). */
const MAX_UNSAVED_BYTES = 16 * 1024 * 1024;

process.umask(0o077); // side effect on import: every file this process creates is owner-only

/** The two places rescue() may write, in order. The temp one is shared on Linux and Windows, so it is checked before use (see privateDir). */
export const rescueBases = (): string[] => [join(USER_DATA, "rescue"), join(tmpdir(), "wingman-rescue")];

/** Creates `base` (700) or accepts an existing one only if it is a real folder (not a link) owned by this user; loosens nothing, tightens to 700. Throws otherwise. */
function privateDir(base: string) {
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const st = lstatSync(base);
  if (!st.isDirectory()) throw new Error("not a folder");
  if (process.getuid && st.uid !== process.getuid()) throw new Error("folder belongs to someone else");
  if (process.platform !== "win32" && st.mode & 0o077) chmodSync(base, 0o700);
}

/** One call's folder. The id is a ULID, so folders sort by start time. */
export class CallLog {
  readonly id = ulid();
  readonly dir = join(CALLS, this.id);
  private meta: Record<string, unknown>;
  /** Failed appends so far (disk full, folder removed...). The call keeps running; run.ts shows one amber warning via onWriteFail. */
  writeFailures = 0;
  onWriteFail?: (err: Error, count: number) => void;
  /** Times the folder had vanished and was created again. Rows written before that are gone from disk. */
  recreated = 0;
  /** Rows that could not be written yet (oldest first). They are retried on the next write and, at the end, saved by rescue(). Capped by size. */
  private unsaved: { stream: string; line: string }[] = [];
  private unsavedBytes = 0;
  /** Rows dropped from `unsaved` because it was full. */
  unsavedDropped = 0;
  /** Second path for the answer window: called with every cards row (the exact object written), whether or not the disk write worked. Never throws out. */
  onCardRow?: (row: Record<string, unknown>) => void;
  constructor(meta: Record<string, unknown>) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.meta = { id: this.id, startedAt: new Date().toISOString(), ...meta };
    this.writeMeta();
    // calls/latest -> this call, for the answer window. A symlink to the bare id, so the whole calls/ folder can move.
    const latest = join(CALLS, "latest");
    try {
      rmSync(latest, { force: true });
      symlinkSync(this.id, latest);
    } catch {
      /* best effort */
    }
  }
  private writeMeta() {
    writeFileSync(join(this.dir, "call.json"), JSON.stringify(this.meta, null, 2), { mode: 0o600 });
  }
  /** Merge fields into call.json (e.g. endedAt, and run.ts's phase/liveAt: the answer window polls this file). Whole-file rewrite, best effort. */
  update(fields: Record<string, unknown>) {
    Object.assign(this.meta, fields);
    try {
      this.writeMeta();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          mkdirSync(this.dir, { recursive: true, mode: 0o700 });
          this.recreated++;
          this.writeMeta();
        } catch {
          /* best effort */
        }
      }
    }
  }
  /** Appends one JSON line (with a `t` epoch-ms timestamp) to <stream>.jsonl. Never throws. */
  write(stream: "events" | "transcript" | "cards" | "latency" | "usage" | "live", row: Record<string, unknown>) {
    const full = { t: Date.now(), ...row };
    if (stream === "cards" && this.onCardRow) {
      try {
        this.onCardRow(full);
      } catch {
        /* the pipe is best effort */
      }
    }
    const line = JSON.stringify(full) + "\n";
    // Rows that failed earlier go first, so the file keeps its order when the folder or the space comes back.
    while (this.unsaved.length && !this.tryAppend(this.unsaved[0].stream, this.unsaved[0].line)) {
      this.unsavedBytes -= this.unsaved.shift()!.line.length;
    }
    const err = this.unsaved.length ? new Error("earlier rows are still unsaved") : this.tryAppend(stream, line);
    if (err === undefined) return;
    // Best effort: a full disk or a vanished folder must not end the call.
    this.writeFailures++;
    if (stream !== "live") this.keep(stream, line);
    if (this.writeFailures === 1) {
      try {
        this.onWriteFail?.(err, 1);
      } catch {
        /* never throw from the logger */
      }
    }
  }

  /** One append. A vanished folder is created again and the append retried once. Returns undefined on success, else the error. */
  private tryAppend(stream: string, line: string): Error | undefined {
    const file = join(this.dir, `${stream}.jsonl`);
    try {
      appendFileSync(file, line, { mode: 0o600 });
      return undefined;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return e as Error;
      try {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        this.recreated++;
        try {
          this.writeMeta();
        } catch {
          /* call.json is rewritten on the next update */
        }
        appendFileSync(file, line, { mode: 0o600 });
        return undefined;
      } catch (e2) {
        return e2 as Error;
      }
    }
  }

  private keep(stream: string, line: string) {
    this.unsaved.push({ stream, line });
    this.unsavedBytes += line.length;
    while (this.unsavedBytes > MAX_UNSAVED_BYTES && this.unsaved.length > 1) {
      this.unsavedBytes -= this.unsaved.shift()!.line.length;
      this.unsavedDropped++;
    }
  }

  /** True when this call lost rows on disk (failed writes, or the folder had to be created again). */
  get degraded() {
    return this.writeFailures > 0 || this.recreated > 0;
  }

  /** Saves what the call folder could not hold to a fallback folder (the data dir, then the OS temp dir): the unsaved rows per stream, plus
   *  `transcript.txt` built from the in-memory transcript. Returns the folder, or undefined if nothing could be written anywhere. */
  rescue(transcriptText = ""): string | undefined {
    for (const base of rescueBases()) {
      const dir = join(base, this.id);
      try {
        privateDir(base);
        mkdirSync(dir, { mode: 0o700 }); // fails if it already exists (a planted folder or link), then the next place is tried
        const byStream = new Map<string, string>();
        for (const r of this.unsaved) byStream.set(r.stream, (byStream.get(r.stream) ?? "") + r.line);
        for (const [stream, text] of byStream) writeFileSync(join(dir, `${stream}.unsaved.jsonl`), text, { mode: 0o600 });
        if (transcriptText) writeFileSync(join(dir, "transcript.txt"), transcriptText, { mode: 0o600 });
        writeFileSync(join(dir, "call.json"), JSON.stringify(this.meta, null, 2), { mode: 0o600 });
        return dir;
      } catch {
        /* try the next place */
      }
    }
    return undefined;
  }
}

/** Removes live.jsonl files that a hard exit left behind in older call folders (interim words are not worth keeping). Skips `exceptId` and files touched in the last 2 minutes. Returns how many were removed. */
export function sweepLive(callsDir: string, exceptId: string, now = Date.now()): number {
  let n = 0;
  try {
    for (const d of readdirSync(callsDir)) {
      if (d === exceptId || d === "latest") continue;
      const f = join(callsDir, d, "live.jsonl");
      try {
        if (existsSync(f) && now - statSync(f).mtimeMs > 120_000) {
          rmSync(f, { force: true });
          n++;
        }
      } catch {
        /* next */
      }
    }
  } catch {
    /* no calls folder yet */
  }
  return n;
}
