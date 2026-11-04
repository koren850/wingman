// Interview plans: kind "interview", the plan's own prepared cards, the interview prompt block and guard.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { isInterview, briefCardsFile, briefNotes, briefKind } from "./brief.ts";
import { guardInterview, guard } from "./guards.ts";
import { buildPrefix, interviewBlock } from "./reflex.ts";

const b = { who: "Alex (Acme)", notes: ["Call kind: interview", "Topic: round 2", "Prepared cards: /tmp/cards.yaml", "Speaks fast"] };

test("an interview plan is recognised and its cards file is read from the notes", () => {
  assert.equal(briefKind(b), "interview");
  assert.ok(isInterview(b));
  assert.ok(isInterview({ notes: ["Call kind: ראיון"] }));
  assert.ok(!isInterview({ notes: ["Call kind: client"] }));
  assert.ok(!isInterview(undefined));
  assert.equal(briefCardsFile(b), "/tmp/cards.yaml");
  assert.ok(!briefNotes(b).some((n) => n.includes("/tmp/cards.yaml")));   // a file path is not a note for the AI
  assert.ok(briefNotes(b).includes("Speaks fast"));
});

test("interview guard keeps the candidate's own dates and numbers, still blocks prices and promises", () => {
  assert.ok(guardInterview("Agent platform: 2,100+ tasks in 4 days, lead dev since 2023").ok);
  assert.ok(!guard("2,100+ tasks in 4 days").ok);   // the client-call guard would have dropped it
  assert.equal(guardInterview("It costs $500 a month").rule, "price");
  assert.equal(guardInterview("I guarantee it will work").rule, "promise");
});

test("the interview prompt replaces the old interview rule and labels the bank as Dan's answers", () => {
  const bank = [{ id: "salary", title: "Salary", triggers: ["salary"], say: "What range did you set?", facts: [] }];
  const p = buildPrefix("style", bank, "", "<background_files>prep</background_files>", true);
  assert.ok(p.includes(interviewBlock()));
  assert.ok(p.includes("Dan's prepared answers (id: title)"));
  assert.ok(!p.includes("mבנה STAR") && !p.includes("Interview, behavioural question"));
  assert.ok(p.includes("Dan's interview prep"));
  assert.ok(!p.includes("Using the background files:"));
  const client = buildPrefix("style", bank, "", "<background_files>prep</background_files>");
  assert.ok(!client.includes(interviewBlock()) && client.includes("Interview, behavioural question"));
});

test("a say-line about the transcript itself is dropped like a leaked tag", async () => {
  const { leakedTag } = await import("./reflex.ts");
  assert.ok(leakedTag('The say-line is about evaluating a RAG system (the transcript garbled "RAG" into "rack").'));
  assert.ok(!leakedTag("Evaluate retrieval and answers separately, with a fixed test set."));
});
