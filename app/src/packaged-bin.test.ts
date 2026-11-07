// How local tools are started inside the packaged app: the app's own executable runs the bundled engine (no Node, no node_modules).
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bin from "../shared/bin.cjs";

const EXE = "/Applications/Wingman.app/Contents/MacOS/Wingman";

test("packaged: a tsx tool becomes --wingman-tool <name> and keeps its arguments after --", () => {
  const c = bin.binCommand("tsx", ["/x/src/run.ts", "--profile", "demo-en", "--file", "a.wav"], "/x", { packaged: true, execPath: EXE });
  assert.deepEqual(c, { cmd: EXE, args: ["--wingman-tool", "run", "--", "--profile", "demo-en", "--file", "a.wav"] });
  assert.deepEqual(bin.binCommand("tsx", ["src/settings-edit-cli.ts", "read"], "/x", { packaged: true, execPath: EXE }).args, [
    "--wingman-tool",
    "settings-edit-cli",
    "--",
    "read",
  ]);
});

test("packaged: the answer window is the same executable with --wingman-overlay", () => {
  const c = bin.binCommand("electron", ["/x/overlay/main.cjs"], "/x", { packaged: true, execPath: EXE });
  assert.deepEqual(c, { cmd: EXE, args: ["--wingman-overlay", "--"] });
});

test("packaged: only the bundled tools can be started", () => {
  assert.throws(() => bin.binCommand("tsx", ["src/gate.ts"], "/x", { packaged: true, execPath: EXE }), /not part of the packaged app/);
  assert.throws(() => bin.binCommand("tsx", ["../../etc/evil.ts"], "/x", { packaged: true, execPath: EXE }), /not part of the packaged app/);
  assert.throws(() => bin.binCommand("vite", ["x"], "/x", { packaged: true, execPath: EXE }), /not part of the packaged app/);
});

test("packaged: detected by packaged.json in the app folder, never in a checkout", () => {
  const dir = mkdtempSync(join(tmpdir(), "wingman-packed-"));
  try {
    assert.equal(bin.isPackaged(dir), false);
    assert.equal(bin.binCommand("tsx", ["src/call.ts"], dir, { platform: "darwin" }).cmd, join(dir, "node_modules", ".bin", "tsx"));
    writeFileSync(join(dir, "packaged.json"), "{}");
    assert.equal(bin.isPackaged(dir), true);
    assert.equal(bin.binCommand("tsx", ["src/call.ts"], dir, { execPath: EXE }).args[0], "--wingman-tool");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real checkout is not packaged", () => {
  assert.equal(bin.isPackaged(join(import.meta.dirname, "..")), false);
});
