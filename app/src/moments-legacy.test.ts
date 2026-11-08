// moments.engine = legacy (the default): the old question gate and reflex call run exactly as before; the moment engine does nothing.
import "./test-setup.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupEngine, type Engine } from "./testkit/engine-inproc.ts";

let e: Engine;
before(async () => {
  e = await setupEngine({ "moments.engine": "legacy" });
});
after(() => e?.stop());

test("legacy: a question makes one reflex call (no moment or observer call) and the reflex card shows", async () => {
  await e.reset();
  e.pm.reply({ role: "reflex", lastLine: "databases" }, "ANS\nPostgres and MySQL are both supported", { ms: 400 });
  e.say("them", "Which databases can the reporting tool connect to?");
  await e.vc.advance(3000);
  assert.equal(e.pm.callsFor("reflex").length, 1);
  assert.equal(e.pm.callsFor("moment").length + e.pm.callsFor("observer").length, 0);
  const s = e.screen();
  assert.equal(s.length, 1, JSON.stringify(s));
  assert.equal(s[0].say, "Postgres and MySQL are both supported");
  assert.equal(s[0].kind, undefined, "a legacy card row has no v2 fields");
});

test("legacy: lines without a question make no model call at all, and a number the user says is not checked", async () => {
  await e.reset();
  e.st.m.mem = { ...e.st.m.mem, numbers: [{ id: "n1", what: "quoted price for the whole project", value: "5000 ₪", at: 0 }] };
  e.say("them", "Honestly your offer is much heavier than the other vendor we looked at");
  await e.vc.advance(4000);
  e.say("me", "So the quoted price for the project is 4000 ₪ in total");
  await e.vc.advance(4000);
  assert.equal(e.pm.calls.length, 0);
  assert.equal(e.screen().filter((c) => c.kind === "check").length, 0);
});

test("legacy: the engine mode shows in the settings and the v2 state stays untouched", async () => {
  assert.equal(e.boot.S.moments.engine, "legacy");
  assert.equal(e.boot.momentsV2, false);
  assert.equal(e.st.m.seq, 0);
});
