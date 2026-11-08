// Every documented command must exist: each package.json script that runs a file must point at a file in the repo,
// and the commands the docs tell people to type must be real scripts.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const scripts = (JSON.parse(readFileSync(join(APP, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

test("every script that runs a file points at a file that exists", () => {
  const missing: string[] = [];
  for (const [name, cmd] of Object.entries(scripts)) {
    // Only the first command of a chain is a file target; `pnpm x && pnpm y` entries name other scripts.
    for (const part of cmd.split("&&")) {
      const m = part.trim().match(/^(?:tsx|node|sh)\s+(?:--\S+\s+\S+\s+)*([\w./-]+\.(?:ts|cjs|js|sh))\b/) ?? part.trim().match(/^(scripts\/[\w./-]+\.sh)\b/);
      if (m && !existsSync(join(APP, m[1]))) missing.push(`${name} -> ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("every `pnpm <script>` inside a script exists", () => {
  const bad: string[] = [];
  for (const [name, cmd] of Object.entries(scripts))
    for (const m of cmd.matchAll(/\bpnpm\s+([\w:-]+)/g)) if (!(m[1] in scripts) && !["install", "run"].includes(m[1])) bad.push(`${name} -> pnpm ${m[1]}`);
  assert.deepEqual(bad, []);
});

test("the commands the docs name are scripts", () => {
  for (const s of ["morning", "replay", "eval:judge", "cassette:record", "cassette:status", "snapshots", "eval", "eval:memory", "doctor", "tag", "call"])
    assert.ok(s in scripts, `package.json has no "${s}" script`);
});
