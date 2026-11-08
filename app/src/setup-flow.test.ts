// The guided setup flow (dashboard/setuplib.js): three required steps, optional extras, "2 of 3" progress, and the wiring in setup.js.
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./env.ts";
const req = createRequire(import.meta.url);
const S = req("../dashboard/setuplib.js");

test("the required path is three steps: try, connect, allow", () => {
  assert.deepEqual(S.REQUIRED, ["try", "connect", "allow"]);
  assert.deepEqual(S.OPTIONAL, ["about", "privacy", "mic", "pack", "check"]);
});

test("progress reads '2 of 3' and the card is ready only when all three are done", () => {
  const p = S.plan({ done: { try: true, connect: true } });
  assert.equal(S.progressText(p.count, p.total), "2 of 3");
  assert.equal(p.ready, false);
  assert.equal(p.next, "allow");
  assert.equal(p.visible, true);
  const r = S.plan({ done: { try: true, connect: true, allow: true } });
  assert.equal(r.ready, true);
  assert.equal(r.next, "");
  assert.equal(r.visible, true); // shows "You're ready" until it is closed
  assert.equal(S.plan({ done: { try: true, connect: true, allow: true }, closed: true }).visible, false);
  assert.equal(S.plan({ done: { try: true, connect: true, allow: true }, closed: true, force: true }).visible, true);
});

test("skipping a required step moves on and hides the card; opening the guide from Settings shows it again", () => {
  const sk = { try: true, connect: true };
  const p = S.plan({ done: {}, skipped: sk });
  assert.equal(p.next, "allow");
  assert.equal(p.settled, false);
  const all = S.plan({ done: {}, skipped: { ...sk, allow: true } });
  assert.equal(all.settled, true);
  assert.equal(all.visible, false);
  assert.equal(all.count, 0);
  assert.equal(S.plan({ done: {}, skipped: { ...sk, allow: true }, force: true }).visible, true);
  assert.equal(S.plan({}).next, "try");
});

test("plain names: the user guide lists the glossary words (the window wording is held by the glossary lint rule in eslint.config.mjs)", () => {
  const guide = readFileSync(join(ROOT, "../docs/USER-GUIDE.md"), "utf8");
  assert.match(guide, /## Words used in Wingman/);
  for (const t of ["Group call mode", "About the call", "Your answers", "Speech to text", "Readiness check"]) assert.ok(guide.includes(t), t);
});
