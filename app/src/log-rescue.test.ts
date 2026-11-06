// CallLog when the call folder vanishes or cannot be written: recreate it, keep rows in memory, save a rescue copy.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, chmodSync, statSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallLog, rescueBases } from "./log.ts";

const rows = (log: CallLog, stream: string) =>
  readFileSync(join(log.dir, `${stream}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

test("a vanished call folder is created again and later rows are saved", () => {
  const log = new CallLog({ a: 1 });
  let warned = 0;
  log.onWriteFail = () => warned++;
  log.write("transcript", { text: "one" });
  rmSync(log.dir, { recursive: true });
  log.write("transcript", { text: "two" });
  log.write("transcript", { text: "three" });
  assert.deepEqual(
    rows(log, "transcript").map((r) => r.text),
    ["two", "three"],
  );
  assert.ok(existsSync(join(log.dir, "call.json")), "call.json is written again");
  assert.equal(log.writeFailures, 0);
  assert.equal(log.recreated, 1);
  assert.equal(log.degraded, true, "rows written before the folder vanished are gone, so the call counts as degraded");
  assert.equal(warned, 0);
});

test("when the folder cannot be created, rows are kept and written in order once it works again", () => {
  const log = new CallLog({ a: 1 });
  let warned = 0;
  log.onWriteFail = () => warned++;
  rmSync(log.dir, { recursive: true });
  writeFileSync(log.dir, "a file where the folder should be");
  log.write("transcript", { text: "one" });
  log.write("transcript", { text: "two" });
  assert.equal(log.writeFailures, 2);
  assert.equal(warned, 1, "one warning only");
  rmSync(log.dir);
  log.write("transcript", { text: "three" });
  assert.deepEqual(
    rows(log, "transcript").map((r) => r.text),
    ["one", "two", "three"],
  );
});

test("rescue() writes the unsaved rows and the in-memory transcript to a fallback folder", () => {
  const log = new CallLog({ a: 1 });
  log.onWriteFail = () => {};
  rmSync(log.dir, { recursive: true });
  writeFileSync(log.dir, "blocked");
  log.write("transcript", { text: "kept in memory" });
  log.write("live", { text: "interim words are not kept" });
  const dir = log.rescue("them: hello\nme: hi\n");
  assert.ok(dir, "a rescue folder was written");
  assert.deepEqual(readdirSync(dir!).sort(), ["call.json", "transcript.txt", "transcript.unsaved.jsonl"]);
  assert.equal(readFileSync(join(dir!, "transcript.txt"), "utf8"), "them: hello\nme: hi\n");
  assert.equal(JSON.parse(readFileSync(join(dir!, "transcript.unsaved.jsonl"), "utf8")).text, "kept in memory");
  rmSync(dir!, { recursive: true, force: true });
});

test("rescue() uses private modes, tightens a loose base, and refuses a base that is a link", () => {
  const [primary] = rescueBases();
  rmSync(primary, { recursive: true, force: true });
  mkdirSync(primary, { recursive: true, mode: 0o755 });
  chmodSync(primary, 0o755);
  const log = new CallLog({ a: 1 });
  const dir = log.rescue("hello");
  assert.ok(dir && dir.startsWith(primary));
  if (process.platform !== "win32") {
    assert.equal(statSync(primary).mode & 0o777, 0o700, "loose base tightened");
    assert.equal(statSync(dir!).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir!, "transcript.txt")).mode & 0o777, 0o600);
  }
  rmSync(primary, { recursive: true, force: true });

  // A link planted at the base must not be followed: the copy goes to the other place (or nowhere), never through the link.
  const elsewhere = mkdtempSync(join(tmpdir(), "wm-link-"));
  symlinkSync(elsewhere, primary);
  const log2 = new CallLog({ a: 1 });
  const dir2 = log2.rescue("secret");
  assert.deepEqual(readdirSync(elsewhere), [], "nothing written through the link");
  if (dir2) assert.ok(!dir2.startsWith(primary));
  rmSync(primary, { force: true });
  rmSync(elsewhere, { recursive: true, force: true });
  if (dir2) rmSync(dir2, { recursive: true, force: true });
});
