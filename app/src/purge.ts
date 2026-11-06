// pnpm purge <callId|--older-than N|--all>: delete saved call folders (audio is never saved, but transcripts are).
// Top-level script: it runs on import. Exit code 2 on a bad id or usage.
import { readdirSync, rmSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CALLS } from "./env.ts";
import { rescueBases } from "./log.ts";

const args = process.argv.slice(2);
const dirs = () => (existsSync(CALLS) ? readdirSync(CALLS).filter((d) => d !== "latest" && statSync(join(CALLS, d)).isDirectory()) : []);
/** Deletes one call folder. The id is checked against a strict pattern first so it can never be a path ("..", "/"). */
function purge(id: string) {
  if (!/^[0-9A-Za-z]{10,40}$/.test(id)) {
    console.error(`Not a call id: ${id}`);
    process.exitCode = 2;
    return;
  }
  const dir = join(CALLS, id);
  if (!existsSync(dir)) {
    console.error(`No such call: ${id}`);
    process.exitCode = 2;
    return;
  }
  rmSync(dir, { recursive: true, force: true });
  // existsSync follows the link: false means calls/latest now dangles (it pointed at the folder just deleted), so remove it.
  try {
    if (existsSync(join(CALLS, "latest")) === false) rmSync(join(CALLS, "latest"), { force: true });
  } catch {
    /* best effort: the latest link is only a convenience */
  }
  console.log(`Deleted ${id}`);
}
if (args[0] === "--older-than") {
  const days = Number(args[1]);
  if (!Number.isFinite(days) || days < 0) {
    console.error("Usage: pnpm purge --older-than <days>");
    process.exit(2);
  }
  const cutoff = Date.now() - days * 86_400_000;
  const old = dirs().filter((d) => statSync(join(CALLS, d)).mtimeMs < cutoff);
  for (const d of old) purge(d);
  console.log(`${old.length} call(s) older than ${days} day(s) deleted.`);
} else if (args[0] === "--all") {
  for (const d of dirs()) purge(d);
  for (const b of rescueBases()) rmSync(b, { recursive: true, force: true }); // rescue copies of transcripts (see CallLog.rescue)
} else if (args[0]) {
  purge(args[0]);
} else {
  console.log(
    "Usage: pnpm purge <callId> | --older-than <days> | --all\nSaved calls:\n" +
      (dirs()
        .map((d) => "  " + d)
        .join("\n") || "  (none)"),
  );
}
