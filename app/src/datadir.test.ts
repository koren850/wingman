// Where the user's data lives (shared/paths.cjs) and the one-time copy from the old in-repo folders (shared/migrate.cjs). Temp dirs only.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, symlinkSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import paths from "../shared/paths.cjs";
import migrate from "../shared/migrate.cjs";
import { assertMode, SYMLINK } from "./test-platform.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "wm-datadir-"));
const put = (f: string, s: string) => {
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, s);
};

/** An old-style checkout: <app>/calls/<id>/..., <app>/data/private/briefs/..., entities.json, denylist.txt */
function oldLayout() {
  const appDir = tmp();
  put(join(appDir, "calls", "01AAA", "call.json"), '{"id":"01AAA"}');
  put(join(appDir, "calls", "01AAA", "transcript.jsonl"), "line1\nline2\n");
  put(join(appDir, "calls", "tray.log"), "log");
  if (SYMLINK.skip === false) symlinkSync("01AAA", join(appDir, "calls", "latest"));
  put(join(appDir, "data", "private", "briefs", "m1", "meeting.json"), "{}");
  put(join(appDir, "data", "private", "briefs", "attachments", "a.txt"), "background");
  put(join(appDir, "data", "private", "entities.json"), "{}");
  put(join(appDir, "data", "private", "denylist.txt"), "secret");
  return { appDir, calls: join(appDir, "calls"), private: join(appDir, "data", "private") };
}
const run = (o: ReturnType<typeof oldLayout>, root: string, log: string[] = []) =>
  migrate.migrateUserData({ dataDir: root, oldCalls: o.calls, oldPrivate: o.private, log: (m: string) => log.push(m) });

test("paths: default is ~/Library/Application Support/Wingman, env overrides, layout inside", () => {
  const mac = "darwin"; // the default folder depends on the platform: pin it so the expectations hold on every machine
  assert.equal(paths.dataDir({}, "/Users/x", mac), "/Users/x/Library/Application Support/Wingman");
  assert.equal(paths.callsDir({}, "/Users/x", mac), "/Users/x/Library/Application Support/Wingman/calls");
  assert.equal(paths.briefsDir({}, "/Users/x", mac), "/Users/x/Library/Application Support/Wingman/briefs");
  // An override goes through path.resolve (on Windows "/d" becomes "C:\\d"), so the expectations use resolve/join too.
  assert.equal(paths.attachDir({ WINGMAN_DATA_DIR: "/d" }), join(resolve("/d"), "briefs", "attachments"));
  assert.equal(paths.entitiesFile({ WINGMAN_DATA_DIR: "/d" }), join(resolve("/d"), "entities.json"));
  assert.equal(paths.callsDir({ WINGMAN_DATA_DIR: "/d", WINGMAN_CALLS_DIR: "/c" }), resolve("/c"));
  assert.equal(paths.briefsDir({ WINGMAN_DATA_DIR: "/d", WINGMAN_BRIEFS_DIR: "/b" }), resolve("/b"));
  assert.equal(paths.dataDir({ WINGMAN_DATA_DIR: "  " }, "/h", mac), "/h/Library/Application Support/Wingman");
  assert.equal(paths.isRedirected({}), false);
  assert.equal(paths.isRedirected({ WINGMAN_DATA_DIR: "/d" }), true);
});

test("paths: settings paths (facts.file) map the old data/private location to the data folder", () => {
  const env = { WINGMAN_DATA_DIR: "/d" };
  assert.equal(paths.resolveUserPath("data/private/entities.json", env, "/h", "/s0"), join(resolve("/d"), "entities.json"));
  assert.equal(paths.resolveUserPath("~/x.json", env, "/h", "/s0"), join("/h", "x.json"));
  assert.equal(paths.resolveUserPath("/abs/x.json", env, "/h", "/s0"), "/abs/x.json");
  assert.equal(paths.resolveUserPath("other/x.json", env, "/h", "/s0"), join("/s0", "other", "x.json"));
});

test("tests run with a temp data folder, never the real one", () => {
  assert.ok(process.env.WINGMAN_DATA_DIR && process.env.WINGMAN_DATA_DIR.startsWith(tmpdir()));
});

test("migration copies calls and private data, verifies, writes a marker, leaves the old folders untouched", () => {
  const o = oldLayout(),
    root = join(tmp(), "Wingman"),
    log: string[] = [];
  const r = run(o, root, log);
  assert.equal(r.status, "migrated");
  assert.equal(r.files, 5); // 2 call files, 2 under briefs, entities.json (denylist, tray.log and the latest link are not user data)
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
  const o = oldLayout(),
    root = join(tmp(), "Wingman");
  const t = new Date("2026-01-02T03:04:05Z");
  utimesSync(join(o.calls, "01AAA", "call.json"), t, t);
  run(o, root);
  assertMode(root, 0o700);
  assertMode(join(root, "calls"), 0o700);
  assertMode(join(root, "calls", "01AAA"), 0o700);
  assertMode(join(root, "calls", "01AAA", "call.json"), 0o600);
  assertMode(join(root, "briefs", "attachments", "a.txt"), 0o600);
  assert.equal(Math.round(statSync(join(root, "calls", "01AAA", "call.json")).mtimeMs / 1000), Math.round(t.getTime() / 1000));
});

test("migration run twice: the second run does nothing, new data is not touched", () => {
  const o = oldLayout(),
    root = join(tmp(), "Wingman");
  assert.equal(run(o, root).status, "migrated");
  put(join(root, "calls", "01NEW", "call.json"), "new");
  put(join(o.calls, "01BBB", "call.json"), "added later in the old folder");
  assert.equal(run(o, root).status, "done-before");
  assert.equal(existsSync(join(root, "calls", "01BBB")), false);
  assert.equal(readFileSync(join(root, "calls", "01NEW", "call.json"), "utf8"), "new");
});

test("migration never overwrites data that is already in the new folder", () => {
  const o = oldLayout(),
    root = join(tmp(), "Wingman");
  put(join(root, "calls", "01AAA", "call.json"), "MINE");
  const r = run(o, root);
  assert.equal(r.status, "skipped");
  assert.equal(readFileSync(join(root, "calls", "01AAA", "call.json"), "utf8"), "MINE");
  assert.equal(existsSync(join(root, "entities.json")), false);
  assert.equal(run(o, root).status, "done-before"); // decided once
});

test("migration: an empty new folder and a tray.log alone count as no data", () => {
  const o = oldLayout(),
    root = join(tmp(), "Wingman");
  put(join(root, "calls", "tray.log"), "fresh log");
  assert.equal(run(o, root).status, "migrated");
  assert.ok(existsSync(join(root, "calls", "01AAA", "call.json")));
});

test("migration: Electron's own files in the data folder (it is Electron's userData too) do not count as data", () => {
  const o = oldLayout(),
    root = join(tmp(), "Wingman");
  put(join(root, "Cache", "data_0"), "x");
  put(join(root, "Local Storage", "leveldb", "000003.log"), "x");
  put(join(root, "Preferences"), "{}");
  assert.equal(run(o, root).status, "migrated");
  assert.ok(existsSync(join(root, "calls", "01AAA", "call.json")) && existsSync(join(root, "Preferences")));
});

test("migration: nothing old means nothing happens (fresh install, no marker)", () => {
  const appDir = tmp(),
    root = join(tmp(), "Wingman");
  const r = migrate.migrateUserData({ dataDir: root, oldCalls: join(appDir, "calls"), oldPrivate: join(appDir, "data", "private"), log: () => {} });
  assert.equal(r.status, "none");
  assert.equal(existsSync(root), false);
});

test("migration: an interrupted copy resumes, keeps copied files, finishes and verifies", () => {
  const o = oldLayout(),
    root = join(tmp(), "Wingman");
  mkdirSync(join(root, "calls", "01AAA"), { recursive: true });
  writeFileSync(join(root, migrate.PENDING), "{}");
  writeFileSync(join(root, "calls", "01AAA", "call.json"), '{"id":"01AAA"}'); // copied before the crash
  const r = run(o, root);
  assert.equal(r.status, "migrated");
  assert.equal(r.copied, r.files - 1);
  assert.ok(existsSync(join(root, "briefs", "m1", "meeting.json")));
  assert.equal(existsSync(join(root, migrate.PENDING)), false);
});

test("migration reports failure (no marker) when a copy really fails, and old data stays", () => {
  const o = oldLayout(),
    root = join(tmp(), "Wingman");
  mkdirSync(join(root, "calls", "01AAA", "transcript.jsonl"), { recursive: true }); // a folder where the file must go: the copy cannot succeed
  writeFileSync(join(root, migrate.PENDING), "{}");
  const r = run(o, root);
  assert.equal(r.status, "failed");
  assert.equal(existsSync(join(root, migrate.MARKER)), false);
  assert.equal(readFileSync(join(o.calls, "01AAA", "transcript.jsonl"), "utf8"), "line1\nline2\n");
});

test("migration repairs a truncated earlier copy (a crash in the middle of a copy) instead of failing forever", () => {
  const o = oldLayout(),
    root = join(tmp(), "Wingman");
  put(join(root, "calls", "01AAA", "transcript.jsonl"), "line1\nli"); // the first bytes of the source: what a crashed copy leaves
  writeFileSync(join(root, migrate.PENDING), "{}");
  const r = run(o, root);
  assert.equal(r.status, "migrated");
  assert.equal(readFileSync(join(root, "calls", "01AAA", "transcript.jsonl"), "utf8"), "line1\nline2\n");
  assert.equal(run(o, root).status, "done-before");
});

test("migration never overwrites a file the user changed after the first copy, and does not fail because of it", () => {
  const o = oldLayout(),
    root = join(tmp(), "Wingman"),
    log: string[] = [];
  put(join(root, "calls", "01AAA", "transcript.jsonl"), "my own edit"); // not a prefix of the source: user-owned
  put(join(root, "entities.json"), '{ "changed": true, "more": 1 }'); // longer than the source: user-owned
  writeFileSync(join(root, migrate.PENDING), "{}");
  const r = run(o, root, log);
  assert.equal(r.status, "migrated");
  assert.equal(readFileSync(join(root, "calls", "01AAA", "transcript.jsonl"), "utf8"), "my own edit");
  assert.equal(readFileSync(join(root, "entities.json"), "utf8"), '{ "changed": true, "more": 1 }');
  assert.match(r.message ?? "", /left as they are/);
  assert.deepEqual(JSON.parse(readFileSync(join(root, migrate.MARKER), "utf8")).userOwned.sort(), [join("01AAA", "transcript.jsonl"), "entities.json"].sort());
  assert.equal(run(o, root).status, "done-before"); // no failure, no repeat
});

test("migration copies through a .part file: no stray .part is left behind", () => {
  const o = oldLayout(),
    root = join(tmp(), "Wingman");
  put(join(root, "calls", "01AAA", "transcript.jsonl.part"), "junk from a crash");
  put(join(root, "calls", "01AAA", "transcript.jsonl"), "line1");
  writeFileSync(join(root, migrate.PENDING), "{}");
  assert.equal(run(o, root).status, "migrated");
  assert.equal(existsSync(join(root, "calls", "01AAA", "transcript.jsonl.part")), false);
});

test("migration ignores symlinks (never follows them out of the folder)", SYMLINK, () => {
  const o = oldLayout(),
    root = join(tmp(), "Wingman"),
    outside = tmp();
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

test("ensureUserData migrates for a normal start (home and appDir injected)", () => {
  const o = oldLayout(),
    home = tmp();
  const r = migrate.ensureUserData({ env: {}, home, appDir: o.appDir, log: () => {} });
  assert.equal(r.status, "migrated");
  assert.ok(existsSync(join(paths.dataDir({}, home), "calls", "01AAA", "call.json")));
  assert.equal(readdirSync(o.calls).includes("01AAA"), true);
});
