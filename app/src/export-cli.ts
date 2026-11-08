// Child process for the call page's export buttons (dashboard/window.cjs, "calls:export").
// stdin: { id, fmt: "md" | "json", out }. It writes the export of one saved call to `out` (mode 600) and prints one JSON line:
// { ok: true } or { ok: false, reason: "no-export" | "bad-input" | "failed" }. It never prints call text.
// The export itself is exportCall(callDir, fmt) from session/export.ts (contract 3.5 of the round 12 plan). If that module is not in this build,
// the answer is "no-export" and the window says so.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CALLS } from "./env.ts";

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");

async function main() {
  let raw = "";
  for await (const c of process.stdin) raw += c;
  const i = JSON.parse(raw) as { id?: unknown; fmt?: unknown; out?: unknown };
  if (typeof i.id !== "string" || !/^[0-9A-Za-z_-]{6,60}$/.test(i.id) || (i.fmt !== "md" && i.fmt !== "json") || typeof i.out !== "string" || !i.out)
    return out({ ok: false, reason: "bad-input" });
  const spec = "./session/export.ts";
  const mod = (await import(spec).catch(() => undefined)) as { exportCall?: (dir: string, fmt: "md" | "json") => string | Promise<string> } | undefined;
  if (!mod || typeof mod.exportCall !== "function") return out({ ok: false, reason: "no-export" });
  const text = await mod.exportCall(join(CALLS, i.id), i.fmt);
  if (typeof text !== "string" || !text) return out({ ok: false, reason: "failed" });
  writeFileSync(i.out, text, { mode: 0o600 });
  out({ ok: true });
}
main().catch(() => out({ ok: false, reason: "failed" }));
