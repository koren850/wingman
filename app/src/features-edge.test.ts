// Extra edge cases (speech ring bounds, bad rows, learning "wanted" floor, lookup refusals). No network, no model.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Nudger, SpeechRing, liveNumbers, DEFAULT_NUDGE_CFG } from "./session/coaching.ts";
import { noteWanted, loadLearning } from "./moments/learn.ts";
import { lookup } from "./session/lookup.ts";

const pubDns = async () => [{ address: "93.184.216.34", family: 4 as const }];

test("speech ring: keeps at most 400 rows and 6 minutes, ignores bad rows, stores only two word times", () => {
  const r = new SpeechRing();
  r.push({ ch: "me", text: "x", t: NaN });
  r.push({ ch: "me", text: 5 as unknown as string, t: 1 });
  assert.equal(r.rows().length, 0);
  for (let i = 0; i < 500; i++) r.push({ ch: "me", text: "one two", t: 1000 + i });
  assert.equal(r.rows().length, 400);
  r.push({
    ch: "them",
    text: "late",
    t: 1000 + 7 * 60_000,
    words: [
      { start: 1, end: 2 },
      { start: 3, end: 4 },
    ],
  });
  const rows = r.rows();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].words, [{ start: 1, end: 4 }]);
});

test("nudges: empty, future and malformed rows give no nudge and never throw", () => {
  const n = new Nudger({ ...DEFAULT_NUDGE_CFG, enabled: true });
  assert.equal(n.check(10_000_000, []), undefined);
  const bad = [
    { ch: "me", text: "", t: 5 },
    { ch: "x", text: "a b c", t: 5 },
    { ch: "me", text: "a b c", t: Infinity },
  ] as never;
  assert.equal(n.check(10_000_000, bad), undefined);
  assert.deepEqual(liveNumbers([{ ch: "me", text: "hello there friend", t: 99_000_000 }], 1000).streak, 0);
});

test("learning: noteWanted never goes below zero, ignores unknown tags and unseen tags", () => {
  const f = join(mkdtempSync(join(tmpdir(), "r3e-")), "learn.json");
  noteWanted("CHECK", f);
  noteWanted("NOPE" as never, f);
  const s = loadLearning(f);
  assert.deepEqual(s.tags, {});
});

test("lookup: ftp and file addresses are refused, a missing page and a non-JSON answer fail without throwing", async () => {
  const never = async () => {
    throw new Error("no");
  };
  for (const u of ["ftp://example.com/a", "file:///etc/passwd", "javascript://x"]) {
    const r = await lookup(u, { enabled: true, fetch: never, dns: pubDns });
    assert.equal(r.ok, false, u);
  }
  const nf = await lookup("Zzzz Qqqq", { enabled: true, dns: pubDns, fetch: async () => new Response("nope", { status: 404 }) });
  assert.equal(nf.ok, false);
  const junk = await lookup("Zzzz Qqqq", {
    enabled: true,
    dns: pubDns,
    fetch: async () => new Response("<html>", { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.equal(junk.ok, false);
  const dis = await lookup("Mercury", {
    enabled: true,
    dns: pubDns,
    fetch: async () =>
      new Response(JSON.stringify({ type: "disambiguation", extract: "Mercury may refer to many things." }), {
        headers: { "content-type": "application/json" },
      }),
  });
  assert.equal(!dis.ok && dis.code, "not-found");
});
