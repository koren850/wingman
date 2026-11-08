// Round 12, r3-features, window side: the mode picker data and command, card trust (source line, what the card saw), the Held back list and its ratings reaching
// learn.ts, the learning reset, the stored "Last time" list, speech ring for nudges, and the new snapshot rules. No Electron, no model, no network.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteCallEnd, noteWanted, learnSummary, resetLearning, loadLearning, _dropLearnCache } from "./moments/learn.ts";
import { SpeechRing } from "./session/coaching.ts";
import { handle, readModes } from "./features-cli.ts";
import { CALLS, USER_DATA, ROOT } from "./env.ts";
import { saveMemory } from "./session/store.ts";
import { emptyMemory } from "./session/types.ts";
import { PEOPLE_FILE, indexFinishedCalls, unblockPast } from "./session/people.ts";

const req = createRequire(import.meta.url);
const M = req("../dashboard/modelib.js");
const F = req("../dashboard/featureslib.cjs");
const Trust = req("../dashboard/trustlib.js");
const KN = req("../dashboard/knowslib.js");
const LF = req("../dashboard/livefeed.js");
const SC = req("../dashboard/snapcheck.cjs");
const V2 = req("../overlay/v2.js");
const EN = req("../dashboard/strings.en.js");
const HE = req("../dashboard/strings.he.js");
const OV = req("../overlay/strings.js");
const tmp = () => mkdtempSync(join(tmpdir(), "r3fu-"));

// ---------------------------------------------------------------- mode picker
test("picker: auto shows the guess, locked shows the kind, custom modes are listed, unknown ids are refused", () => {
  const custom = [
    { id: "standup", label: "Standup" },
    { id: "client", label: "x" },
    { id: "bad id", label: "y" },
    { id: "retro", label: "<b>Retro</b>" },
  ];
  assert.deepEqual(M.cleanModes(custom), [
    { id: "standup", label: "Standup" },
    { id: "retro", label: "<b>Retro</b>" }, // text stays text: the page uses textContent
  ]);
  assert.equal(M.cleanModes(Array.from({ length: 12 }, (_, i) => ({ id: "m" + i, label: "m" + i }))).length, 6, "at most 6");
  assert.deepEqual(M.pickerState({ kind: "support", kindLocked: false }, []), { shown: "support", locked: false, guess: true, value: "auto" });
  assert.deepEqual(M.pickerState({ kind: "support", kindLocked: true }, []), { shown: "support", locked: true, guess: false, value: "support" });
  assert.deepEqual(M.pickerState({ kind: "standup", kindLocked: true }, custom), { shown: "standup", locked: true, guess: false, value: "standup" });
  assert.equal(M.pickerState({ kind: "standup", kindLocked: true }, []).shown, "", "a custom mode that is not listed shows nothing");
  assert.equal(M.pickerState(null, []).value, "auto");
  assert.deepEqual(
    M.options([{ id: "standup" }]).map((o: { id: string }) => o.id),
    ["auto", ...M.KINDS, "standup"],
  );
  const T = (k: string) => (EN as Record<string, string>)[k] ?? k;
  assert.equal(M.labelOf("auto", T, []), "Auto");
  assert.equal(M.labelOf("client", T, []), "Client");
  assert.equal(M.labelOf("standup", T, custom), "Standup");
});

test("picker: the knows model carries kind and kindLocked from the memory, custom ids included", () => {
  const m = KN.fromMemory({ ver: 3, kind: "standup", kindLocked: true, topic: { now: "x" }, facts: [] });
  assert.equal(m.kind, "standup");
  assert.equal(m.kindLocked, true);
  assert.equal(KN.fromMemory({ ver: 1, kind: "<script>", topic: {} }).kind, undefined);
  assert.equal(KN.fromMemory({ ver: 1, kind: "client", topic: {} }).kindLocked, false);
});

/** A fake controller that sends the line the real one sends down the control socket ("mode <kind>") to a recorder. */
function fakeController(live = true) {
  const sent: string[] = [];
  return { sent, mode: (k: string) => (live ? (sent.push(`mode ${k}`), true) : false) };
}
test("picker: choosing a mode sends the mode command to the running call (fake control socket)", () => {
  const c = fakeController();
  assert.deepEqual(F.setMode(c, "support", []), { ok: true, kind: "support" });
  assert.deepEqual(F.setMode(c, "auto", []), { ok: true, kind: "auto" });
  assert.deepEqual(F.setMode(c, "standup", [{ id: "standup", label: "S" }]), { ok: true, kind: "standup" });
  assert.deepEqual(c.sent, ["mode support", "mode auto", "mode standup"]);
  for (const bad of ["standup", "rm -rf", "", "client\nstop", 5, null]) assert.equal(F.setMode(c, bad as never, []).ok, false, String(bad));
  assert.equal(c.sent.length, 3, "nothing else reached the socket");
  assert.equal(F.setMode(fakeController(false), "client", []).error, "no-call");
  assert.equal(F.setMode({}, "client", []).error, "unavailable", "an app without the mode command says so");
});

test("custom modes: modes.yaml in the pack is read for the picker (id and label only, at most 6)", () => {
  const d = tmp();
  writeFileSync(
    join(d, "modes.yaml"),
    "modes:\n" +
      [1, 2, 3, 4, 5, 6, 7].map((i) => `  - id: m${i}\n    label: Mode ${i}\n    instructions: secret text ${i}\n`).join("") +
      "  - id: 'bad id'\n    label: x\n",
  );
  const got = readModes([d]);
  assert.equal(got.length, 6);
  assert.deepEqual(got[0], { id: "m1", label: "Mode 1" });
  assert.ok(!JSON.stringify(got).includes("secret"));
  assert.deepEqual(readModes([tmp()]), []);
});

test("picker: the window preload sends the mode as a fixed command with a string argument", () => {
  const calls: unknown[][] = [];
  const fake = {
    contextBridge: { exposeInMainWorld: (_n: string, api: Record<string, (...a: unknown[]) => unknown>) => (exposed = api) },
    ipcRenderer: { invoke: (...a: unknown[]) => (calls.push(a), Promise.resolve({ ok: true })), on: () => {}, send: () => {} },
  };
  let exposed: Record<string, (...a: unknown[]) => unknown> = {};
  const Mod = createRequire(import.meta.url)("node:module") as { _load: (...a: unknown[]) => unknown };
  const orig = Mod._load;
  Mod._load = (r: unknown, ...rest: unknown[]) => (r === "electron" ? fake : orig.call(Mod, r, ...rest));
  try {
    createRequire(import.meta.url)(join(ROOT, "dashboard/preload.cjs"));
  } finally {
    Mod._load = orig;
  }
  exposed.setMode({ evil: 1 });
  exposed.setMode("support");
  exposed.setPlanKind("m1abcdefg", "standup");
  exposed.rateHeld("01CALL", "d1:2", "wanted");
  assert.deepEqual(calls[0], ["call:cmd", "mode", "[object Object]"], "an object becomes a string the main process refuses");
  assert.deepEqual(calls[1], ["call:cmd", "mode", "support"]);
  assert.deepEqual(calls[2], ["plans:setKind", "m1abcdefg", "standup"]);
  assert.deepEqual(calls[3], ["held:rate", "01CALL", "d1:2", "wanted"]);
});

// ---------------------------------------------------------------- the overlay pill data
test("overlay: the view row keeps kind and kindLocked, and a view without a kind has none", () => {
  const v = V2.normView({ kind: "interview", kindLocked: true });
  assert.equal(v.kind, "interview");
  assert.equal(v.kindLocked, true);
  assert.equal(V2.normView({}).kind, "");
  assert.equal(V2.normView({ kind: "support" }).kindLocked, false);
});

// ---------------------------------------------------------------- card trust
const rows = [
  { ch: "them", text: "Can you migrate the sites before March?", t: 1000 },
  { ch: "me", text: "I think so, let me check.", t: 4000 },
  { ch: "them", text: "And what is the price for the backups plan?", t: 9000 },
  { ch: "them", text: "Thanks", t: 12000 },
];
test("trust: Show the line finds the line by its text, else the last line of the right side before the card, and says -1 when there is none", () => {
  assert.equal(Trust.sourceLine(rows, { question: "And what is the price for the backups plan?", t: 9500, badge: "ai" }), 2);
  assert.equal(
    Trust.sourceLine(rows, { question: "Can you migrate the sites before March?", t: 20000, badge: "ai" }),
    0,
    "an older line is still found by its text",
  );
  assert.equal(Trust.sourceLine(rows, { question: "unknown words here", t: 9500, badge: "ai" }), 2, "no text match: the last other-side line before the card");
  assert.equal(Trust.sourceLine(rows, { question: "", t: 5000, badge: "me" }), 1, "a card for the user points at the user's line");
  assert.equal(Trust.sourceLine([], { question: "x", t: 1 }), -1);
  assert.equal(Trust.sourceLine(rows, null), -1);
});

test("trust: What this card saw lists memory version, chunk sources, trimmed parts and tokens; a legacy row says it has none", () => {
  const s = Trust.cardSaw({
    ctx: {
      role: "observer",
      memV: 7,
      tokens: 1130,
      parts: { rules: 300, memory: 420, rawTail: 310, trigger: 100 },
      trimmed: ["retrieved", "memory:facts"],
      chunks: [{ id: "c1", source: "backup-policy.md" }, "c2"],
    },
  });
  assert.equal(s.legacy, false);
  assert.equal(s.memV, 7);
  assert.equal(s.tokens, 1130);
  assert.deepEqual(
    s.parts.map((p: { name: string }) => p.name),
    ["memory", "rawTail", "rules", "trigger"],
    "biggest first",
  );
  assert.deepEqual(s.trimmed, ["retrieved", "memory:facts"]);
  assert.deepEqual(s.chunks, [
    { id: "c1", source: "backup-policy.md" },
    { id: "c2", source: "" },
  ]);
  // sources can come as a parallel list from a newer engine
  assert.equal(Trust.cardSaw({ ctx: { memV: 1, tokens: 1, parts: { a: 1 }, chunks: ["x"], sources: ["notes.txt"] } }).chunks[0].source, "notes.txt");
  for (const legacy of [{}, { ctx: null }, { ctx: "x" }, { ctx: [] }, null]) assert.deepEqual(Trust.cardSaw(legacy as never), { legacy: true });
  // hostile values stay plain
  const h = Trust.cardSaw({
    ctx: { memV: "x", tokens: NaN, parts: { "<b>": 5, ok: Infinity }, trimmed: ["<i>x‮"], chunks: [{ id: "a\u0000b", source: "z".repeat(500) }] },
  });
  assert.equal(h.memV, null);
  assert.ok(h.chunks[0].source.length <= 80);
  assert.doesNotMatch(JSON.stringify(h), /\\u202e|\\u0000/);
});

test("trust: the live feed passes ctx through cleaned, and a card without ctx stays a plain card", () => {
  const card = (o: object) => ({ id: "k1", badge: "ai", say: "Yes.", question: "q?", t: 5, ...o });
  const c = LF.cleanCard(card({ ctx: { memV: 2, tokens: 10, parts: { memory: 10, "bad key!": 4 }, trimmed: [], chunks: [{ id: "c1", source: "a.md" }] } }));
  assert.deepEqual(Object.keys(c.ctx.parts), ["memory"]);
  assert.deepEqual(c.ctx.chunks, [{ id: "c1", source: "a.md" }]);
  assert.equal(LF.cleanCard(card({})).ctx, undefined);
  assert.equal(LF.cleanCard(card({ ctx: "x" })).ctx, undefined);
});

// ---------------------------------------------------------------- Held back and learning
function heldCall() {
  const calls = tmp();
  const id = "01HELDCALL0000000000000001";
  const dir = join(calls, id);
  mkdirSync(dir);
  const ev = [
    { type: "start", t: 1000 },
    { type: "moment.skip", t: 5000, turnId: "t1", source: "observer", why: "model-skip" },
    { type: "moment.drop", t: 9500, turnId: "t3", source: "direct", why: "guard:price", tag: "NOTE" },
    { type: "moment.chip", t: 10000, turnId: "t5", source: "observer", why: "per-minute-cap", tag: "PROMPT" },
    { type: "moment.drop", t: 12500, turnId: "t4", source: "observer", why: "stale-turn", tag: "bad tag!" },
  ];
  writeFileSync(join(dir, "events.jsonl"), ev.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { calls, id, dir, ev };
}
test("held back: skipped and dropped moments with the reason and the line before them (shown chips are not held back)", () => {
  const { ev } = heldCall();
  const list = Trust.heldBack(ev, rows, {});
  assert.deepEqual(
    list.map((x: { group: string; reason: string; tag: string }) => [x.group, x.reason, x.tag]),
    [
      ["skipped", "model-skip", ""],
      ["dropped", "guard:price", "NOTE"],
      ["dropped", "stale-turn", ""],
    ],
  );
  assert.equal(list[1].line, "And what is the price for the backups plan?");
  assert.equal(list[0].line, "Can you migrate the sites before March?", "the last line of the other side before it");
  assert.equal(list[1].learns, true);
  assert.equal(list[0].learns, false);
  assert.equal(new Set(list.map((x: { key: string }) => x.key)).size, 3, "stable, distinct keys");
  assert.equal(Trust.heldBack(ev, rows, { [list[1].key]: "wanted", zzz: "x", "bad key": "wanted" })[1].rating, "wanted");
  assert.deepEqual(Trust.heldBack(null, null, null), []);
});

test("held back: a rating is stored next to the call, 'I wanted this' reaches learn.ts once, and nothing else can be rated", () => {
  const { calls, id, dir, ev } = heldCall();
  const list = Trust.heldBack(ev, rows, {});
  const dropped = list[1];
  const r1 = F.rateHeld(calls, id, dropped.key, "wanted");
  assert.equal(r1.ok, true);
  assert.equal(r1.learnTag, "NOTE");
  assert.deepEqual(F.readHeld(calls, id), { [dropped.key]: "wanted" });
  assert.equal(F.rateHeld(calls, id, dropped.key, "wanted").learnTag, "", "told only once");
  assert.equal(F.rateHeld(calls, id, list[0].key, "wanted").learnTag, "", "no kind of card: stored, nothing to learn");
  assert.equal(F.rateHeld(calls, id, dropped.key, "fine").ok, true);
  assert.equal(F.rateHeld(calls, id, dropped.key, null).ok, true);
  assert.equal(F.readHeld(calls, id)[dropped.key], undefined);
  assert.equal(
    ((statSync(join(dir, "heldback.json")).mode & 0o777) | 0).toString(8),
    process.platform === "win32" ? ((statSync(join(dir, "heldback.json")).mode & 0o777) | 0).toString(8) : "600",
  );
  // not a held-back moment (the chip row index 3, a start row), bad keys, bad ratings, bad ids
  assert.equal(F.rateHeld(calls, id, "x3:3", "wanted").error, "not-held-back");
  assert.equal(F.rateHeld(calls, id, "x0:0", "wanted").error, "not-held-back");
  assert.equal(F.rateHeld(calls, id, "../../x", "wanted").error, "bad-key");
  assert.equal(F.rateHeld(calls, id, dropped.key, "great").error, "bad-rating");
  assert.equal(F.rateHeld(calls, "../x", dropped.key, "wanted").error, "no-call");
});

test("learning: 'I wanted this' takes one negative rating away and lowers a raised kind; reset deletes learn.json", () => {
  const file = join(tmp(), "learn.json");
  noteCallEnd({ NOTE: 2 }, file);
  noteCallEnd({ NOTE: 1 }, file);
  assert.deepEqual(learnSummary(file).raised, ["NOTE"]);
  noteWanted("NOTE", file);
  assert.deepEqual(learnSummary(file).raised, [], "3 negatives became 2: no longer raised");
  assert.equal(loadLearning(file).calls, 2, "a rating after the call is not a call");
  noteWanted("NOTE", file);
  noteWanted("NOTE", file);
  noteWanted("NOTE", file); // never below zero
  assert.equal(learnSummary(file).watching.NOTE, undefined);
  noteWanted("SKIP" as never, file);
  noteWanted("ANS", file); // a kind with no history: nothing happens
  noteCallEnd({ ANS: 3 }, file);
  assert.ok(existsSync(file));
  resetLearning(file);
  assert.equal(existsSync(file), false);
  _dropLearnCache();
  assert.deepEqual(learnSummary(file), { calls: 0, raised: [], watching: {} });
});

test("learning: the window tool ops (summary, reset, wanted) work on the real learn.json path", async () => {
  const wipe = await handle({ op: "learn.reset" });
  assert.equal(wipe.ok, true);
  assert.equal((await handle({ op: "learn.wanted", tag: "NOTE" })).ok, true);
  assert.equal((await handle({ op: "learn.wanted", tag: "SKIP" })).ok, false);
  assert.equal((await handle({ op: "learn.wanted", tag: "nope" })).ok, false);
  const s = await handle({ op: "learn.summary" });
  assert.equal(s.ok, true);
  assert.equal((await handle({ op: "bad" })).ok, false);
});

// ---------------------------------------------------------------- Last time list, search and recap through the window tool
test("window tool: list, search, recap by topic, and forget stored facts", async () => {
  const id = "01TOOLCALL0000000000000001";
  const dir = join(CALLS, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "call.json"), JSON.stringify({ id, mode: "live", startedAt: "2026-10-20T09:00:00.000Z", endedAt: "2026-10-20T09:30:00.000Z" }));
  const m = emptyMemory(1000, "client");
  m.topic.now = "Hosting move for Levi Studio";
  m.roster.push({ id: "p1", name: "Dana Levi", side: "them", role: "owner at Levi Studio" });
  m.facts.push({ id: "f1", text: "Backups are kept for 30 days", at: 1, src: "call" });
  m.commitments.push({ id: "c1", who: "me", what: "send the updated offer", at: 2, status: "open" });
  saveMemory(dir, m);
  indexFinishedCalls({ callsDir: CALLS, file: join(USER_DATA, PEOPLE_FILE) });
  const list = await handle({ op: "past.list" });
  assert.equal((list.people as { name: string }[])[0].name, "Dana Levi");
  const s = await handle({ op: "past.search", q: "how long are backups kept" });
  assert.equal(s.found, true);
  assert.match(String(s.text), /^AI offline: from notes/);
  assert.equal((s.hits as { callId: string }[])[0].callId, id);
  assert.equal((await handle({ op: "past.search", q: "  " })).ok, false);
  // a meeting with no names but the same company words is offered the recap
  const rec = await handle({ op: "past.recap", title: "Levi Studio hosting check-in", who: "", topic: "", goal: "" });
  assert.equal(rec.by, "topic");
  assert.equal(rec.person, "Dana Levi");
  assert.ok((rec.facts as unknown[]).length >= 1);
  // a meeting with a known name uses the Last time facts instead (the review step lists those itself)
  assert.equal((await handle({ op: "past.recap", title: "x", who: "Dana", topic: "", goal: "" })).by, "name");
  assert.equal((await handle({ op: "past.recap", title: "Plumbing", who: "", topic: "", goal: "" })).by, "none");
  assert.deepEqual(await handle({ op: "past.forget", key: "dana levi" }), { ok: true, removed: true });
  assert.deepEqual((await handle({ op: "past.list" })).people, []);
  unblockPast(join(USER_DATA, PEOPLE_FILE)); // the data folder is shared with other test files
  assert.equal((await handle({ op: "past.forget", key: "" })).ok, false);
  // the lookup op never runs while the setting is off
  const l = await handle({ op: "lookup", term: "CNAME record" });
  assert.equal(l.ok, false);
  assert.equal(l.reason, "off");
  assert.deepEqual((await handle({ op: "modes.list" })).ok, true);
});

// ---------------------------------------------------------------- nudges: the engine's speech ring
test("nudges: the speech ring keeps only the last 6 minutes and the first and last word times", () => {
  const r = new SpeechRing();
  const t0 = 1_000_000;
  r.push({ ch: "me", text: "old", t: t0 });
  r.push({
    ch: "me",
    text: "new one",
    t: t0 + 7 * 60_000,
    words: [
      { start: 1, end: 2 },
      { start: 3, end: 9 },
    ],
  });
  const rows = r.rows();
  assert.equal(rows.length, 1, "the old row is gone");
  assert.deepEqual(rows[0].words, [{ start: 1, end: 9 }]);
  for (let i = 0; i < 600; i++) r.push({ ch: "them", text: "x", t: t0 + 7 * 60_000 + i });
  assert.ok(r.rows().length <= 400);
  r.push({ ch: "me", text: 5 as never, t: 1 });
  r.clear();
  assert.equal(r.rows().length, 0);
});

// ---------------------------------------------------------------- strings and snapshot rules
test("strings: every new key exists in English and Hebrew, with the same {placeholders}", () => {
  const keys = Object.keys(EN).filter((k) => /^(mode|trust|held|learn|tag|past|lookup|recap|compose\.past)\./.test(k));
  assert.ok(keys.length > 100);
  const ph = (s: string) => (s.match(/\{[a-zA-Z]+\}/g) ?? []).sort().join();
  for (const k of keys) {
    assert.ok(k in HE, "Hebrew misses " + k);
    assert.equal(ph(EN[k]), ph(HE[k]), k);
  }
  for (const k of ["mode.pill.auto", "mode.pill.title", "mode.pill.titleAuto", "nudge.pace", "nudge.share", "nudge.interrupt", "kind.interview"]) {
    assert.ok(OV.en?.[k] ?? OV.EN?.[k] ?? JSON.stringify(OV).includes(`"${k}"`), "overlay English misses " + k);
  }
  assert.match(HE["mode.locked"], /[֐-׿]/);
});

test("snapshot rules: the new checks flag a Home without pickers, a review without Held back, and Privacy without the list", () => {
  const ok = { dir: "ltr", lang: "en", primaries: 1, pills: 2, modeRows: 3, modeCustom: true, pastCard: true };
  assert.deepEqual(SC.rules("idle-en-light", ok), []);
  assert.match(SC.rules("idle-en-light", { ...ok, modeRows: 0 }).join(), /mode picker/);
  assert.match(SC.rules("idle-en-light", { ...ok, pastCard: false }).join(), /past calls/);
  assert.match(SC.rules("review-en-light", { dir: "ltr", lang: "en", review: true }).join(), /Held back/);
  assert.deepEqual(SC.rules("review-en-light", { dir: "ltr", lang: "en", review: true, heldList: true, heldItems: 2, heldRate: 4, learnReset: true }), []);
  assert.match(SC.rules("trust-he-dark", { dir: "rtl", lang: "he" }).join(), /Show the line/);
  assert.match(SC.rules("settings-privacy-en-dark", { dir: "ltr", lang: "en", settingsTabs: 5 }).join(), /remembered about people/);
});
