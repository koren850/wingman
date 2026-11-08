// Wrap-up from the call memory (summary.ts runWrapup): open loops, the follow-up draft and its guards, the fallbacks.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWrapup, mergeWrapFields, localWrapFields, memoryOpenLoops, wrapupSkipReason, type CallData } from "./summary.ts";
import { policyModel } from "./testkit/policy-model.ts";
import { applyPatch } from "./session/patch.ts";
import { emptyMemory, type SessionMemory } from "./session/types.ts";
import { CostMeter } from "./cost.ts";
import { loadSettings } from "./settings.ts";
import { ME_LABEL } from "./profile.ts";
import { memoryWrapUpTip } from "./tips.ts";
import type { ModelRegistry } from "./providers/llm.ts";

const WRAP = { system: "post-call summary" }; // the summary prompt also starts like the reflex prompt, so the role marker is not used here

const S0 = loadSettings({ env: {}, userFile: "/nonexistent/x.yaml" }).settings;
const newCost = () => new CostMeter(S0.budget.prices, S0.budget);
const mem = (): SessionMemory => {
  const r = applyPatch(
    emptyMemory(1000),
    {
      add: {
        facts: [{ text: "The shop sells garden tools online", who: "Dana" }],
        numbers: [{ what: "storage", value: "500 GB" }],
        commitments: [
          { who: "me", what: "send the offer", due: "Tuesday" },
          { who: "Dana", what: "share the product list" },
          { who: "me", what: "book the call" },
        ],
        openQuestions: [
          { asker: "Dana", text: "Who owns the DNS records" },
          { asker: "me", text: "What is the traffic" },
        ],
        decisions: [{ text: "Start with the product pages" }],
        objections: [{ who: "Dana", text: "The old host was cheaper" }],
      },
      resolve: ["c3", "q2"],
      summary: "They plan to move a garden tools shop. Speed matters. Hosting is the open topic.",
      topic: "migration",
    },
    { now: 2000 },
  );
  assert.ok(r.applied, r.reason);
  const withAgenda = {
    ...r.mem,
    mustCover: [
      { id: "m1", text: "Timeline", done: false },
      { id: "m2", text: "Budget", done: true },
    ],
  };
  return withAgenda;
};
const lines: CallData["lines"] = Array.from({ length: 60 }, (_, i) => ({
  ch: i % 2 ? ("me" as const) : ("them" as const),
  text: `line ${i} about the shop storage of 500 GB`,
}));

test("memoryOpenLoops: open questions, objections, open promises and agenda items left", () => {
  const l = memoryOpenLoops(mem(), "en");
  assert.deepEqual(l.openQuestions, ["Who owns the DNS records", "The old host was cheaper", "Not covered in the call: Timeline"]);
  assert.deepEqual(
    l.nextSteps.map((n) => [n.who, n.what, n.when]),
    [
      [ME_LABEL, "send the offer", "Tuesday"],
      ["Dana", "share the product list", undefined],
    ],
  );
  assert.deepEqual(l.decisions, ["Start with the product pages"]);
  assert.equal(memoryOpenLoops(mem(), "he").openQuestions.at(-1), "לא כוסה בשיחה: Timeline");
});

test("localWrapFields: a summary, the open loops and an email made from the memory alone", () => {
  const f = localWrapFields(mem(), "en");
  assert.ok(f.summary.length >= 1 && f.summary.length <= 5);
  assert.match(f.followUpEmail, /Still open:/);
  assert.match(f.followUpEmail, /Who owns the DNS records/);
  assert.match(f.followUpEmail, /send the offer/);
  assert.equal(localWrapFields(emptyMemory(0), "en").followUpEmail, "");
});

test("mergeWrapFields adds the memory's open loops to what the model wrote, without duplicates", () => {
  const model = {
    summary: ["a"],
    decisions: [],
    nextSteps: [{ who: ME_LABEL, what: "Send the offer" }],
    openQuestions: ["who owns the dns records"],
    followUpEmail: "Hi,",
  };
  const m = mergeWrapFields(model, mem(), "en");
  assert.equal(m.nextSteps.length, 2, "the offer is there once; Dana's promise was added");
  assert.equal(m.openQuestions.filter((q) => /dns/i.test(q)).length, 1);
  assert.ok(m.openQuestions.includes("Not covered in the call: Timeline"));
  assert.deepEqual(m.decisions, ["Start with the product pages"]);
});

function setup(reply: string | undefined, o: { capped?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wm-wrap-"));
  const pm = policyModel({ strict: false, defaultText: "{}" });
  if (reply !== undefined) pm.reply(WRAP, reply);
  else pm.error(WRAP, 529, "overloaded");
  const registry = { resolve: async () => pm.model } as unknown as ModelRegistry;
  const cost = newCost();
  if (o.capped) cost.addLlm("x", S0.summary.model, { inputTokens: 1e12, outputTokens: 1e12 });
  const rows: { stream: string; [k: string]: unknown }[] = [];
  const run = (over: object = {}) =>
    runWrapup({
      dir,
      callId: "C1",
      S: S0,
      registry,
      cost,
      mem: mem(),
      lines,
      contextNotes: [],
      write: (stream, row) => rows.push({ stream, ...row }),
      generate: undefined,
      ...over,
    });
  return { dir, pm, run, rows, cost };
}
const MODEL_JSON = JSON.stringify({
  summary: ["They plan to move a garden tools shop", "Speed matters"],
  decisions: ["Start with the product pages"],
  nextSteps: [{ who: ME_LABEL, what: "send the offer" }],
  openQuestions: [],
  followUpEmail: "Hi,\nThank you for the call. We will start with the product pages. I guarantee full success.\nBest regards",
});

test("runWrapup: summary.json has open loops from the memory, the email passes the guards, one model call, only the tail of the call", async () => {
  const t = setup(MODEL_JSON);
  const r = await t.run();
  assert.ok(r.ok, r.error);
  assert.equal(t.pm.calls.length, 1);
  const file = join(t.dir, "summary.json");
  const s = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(s.from, "memory");
  assert.ok(s.openQuestions.includes("Who owns the DNS records"), "an open question from the memory");
  assert.ok(s.openQuestions.includes("Not covered in the call: Timeline"));
  assert.ok(
    s.nextSteps.some((n: { who: string }) => n.who === "Dana"),
    "Dana's promise from the memory",
  );
  // the follow-up passed the guards: "I guarantee" is a promise sentence, so it became a placeholder
  assert.doesNotMatch(s.followUpEmail, /guarantee/);
  assert.match(s.followUpEmail, /\[fill in/);
  // the prompt: memory in, the tail only, not the whole transcript
  const v = t.pm.assertPrompt(WRAP, { contains: ["garden tools", "Who owns the DNS records"], notContains: "line 0 about" });
  assert.match(v.user, /line 59 about/);
  assert.ok(v.tokens < 14000);
  assert.ok(t.rows.some((x) => x.type === "summary.done" && x.from === "memory"));
});

test("runWrapup: a figure in the email that nobody said becomes a placeholder", async () => {
  const bad = JSON.parse(MODEL_JSON);
  bad.followUpEmail = "Hi,\nThank you for the call. Your site will hold 88 pages. The storage is 500 GB.\nBest regards";
  const t = setup(JSON.stringify(bad));
  const r = await t.run();
  assert.ok(r.ok);
  const s = JSON.parse(readFileSync(join(t.dir, "summary.json"), "utf8"));
  assert.doesNotMatch(s.followUpEmail, /88/);
  assert.match(s.followUpEmail, /500 GB/);
  assert.ok(s.guard.rules.includes("number"));
});

test("runWrapup: when the model fails, the memory alone makes the summary, with open loops and a guarded follow-up", async () => {
  const t = setup(undefined);
  const r = await t.run();
  assert.ok(r.ok);
  const s = JSON.parse(readFileSync(join(t.dir, "summary.json"), "utf8"));
  assert.equal(s.model, "memory");
  assert.ok(s.openQuestions.includes("Who owns the DNS records"));
  assert.match(s.followUpEmail, /Still open:/);
  assert.ok(t.rows.some((x) => x.type === "wrapup.model-failed"));
  // the template is also guarded: "Tuesday" is a date and becomes a placeholder
  assert.doesNotMatch(s.followUpEmail, /Tuesday/);
});

test("runWrapup: a spent budget skips the model call and still writes the summary from the memory", async () => {
  const t = setup(MODEL_JSON, { capped: true });
  const r = await t.run();
  assert.ok(r.ok);
  assert.equal(t.pm.calls.length, 0);
  assert.ok(t.rows.some((x) => x.type === "wrapup.model-failed" && x.reason === "cost-cap"));
});

test("runWrapup: no memory, discard, crash, no AI: nothing is written and the caller falls back", async () => {
  const t = setup(MODEL_JSON);
  for (const [over, why] of [
    [{ mem: emptyMemory(0) }, "no-memory"],
    [{ discard: true }, "discard"],
    [{ crashed: true }, "crashed"],
    [{ noAi: true }, "no-ai"],
  ] as const) {
    const r = await t.run(over);
    assert.equal(r.skipped, why);
  }
  assert.equal(existsSync(join(t.dir, "summary.json")), false);
  assert.equal(wrapupSkipReason({ mem: mem(), S: S0, noAi: false }), undefined);
});

test("runWrapup: Skip summary (abort) writes nothing", async () => {
  const t = setup(MODEL_JSON);
  const ac = new AbortController();
  ac.abort();
  const r = await t.run({ signal: ac.signal });
  assert.equal(r.skipped, "user");
  assert.equal(existsSync(join(t.dir, "summary.json")), false);
});

test("memoryWrapUpTip: the wrap-up reminder reads the memory, once, only at a closing cue or late in the call", () => {
  const m = mem();
  const o = { latestText: "ok", elapsedMin: 5, wrapUpAfterMin: 40, alreadyNudged: false, lang: "en" as const };
  assert.equal(memoryWrapUpTip(m, o), undefined, "not yet");
  const t = memoryWrapUpTip(m, { ...o, latestText: "thanks so much, talk soon" });
  assert.match(t!.text, /still open: Timeline/);
  assert.equal(memoryWrapUpTip(m, { ...o, elapsedMin: 50 })?.type, "remind");
  assert.equal(memoryWrapUpTip(m, { ...o, elapsedMin: 50, alreadyNudged: true }), undefined);
  assert.equal(memoryWrapUpTip(emptyMemory(0), { ...o, elapsedMin: 50 }), undefined);
});
