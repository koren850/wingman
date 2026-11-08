// Call modes and coaching: the call modes (client, support, team, personal, consult), the coaching numbers, the time-left card, exports.
// Offline: invented data, the scripted model and temp folders. No network, no keys.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KINDS, emptyMemory, type MemoryKind } from "./session/types.ts";
import { modeInstructions, modeMustCoverTemplate, modeProfile, modeSummaryShape, DISCOVERY_TEMPLATE } from "./moments/modes.ts";
import { buildMomentPrompt } from "./moments/prompt.ts";
import { DEFAULT_SCHEDULER, decide, newSchedulerState, type ScheduledMoment } from "./moments/scheduler.ts";
import { timeLeftTip, checkTip } from "./tips.ts";
import { computeCoaching, coachingForCall } from "./session/coaching.ts";
import { buildExport, exportCall, mailtoLink, ExportError } from "./session/export.ts";
import { saveMemory } from "./session/store.ts";
import { applyPatch } from "./session/patch.ts";
import { runSummary, type CallData } from "./summary.ts";
import { ModelRegistry } from "./providers/llm.ts";
import { CostMeter } from "./cost.ts";
import { loadSettings } from "./settings.ts";
import { main } from "./cli/index.ts";
import { DATA } from "./env.ts";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import childProcess from "node:child_process";

const tmp = (n: string) => mkdtempSync(join(tmpdir(), `wm-r2modes-${n}-`));
const NEW_MODES: MemoryKind[] = ["client", "support", "team", "personal", "consult"];

// ---------------------------------------------------------------- modes
test("modes: each new mode has instructions, a profile and a summary shape; the others stay neutral", () => {
  for (const k of NEW_MODES) {
    assert.ok(modeInstructions(k).length > 200, `${k} has instructions`);
    assert.match(modeInstructions(k), /^Mode: /);
    assert.ok(Object.keys(modeProfile(k)).length >= 3, `${k} has a profile`);
    assert.ok(modeSummaryShape(k).heading.summary.en && modeSummaryShape(k).heading.summary.he);
  }
  for (const k of ["vendor", "other"] as const) {
    assert.equal(modeInstructions(k), "");
    assert.deepEqual(modeProfile(k), {});
  }
  assert.equal(modeInstructions(undefined), "");
  assert.ok(modeInstructions("interview").includes("practice interview"));
});

test("modes: a profile can only make the engine calmer than the settings, never costlier (except the practice interview)", () => {
  const cap = DEFAULT_SCHEDULER.maxPerMinute;
  for (const k of NEW_MODES) {
    const p = modeProfile(k);
    assert.ok((p.maxPerMinute ?? cap) <= cap, `${k} maxPerMinute`);
    assert.ok((p.observerPerMinute ?? 6) <= 6, `${k} observerPerMinute`);
    assert.equal(p.monologueWords ?? 0, 0, `${k} has no coaching look at long answers`);
  }
  assert.ok((modeProfile("personal").observerPerMinute ?? 6) < (modeProfile("client").observerPerMinute ?? 6));
});

test("modes: instruction text has no hosting words and no word lists; the discovery template is plain", () => {
  const hosting = /hosting|wordpress|plesk|cpanel|\bdns\b|\bphp\b|\bssl\b|domain|plugin|\bcms\b/i;
  for (const k of KINDS) assert.doesNotMatch(modeInstructions(k), hosting, k);
  assert.doesNotMatch(buildMomentPrompt({ userName: "Dan" }), hosting, "the base rules are neutral too");
  assert.ok(DISCOVERY_TEMPLATE.length >= 5);
  assert.deepEqual(modeMustCoverTemplate("client"), DISCOVERY_TEMPLATE);
  assert.deepEqual(modeMustCoverTemplate("team"), []);
});

test("modes: the moment prompt carries the mode text of the kind, and nothing for a neutral kind", () => {
  const base = buildMomentPrompt({ userName: "Dan" });
  for (const k of NEW_MODES) {
    const p = buildMomentPrompt({ userName: "Dan", kind: k });
    assert.ok(p.includes(modeInstructions(k)), k);
    assert.ok(p.length > base.length);
  }
  assert.equal(buildMomentPrompt({ userName: "Dan", kind: "other" }), base);
  assert.match(buildMomentPrompt({ userName: "Dan", kind: "client" }), /must-cover list/);
  assert.match(buildMomentPrompt({ userName: "Dan", kind: "support" }), /reproduce|Steps to reproduce/);
  assert.match(buildMomentPrompt({ userName: "Dan", kind: "team" }), /owner/);
});

const mom = (tag: ScheduledMoment["tag"], value: 0 | 1 | 2 | 3): ScheduledMoment => ({
  tag,
  value,
  aim: "me",
  say: "x",
  why: "y",
  more: [],
  source: "observer",
  lineAt: 1000,
});

test("modes: the scheduler applies the profile of the kind (policy table)", () => {
  const at = (kind: MemoryKind | undefined) => ({ ...newSchedulerState(1000), kind });
  // "show" here means: the mode's minimum VALUE lets it through. A VALUE 1 card that passes is still only a chip (the precision rule), checked once below.
  const show = (kind: MemoryKind | undefined, tag: ScheduledMoment["tag"], v: 0 | 1 | 2 | 3) => {
    const d = decide(mom(tag, v), at(kind), DEFAULT_SCHEDULER);
    return d.action !== "drop" && d.reason !== "below-min-value";
  };
  assert.equal(decide(mom("PROMPT", 1), at("client"), DEFAULT_SCHEDULER).reason, "value-1");
  // discovery and support: a missing topic or a small ticket fact (value 1) is worth a look; elsewhere it is not
  assert.equal(show("client", "PROMPT", 1), true);
  assert.equal(show("support", "NOTE", 1), true);
  assert.equal(show("support", "PROMPT", 1), true);
  assert.equal(show("other", "PROMPT", 1), false);
  assert.equal(show("team", "PROMPT", 1), false);
  // a one-to-one is the quietest: a value 2 answer is not enough, a value 3 is
  assert.equal(show("personal", "ANS", 2), false);
  assert.equal(show("personal", "ANS", 3), true);
  assert.equal(show("other", "ANS", 2), true);
  // consult: a term and a note are welcome at value 1
  assert.equal(show("consult", "TERM", 1), true);
  assert.equal(show("consult", "REPLY", 1), false);
  // a standup holds back a value 1 check that another call would show
  assert.equal(show("other", "CHECK", 1), true);
  assert.equal(show("team", "CHECK", 1), false);
  // the card cap per minute follows the profile
  const shown = (kind: MemoryKind, n: number) => {
    let st = { ...newSchedulerState(100_000), kind };
    st = { ...st, shown: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, at: 99_000 - i, tag: "NOTE" as const, memVer: 1, rank: 1, exempt: false })) };
    return decide({ ...mom("ANS", 3), lineAt: 100_000 }, st, DEFAULT_SCHEDULER).action;
  };
  assert.equal(shown("personal", 1), "chip", "one card a minute in a one-to-one");
  assert.equal(shown("team", 2), "chip");
  assert.equal(shown("client", 2), "show");
});

test("modes: a mode text for a kind never reaches a kind that has none (no leak between modes)", () => {
  for (const k of NEW_MODES) for (const other of NEW_MODES.filter((o) => o !== k)) assert.ok(!modeInstructions(k).includes(modeInstructions(other)));
  assert.equal(modeSummaryShape("personal").followUp, false);
  assert.equal(modeSummaryShape("client").followUp, true);
  assert.match(modeSummaryShape("team").heading.nextSteps.en, /owner/i);
});

// ---------------------------------------------------------------- the time-left card
test("timeLeftTip: a standup shows nothing before the planned length, one card at it, and none after it was shown", () => {
  const lead = modeProfile("team").timeCardLeadMin;
  assert.equal(lead, 0);
  const at = (elapsedMin: number, alreadyShown = false) => timeLeftTip({ plannedMin: 15, elapsedMin, leadMin: lead, alreadyShown, lang: "en" });
  assert.equal(at(0), undefined);
  assert.equal(at(7.5), undefined);
  assert.equal(at(14.99), undefined);
  const t = at(15);
  assert.ok(t);
  assert.match(t.text, /15 minutes are up/);
  assert.equal(at(15.5, true), undefined, "once");
  assert.ok(checkTip(t, []).ok, "the card passes the tip guards (no price, date or promise)");
  assert.ok(t.text.length <= 140);
});

test("timeLeftTip: other modes show a gentle card some minutes before the end; no planned length, no card", () => {
  const t = timeLeftTip({ plannedMin: 30, elapsedMin: 25.2, alreadyShown: false, lang: "en" });
  assert.ok(t);
  assert.match(t.text, /About 5 min left of the planned 30/);
  assert.equal(timeLeftTip({ plannedMin: 30, elapsedMin: 24, alreadyShown: false, lang: "en" }), undefined);
  assert.equal(timeLeftTip({ plannedMin: 0, elapsedMin: 100, alreadyShown: false }), undefined);
  // a short meeting: the lead is at most half of the planned length, so the card is not shown at the start
  assert.equal(timeLeftTip({ plannedMin: 6, elapsedMin: 1, alreadyShown: false }), undefined);
  assert.ok(timeLeftTip({ plannedMin: 6, elapsedMin: 3.5, alreadyShown: false }));
  const he = timeLeftTip({ plannedMin: 20, elapsedMin: 15.5, alreadyShown: false, lang: "he" });
  assert.match(he!.text, /[֐-׿]/);
  assert.ok(checkTip(he!, []).ok);
});

// ---------------------------------------------------------------- coaching numbers
const T0 = 1_800_000_000_000;
const text = (n: number, q = false) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ") + (q ? "?" : ".");
type FRow = { ch: "me" | "them"; text: string; t: number };
// Speaking time comes from the word count at 150 words a minute (2.5 words a second). Times are seconds from T0 (the end of the row).
const rows = (): FRow[] => [
  { ch: "them", text: text(25), t: T0 + 10_000 }, // 0 - 10 s
  { ch: "me", text: text(10, true), t: T0 + 14_000 }, // 10 - 14, one question
  { ch: "them", text: text(5), t: T0 + 20_000 }, // 18 - 20
  { ch: "me", text: text(50), t: T0 + 45_000 }, // 25 - 45
  { ch: "me", text: text(25), t: T0 + 55_000 }, // 45 - 55, same stretch: 25 - 55 = 30 s
  { ch: "them", text: text(6), t: T0 + 60_000 }, // 57.6 - 60 ends the stretch
  { ch: "me", text: text(5), t: T0 + 74_000 }, // 72 - 74, starts while they talk (68 - 80)
  { ch: "them", text: text(30), t: T0 + 80_000 },
];
const EXPECTED = { talkSharePct: 58, longestMonologueSec: 30, questionsAsked: 1, paceWpm: { me: 150, them: 150 }, interruptions: 1 };

test("coaching: the numbers of a fixture call are exact", () => {
  assert.deepEqual(computeCoaching(rows()), EXPECTED);
});

test("coaching: a short reply from the other side does not end a monologue; a long one does; a question mark in the user's speech only", () => {
  const r: FRow[] = [
    { ch: "me", text: text(25), t: T0 + 10_000 }, // 0 - 10
    { ch: "them", text: "mm-hm", t: T0 + 11_000 },
    { ch: "me", text: text(25, true), t: T0 + 21_000 }, // 11 - 21
    { ch: "them", text: text(10, true), t: T0 + 40_000 },
  ];
  const c = computeCoaching(r)!;
  assert.equal(c.longestMonologueSec, 21);
  assert.equal(c.questionsAsked, 1, "their question is not counted");
  assert.equal(c.interruptions, 0);
});

test("coaching: too little speech gives no numbers; word times are used when a row has them; rubbish rows are ignored", () => {
  assert.equal(computeCoaching([{ ch: "me", text: "hello there", t: T0 }]), undefined);
  const r = [
    {
      ch: "me" as const,
      text: text(30),
      t: T0 + 20_000,
      words: [
        { start: 100, end: 100.5 },
        { start: 109, end: 120 },
      ],
    }, // 20 s from the word times
    { ch: "them" as const, text: text(30), t: T0 + 60_000 },
    { ch: "x" as never, text: "bad", t: T0 },
    { ch: "me" as const, text: "", t: T0 },
  ];
  const c = computeCoaching(r)!;
  assert.equal(c.paceWpm.me, 90, "30 words in 20 s");
  assert.equal(c.paceWpm.them, 150);
  assert.equal(c.talkSharePct, 63, "20 s of 32 s");
});

test("coaching: filler words are not counted: the numbers do not change when the words are fillers, and there is no filler field", () => {
  const fillers = ["um", "uh", "you", "know", "אהה", "כאילו", "like", "so"];
  const filler = (n: number, q = false) => Array.from({ length: n }, (_, i) => fillers[i % fillers.length]).join(" ") + (q ? "?" : ".");
  const mk = (t: (n: number, q?: boolean) => string) =>
    computeCoaching([
      { ch: "them", text: t(25), t: T0 + 10_000 },
      { ch: "me", text: t(40, true), t: T0 + 30_000 },
      { ch: "them", text: t(10), t: T0 + 40_000 },
    ])!;
  const plain = mk(text),
    full = mk(filler);
  assert.deepEqual(full, plain, "a call made only of filler words has the same numbers as one made of plain words");
  const keys = (o: unknown): string[] => (o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => [k, ...keys(v)]) : []);
  assert.ok(!keys(full).some((k) => /filler|um|uh/i.test(k)), `no filler field: ${keys(full).join(",")}`);
});

// ---------------------------------------------------------------- a fixture call folder
function fixtureCall(opts: { summary?: boolean; kind?: MemoryKind; memory?: boolean } = {}): { calls: string; dir: string; id: string } {
  const calls = tmp("calls");
  const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const dir = join(calls, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "call.json"), JSON.stringify({ id, startedAt: "2026-11-09T09:00:00.000Z", endedAt: "2026-11-09T09:15:00.000Z", mode: "live" }));
  writeFileSync(
    join(dir, "transcript.jsonl"),
    rows()
      .map((r) => JSON.stringify({ ...r, words: [] }))
      .join("\n") + "\n",
  );
  if (opts.memory !== false) {
    const mem = applyPatch(
      emptyMemory(1, opts.kind ?? "client"),
      {
        topic: "Rollout plan",
        add: {
          decisions: [{ text: "Start with the pilot team" }],
          commitments: [{ who: "me", what: "send the notes", due: "Friday" }],
          openQuestions: [{ asker: "Noa", text: "Who signs the contract?" }],
        },
        summary: "They want a pilot. The contract owner is not known yet.",
      },
      { now: 2 },
    ).mem;
    saveMemory(dir, { ...mem, kind: opts.kind ?? "client" });
  }
  if (opts.summary !== false)
    writeFileSync(
      join(dir, "summary.json"),
      JSON.stringify({
        v: 1,
        callId: id,
        generatedAt: "2026-11-09T09:16:00.000Z",
        model: "scripted:summary",
        summary: ["They want a pilot with one team", "The contract owner is not known yet"],
        decisions: ["Start with the pilot team"],
        nextSteps: [
          { who: "אני", what: "send the notes", when: "Friday" },
          { who: "Noa", what: "find the contract owner" },
        ],
        openQuestions: ["Who signs the contract?"],
        followUpEmail: "Hi Noa,\nThank you for the call. We will start with the pilot team. I will send the notes.\nBest regards",
        guard: { replaced: 0, rules: [] },
        costUsd: 0.001,
        coaching: EXPECTED,
      }),
    );
  return { calls, dir, id };
}

test("coaching: coachingForCall reads transcript.jsonl of a call folder", () => {
  const f = fixtureCall();
  try {
    assert.deepEqual(coachingForCall(f.dir), EXPECTED);
    assert.equal(coachingForCall(join(f.calls, "missing")), undefined);
  } finally {
    rmSync(f.calls, { recursive: true, force: true });
  }
});

const S0 = loadSettings({ env: {}, userFile: "/nonexistent/x.yaml" }).settings;

test("summary.json carries the coaching numbers of the call (fixture), written with no extra model call", async () => {
  const f = fixtureCall({ summary: false });
  try {
    const data: CallData = {
      lines: rows().map((r) => ({ ch: r.ch, text: r.text })),
      contextNotes: [],
      aiNotes: [],
    };
    const cost = new CostMeter(S0.budget.prices, S0.budget);
    const S = { ...S0, summary: { ...S0.summary, model: "scripted:summary", minWords: 1 } };
    const r = await runSummary({ dir: f.dir, callId: f.id, S, registry: new ModelRegistry({}), cost, data, write: () => {} });
    assert.ok(r.ok, r.error);
    const j = JSON.parse(readFileSync(join(f.dir, "summary.json"), "utf8"));
    assert.deepEqual(j.coaching, EXPECTED);
    assert.equal(cost.roles.summary.calls, 1, "the one existing summary call; the numbers cost nothing");
  } finally {
    rmSync(f.calls, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- exports
test("export json: the fixture call round-trips", () => {
  const f = fixtureCall();
  try {
    const out = exportCall(f.dir, "json");
    const x = JSON.parse(out);
    assert.deepEqual(x, buildExport(f.dir), "stable: what is printed parses back to the same object");
    assert.equal(x.v, 1);
    assert.equal(x.callId, f.id);
    assert.equal(x.kind, "client");
    assert.equal(x.durationMin, 15);
    assert.deepEqual(x.summary, ["They want a pilot with one team", "The contract owner is not known yet"]);
    assert.deepEqual(x.decisions, ["Start with the pilot team"]);
    assert.deepEqual(x.nextSteps, [
      { who: "Me", what: "send the notes", when: "Friday" },
      { who: "Noa", what: "find the contract owner" },
    ]);
    assert.deepEqual(x.openQuestions, ["Who signs the contract?"]);
    assert.deepEqual(x.coaching, EXPECTED);
    assert.match(x.followUp.text, /pilot team/);
    assert.equal(JSON.stringify(JSON.parse(out), null, 2) + "\n", out);
  } finally {
    rmSync(f.calls, { recursive: true, force: true });
  }
});

/** Reads the sections of the Markdown export back into lists (the round trip). */
function parseMd(md: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let cur = "";
  for (const l of md.split("\n")) {
    if (l.startsWith("## ")) out[(cur = l.slice(3))] = [];
    else if (cur && l.startsWith("- ")) out[cur].push(l.slice(2));
  }
  return out;
}

test("export md: the fixture call round-trips to the same lists as the json export, with the headings of the mode", () => {
  const f = fixtureCall();
  try {
    const md = exportCall(f.dir, "md");
    const x = buildExport(f.dir);
    const s = parseMd(md);
    const h = modeSummaryShape("client").heading;
    assert.deepEqual(s[h.summary.en], x.summary);
    assert.deepEqual(s[h.decisions.en], x.decisions);
    assert.deepEqual(
      s[h.nextSteps.en],
      x.nextSteps.map((n) => `**${n.who}**: ${n.what}${n.when ? ` (${n.when})` : ""}`),
    );
    assert.deepEqual(s[h.openQuestions.en], x.openQuestions);
    assert.ok(s["Coaching numbers"].includes("Your share of the talking: 58%"));
    assert.match(md, /^# Call 01ARZ3NDEKTSV4RRFFQ69G5FAV/);
    assert.match(md, /> Hi Noa,/);
    assert.match(md, /\]\(mailto:\?subject=/);
    // a different kind uses its own headings
    const t = fixtureCall({ kind: "team" });
    try {
      const m2 = exportCall(t.dir, "md");
      assert.match(m2, /## Action items \(by owner\)/);
      assert.match(m2, /## Blockers/);
    } finally {
      rmSync(t.calls, { recursive: true, force: true });
    }
  } finally {
    rmSync(f.calls, { recursive: true, force: true });
  }
});

test("export: the follow-up goes through the sentence guard; a personal call has none; a call without a summary exports from the memory", () => {
  const f = fixtureCall();
  try {
    const j = JSON.parse(readFileSync(join(f.dir, "summary.json"), "utf8"));
    j.followUpEmail = "Hi,\nThe price is 500 dollars. I guarantee it works.\nBest regards";
    writeFileSync(join(f.dir, "summary.json"), JSON.stringify(j));
    const x = buildExport(f.dir);
    assert.doesNotMatch(x.followUp.text, /500|guarantee/);
    assert.ok(x.followUp.guardReplaced >= 1);
    assert.match(exportCall(f.dir, "md"), /Complete them before you send/);
  } finally {
    rmSync(f.calls, { recursive: true, force: true });
  }
  const p = fixtureCall({ kind: "personal" });
  try {
    const x = buildExport(p.dir);
    assert.equal(x.followUp.text, "");
    assert.equal(x.followUp.mailto, "");
    assert.doesNotMatch(exportCall(p.dir, "md"), /mailto:/);
  } finally {
    rmSync(p.calls, { recursive: true, force: true });
  }
  const m = fixtureCall({ summary: false });
  try {
    const x = buildExport(m.dir);
    assert.equal(x.source, "memory");
    assert.ok(x.decisions.includes("Start with the pilot team"));
    assert.ok(x.openQuestions.includes("Who signs the contract?"));
  } finally {
    rmSync(m.calls, { recursive: true, force: true });
  }
  const e = fixtureCall({ summary: false, memory: false });
  try {
    assert.throws(() => buildExport(e.dir), ExportError);
  } finally {
    rmSync(e.calls, { recursive: true, force: true });
  }
});

test("export: text from a summary file is cleaned (control characters, bidi overrides, huge items)", () => {
  const f = fixtureCall();
  try {
    const j = JSON.parse(readFileSync(join(f.dir, "summary.json"), "utf8"));
    j.summary = ["Line one\u0000‮ with tricks\nsecond line", "x".repeat(5000)];
    writeFileSync(join(f.dir, "summary.json"), JSON.stringify(j));
    const x = buildExport(f.dir);
    assert.equal(x.summary[0], "Line one with tricks second line");
    assert.equal(x.summary[1].length, 600);
  } finally {
    rmSync(f.calls, { recursive: true, force: true });
  }
});

test("mailto: a link is built as text with a subject and a body, cut to a safe length, and never sent", () => {
  const link = mailtoLink("Follow-up: plan", "Hi,\nThanks & see you.\nBest");
  assert.equal(link, "mailto:?subject=Follow-up%3A%20plan&body=Hi%2C%0D%0AThanks%20%26%20see%20you.%0D%0ABest");
  const long = mailtoLink("s", Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n"));
  assert.ok(long.length < 4000);
  assert.match(decodeURIComponent(long), /…$/);
  assert.match(mailtoLink("s", "b", "noa@example.com"), /^mailto:noa@example\.com\?/);
  assert.match(mailtoLink("s", "b", "noa@example.com?cc=x@y.z&bcc=a@b.c"), /^mailto:\?/, "a recipient with extra header fields is dropped");
});

test("export: building an export and a mailto link makes no network call and starts no process", () => {
  // The module only builds text. Behaviour check: with fetch, sockets, http and child processes replaced by counters, an export and a mail link still work and the counters stay at zero.
  const hits: string[] = [];
  const g = globalThis as { fetch?: unknown };
  const realFetch = g.fetch;
  g.fetch = () => {
    hits.push("fetch");
    throw new Error("network is off");
  };
  const patches: (() => void)[] = [];
  const trap = (obj: object, name: string, label: string) => {
    const o = obj as Record<string, unknown>;
    const orig = o[name];
    o[name] = () => {
      hits.push(label);
      throw new Error(`${label} is off`);
    };
    patches.push(() => (o[name] = orig));
  };
  trap(net.Socket.prototype, "connect", "net.connect");
  trap(http, "request", "http.request");
  trap(https, "request", "https.request");
  trap(childProcess, "spawn", "spawn");
  trap(childProcess, "exec", "exec");
  trap(childProcess, "execFile", "execFile");
  const f = fixtureCall();
  try {
    const x = buildExport(f.dir);
    assert.ok(x.summary.length > 0);
    assert.match(mailtoLink("Follow-up", "Hi,\nthanks", "noa@example.com"), /^mailto:/);
  } finally {
    for (const undo of patches) undo();
    g.fetch = realFetch;
    rmSync(f.calls, { recursive: true, force: true });
  }
  assert.deepEqual(hits, [], "no network call and no process");
});

// ---------------------------------------------------------------- the CLI
async function run(calls: string, ...argv: string[]) {
  let out = "",
    err = "";
  const code = await main(argv, { out: (s) => void (out += s), err: (s) => void (err += s), env: { ...process.env, WINGMAN_CALLS_DIR: calls } });
  return { code, out, err };
}

test("cli: wingman export prints Markdown by default and with --md, and JSON with --json; a bad call is exit 5; nothing to export is exit 5", async () => {
  const f = fixtureCall();
  try {
    const md = await run(f.calls, "export", f.id);
    assert.equal(md.code, 0, md.err);
    assert.match(md.out, /^# Call /);
    assert.match(md.out, /## What we learned/);
    const md2 = await run(f.calls, "export", "latest", "--md");
    assert.equal(md2.out, md.out);
    const js = await run(f.calls, "export", f.id, "--json");
    assert.equal(js.code, 0, js.err);
    const j = JSON.parse(js.out);
    assert.equal(j.ok, true);
    assert.equal(j.format, "json");
    assert.deepEqual(j.export, buildExport(f.dir));
    const both = JSON.parse((await run(f.calls, "export", f.id, "--md", "--json")).out);
    assert.equal(both.format, "md");
    assert.equal(both.markdown + "", md.out.replace(/\n?$/, "\n"));
    assert.equal((await run(f.calls, "export", "01ARZ3NDEKTSV4RRFFQ69G5FAW")).code, 5);
    assert.equal((await run(f.calls, "export", "../x")).code, 2);
    const e = fixtureCall({ summary: false, memory: false });
    try {
      const r = await run(e.calls, "export", e.id);
      assert.equal(r.code, 5);
      assert.match(r.err, /nothing to export/);
    } finally {
      rmSync(e.calls, { recursive: true, force: true });
    }
  } finally {
    rmSync(f.calls, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- starter packs
test("starter packs: no hosting-only wording in the neutral packs (their text, topics and key terms)", () => {
  const root = join(DATA, "starter-packs");
  const hosting = /hosting|wordpress|woocommerce|plesk|cpanel|\bdns\b|\bphp\b|\bssl\b|domain name|plugin|\bcms\b|אחסון אתרים|דומיין|וורדפרס/i;
  for (const id of readdirSync(root)) {
    for (const f of readdirSync(join(root, id))) {
      const t = readFileSync(join(root, id, f), "utf8");
      // "storage" in the security answers is data at rest, not a web host: the Hebrew word for storage is allowed there
      assert.doesNotMatch(t, hosting, `${id}/${f}`);
    }
  }
});

test("review: mailto encodes brackets so a Markdown link cannot end early", () => {
  const link = mailtoLink("Plan (v2)", "See (the) notes");
  assert.ok(!/[()]/.test(link));
  assert.equal(decodeURIComponent(link.split("body=")[1] ?? ""), "See (the) notes");
});

test("review: coaching ignores rows with bad times and junk text", () => {
  const rows = [
    { ch: "me" as const, text: "word ".repeat(30).trim(), t: Number.NaN },
    { ch: "them" as const, text: "", t: 1000 },
  ];
  assert.equal(computeCoaching(rows), undefined);
});

test("review: time-left card is once, never before the lead, and never without a planned length", () => {
  assert.equal(timeLeftTip({ plannedMin: 0, elapsedMin: 99, alreadyShown: false }), undefined);
  assert.equal(timeLeftTip({ plannedMin: 15, elapsedMin: 14.9, leadMin: 0, alreadyShown: false }), undefined);
  assert.ok(timeLeftTip({ plannedMin: 15, elapsedMin: 15, leadMin: 0, alreadyShown: false }));
  assert.equal(timeLeftTip({ plannedMin: 15, elapsedMin: 16, leadMin: 0, alreadyShown: true }), undefined);
  assert.equal(timeLeftTip({ plannedMin: 4, elapsedMin: 0.5, alreadyShown: false }), undefined);
});
