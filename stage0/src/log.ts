// Plain JSONL call log: calls/<ulid>/{events,transcript,cards,latency,usage}.jsonl (interim privacy policy).
// Files are private to the user (umask 077). Delete with `pnpm purge`.
import { mkdirSync, appendFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";
import { CALLS } from "./env.ts";

process.umask(0o077);

export class CallLog {
  readonly id = ulid();
  readonly dir = join(CALLS, this.id);
  private meta: Record<string, unknown>;
  constructor(meta: Record<string, unknown>) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.meta = { id: this.id, startedAt: new Date().toISOString(), ...meta };
    this.writeMeta();
    // calls/latest -> this call, for the overlay.
    const latest = join(CALLS, "latest");
    try { rmSync(latest, { force: true }); symlinkSync(this.id, latest); } catch { /* best effort */ }
  }
  private writeMeta() { writeFileSync(join(this.dir, "call.json"), JSON.stringify(this.meta, null, 2), { mode: 0o600 }); }
  /** Merge fields into call.json (e.g. endedAt). */
  update(fields: Record<string, unknown>) { Object.assign(this.meta, fields); try { this.writeMeta(); } catch { /* best effort */ } }
  write(stream: "events" | "transcript" | "cards" | "latency" | "usage", row: Record<string, unknown>) {
    appendFileSync(join(this.dir, `${stream}.jsonl`), JSON.stringify({ t: Date.now(), ...row }) + "\n", { mode: 0o600 });
  }
}
