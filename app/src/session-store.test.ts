// Call memory store: atomic write, schema-checked load, corrupt file recovery (src/session/store.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMemory, loadMemory, saveMemory, SESSION_FILE, type Fs } from "./session/store.ts";
import { applyPatch } from "./session/patch.ts";
import { emptyMemory, type SessionMemory } from "./session/types.ts";
import { POSIX } from "./test-platform.ts";

const dir = () => mkdtempSync(join(tmpdir(), "wm-session-"));
const withFact = (m: SessionMemory, text: string, now = 1) => applyPatch(m, { add: { facts: [{ text }] } }, { now }).mem;

test("save then load gives back the same memory", () => {
  const d = dir();
  const m = withFact(emptyMemory(), "Budget is 40k");
  saveMemory(d, m);
  const r = loadMemory(d);
  assert.equal(r.status, "ok");
  assert.deepEqual(r.mem, m);
  rmSync(d, { recursive: true });
});

test("session.json is mode 600", POSIX, () => {
  const d = dir();
  saveMemory(d, emptyMemory());
  assert.equal(statSync(join(d, SESSION_FILE)).mode & 0o777, 0o600);
  rmSync(d, { recursive: true });
});

test("no file: an empty memory, status missing", () => {
  const d = dir();
  const r = loadMemory(d, 55);
  assert.equal(r.status, "missing");
  assert.equal(r.mem.ver, 0);
  assert.equal(r.mem.updatedAt, 55);
  assert.equal(loadMemory(join(d, "nope")).status, "missing");
  rmSync(d, { recursive: true });
});

test("a kill between the temp write and the rename leaves the old file whole", () => {
  const d = dir();
  const m1 = withFact(emptyMemory(), "first");
  saveMemory(d, m1);
  const m2 = withFact(m1, "second", 2);
  const dying: Fs = {
    write: (p, data) => writeFileSync(p, data),
    rename: () => {
      throw new Error("killed");
    },
  };
  assert.throws(() => saveMemory(d, m2, dying), /killed/);
  assert.deepEqual(loadMemory(d).mem, m1);
  assert.deepEqual(
    readdirSync(d).filter((n) => n.endsWith(".tmp")),
    [],
    "temp file cleaned up",
  );
  rmSync(d, { recursive: true });
});

test("a kill in the middle of the temp write leaves the old file whole and the stray temp file is swept on load", () => {
  const d = dir();
  const m1 = withFact(emptyMemory(), "first");
  saveMemory(d, m1);
  const full = JSON.stringify(withFact(m1, "second", 2));
  // the process died after half the bytes: only a .tmp exists, session.json was never touched
  writeFileSync(join(d, `${SESSION_FILE}.4242-1.tmp`), full.slice(0, full.length >> 1));
  const r = loadMemory(d);
  assert.equal(r.status, "ok");
  assert.deepEqual(r.mem, m1);
  assert.ok(!existsSync(join(d, `${SESSION_FILE}.4242-1.tmp`)));
  rmSync(d, { recursive: true });
});

test("rename really replaces: the second save wins and the first is kept as the previous copy", () => {
  const d = dir();
  const m1 = withFact(emptyMemory(), "one");
  const m2 = withFact(m1, "two", 2);
  saveMemory(d, m1);
  saveMemory(d, m2);
  assert.deepEqual(loadMemory(d).mem, m2);
  assert.deepEqual(JSON.parse(readFileSync(join(d, "session.prev.json"), "utf8")), m1);
  rmSync(d, { recursive: true });
});

test("corrupt file: moved to session.bad, the previous good copy is used", () => {
  const d = dir();
  const m1 = withFact(emptyMemory(), "good");
  saveMemory(d, m1);
  saveMemory(d, withFact(m1, "newer", 2));
  writeFileSync(join(d, SESSION_FILE), '{"v":1,"facts":[{"text":');
  const r = loadMemory(d);
  assert.equal(r.status, "recovered");
  assert.deepEqual(r.mem, m1);
  assert.ok(existsSync(join(d, "session.bad")));
  assert.ok(!existsSync(join(d, SESSION_FILE)));
  rmSync(d, { recursive: true });
});

test("corrupt file and no previous copy: start empty, keep the bad file", () => {
  const d = dir();
  writeFileSync(join(d, SESSION_FILE), "not json at all");
  const r = loadMemory(d, 9);
  assert.equal(r.status, "corrupt");
  assert.equal(r.mem.ver, 0);
  assert.ok(existsSync(join(d, "session.bad")));
  // saving works again afterwards
  saveMemory(d, withFact(r.mem, "fresh"));
  assert.equal(loadMemory(d).status, "ok");
  rmSync(d, { recursive: true });
});

test("a file that parses but breaks the schema is treated as corrupt", () => {
  const d = dir();
  const good = withFact(emptyMemory(), "x");
  const variants: ((m: Record<string, unknown>) => void)[] = [
    (m) => (m.v = 2),
    (m) => (m.kind = "wedding"),
    (m) => (m.facts = "nope"),
    (m) => (m.facts = [{ id: "f1", text: 5, at: 1, src: "call" }]),
    (m) =>
      (m.facts = [
        { id: "f1", text: "a", at: 1, src: "call" },
        { id: "f1", text: "b", at: 1, src: "call" },
      ]),
    (m) => (m.facts = Array.from({ length: 31 }, (_, i) => ({ id: "f" + (i + 1), text: "t", at: 1, src: "call" }))),
    (m) => (m.commitments = [{ id: "c1", who: "a", what: "b", at: 1, status: "maybe" }]),
    (m) => delete m.summary,
    (m) => (m.topic = { now: 1, history: [] }),
    (m) => (m.seq = { f: "x" }),
  ];
  for (const f of variants) {
    const o = JSON.parse(JSON.stringify(good));
    f(o);
    assert.equal(checkMemory(o).ok, false, JSON.stringify(o).slice(0, 80));
  }
  assert.equal(checkMemory(JSON.parse(JSON.stringify(good))).ok, true);
  writeFileSync(join(d, SESSION_FILE), JSON.stringify({ ...good, v: 2 }));
  assert.equal(loadMemory(d).status, "corrupt");
  rmSync(d, { recursive: true });
});

test("session.json missing but a previous copy exists: it is used", () => {
  const d = dir();
  const m1 = withFact(emptyMemory(), "good");
  saveMemory(d, m1);
  saveMemory(d, withFact(m1, "newer", 2));
  renameSync(join(d, SESSION_FILE), join(d, "gone.json"));
  const r = loadMemory(d);
  assert.equal(r.status, "recovered");
  assert.deepEqual(r.mem, m1);
  rmSync(d, { recursive: true });
});

test("checkMemory rejects a seq that would break ids", () => {
  const m = emptyMemory(1) as unknown as Record<string, unknown>;
  m.seq = { f: 1e21 };
  assert.equal(checkMemory(m).ok, false);
});
