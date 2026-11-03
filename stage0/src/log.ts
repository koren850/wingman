// Plain JSONL call log: calls/<ulid>/{events,transcript,cards,latency,usage}.jsonl plus call.json (metadata).
// Written by run.ts; read by the answer window (it tails cards.jsonl and call.json via the calls/latest link),
// the dashboard, the CLI and the summary. Audio is never saved. Files are private to the user (umask 077).
// Delete with `pnpm purge`.
import { mkdirSync, appendFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";
import { CALLS } from "./env.ts";

process.umask(0o077);   // side effect on import: every file this process creates is owner-only

/** One call's folder. The id is a ULID, so folders sort by start time. */
export class CallLog {
  readonly id = ulid();
  readonly dir = join(CALLS, this.id);
  private meta: Record<string, unknown>;
  /** Failed appends so far (disk full, folder removed...). The call keeps running; run.ts shows one amber warning via onWriteFail. */
  writeFailures = 0;
  onWriteFail?: (err: Error, count: number) => void;
  constructor(meta: Record<string, unknown>) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.meta = { id: this.id, startedAt: new Date().toISOString(), ...meta };
    this.writeMeta();
    // calls/latest -> this call, for the answer window. A symlink to the bare id, so the whole calls/ folder can move.
    const latest = join(CALLS, "latest");
    try { rmSync(latest, { force: true }); symlinkSync(this.id, latest); } catch { /* best effort */ }
  }
  private writeMeta() { writeFileSync(join(this.dir, "call.json"), JSON.stringify(this.meta, null, 2), { mode: 0o600 }); }
  /** Merge fields into call.json (e.g. endedAt, and run.ts's phase/liveAt: the answer window polls this file). Whole-file rewrite, best effort. */
  update(fields: Record<string, unknown>) { Object.assign(this.meta, fields); try { this.writeMeta(); } catch { /* best effort */ } }
  /** Appends one JSON line (with a `t` epoch-ms timestamp) to <stream>.jsonl. Never throws. */
  write(stream: "events" | "transcript" | "cards" | "latency" | "usage" | "live", row: Record<string, unknown>) {
    try { appendFileSync(join(this.dir, `${stream}.jsonl`), JSON.stringify({ t: Date.now(), ...row }) + "\n", { mode: 0o600 }); }
    catch (e) {
      // Best effort: a full disk or a vanished folder must not end the call.
      this.writeFailures++;
      if (this.writeFailures === 1) { try { this.onWriteFail?.(e as Error, 1); } catch { /* never throw from the logger */ } }
    }
  }
}
