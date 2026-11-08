import test from "node:test";
import assert from "node:assert/strict";
import { openScope } from "./engine/question.ts";
import { st } from "./engine/state.ts";

test("a newer final aborts every part of the old one; a shared scope stays attached", () => {
  const a = openScope(true);
  assert.equal(st.turn.current, a.ac);
  const b = openScope(true);
  assert.equal(a.ac.signal.aborted, true);
  assert.equal(b.ac.signal.aborted, false);
  assert.equal(st.turn.current, b.ac);
});
