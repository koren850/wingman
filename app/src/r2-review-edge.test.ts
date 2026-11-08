// Round 12 review of r2-context-quality: edge cases for the chunked tail and the role text split.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTailParts, buildContext, modelMessages, type RawLine } from "./context/build.ts";
import { splitRoleText } from "./context/cache.ts";
import { emptyMemory } from "./session/types.ts";

const lines = (n: number, from = 0): RawLine[] =>
  Array.from(
    { length: n },
    (_, i) => ({ side: i % 2 ? "me" : "them", text: `שורה ${from + i} line number ${from + i} about budget`, at: from + i }) as RawLine,
  );

test("chunked tail: text is the stable chunks plus the rest, and growing the window keeps the stable chunks as a prefix", () => {
  const a = renderTailParts(lines(60), 100_000, 4);
  assert.ok(a.stable.length >= 2, "needs anchors");
  assert.equal(a.text, a.stable.join("") + a.rest);
  assert.ok(a.text.startsWith("<call_transcript>\n"));
  assert.ok(a.text.endsWith("\n</call_transcript>"));
  const b = renderTailParts(lines(65), 100_000, 4);
  // the older chunks stay byte-identical (append-only)
  for (let i = 0; i < a.stable.length; i++) assert.equal(b.stable[i], a.stable[i]);
});

test("chunked tail: chunk 0 or too few anchors gives no stable part", () => {
  assert.deepEqual(renderTailParts(lines(40), 100_000, 0).stable, []);
  assert.deepEqual(renderTailParts(lines(2), 100_000, 4).stable, []);
});

test("chunked tail: the parts hold the same text as the plain message and only the last stable part carries a marker", () => {
  const ctx = buildContext({
    role: "moment",
    roleInstructions: "Rules.",
    memory: emptyMemory(0),
    rawLines: lines(60),
    trigger: "t",
    cache: { tailChunk: 4 },
  });
  assert.ok(ctx.parts, "parts set");
  const marked = ctx.parts!.filter((p) => p.providerOptions);
  assert.equal(marked.length, 1);
  assert.equal(ctx.parts!.at(-1)!.providerOptions, undefined);
  assert.equal(ctx.parts!.map((p) => p.text).join(""), ctx.messages[0].content.replace(/^$/, ""));
  assert.equal(modelMessages(ctx)[0].content, ctx.parts);
  const plain = buildContext({ role: "moment", roleInstructions: "Rules.", memory: emptyMemory(0), rawLines: lines(60), trigger: "t" });
  assert.equal(plain.parts, undefined);
  assert.equal(modelMessages(plain)[0].content, plain.messages[0].content);
});

test("at most 4 cache markers in one request, including the chunked tail", () => {
  const mem = emptyMemory(0);
  mem.summary = "x ".repeat(50);
  mem.facts.push({ id: "f1", text: "a fact", at: 1 } as never);
  const ctx = buildContext({
    role: "moment",
    roleInstructions: "Rules.\n\n<call_facts>\nx\n</call_facts>",
    memory: mem,
    rawLines: lines(60),
    trigger: "t",
    cache: { tailChunk: 4 },
  });
  const n = ctx.system.filter((b) => b.cache).length + (ctx.parts?.filter((p) => p.providerOptions).length ?? 0);
  assert.ok(n <= 4, `markers ${n}`);
});

test("splitRoleText: the earliest marker wins, and a role text without markers is all rules", () => {
  const t = "rules\n\nCall frame (x)\nmore\n\n<call_facts>\nf";
  const s = splitRoleText(t);
  assert.equal(s.rules, "rules");
  assert.ok(s.data.startsWith("Call frame"));
  assert.deepEqual(splitRoleText("plain"), { rules: "plain", data: "" });
  assert.deepEqual(splitRoleText(""), { rules: "", data: "" });
});
