// Round 12 live UI, data side: memory -> screens (shared/memview.js), user edits (shared/memedit.cjs, session/useredit.ts),
// the answer window's memory feed and card controls (overlay/memfeed.cjs, overlay/act.cjs).
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch } from "./session/patch.ts";
import { toView } from "./session/view.ts";
import { emptyMemory, type SessionMemory } from "./session/types.ts";
import { checkMemory } from "./session/store.ts";
import { applyUserEdit, queueUserEdit, UserEditQueue, USER_EDITS_FILE } from "./session/useredit.ts";
import { POSIX } from "./test-platform.ts";

const require = createRequire(import.meta.url);
const MV = require("../shared/memview.js");
const ME = require("../shared/memedit.cjs");
const { createMemoryFeed, parseMemory } = require("../overlay/memfeed.cjs");
const { applyAct } = require("../overlay/act.cjs");

const tmp = () => mkdtempSync(join(tmpdir(), "wm-live-"));
const NOW = 1_700_000_000_000;

/** A memory with a bit of everything, built through the real patch code. */
function sample(): SessionMemory {
  let m = emptyMemory(NOW, "client");
  const patches: object[] = [
    {
      roster: [
        { name: "Dan", side: "me" },
        { name: "Maya", side: "them" },
      ],
      topic: "Renewal price",
    },
    {
      add: {
        facts: [{ text: "Budget is 12k" }, { text: "Prefers WhatsApp" }],
        decisions: [{ text: "Move on Thursday" }],
        openQuestions: [
          { asker: "Maya", text: "Is backup included?" },
          { asker: "Dan", text: "Who owns the domain?" },
        ],
        commitments: [
          { who: "Dan", what: "send the offer", due: "Friday" },
          { who: "Maya", what: "send the product list" },
        ],
        numbers: [{ what: "budget", value: "$12,000" }],
      },
    },
  ];
  for (const p of patches) m = applyPatch(m, p, { now: NOW }).mem;
  return m;
}

test("viewFromMemory gives the same view as src/session/view.ts", () => {
  const m = sample();
  assert.deepEqual(MV.viewFromMemory(m), toView(m));
  assert.deepEqual(MV.viewFromMemory(emptyMemory(0)), toView(emptyMemory(0)));
});

test("cleanView keeps known fields, cleans text and rejects other shapes", () => {
  assert.equal(MV.cleanView(null), null);
  assert.equal(MV.cleanView([1]), null);
  assert.equal(MV.cleanView({ nothing: 1 }), null);
  const v = MV.cleanView({
    ver: 3.4,
    topic: "a‮b\n\nc",
    soFar: ["x", 5, "y"],
    open: [{ id: "q1", text: "?" }, { text: "" }, "str"],
    extra: "dropped",
    numbers: [{ what: "a", value: "1" }, {}],
  });
  assert.equal(v.ver, 3);
  assert.equal(v.topic, "ab c");
  assert.deepEqual(v.soFar, ["x", "", "y"].filter(Boolean));
  assert.deepEqual(
    v.open.map((x: { text: string }) => x.text),
    ["?", "str"],
  );
  assert.equal(v.extra, undefined);
  assert.equal(v.numbers.length, 1);
});

test("recap from notes: where, decided, my open items, my promises, what they asked of me", () => {
  const rc = MV.recapFromMemory(sample());
  assert.equal(rc.where, "Renewal price");
  assert.deepEqual(rc.decided, ["Move on Thursday"]);
  assert.deepEqual(rc.open, ["Who owns the domain?"]);
  assert.deepEqual(rc.promised, ["send the offer"]);
  assert.deepEqual(rc.asked, ["Is backup included?"]);
});

test("parseRecapText reads partial and labelled streams, in any language, and ignores unlabelled text", () => {
  const p1 = MV.parseRecapText("WHERE: Pricing talk\nDECIDED: Thursday | Monthly bill");
  assert.equal(p1.labels, 2);
  assert.deepEqual(p1.recap.decided, ["Thursday", "Monthly bill"]);
  const p2 = MV.parseRecapText("junk before\nWHERE: איפה אנחנו\nOPEN:\n- שאלה אחת\n- שאלה שתיים\nASKED: חצי");
  assert.equal(p2.recap.where, "איפה אנחנו");
  assert.deepEqual(p2.recap.open, ["שאלה אחת", "שאלה שתיים"]);
  assert.deepEqual(p2.recap.asked, ["חצי"]);
  assert.equal(MV.parseRecapText("hello there").labels, 0);
  assert.equal(MV.parseRecapText("").labels, 0);
  assert.equal(MV.parseRecapText("OPEN: a; b; c; d; e").recap.open.length, 3);
});

test("overlayViewRow: view row from a full memory, from a bare view, and the ai state", () => {
  const full = MV.overlayViewRow(sample(), { ai: "paused", at: 5 });
  assert.equal(full.type, "view");
  assert.equal(full.now, "Renewal price");
  assert.equal(full.kind, "client");
  assert.equal(full.ai, "paused");
  assert.ok(full.promises.some((p: string) => p.includes("send the offer")));
  const bare = MV.overlayViewRow(toView(sample()), { ai: "weird" });
  assert.equal(bare.ai, "ok");
  assert.equal(bare.now, "Renewal price");
  assert.equal(MV.overlayViewRow(null).now, "");
});

test("openLoops and followupDraft use only memory lines and mark an empty draft", () => {
  const loops = MV.openLoops(sample());
  assert.equal(loops.promises.length, 1);
  assert.equal(loops.theirs.length, 1);
  assert.equal(loops.questions.length, 2);
  const labels = { hello: "Hi,", decided: "We decided:", weOwe: "From me:", youOwe: "From you:", open: "Still open:", bye: "Thanks" };
  const d = MV.followupDraft(sample(), { labels });
  assert.ok(d.text.startsWith("Hi,"));
  assert.ok(d.text.includes("- send the offer (Friday)"));
  assert.ok(d.text.includes("- Maya: send the product list"));
  assert.ok(d.text.endsWith("Thanks"));
  assert.equal(d.empty, false);
  assert.equal(MV.followupDraft(emptyMemory(0), { labels }).empty, true);
});

// ---- edits ----

const BAD_EDITS: [string, unknown][] = [
  ["null", null],
  ["array", []],
  ["string", "edit"],
  ["no op", { id: "f1", text: "x" }],
  ["unknown op", { op: "drop", id: "f1" }],
  ["bad id", { op: "remove", id: "x1" }],
  ["id zero", { op: "remove", id: "f0" }],
  ["id with path", { op: "remove", id: "f1/../x" }],
  ["id number", { op: "remove", id: 1 }],
  ["edit no text", { op: "edit", id: "f1" }],
  ["edit empty", { op: "edit", id: "f1", text: "   " }],
  ["edit only controls", { op: "edit", id: "f1", text: "\u0000‮" }],
  ["edit too long", { op: "edit", id: "f1", text: "x".repeat(201) }],
  ["edit huge", { op: "edit", id: "f1", text: "x".repeat(5000) }],
  ["edit number text", { op: "edit", id: "f1", text: 5 }],
  ["extra field", { op: "edit", id: "f1", text: "ok", src: "brief" }],
  ["remove with text", { op: "remove", id: "f1", text: "ok" }],
  ["add bad list", { op: "add", list: "roster", text: "x" }],
  ["add proto list", { op: "add", list: "__proto__", text: "x" }],
  ["add empty", { op: "add", list: "facts", text: "" }],
];
for (const [name, raw] of BAD_EDITS)
  test(`edit validator rejects: ${name}`, () => {
    const r = ME.validateEdit(raw);
    assert.equal(r.ok, false);
    assert.ok(typeof r.reason === "string" && r.reason.length > 0);
    // the engine side refuses the same thing and leaves the memory alone
    const m = sample();
    const a = applyUserEdit(m, raw, NOW + 1);
    assert.equal(a.applied, false);
    assert.equal(a.mem, m);
  });

test("edit validator cleans text and accepts the three ops", () => {
  assert.deepEqual(ME.validateEdit({ op: "edit", id: "f1", text: " a‏  b\n c " }), { ok: true, edit: { op: "edit", id: "f1", text: "a b c" } });
  assert.equal(ME.validateEdit({ op: "remove", id: "q12" }).ok, true);
  assert.equal(ME.validateEdit({ op: "add", list: "mustCover", text: "Price" }).ok, true);
  assert.equal(ME.validateEdit({ op: "edit", id: "f1", text: "ש".repeat(200) }).ok, true);
});

test("applyUserEdit: edit, remove (and the updater cannot add it back), add, version bump, schema stays valid", () => {
  let m = sample();
  const f1 = m.facts[0];
  let r = applyUserEdit(m, { op: "edit", id: f1.id, text: "Budget is 15k" }, NOW + 10);
  assert.equal(r.applied, true);
  assert.equal(r.mem.facts[0].text, "Budget is 15k");
  assert.equal(r.mem.facts[0].src, "user");
  assert.equal(r.mem.ver, m.ver + 1);
  assert.equal(m.facts[0].text, "Budget is 12k", "input is not changed");
  m = r.mem;
  r = applyUserEdit(m, { op: "remove", id: f1.id }, NOW + 20);
  assert.equal(r.applied, true);
  assert.ok(!r.mem.facts.some((f) => f.id === f1.id));
  assert.equal(r.mem.vetoed?.length, 2, "the old wording (edit) and the new one (remove) are both kept out");
  // the memory updater proposes the same line again: it stays out
  const again = applyPatch(r.mem, { add: { facts: [{ text: "Budget is 15k" }] } }, { now: NOW + 30 });
  assert.ok(!again.mem.facts.some((f) => f.text === "Budget is 15k"));
  // add
  r = applyUserEdit(r.mem, { op: "add", list: "commitments", text: "Call Maya" }, NOW + 40);
  assert.equal(r.applied, true);
  const c = r.mem.commitments.at(-1)!;
  assert.deepEqual([c.who, c.what, c.status], ["me", "Call Maya", "open"]);
  const dup = applyUserEdit(r.mem, { op: "add", list: "commitments", text: "call maya" }, NOW + 41);
  assert.equal(dup.applied, false);
  r = applyUserEdit(r.mem, { op: "add", list: "mustCover", text: "Downtime" }, NOW + 50);
  assert.equal(r.mem.mustCover.at(-1)!.done, false);
  assert.equal(checkMemory(JSON.parse(JSON.stringify(r.mem))).ok, true);
  // unknown id
  const miss = applyUserEdit(r.mem, { op: "remove", id: "f99" }, NOW + 60);
  assert.equal(miss.applied, false);
  assert.equal(miss.reason, "unknown id");
});

test("applyUserEdit: ids of new lines are never reused after a removal; a full list refuses an add", () => {
  let m = sample();
  const last = m.facts.at(-1)!;
  m = applyUserEdit(m, { op: "remove", id: last.id }, NOW + 1).mem;
  const a = applyUserEdit(m, { op: "add", list: "facts", text: "Something new" }, NOW + 2);
  assert.notEqual(a.mem.facts.at(-1)!.id, last.id);
  let full = emptyMemory(0);
  for (let i = 0; i < 30; i++) full = applyUserEdit(full, { op: "add", list: "facts", text: `fact number ${i}` }, i + 1).mem;
  assert.equal(full.facts.length, 30);
  const over = applyUserEdit(full, { op: "add", list: "facts", text: "one too many" }, 99);
  assert.equal(over.applied, false);
});

test("user edit queue: window appends, engine drains once, bad rows are skipped, torn lines wait", { ...POSIX }, () => {
  const dir = tmp();
  const q = new UserEditQueue(dir);
  const m = sample();
  assert.equal(q.drain(m, NOW).mem, m);
  assert.throws(() => queueUserEdit(dir, { op: "edit", id: "zz", text: "x" }), /bad id/);
  assert.equal(existsSync(join(dir, USER_EDITS_FILE)), false, "a bad edit writes nothing");
  queueUserEdit(dir, { op: "edit", id: m.facts[0].id, text: "Budget is 15k" });
  appendFileSync(join(dir, USER_EDITS_FILE), "not json\n" + JSON.stringify({ at: 1, edit: { op: "remove", id: "f77" } }) + "\n");
  queueUserEdit(dir, { op: "add", list: "decisions", text: "Ship it" });
  assert.equal(statSync(join(dir, USER_EDITS_FILE)).mode & 0o777, 0o600);
  const r = q.drain(m, NOW + 5);
  assert.equal(r.applied, 2);
  assert.equal(r.skipped, 2);
  assert.equal(r.mem.facts[0].text, "Budget is 15k");
  assert.equal(r.mem.decisions.at(-1)!.text, "Ship it");
  assert.equal(q.drain(r.mem, NOW + 6).applied, 0, "each row is applied once");
  // a half-written line is read later, not lost and not applied early
  const half = JSON.stringify({ at: 2, edit: { op: "add", list: "facts", text: "Late לילה" } });
  appendFileSync(join(dir, USER_EDITS_FILE), half.slice(0, 20));
  assert.equal(q.drain(r.mem, NOW + 7).applied, 0);
  appendFileSync(join(dir, USER_EDITS_FILE), half.slice(20) + "\n");
  const r2 = q.drain(r.mem, NOW + 8);
  assert.equal(r2.applied, 1);
  assert.equal(r2.mem.facts.at(-1)!.text, "Late לילה");
});

// ---- the answer window's memory feed ----

test("memory feed: session.json becomes a view row once per version; older and torn files are ignored", () => {
  const dir = tmp();
  const rows: Record<string, unknown>[] = [];
  const feed = createMemoryFeed({ send: (r: Record<string, unknown>) => rows.push(r), now: () => 7 });
  assert.equal(feed.fromDir(dir), false, "no file yet");
  const m = sample();
  writeFileSync(join(dir, "session.json"), JSON.stringify(m));
  assert.equal(feed.fromDir(dir), true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, "view");
  assert.equal(rows[0].now, "Renewal price");
  assert.equal(feed.fromDir(dir), false, "same file, nothing new");
  writeFileSync(join(dir, "session.json"), '{"v":1,"ver":'); // torn
  assert.equal(feed.fromDir(dir), false);
  writeFileSync(join(dir, "session.json"), JSON.stringify({ ...m, ver: m.ver - 1, topic: { now: "old", history: [] } }));
  assert.equal(feed.fromDir(dir), false, "an older version never replaces a newer one");
  writeFileSync(join(dir, "session.json"), JSON.stringify({ ...m, ver: m.ver + 1, topic: { now: "Next topic", history: [] } }));
  assert.equal(feed.fromDir(dir), true);
  assert.equal(rows.at(-1)!.now, "Next topic");
  assert.equal(parseMemory("[]"), null);
  assert.equal(parseMemory(JSON.stringify({ v: 2 })), null);
});

test("memory feed: relay rows, AI paused from health bars, and nothing blank", () => {
  const rows: Record<string, unknown>[] = [];
  const feed = createMemoryFeed({ send: (r: Record<string, unknown>) => rows.push(r) });
  assert.equal(feed.health({ id: "health-mic", level: "red" }), false, "other bars do not count");
  assert.equal(feed.health({ id: "health-ai", level: "amber" }), true);
  assert.equal(rows.at(-1)!.ai, "paused", "the pill shows even before the first memory");
  assert.equal(feed.fromRow({ type: "memory", view: toView(sample()) }), true);
  assert.equal(rows.at(-1)!.ai, "paused");
  assert.equal(rows.at(-1)!.now, "Renewal price");
  assert.equal(feed.health({ id: "health-ladder", level: "red" }), true);
  assert.equal(rows.at(-1)!.ai, "offline");
  feed.health({ id: "health-ladder", clear: true });
  assert.equal(feed.ai, "paused");
  feed.health({ id: "health-ai", clear: true });
  assert.equal(feed.ai, "ok");
  assert.equal(rows.at(-1)!.ai, "ok");
  assert.equal(feed.fromRow({ type: "memory", view: "bad" }), false);
  assert.equal(feed.fromRow({ type: "memory", view: { ...toView(sample()), ver: 0 } }), false, "older than on screen");
  assert.equal(feed.fromRow({ type: "memory", ai: "offline", view: toView(sample()) }), true, "an explicit ai state is a change");
  feed.reset();
  assert.equal(feed.ai, "ok");
});

test("recap rows are cleaned before they reach the page", () => {
  const feed = createMemoryFeed({ send() {} });
  assert.equal(feed.recap(null), null);
  assert.equal(feed.recap({ phase: "boom" }), null);
  const p = feed.recap({ phase: "delta", text: "WHERE: x", recap: { where: "w‮", decided: ["a", 5, "b", "c", "d"], bad: 1 }, offline: true });
  assert.equal(p.phase, "delta");
  assert.equal(p.recap.where, "w");
  assert.deepEqual(p.recap.decided, ["a", "b", "c"]);
  assert.equal(p.offline, true);
  assert.equal(feed.recap({ phase: "error" }).recap, null);
});

// ---- card controls ----

test("act: rate writes tags.jsonl in the dashboard format, a second rating replaces, none clears", { ...POSIX }, () => {
  const dir = tmp();
  writeFileSync(
    join(dir, "cards.jsonl"),
    [
      { id: "a1", badge: "ai", say: "x" },
      { id: "h1", badge: "warn", health: true },
      { id: "cap", type: "capture", value: "x" },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n",
  );
  const tags = () =>
    existsSync(join(dir, "tags.jsonl"))
      ? readFileSync(join(dir, "tags.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  assert.deepEqual(applyAct(dir, { kind: "rate", cardId: "a1", rating: "useful" }, NOW), { ok: true });
  assert.deepEqual(
    tags().map((t) => [t.id, t.useful, t.badge]),
    [["a1", "y", "ai"]],
  );
  assert.equal(statSync(join(dir, "tags.jsonl")).mode & 0o777, 0o600);
  applyAct(dir, { kind: "rate", cardId: "a1", rating: "not_useful" }, NOW);
  assert.deepEqual(
    tags().map((t) => t.useful),
    ["n"],
  );
  applyAct(dir, { kind: "rate", cardId: "a1", rating: "none" }, NOW);
  assert.deepEqual(tags(), []);
  assert.equal(applyAct(dir, { kind: "rate", cardId: "nope", rating: "useful" }, NOW).ok, false);
  assert.equal(applyAct(dir, { kind: "rate", cardId: "h1", rating: "useful" }, NOW).ok, false, "a health bar is not ratable");
  assert.equal(applyAct(dir, { kind: "rate", cardId: "cap", rating: "useful" }, NOW).ok, false);
});

test("act: pin, unpin, dismiss and recap are appended as events; anything else is refused", { ...POSIX }, () => {
  const dir = tmp();
  for (const name of ["pin", "unpin", "dismiss", "recap"]) assert.equal(applyAct(dir, { kind: "event", cardId: "a1", name }, NOW).ok, true);
  const rows = readFileSync(join(dir, "overlay-events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    rows.map((r) => r.name),
    ["pin", "unpin", "dismiss", "recap"],
  );
  assert.equal(rows[0].type, "overlay");
  for (const bad of [
    null,
    {},
    { kind: "event", cardId: "", name: "pin" },
    { kind: "event", cardId: "a", name: "delete" },
    { kind: "rate", cardId: "a", rating: "great" },
    { kind: "exec", cardId: "a" },
    "pin",
  ])
    assert.equal(applyAct(dir, bad, NOW).ok, false);
  assert.equal(readFileSync(join(dir, "overlay-events.jsonl"), "utf8").trim().split("\n").length, 4);
  assert.equal(applyAct(join(dir, "missing", "deeper"), { kind: "event", cardId: "a", name: "pin" }, NOW).ok, false, "an I/O error is a result, not a throw");
});

test("applyUserEdit: the old wording of an edited line cannot come back; the veto list stays within 40; garbage never throws", () => {
  const m = sample();
  const r = applyUserEdit(m, { op: "edit", id: m.facts[0].id, text: "Budget is 15k" }, NOW + 1);
  const again = applyPatch(r.mem, { add: { facts: [{ text: "Budget is 12k" }] } }, { now: NOW + 2 });
  assert.ok(!again.mem.facts.some((f) => f.text === "Budget is 12k"), "old wording stays out");
  let cur = r.mem;
  for (let i = 0; i < 60; i++) {
    cur = applyUserEdit(cur, { op: "add", list: "decisions", text: `Decision number ${i} here` }, NOW + 10 + i).mem;
    const d = cur.decisions.at(-1)!;
    cur = applyUserEdit(cur, { op: "remove", id: d.id }, NOW + 100 + i).mem;
  }
  assert.ok((cur.vetoed ?? []).length <= 40);
  assert.equal(checkMemory(JSON.parse(JSON.stringify(cur))).ok, true);
  for (const bad of [
    null,
    5,
    "x",
    [],
    {},
    { op: "remove" },
    { op: "remove", id: "f1", extra: 1 },
    { op: "edit", id: "x9", text: "a" },
    { op: "add", list: "roster", text: "a" },
  ]) {
    const x = applyUserEdit(m, bad, NOW);
    assert.equal(x.applied, false);
    assert.equal(x.mem, m);
  }
  const long = applyUserEdit(m, { op: "edit", id: m.facts[0].id, text: "x".repeat(201) }, NOW);
  assert.equal(long.applied, false);
  const bidi = applyUserEdit(m, { op: "edit", id: m.facts[0].id, text: "a\u202Eb\u0000c\nd" }, NOW);
  assert.equal(bidi.mem.facts[0].text, "abc d");
});

test("memory feed: a torn session.json is read again on the next call even when its size and time are unchanged", () => {
  const dir = tmp();
  const rows: Record<string, unknown>[] = [];
  const feed = createMemoryFeed({ send: (r: Record<string, unknown>) => rows.push(r), now: () => 7 });
  const f = join(dir, "session.json");
  const good = JSON.stringify(sample());
  writeFileSync(f, good.slice(0, 20));
  assert.equal(feed.fromDir(dir), false);
  writeFileSync(f, good);
  assert.equal(feed.fromDir(dir), true);
});
