// Prepared meetings: the pure rules (shared/plans.js) and the store (tray/plans.cjs). Offline, temp folders, invented data only.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBrief, briefNotes } from "./brief.ts";

const req = createRequire(import.meta.url);
const P = req("../shared/plans.js");
const { createPlanStore } = req("../tray/plans.cjs");
const attachments = req("../tray/attachments.cjs");

const HOUR = 3600_000, DAY = 24 * HOUR;
const T0 = new Date(2026, 10, 3, 9, 0).getTime();   // Tue 3 Nov 2026, 09:00 local
const at = (h: number, m = 0, d = 0) => new Date(2026, 10, 3 + d, h, m).getTime();
function rig(start = T0) {
  const dir = mkdtempSync(join(tmpdir(), "wm-plans-"));
  let t = start;
  const store = createPlanStore({ dir, now: () => t, pdftotext: "" });
  return { dir, store, now: () => t, tick: (ms: number) => { t += ms; }, set: (ms: number) => { t = ms; }, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("rules: a timed meeting lives until 6 h after its time, an untimed one 14 days after the last edit, a used one 7 days", () => {
  const timed = { id: "m1", at: at(14, 30), createdAt: T0, updatedAt: T0, usedAt: 0 };
  assert.equal(P.expiresAt(timed), at(14, 30) + 6 * HOUR);
  assert.equal(P.statusOf(timed, at(20, 29)), "ready"); assert.equal(P.statusOf(timed, at(20, 30)), "expired");
  const untimed = { id: "m2", at: 0, createdAt: T0, updatedAt: T0 + DAY, usedAt: 0 };
  assert.equal(P.expiresAt(untimed), T0 + 15 * DAY, "the cap counts from the last edit");
  assert.equal(P.statusOf(untimed, T0 + 14 * DAY), "ready");
  const used = { ...timed, usedAt: at(14, 40) };
  assert.equal(P.statusOf(used, at(15)), "used"); assert.equal(P.statusOf(used, at(14, 40) + 7 * DAY), "expired");
});

test("rules: order is soonest first (timed before untimed); next and due-now use the 30 minute window", () => {
  const m = (id: string, atMs: number, upd = 1) => ({ id, at: atMs, createdAt: T0, updatedAt: upd, usedAt: 0, who: id });
  const list = [m("c", 0, 5), m("b", at(16)), m("a", at(14, 30)), m("d", 0, 9), m("past", at(8))];
  assert.deepEqual(P.order(list).map((x: any) => x.id), ["past", "a", "b", "d", "c"]);
  const now = at(14, 10);
  assert.equal(P.nextMeeting(list, now).id, "a", "the 08:00 one is past the window, so it is not 'next'");
  assert.deepEqual(P.dueNow(list, now).map((x: any) => x.id), ["a"]);
  assert.deepEqual(P.dueNow(list, at(15, 15)).map((x: any) => x.id), [], "15:15 is 45 min from 16:00 and 45 min after 14:30");
  assert.deepEqual(P.dueNow(list, at(15, 45)).map((x: any) => x.id), ["b"]);
});

test("rules: practiceDefault is the next meeting, else the only one, else none", () => {
  const m = (id: string, atMs = 0) => ({ id, at: atMs, createdAt: T0, updatedAt: T0, usedAt: 0 });
  assert.equal(P.practiceDefault([], T0), null);
  assert.equal(P.practiceDefault([m("a")], T0).id, "a");
  assert.equal(P.practiceDefault([m("a"), m("b")], T0), null);
  assert.equal(P.practiceDefault([m("a"), m("b", at(14))], T0).id, "b");
});

test("rules: time parsing and labels", () => {
  assert.equal(P.parseAt("2026-11-03 14:30", T0), at(14, 30));
  assert.equal(P.parseAt("2026-11-03T14:30", T0), at(14, 30));
  assert.equal(P.parseAt("14:30", T0), at(14, 30));
  assert.equal(P.parseAt("2026-11-03T12:30:00Z", T0), Date.parse("2026-11-03T12:30:00Z"));
  assert.equal(P.parseAt("", T0), 0); assert.equal(P.parseAt("none", T0), 0);
  for (const bad of ["tomorrow", "2026-02-30 10:00", "2026-11-03 25:00", "25:99", "2026-11-03"]) assert.throws(() => P.parseAt(bad, T0), /not a time/, bad);
  assert.throws(() => P.parseAt("2026-11-02 08:00", T0), /6 hours ago/);
  assert.throws(() => P.parseAt("2027-06-01 08:00", T0), /90 days/);
  assert.equal(P.formatAt(at(14, 30), T0), "Today 14:30"); assert.equal(P.formatAt(at(9, 5, 1), T0), "Tomorrow 09:05");
  assert.equal(P.formatAt(at(9, 0, 2), T0), "Thu 5 Nov 09:00"); assert.equal(P.formatAt(0, T0), "");
  assert.equal(P.toInputValue(at(14, 30)), "2026-11-03T14:30");
  assert.equal(P.label({ title: "T", who: "W" }), "T"); assert.equal(P.label({ who: "Dana, Acme" }), "Dana, Acme"); assert.equal(P.label({}), "Prepared meeting");
  assert.equal(P.menuLabel({ who: "Dana · Acme", at: at(14, 30) }, T0), "Dana · Acme (Today 14:30)");
  assert.ok(P.menuLabel({ who: "x".repeat(200) }, T0).length <= 64);
});

test("store: create, list in order, edit, delete; fields are cleaned and capped", () => {
  const r = rig();
  try {
    const a = r.store.create({ who: "Dana, Acme", goal: "agree the migration date", kind: "client", topic: "hosting move", notes: "prefers WhatsApp; calls after 5", mustCover: ["price", "downtime"], at: at(14, 30) });
    assert.equal(a.ok, true, a.error);
    assert.match(a.meeting.id, /^m[0-9a-z]{6,12}$/);
    assert.deepEqual(a.meeting.notes, ["prefers WhatsApp", "calls after 5"]);
    r.tick(1000);
    const b = r.store.create({ title: "Quarterly check-in\u0000‮", who: "Noam, Beta Ltd" });
    assert.equal(b.meeting.title, "Quarterly check-in", "control and bidi-override characters are removed");
    const c = r.store.create({ who: "Early bird", at: at(10) });
    assert.deepEqual(r.store.list().map((m: any) => m.who), ["Early bird", "Dana, Acme", "Noam, Beta Ltd"]);
    assert.equal(r.store.create({}).ok, false); assert.match(r.store.create({}).error, /at least one/i);
    assert.match(r.store.create({ who: "x", at: "nonsense" }).error, /not a time/);
    r.tick(1000);
    const e = r.store.update(a.meeting.id, { goal: "new goal", mustCover: ["price", "downtime", "backups"] });
    assert.equal(e.meeting.who, "Dana, Acme", "untouched fields are kept"); assert.equal(e.meeting.goal, "new goal"); assert.equal(e.meeting.mustCover.length, 3);
    assert.equal(r.store.update(a.meeting.id, { at: "none" }).meeting.at, 0, "a time can be removed");
    assert.equal(r.store.update("m999999", { who: "x" }).ok, false);
    assert.equal(r.store.remove(c.meeting.id).ok, true);
    assert.equal(existsSync(r.store.dirOf(c.meeting.id)), false, "the folder is gone");
    assert.equal(r.store.list().length, 2);
    assert.equal(r.store.remove(c.meeting.id).ok, false);
    const mode = statSync(join(r.store.dirOf(a.meeting.id), "meeting.json")).mode & 0o777;
    assert.equal(mode, 0o600); assert.equal(statSync(r.store.dirOf(a.meeting.id)).mode & 0o777, 0o700);
  } finally { r.done(); }
});

test("store: several meetings at once, at most 30, ids resolve by unique prefix", () => {
  const r = rig();
  try {
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) { r.tick(7); const x = r.store.create({ who: "M" + i }); assert.equal(x.ok, true, x.error); ids.push(x.meeting.id); }
    assert.match(r.store.create({ who: "one too many" }).error, /At most 30/);
    assert.equal(r.store.get(ids[3]).who, "M3");
    assert.equal(r.store.resolve("m").error, "not_found", "too short");
    const common = ids[0].slice(0, 3);
    assert.equal(r.store.resolve(common).error, "ambiguous");
    assert.equal(r.store.resolve("ZZZ").error, "not_found");
  } finally { r.done(); }
});

test("store: a timed meeting expires 6 h after its time and its folder is removed; an untimed one after 14 days", () => {
  const r = rig();
  try {
    const timed = r.store.create({ who: "Timed", at: at(14, 30) }).meeting;
    const loose = r.store.create({ who: "Loose" }).meeting;
    r.set(at(20, 29)); assert.equal(r.store.list().length, 2);
    r.set(at(20, 31)); assert.deepEqual(r.store.list().map((m: any) => m.who), ["Loose"]);
    assert.equal(existsSync(r.store.dirOf(timed.id)), false, "expired meetings are deleted, with their files");
    r.set(T0 + 13 * DAY); assert.equal(r.store.list().length, 1);
    r.set(T0 + 14 * DAY + HOUR); assert.equal(r.store.list().length, 0);
    assert.equal(existsSync(r.store.dirOf(loose.id)), false);
    r.set(T0 + 20 * DAY);
    assert.match(r.store.create({ who: "Late", at: T0 }).error, /6 hours ago/);
  } finally { r.done(); }
});

test("store: editing an untimed meeting refreshes its 14 day cap", () => {
  const r = rig();
  try {
    const m = r.store.create({ who: "Loose" }).meeting;
    r.set(T0 + 10 * DAY); r.store.update(m.id, { goal: "touched" });
    r.set(T0 + 20 * DAY); assert.equal(r.store.list().length, 1);
    r.set(T0 + 25 * DAY); assert.equal(r.store.list().length, 0);
  } finally { r.done(); }
});

test("store: markUsed uses up only that meeting, drops its files, keeps it 7 days for the Calls view", async () => {
  const r = rig();
  try {
    const a = r.store.create({ who: "Dana", at: at(14, 30) }).meeting, b = r.store.create({ who: "Noam", at: at(16) }).meeting;
    await r.store.files(a.id).addPaste("Invented background: Acme runs 12 WordPress sites.");
    await r.store.files(b.id).addPaste("Invented background: Beta Ltd sells shoes online.");
    assert.equal(r.store.get(a.id).files, 1);
    r.set(at(14, 31));
    assert.equal(r.store.markUsed(a.id, "01CALLID"), true);
    assert.equal(r.store.markUsed(a.id, "01OTHER"), false, "already used");
    assert.deepEqual(r.store.list().map((m: any) => m.who), ["Noam"], "a used meeting is not offered any more");
    const all = r.store.list({ includeUsed: true });
    assert.deepEqual(all.map((m: any) => [m.who, m.status]), [["Noam", "ready"], ["Dana", "used"]]);
    const used = all[1];
    assert.equal(used.callId, "01CALLID"); assert.equal(used.files, 0, "background files are dropped once used");
    assert.equal(r.store.get(b.id).files, 1, "the other meeting keeps its files");
    assert.equal(r.store.exportBrief(a.id), null, "a used meeting cannot start another call");
    assert.equal(r.store.update(a.id, { who: "x" }).ok, false);
    r.set(at(14, 31) + 8 * DAY); assert.equal(r.store.list({ includeUsed: true }).length, 0);
  } finally { r.done(); }
});

test("store: exportBrief writes the file the engine reads (--brief), kind and topic as notes, and the files folder", async () => {
  const r = rig();
  try {
    const m = r.store.create({ title: "Hosting move", who: "Dana, Acme", goal: "agree a date", kind: "vendor", topic: "hosting move", notes: ["prefers WhatsApp"], mustCover: ["price", "downtime"] }).meeting;
    await r.store.files(m.id).addPaste("Invented background text for the AI.");
    const x = r.store.exportBrief(m.id)!;
    assert.ok(x.briefFile.endsWith("brief.yaml") && x.attachDir.endsWith("files"));
    const b = loadBrief(x.briefFile) as any;
    assert.equal(b.who, "Dana, Acme"); assert.deepEqual(b.mustCover, ["price", "downtime"]); assert.equal(b.planId, m.id);
    assert.deepEqual(briefNotes(b), ["On this call: Dana, Acme", "Goal of the call: agree a date", "Call kind: vendor", "Topic: hosting move", "prefers WhatsApp"]);
    assert.ok(existsSync(x.briefFile), "loadBrief with an explicit file never consumes it");
    assert.equal(attachments.createStore({ dir: x.attachDir, maxAgeMs: 400 * DAY, pdftotext: "" }).readAll({}).length, 1);
  } finally { r.done(); }
});

test("store: the draft's background files move into the meeting when it is saved; Cancel throws them away", async () => {
  const r = rig();
  try {
    await r.store.files("").addPaste("Invented draft background.");
    assert.equal(r.store.files("").list().files.length, 1);
    const m = r.store.create({ who: "Dana" }, { adoptDraft: true }).meeting;
    assert.equal(m.files, 1); assert.equal(r.store.files("").list().files.length, 0);
    await r.store.files("").addPaste("Another draft.");
    r.store.discardDraft(); assert.equal(r.store.files("").list().files.length, 0);
    assert.deepEqual(r.store.list().map((x: any) => x.id), [m.id], "the draft is never listed as a meeting");
  } finally { r.done(); }
});

test("store: background files are not limited to 6 hours any more (the meeting's own expiry decides)", async () => {
  const r = rig();
  try {
    const m = r.store.create({ who: "Dana", at: at(9, 0, 5) }).meeting;
    await r.store.files(m.id).addPaste("Invented background.");
    r.set(T0 + 3 * DAY); assert.equal(r.store.get(m.id).files, 1);
  } finally { r.done(); }
});

test("migration: the old single Plan and its background files become ONE prepared meeting, nothing lost", async () => {
  const r = rig();
  try {
    // the old layout: latest.yaml plus flat attachments/ (written the way earlier versions did)
    const yaml = 'who: "Dana Levi, Levi Studio"\ngoal: "agree a migration date"\nnotes: ["Call kind: vendor","Topic: hosting move","prefers WhatsApp"]\nmustCover: ["price","downtime window"]\ncreatedAt: "2026-11-03T05:00:00.000Z"\n';
    writeFileSync(join(r.dir, "latest.yaml"), yaml, { mode: 0o600 });
    const old = attachments.createStore({ dir: join(r.dir, "attachments"), now: r.now, pdftotext: "" });
    assert.equal(old.addPaste("Invented background: Levi Studio runs 12 WordPress sites.").ok, true);
    assert.equal((await old.addFile("offer.md", Buffer.from("# Offer\nHosting 49 per month (invented)."))).ok, true);
    const stamp = new Date(2026, 10, 3, 8, 0); utimesSync(join(r.dir, "latest.yaml"), stamp, stamp);
    const list = r.store.list();
    assert.equal(list.length, 1, "exactly one meeting");
    const m = list[0];
    assert.equal(m.who, "Dana Levi, Levi Studio"); assert.equal(m.goal, "agree a migration date");
    assert.equal(m.kind, "vendor"); assert.equal(m.topic, "hosting move"); assert.deepEqual(m.notes, ["prefers WhatsApp"]); assert.deepEqual(m.mustCover, ["price", "downtime window"]);
    assert.equal(m.at, 0, "no time"); assert.equal(m.files, 2, "both background files came along");
    assert.deepEqual(m.fileList.map((f: any) => f.name).sort(), ["offer", "pasted text"]);
    assert.equal(existsSync(join(r.dir, "latest.yaml")), false, "the old file is gone");
    assert.deepEqual(readdirSync(join(r.dir, "attachments")), [], "the flat attachments moved");
    assert.equal(r.store.list().length, 1, "running it again changes nothing");
    // the migrated meeting can start a call like any other
    assert.ok(r.store.exportBrief(m.id));
  } finally { r.done(); }
});

test("migration: a crash after the meeting was written but before latest.yaml was removed does not make a second copy", () => {
  const r = rig();
  try {
    writeFileSync(join(r.dir, "latest.yaml"), 'who: "Dana"\nnotes: []\nmustCover: []\n', { mode: 0o600 });
    const first = r.store.list(); assert.equal(first.length, 1);
    writeFileSync(join(r.dir, "latest.yaml"), 'who: "Dana"\nnotes: []\nmustCover: []\n');   // the old file comes back, with the same time as before
    utimesSync(join(r.dir, "latest.yaml"), new Date(first[0].createdAt), new Date(first[0].createdAt));
    assert.equal(r.store.list().length, 1);
    assert.equal(existsSync(join(r.dir, "latest.yaml")), false);
  } finally { r.done(); }
});

test("migration: nothing to migrate is a no-op; a broken old file does not hide new meetings; read-only mode touches nothing", () => {
  const r = rig(), ro = rig();
  try {
    assert.deepEqual(r.store.list(), []);
    writeFileSync(join(r.dir, "latest.yaml"), ": : not yaml [", { mode: 0o600 });
    assert.equal(r.store.create({ who: "New one" }).ok, true);
    assert.ok(r.store.list().some((m: any) => m.who === "New one"));
    writeFileSync(join(ro.dir, "latest.yaml"), 'who: "Dana"\n');
    const rs = createPlanStore({ dir: ro.dir, now: ro.now, readOnly: true });
    assert.deepEqual(rs.list(), []); assert.equal(existsSync(join(ro.dir, "latest.yaml")), true, "snapshot mode never migrates or deletes");
  } finally { r.done(); ro.done(); }
});

test("migration: an old Plan past the old 6 h rule still migrates (not silently dropped), with the new 14 day cap from its file time", () => {
  const r = rig();
  try {
    writeFileSync(join(r.dir, "latest.yaml"), 'who: "Old plan"\nnotes: []\nmustCover: []\n');
    const stamp = new Date(T0 - 3 * DAY); utimesSync(join(r.dir, "latest.yaml"), stamp, stamp);
    const l = r.store.list(); assert.equal(l.length, 1, "kept, not silently dropped");
    r.set(T0 + 12 * DAY); assert.equal(r.store.list().length, 0, "gone 14 days after the old file time");
  } finally { r.done(); }
});

test("files: a meeting folder is the only place its background lives, and it is created owner-only", async () => {
  const r = rig();
  try {
    const m = r.store.create({ who: "Dana" }).meeting;
    await r.store.files(m.id).addPaste("Invented text.");
    const f = join(r.store.dirOf(m.id), "files");
    assert.equal(statSync(f).mode & 0o777, 0o700);
    const n = readdirSync(f)[0]; assert.equal(statSync(join(f, n)).mode & 0o777, 0o600);
    assert.equal(r.store.files("nope"), null);
    mkdirSync(join(r.dir, "plans", "junk"), { recursive: true });
    assert.equal(r.store.list().length, 1, "stray folders are ignored");
  } finally { r.done(); }
});
