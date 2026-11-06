// Where the user's data lives (shared/paths.cjs) and the one-time copy from the old in-repo folders (shared/migrate.cjs). Temp dirs only.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, symlinkSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import paths from "../shared/paths.cjs";
import migrate from "../shared/migrate.cjs";
import { assertMode } from "./test-platform.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "wm-datadir-"));
const put = (f: string, s: string) => { mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, s); };
const mode = (f: string) => statSync(f).mode & 0o777;

/** An old-style checkout: stage0/calls/<id>/..., stage0/data/private/briefs/..., entities.json, denylist.txt */
function oldLayout() {
  const stage0 = tmp();
  put(join(stage0, "calls", "01AAA", "call.json"), '{"id":"01AAA"}');
  put(join(stage0, "calls", "01AAA", "transcript.jsonl"), "line1\nline2\n");
  put(join(stage0, "calls", "tray.log"), "log");
  symlinkSync("01AAA", join(stage0, "calls", "latest"));
  put(join(stage0, "data", "private", "briefs", "m1", "meeting.json"), "{}");
  put(join(stage0, "data", "private", "briefs", "attachments", "a.txt"), "background");
  put(join(stage0, "data", "private", "entities.json"), "{}");
  put(join(stage0, "data", "private", "denylist.txt"), "secret");
  return { stage0, calls: join(stage0, "calls"), private: join(stage0, "data", "private") };
}
const run = (o: ReturnType<typeof oldLayout>, root: string, log: string[] = []) => migrate.migrateUserData({ dataDir: root, oldCalls: o.calls, oldPrivate: o.private, log: (m: string) => log.push(m) });

test("paths: default is ~/Library/Application Support/Wingman, env overrides, layout inside", () => {
  assert.equal(paths.dataDir({}, "/Users/x"), "/Users/x/Library/Application Support/Wingman");
  assert.equal(paths.callsDir({}, "/Users/x"), "/Users/x/Library/Application Support/Wingman/calls");
  assert.equal(paths.briefsDir({}, "/Users/x"), "/Users/x/Library/Application Support/Wingman/briefs");
  assert.equal(paths.attachDir({ WINGMAN_DATA_DIR: "/d" }), "/d/briefs/attachments");
  assert.equal(paths.entitiesFile({ WINGMAN_DATA_DIR: "/d" }), "/d/entities.json");
  assert.equal(paths.callsDir({ WINGMAN_DATA_DIR: "/d", WINGMAN_CALLS_DIR: "/c" }), "/c");
  assert.equal(paths.briefsDir({ WINGMAN_DATA_DIR: "/d", WINGMAN_BRIEFS_DIR: "/b" }), "/b");
  assert.equal(paths.dataDir({ WINGMAN_DATA_DIR: "  " }, "/h"), "/h/Library/Application Support/Wingman");
  assert.equal(paths.isRedirected({}), false);
  assert.equal(paths.isRedirected({ WINGMAN_DATA_DIR: "/d" }), true);
});

test("paths: settings paths (facts.file) map the old data/private location to the data folder", () => {
  const env = { WINGMAN_DATA_DIR: "/d" };
  assert.equal(paths.resolveUserPath("data/private/entities.json", env, "/h", "/s0"), "/d/entities.json");
  assert.equal(paths.resolveUserPath("~/x.json", env, "/h", "/s0"), "/h/x.json");
  assert.equal(paths.resolveUserPath("/abs/x.json", env, "/h", "/s0"), "/abs/x.json");
  assert.equal(paths.resolveUserPath("other/x.json", env, "/h", "/s0"), "/s0/other/x.json");
});

test("tests run with a temp data folder, never the real one", () => {
  assert.ok(process.env.WINGMAN_DATA_DIR && process.env.WINGMAN_DATA_DIR.startsWith(tmpdir()));
});

test("migration copies calls and private data, verifies, writes a marker, leaves the old folders untouched", () => {
  const o = oldLayout(), root = join(tmp(), "Wingman"), log: string[] = [];
  const r = run(o, root, log);
  assert.equal(r.status, "migrated");
  assert.equal(r.files, 5);   // 2 call files, 2 under briefs, entities.json (denylist, tray.log and the latest link are not user data)
  assert.equal(readFileSync(join(root, "calls", "01AAA", "transcript.jsonl"), "utf8"), "line1\nline2\n");
  assert.equal(readFileSync(join(root, "briefs", "attachments", "a.txt"), "utf8"), "background");
  assert.ok(existsSync(join(root, "entities.json")));
  assert.equal(existsSync(join(root, "denylist.txt")), false);
  assert.equal(existsSync(join(root, "calls", "latest")), false);
  assert.ok(existsSync(join(root, migrate.MARKER)));
  assert.equal(existsSync(join(root, migrate.PENDING)), false);
  // old copy untouched
  assert.ok(existsSync(join(o.calls, "01AAA", "call.json")) && existsSync(join(o.private, "entities.json")) && existsSync(join(o.private, "denylist.txt")));
  assert.match(log.join("\n"), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(log.join("\n"), /left in place/);
});

test("migration sets folder mode 700 and file mode 600 and keeps modified times", () => {
  const o = oldLayout(), root = join(tmp(), "Wingman");
  const t = new Date("2026-01-02T03:04:05Z"); utimesSync(join(o.calls, "01AAA", "call.json"), t, t);
  run(o, root);
  assertMode(root, 0o700);
  assertMode(join(root, "calls"), 0o700);
  assertMode(join(root, "calls", "01AAA"), 0o700);
  assertMode(join(root, "calls", "01AAA", "call.json"), 0o600);
  assertMode(join(root, "briefs", "attachments", "a.txt"), 0o600);
  assert.equal(Math.round(statSync(join(root, "calls", "01AAA", "call.json")).mtimeMs / 1000), Math.round(t.getTime() / 1000));
});

test("migration run twice: the second run does nothing, new data is not touched", () => {
  const o = oldLayout(), root = join(tmp(), "Wingman");
  assert.equal(run(o, root).status, "migrated");
  put(join(root, "calls", "01NEW", "call.json"), "new");
  put(join(o.calls, "01BBB", "call.json"), "added later in the old folder");
  assert.equal(run(o, root).status, "done-before");
  assert.equal(existsSync(join(root, "calls", "01BBB")), false);
  assert.equal(readFileSync(join(root, "calls", "01NEW", "call.json"), "utf8"), "new");
});

test("migration never overwrites data that is already in the new folder", () => {
  const o = oldLayout(), root = join(tmp(), "Wingman");
  put(join(root, "calls", "01AAA", "call.json"), "MINE");
  const r = run(o, root);
  assert.equal(r.status, "skipped");
  assert.equal(readFileSync(join(root, "calls", "01AAA", "call.json"), "utf8"), "MINE");
  assert.equal(existsSync(join(root, "entities.json")), false);
  assert.equal(run(o, root).status, "done-before");   // decided once
});

test("migration: an empty new folder and a tray.log alone count as no data", () => {
  const o = oldLayout(), root = join(tmp(), "Wingman");
  put(join(root, "calls", "tray.log"), "fresh log");
  assert.equal(run(o, root).status, "migrated");
  assert.ok(existsSync(join(root, "calls", "01AAA", "call.json")));
});

test("migration: Electron's own files in the data folder (it is Electron's userData too) do not count as data", () => {
  const o = oldLayout(), root = join(tmp(), "Wingman");
  put(join(root, "Cache", "data_0"), "x"); put(join(root, "Local Storage", "leveldb", "000003.log"), "x"); put(join(root, "Preferences"), "{}");
  assert.equal(run(o, root).status, "migrated");
  assert.ok(existsSync(join(root, "calls", "01AAA", "call.json")) && existsSync(join(root, "Preferences")));
});

test("migration: nothing old means nothing happens (fresh install, no marker)", () => {
  const stage0 = tmp(), root = join(tmp(), "Wingman");
  const r = migrate.migrateUserData({ dataDir: root, oldCalls: join(stage0, "calls"), oldPrivate: join(stage0, "data", "private"), log: () => {} });
  assert.equal(r.status, "none");
  assert.equal(existsSync(root), false);
});

test("migration: an interrupted copy resumes, keeps copied files, finishes and verifies", () => {
  const o = oldLayout(), root = join(tmp(), "Wingman");
  mkdirSync(join(root, "calls", "01AAA"), { recursive: true });
  writeFileSync(join(root, migrate.PENDING), "{}");
  writeFileSync(join(root, "calls", "01AAA", "call.json"), '{"id":"01AAA"}');   // copied before the crash
  const r = run(o, root);
  assert.equal(r.status, "migrated");
  assert.equal(r.copied, r.files - 1);
  assert.ok(existsSync(join(root, "briefs", "m1", "meeting.json")));
  assert.equal(existsSync(join(root, migrate.PENDING)), false);
});

test("migration reports failure (no marker) when a copy cannot be verified, and old data stays", () => {
  const o = oldLayout(), root = join(tmp(), "Wingman");
  put(join(root, "calls", "01AAA", "transcript.jsonl"), "x");   // different size than the source, but pending so it is "resumed", not overwritten
  writeFileSync(join(root, migrate.PENDING), "{}");
  const r = run(o, root);
  assert.equal(r.status, "failed");
  assert.equal(existsSync(join(root, migrate.MARKER)), false);
  assert.equal(readFileSync(join(o.calls, "01AAA", "transcript.jsonl"), "utf8"), "line1\nline2\n");
});

test("migration ignores symlinks (never follows them out of the folder)", () => {
  const o = oldLayout(), root = join(tmp(), "Wingman"), outside = tmp();
  put(join(outside, "secret.txt"), "outside");
  symlinkSync(outside, join(o.private, "briefs", "link"));
  symlinkSync(join(outside, "secret.txt"), join(o.private, "leak.txt"));
  run(o, root);
  assert.equal(existsSync(join(root, "briefs", "link")), false);
  assert.equal(existsSync(join(root, "leak.txt")), false);
});

test("ensureUserData does nothing while tests/QA redirect the data folder", () => {
  const r = migrate.ensureUserData({ env: { WINGMAN_DATA_DIR: "/nonexistent" }, log: () => {} });
  assert.equal(r.status, "redirected");
});

test("ensureUserData migrates for a normal start (home and stage0 injected)", () => {
  const o = oldLayout(), home = tmp();
  const r = migrate.ensureUserData({ env: {}, home, stage0: o.stage0, log: () => {} });
  assert.equal(r.status, "migrated");
  assert.ok(existsSync(join(home, "Library", "Application Support", "Wingman", "calls", "01AAA", "call.json")));
  assert.equal(readdirSync(o.calls).includes("01AAA"), true);
});
