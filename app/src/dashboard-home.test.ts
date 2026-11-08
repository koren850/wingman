// Home helpers (dashboard/homelib.js): stop steps from the real phase, the AI mode line, the Start gate, practice label, the Ask/Note input, doctor wording.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const H = req("../dashboard/homelib.js");
const lib = req("../tray/lib.cjs");

const states = (call: any) =>
  H.stopSteps(call)
    .map((s: any) => `${s.key}:${s.state}`)
    .join(" ");

test("stop steps follow state.stopPhase (saving -> summary -> done)", () => {
  assert.equal(states({ stopPhase: "saving" }), "listening:done saving:now summary:todo");
  assert.equal(states({ stopPhase: "summary" }), "listening:done saving:done summary:now");
  assert.equal(states({ stopPhase: "done" }), "listening:done saving:done summary:done");
});

test("stop steps fall back to the old inference when no phase has arrived", () => {
  assert.equal(states({ stopPhase: "" }), "listening:done saving:now summary:now");
  assert.equal(states({}), "listening:done saving:now summary:now");
  assert.equal(states({ summaryOk: true }), "listening:done saving:now summary:done");
  assert.equal(states({ endedCleanly: true }), "listening:done saving:done summary:done");
  assert.equal(states(null), "listening:done saving:now summary:now");
});

test("the controller reducer feeds the stop steps: stopphase events, reset on a new call", () => {
  let s = lib.reduce(lib.initialState(), { ev: "starting" });
  s = lib.reduce(s, { ev: "consented" });
  s = lib.reduce(s, { ev: "stopping" });
  assert.equal(states(s), "listening:done saving:now summary:now");
  s = lib.reduce(s, { ev: "stopphase", phase: "summary" });
  assert.equal(states(s), "listening:done saving:done summary:now");
  s = lib.reduce(s, { ev: "stopphase", phase: "bogus" });
  assert.equal(s.stopPhase, "summary");
  s = lib.reduce(lib.reduce(s, { ev: "exit", code: 0 }), { ev: "starting" });
  assert.equal(s.stopPhase, "");
});

const row = (key: string, value: any) => ({ key, value });
test("AI mode line reads the effective settings", () => {
  const base = [row("run.noAi", true), row("assist.answerMe", "hotkey"), row("reflex.allowAns", true), row("cards.quiet", false)];
  assert.deepEqual(H.aiMode(base), { on: true, text: "AI on · answers your questions: hotkey only" });
  assert.equal(
    H.aiMode([...base.slice(0, 1), row("assist.answerMe", "always"), row("reflex.allowAns", false), row("cards.quiet", true)]).text,
    "AI on · answers your questions: always · other side: Prepared cards only · starts in quiet mode",
  );
  assert.equal(H.aiMode([row("run.noAi", true), row("assist.answerMe", "off")]).text, "AI on · your own questions: only with the hotkey");
  const off = H.aiMode([row("run.noAi", false), row("assist.answerMe", "always")]);
  assert.equal(off.on, false);
  assert.match(off.text, /^AI off in Settings/);
  assert.equal(H.aiMode([]), null);
  assert.equal(H.aiMode(null), null);
  assert.equal(H.aiMode([row("assist.answerMe", "always")]), null);
});

test("AI mode matches the real catalog rows (inverted run.noAi)", () => {
  const cat = req("../tray/settings-catalog.cjs");
  const values: any = { "run.noAi": false, "assist.answerMe": "hotkey", "reflex.allowAns": true, "cards.quiet": false };
  const defaults: any = {};
  for (const i of cat.ITEMS) defaults[i.key] = i.kind === "bool" && i.invert ? true : 0;
  for (const i of cat.ITEMS) if (!(i.key in values)) values[i.key] = defaults[i.key];
  const rows = cat.describe({ values, defaults: values, changed: [] });
  assert.equal(H.aiMode(rows).on, true); // stored noAi=false means the AI is used
  values["run.noAi"] = true;
  assert.equal(H.aiMode(cat.describe({ values, defaults: values, changed: [] })).on, false);
});

test("Start is only blocked by a NOT READY result", () => {
  assert.equal(H.blockedBy(null), null);
  assert.equal(H.blockedBy({ ok: true, verdict: "READY" }), null);
  assert.equal(H.blockedBy({ ok: false, verdict: "BUSY" }), null);
  const d = { ok: false, verdict: "NOT READY", failing: [] };
  assert.equal(H.blockedBy(d), d);
});

const NOW = new Date(2026, 10, 3, 9, 0).getTime(),
  at = (h: number, m = 0) => new Date(2026, 10, 3, h, m).getTime();
const mt = (id: string, o: object = {}) => ({
  id,
  title: "",
  who: id,
  goal: "",
  at: 0,
  createdAt: NOW,
  updatedAt: NOW,
  usedAt: 0,
  mustCount: 0,
  files: 0,
  ...o,
});

test("Start card: prepared meetings are listed soonest first, the next timed one is highlighted, a used plan stays in the list (plans are reusable) but is not next for the slot it served", () => {
  const list = [
    mt("mnoTime0", { updatedAt: NOW + 5 }),
    mt("mlate01", { at: at(16), who: "Noam, Beta", mustCount: 3 }),
    mt("mnext01", { at: at(14, 30), who: "Dana, Acme", files: 2 }),
    mt("mused01", { at: at(14), usedAt: at(14, 5) }),
    mt("mold001", { at: at(1) }),
  ];
  const r = H.startPaths(list, NOW);
  assert.deepEqual(
    r.rows.map((x: any) => x.id),
    ["mold001", "mused01", "mnext01", "mlate01", "mnoTime0"],
  );
  assert.equal(r.next.id, "mnext01");
  assert.equal(H.nextText(r.next), "Next: Dana, Acme at 14:30");
  const row = (id: string) => r.rows.find((x: any) => x.id === id);
  assert.deepEqual([row("mnext01").time, row("mnext01").files, row("mlate01").must, row("mnoTime0").time], ["Today 14:30", 2, 3, ""]);
  assert.equal(row("mnext01").isNext, true);
  assert.equal(row("mlate01").isNext, false);
  assert.equal(row("mused01").isNext, false, "its slot was already held");
  assert.equal(row("mnext01").startLabel, "Start Dana, Acme");
  assert.equal(H.startPaths([mt("mnoTime0")], NOW).next, null, "an untimed meeting is never 'Next'");
  assert.deepEqual(H.startPaths([], NOW), { next: null, rows: [] });
  assert.equal(H.startPaths(null, NOW).rows.length, 0);
});

test("Start card: a title wins over who in the row; the subtitle never repeats the name", () => {
  const r = H.startPaths(
    [mt("mtitled", { title: "Hosting move", who: "Dana", goal: "date" }), mt("mgoal01", { who: "", goal: "agree a date" })],
    NOW,
  ).rows.sort((a: any, b: any) => (a.id < b.id ? 1 : -1));
  assert.equal(r[0].name, "Hosting move");
  assert.equal(r[0].sub, "Dana");
  assert.equal(r[1].name, "agree a date");
  assert.equal(r[1].sub, "", "no repeat of the name");
});

test("practice names the plan it uses (the next meeting, or the only one) and says nothing special otherwise", () => {
  assert.equal(H.practiceLabel(null), "Practice call (offline, free)");
  assert.equal(H.practiceLabel(mt("mx", { who: "Dana, Acme" })), 'Practice call · uses "Dana, Acme"');
  assert.equal(H.practiceTarget([mt("a"), mt("b")], NOW), null);
  assert.equal(H.practiceTarget([mt("a")], NOW).id, "a");
  assert.equal(H.practiceTarget([mt("a"), mt("b", { at: at(14) })], NOW).id, "b");
});

test("Ask/Note input: two clear modes, unknown mode means note, the armed state is spelled out", () => {
  assert.equal(H.composer("ask").button, "Ask");
  assert.equal(H.composer("note").button, "Add note");
  assert.equal(H.composer("whatever").label, "Note for the AI");
  assert.equal(H.composer(undefined).label, "Note for the AI");
  assert.notEqual(H.composer("ask").placeholder, H.composer("note").placeholder);
  assert.equal(H.askStatus({ askArmed: true }), "Listening for your question. Say it now.");
  assert.equal(H.askStatus({ askArmed: false }), "");
  assert.equal(H.askStatus(null), "");
});

test("doctor text speaks to the app user: Keychain, Wingman, readiness check", () => {
  assert.equal(H.niceFix("add it to ~/.config/wingman/keys.env"), "add it in Settings, Keys");
  assert.equal(H.niceFix("grant Microphone to your terminal app, restart it"), "grant Microphone to Wingman, restart it");
  assert.equal(H.niceFix("run doctor again"), "run readiness check again");
  assert.equal(H.keyRelated({ text: "DEEPGRAM_API_KEY missing", fix: "" }), true);
  assert.equal(H.keyRelated({ text: "mic silent", fix: "grant Microphone" }), false);
});

test("focus key: id first, then data-fk", () => {
  assert.equal(H.focusKey({ id: "a", getAttribute: () => "b" }), "a");
  assert.equal(H.focusKey({ id: "", getAttribute: () => "b" }), "b");
  assert.equal(H.focusKey(null), "");
});

test("recent plans: newest first, no duplicates, capped, junk dropped", () => {
  const D = req("../dashboard/lib.cjs");
  const p = (who: string, goal = "", notes = "", mustCover = "") => ({ who, goal, notes, mustCover });
  let l: any[] = [];
  for (const w of ["a", "b", "c", "d", "e", "f"]) l = D.recentAdd(l, p(w, "g"));
  assert.deepEqual(
    l.map((x) => x.who),
    ["f", "e", "d", "c", "b"],
  );
  assert.equal(l.length, D.RECENT_MAX);
  l = D.recentAdd(l, p("D", "G", "new notes")); // same who and goal (any case): moved to the front, not doubled
  assert.deepEqual(
    l.map((x) => x.who),
    ["D", "f", "e", "c", "b"],
  );
  assert.equal(l[0].notes, "new notes");
  assert.deepEqual(D.recentAdd(l, p("", "", "", "")), l); // an empty plan is not remembered
  assert.equal(D.cleanPlan({ who: 1, goal: "", notes: "", mustCover: "" }), null);
  assert.equal(D.cleanPlan({ who: "x".repeat(1501), goal: "", notes: "", mustCover: "" }), null);
  assert.equal(D.cleanPlan([]), null);
  assert.equal(D.cleanPlan(null), null);
  assert.deepEqual(D.recentClean([p("ok"), { who: 5 }, "junk", null]), [p("ok")]);
  assert.deepEqual(D.recentClean("nope"), []);
  assert.equal(D.cleanPlan(p("a\u0000b")).who, "ab");
});

// ---- the running call cannot be deleted from the Calls view ----
test("deleteRefusal: only the call that is running now is refused", () => {
  const { deleteRefusal } = req("../dashboard/lib.cjs");
  const live = { running: true, callId: "01JLIVE", phase: "live" };
  assert.match(deleteRefusal(live, "01JLIVE"), /still running/);
  assert.equal(deleteRefusal(live, "01JOTHER"), "");
  assert.equal(deleteRefusal({ running: false, callId: "01JLIVE", phase: "idle" }, "01JLIVE"), "", "an ended call can be deleted");
  assert.equal(deleteRefusal({ running: true, callId: "01JLIVE", phase: "idle" }, "01JLIVE"), "");
});

// ---- Calls list: start time without call.json, and the per-folder cache ----
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
const callsLib = req("../dashboard/lib.cjs");
const newCalls = () => mkdtempSync(pjoin(tmpdir(), "wm-calls-"));

test("a call folder without call.json shows the time from its id, or the folder time, never 1970", () => {
  const dir = newCalls();
  const ulid = "01JC1QZ8M0" + "0".repeat(16),
    id2 = "ZZZZZZZZZZ" + "0".repeat(16); // a real 2024 time, and an id that is not a time
  mkdirSync(pjoin(dir, ulid));
  mkdirSync(pjoin(dir, id2));
  const folder = new Date("2026-03-04T10:00:00Z");
  utimesSync(pjoin(dir, id2), folder, folder);
  const rows = callsLib.listCalls(dir);
  const a = rows.find((r: any) => r.id === ulid),
    b = rows.find((r: any) => r.id === id2);
  assert.ok(a.startedAt > Date.UTC(2020, 0, 1) && a.startedAt === callsLib.idTime(ulid));
  assert.equal(b.startedAt, folder.getTime());
});

test("listCalls caches a call's row until one of its files changes", () => {
  const dir = newCalls(),
    id = "01JC1QZ8M0" + "0".repeat(16);
  mkdirSync(pjoin(dir, id));
  writeFileSync(pjoin(dir, id, "call.json"), JSON.stringify({ startedAt: "2026-01-01T10:00:00Z", mode: "live" }));
  writeFileSync(pjoin(dir, id, "events.jsonl"), JSON.stringify({ t: Date.parse("2026-01-01T10:00:00Z"), type: "x" }) + "\n");
  assert.equal(callsLib.listCalls(dir)[0].mode, "live");
  const real = nodeFs.readFileSync;
  let reads = 0;
  (nodeFs as any).default.readFileSync = (...a: any[]) => {
    reads++;
    return (real as any)(...a);
  };
  try {
    callsLib.listCalls(dir);
    callsLib.listCalls(dir);
    assert.equal(reads, 0, "unchanged files are not read again");
    writeFileSync(pjoin(dir, id, "call.json"), JSON.stringify({ startedAt: "2026-01-01T10:00:00Z", mode: "practice", note: "changed" }));
    assert.equal(callsLib.listCalls(dir)[0].mode, "practice");
    assert.ok(reads > 0);
  } finally {
    (nodeFs as any).default.readFileSync = real;
  }
});

test("listCallsAsync returns the same rows as listCalls and yields to the event loop while it works", async () => {
  const dir = newCalls();
  for (let i = 0; i < 40; i++) mkdirSync(pjoin(dir, "01JC1QZ8" + String(10 + i) + "0".repeat(16)));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  const rows = await callsLib.listCallsAsync(dir, 5);
  clearInterval(timer);
  assert.deepEqual(rows, callsLib.listCalls(dir));
  assert.equal(rows.length, 40);
  assert.ok(ticks > 0, "the event loop ran between chunks");
});
