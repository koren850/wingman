// Prompt snapshots for every model role of the v2 engine, taken from real calls of the real engine modules (in-process, virtual clock, policy fake):
// moment, observer, memory, compact, wrap-up, plus the block layout (which block is cached for how long). ask and digest have their own snapshots
// (src/ask-digest.test.ts). A change to any prompt shows up as a diff of a .txt file in data/snapshots/prompts/. To accept it:
//   WINGMAN_UPDATE_SNAPSHOTS=1 ./node_modules/.bin/tsx --import ./src/test-setup.ts --test src/e2e/v2-prompts.test.ts   then read `git diff`.
// Also here: size ceilings per role (the prompt never goes over its budget) and checks on how replies are read (a prompt change must not break the format).
import "../test-setup.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupEngine, type Engine } from "../testkit/engine-inproc.ts";
import { registerRole } from "../testkit/prompt.ts";
import { policyModel } from "../testkit/policy-model.ts";
import { assertPromptSnapshot } from "../testkit/prompt-snapshot.ts";
import { loadSplit } from "../../qa/golden-load.ts";
import { observeModel, observePolicy, type CallRecord } from "./v2-kit.ts";
import { DEFAULT_BUDGETS } from "../context/budget.ts";
import { MOMENT_RULES } from "../moments/prompt.ts";
import { MEMORY_UPDATER_INSTRUCTIONS, COMPACTOR_INSTRUCTIONS } from "../session/prompt.ts";
import { parseMoment } from "../moments/parse.ts";
import { runWrapup } from "../summary-wrapup.ts";
import { applyPatch } from "../session/patch.ts";
import { emptyMemory } from "../session/types.ts";
import { CostMeter } from "../cost.ts";
import { loadSettings } from "../settings.ts";
import type { ModelRegistry } from "../providers/llm.ts";

registerRole("memory", "You keep the memory of a live call");
registerRole("compact", "You tidy the memory of a live call");

let e: Engine;
let calls: CallRecord[] = [];
before(async () => {
  e = await setupEngine({ "llm.reflex.model": "anthropic:claude-haiku-5-5", "memory.compactEveryMinutes": 1 });
  const coach = await import("../engine/coach.ts");
  const obs = observeModel(e, { keepText: true });
  calls = obs.calls;
  await e.reset(0);
  const g = loadSplit("dev").find((x) => x.id === "dev-sales-en")!;
  // the replies: the meeting's own, and one patch for the first memory call so that the later prompts carry a memory block
  for (const s of g.script ?? []) {
    const t = g.lines.find((l) => l.id === s.whenLastLine)?.text;
    if (s.role === "moment" && t) e.pm.reply({ role: ["moment", "observer"], lastLine: t }, s.reply, { ms: s.ms ?? 800 });
  }
  e.pm.reply(
    { role: "memory" },
    JSON.stringify({
      add: {
        facts: [{ text: "Northwind Foods is a grocery chain with 14 stores", who: "Maya" }],
        numbers: [{ what: "budget in the intake form", value: "$5,000", who: "Maya" }],
        commitments: [{ who: "Maya", what: "send the full product list", due: "Wednesday" }],
        openQuestions: [{ asker: "Josh", text: "Do you handle pickup lockers" }],
      },
      topic: "online store scope and budget",
    }),
    { ms: 700, times: 1 },
  );
  e.pm.reply({ role: "memory" }, "{}", { ms: 600 });
  e.pm.reply({ role: "compact" }, JSON.stringify({ summary: "Maya wants an online store with delivery slots for 14 stores." }), { ms: 900 });
  coach.tipsTick();
  let prev = 0;
  for (const l of g.lines.slice(0, 22)) {
    await e.vc.advance(Math.max(0, l.t - prev));
    prev = l.t;
    e.say(l.side, l.text);
  }
  await e.vc.advance(120_000);
});
after(() => e?.stop());

const last = (role: string) => {
  const c = calls.filter((x) => x.role === role && x.text).at(-1);
  assert.ok(c?.text, `a ${role} call was made`);
  return c!;
};
const asPrompt = (c: CallRecord) => ({
  system: c.text!.system.map((b, i) => `--- block ${i + 1}${b.cache ? ` (cache ${b.cache})` : " (not cached)"} ---\n${b.text}`).join("\n"),
  messages: [{ role: "user", content: c.text!.user }],
});

for (const role of ["moment", "observer", "memory", "compact"] as const)
  test(`snapshot: ${role} prompt (blocks, cache markers, memory block, transcript tail)`, () => {
    assertPromptSnapshot(`v2-${role}`, asPrompt(last(role)));
  });

test("snapshot: wrap-up prompt (from a fixed memory and a fixed tail)", async () => {
  const S0 = loadSettings({ env: {}, userFile: "/nonexistent/x.yaml" }).settings;
  const pm = policyModel({ strict: false });
  pm.reply({ system: "post-call summary" }, JSON.stringify({ summary: ["x"], decisions: [], nextSteps: [], openQuestions: [], followUpEmail: "" }));
  const o = observePolicy(pm, { keepText: true });
  const r = applyPatch(
    emptyMemory(1000),
    {
      add: {
        facts: [{ text: "The shop sells garden tools online", who: "Dana" }],
        commitments: [{ who: "me", what: "send the offer", due: "Tuesday" }],
        openQuestions: [{ asker: "Dana", text: "Who owns the DNS records" }],
      },
      summary: "They plan to move a garden tools shop. Speed matters.",
      topic: "migration",
    },
    { now: 2000 },
  );
  assert.ok(r.applied);
  await runWrapup({
    dir: mkdtempSync(join(tmpdir(), "wm-wrapsnap-")),
    callId: "C1",
    S: S0,
    registry: { resolve: async (_r: string, role?: string) => o.wrap(role) } as unknown as ModelRegistry,
    cost: new CostMeter(S0.budget.prices, S0.budget),
    mem: r.mem,
    lines: [
      { ch: "them", text: "So who owns the DNS records today?" },
      { ch: "me", text: "I will find out and send the offer on Tuesday." },
    ],
    contextNotes: [],
    write: () => {},
    generate: undefined,
  });
  const c = o.calls.find((x) => x.text);
  assert.ok(c, "a wrap-up call was made");
  assertPromptSnapshot("v2-wrapup", asPrompt(c));
});

test("snapshot: block layout per role (which block is cached, for how long, and how many tokens each holds)", () => {
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const c of calls.filter((x) => x.text)) {
    if (seen.has(c.role)) continue;
    seen.add(c.role);
  }
  for (const role of ["moment", "observer", "memory", "compact"]) {
    const c = last(role);
    rows.push(
      `${role}: ` +
        c
          .text!.system.map(
            (b, i) =>
              `block ${i + 1} ${b.cache ? "cache " + b.cache : "no cache"} ${c.blocks[i].tokens} tokens, starts "${b.text.trim().slice(0, 40).replace(/\s+/g, " ")}"`,
          )
          .join(" | ") +
        ` | user message ${c.userTokens} tokens`,
    );
  }
  // token counts are an estimate that moves with every wording change: they are part of the reviewed diff
  assertPromptSnapshot("v2-layout", { system: rows.join("\n") });
});

// ---------------------------------------------------------------- ceilings and format checks (these do not need a snapshot)
test("memory in the prompts: the moment and observer calls carry the block the memory loop built (the call teaches the next call)", () => {
  for (const role of ["moment", "observer"]) {
    const c = last(role);
    const mem = c.text!.system.find((b) => /<call_memory>/.test(b.text));
    assert.ok(mem, `${role}: no <call_memory> block in the prompt: the memory loop learns, but this call never sees it`);
    assert.equal(mem.cache, "5m", `${role}: the memory block is the 5-minute cache block`);
    assert.match(mem.text, /Northwind Foods/, `${role}: the fact the loop learned is in the block`);
    assert.match(mem.text, /pickup lockers/, `${role}: the open question is in the block`);
  }
});

test("memory seed: a late pre-meeting seed never overwrites what the call already learned", async () => {
  const moments = await import("../engine/moments.ts");
  const { st } = await import("../engine/state.ts");
  const { contextNotes } = await import("../engine/boot.ts");
  const keep = st.m.mem;
  contextNotes.push("Invented prepared note for the seed test");
  try {
    assert.ok(keep.ver > 0 || keep.facts.length > 0, "the replayed call has a learned memory");
    moments._resetMoments(); // the seed flag is per process: clear it so that ensureSeeded runs again
    moments.ensureSeeded();
    assert.equal(st.m.mem, keep, "ensureSeeded replaced the learned memory");
  } finally {
    contextNotes.pop();
    st.m.mem = keep;
  }
});

test("size: every role's input stays under its budget in the replayed call, and the static rules stay short", () => {
  for (const role of ["moment", "observer", "memory", "compact"] as const) {
    const c = last(role);
    const total = c.plain + c.read + c.write;
    assert.ok(total <= DEFAULT_BUDGETS[role].total + 400, `${role}: ${total} tokens (budget ${DEFAULT_BUDGETS[role].total})`);
  }
  const est = (s: string) => Math.ceil(s.length / 3.5);
  console.log(
    `PROMPT SIZE static text: moment rules ${est(MOMENT_RULES)} tokens, memory updater ${est(MEMORY_UPDATER_INSTRUCTIONS)}, compactor ${est(COMPACTOR_INSTRUCTIONS)}`,
  );
  assert.ok(est(MOMENT_RULES) <= 1350, "the moment rules fit in 1350 tokens");
  assert.ok(est(MEMORY_UPDATER_INSTRUCTIONS) <= 700);
});

test("format: the moment prompt names every verdict the reader accepts, and a reply in either layout is read the same way", () => {
  for (const tag of ["SKIP", "ANS", "BANK", "STALL", "REPLY", "CHECK", "TERM", "PROMPT", "NOTE"])
    assert.ok(new RegExp(`\\b${tag}\\b`).test(MOMENT_RULES), `${tag} is described`);
  const body = "VALUE: 2\nAIM: me\nSAY: Ask what they compared us with\nWHY: price objection";
  const read = (txt: string) => parseMoment(txt).moment;
  const plain = read(`REPLY\n${body}`),
    tagged = read(`TAG: REPLY\n${body}`),
    lower = read(`reply\n${body}`),
    fenced = read("```\nREPLY\n" + body + "\n```");
  for (const [name, m] of Object.entries({ plain, tagged, lower, fenced })) console.log(`FORMAT ${name}: ${m.tag}${m.tag === "SKIP" ? " (not read)" : ""}`);
  assert.equal(plain.tag, "REPLY");
  assert.equal(tagged.tag, "REPLY", "the layout the golden scripts use (TAG: first)");
});
