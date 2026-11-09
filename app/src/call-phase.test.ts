// The call phase (engine/phase.ts): forward only, and what hangs off it (st.call flags, the card gate, the health tick).
import "./test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { callPhase, isClosing, isStopping, transition } from "./engine/phase.ts";
import { st } from "./engine/state.ts";
import { emitCard, type Card } from "./engine/cards.ts";
import { startHealthTick } from "./engine/degrade.ts";
import { log, sup } from "./engine/boot.ts";

const card = (id: string, o: Partial<Card> = {}): Card => ({ id, turnId: "t", badge: "ai", question: "q", say: "s", facts: [], at: 1, ...o });
const cardRows = () =>
  readFileSync(join(log.dir, "cards.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

// One process, one call: the phase only moves forward, so these steps run in order in a single test.
test("call phase: forward only, derived flags, cards and the health tick stop with Stop", () => {
  assert.equal(callPhase(), "starting");
  assert.equal(st.call.shuttingDown, false);
  assert.equal(transition("waiting"), true);
  assert.equal(transition("starting"), false, "no way back");
  assert.equal(transition("live"), true);
  assert.equal(callPhase(), "live");
  emitCard(card("before"));
  assert.ok(cardRows().some((r) => r.id === "before"));

  assert.equal(transition("closing"), true);
  assert.equal(isStopping(), true);
  assert.equal(isClosing(), true);
  assert.equal(st.call.shuttingDown, true, "derived from the phase");
  assert.equal(st.call.closing, true);
  assert.equal(transition("live"), false, "a late consent cannot bring the call back to live");
  assert.equal(callPhase(), "closing");

  // After Stop only rows that take something away go out.
  emitCard(card("late-answer"));
  emitCard(card("late-health", { health: true, badge: "warn", level: "red" }));
  emitCard(card("before", { withdraw: true }));
  emitCard(card("late-health", { health: true, badge: "warn", clear: true }));
  const ids = cardRows().map((r) => `${r.id}${r.withdraw ? ":withdraw" : ""}${r.clear ? ":clear" : ""}`);
  assert.deepEqual(ids, ["before", "before:withdraw", "late-health:clear"]);

  // The health tick does not start after Stop (a Stop during startup must not bring the supervisor back).
  const listeners = sup.listenerCount("rung");
  startHealthTick();
  assert.equal(sup.listenerCount("rung"), listeners);

  assert.equal(transition("closed"), true);
  assert.equal(isClosing(), false);
  assert.equal(st.call.closing, false);
  assert.equal(st.call.shuttingDown, true);
  assert.equal(transition("closing"), false);
  assert.equal(transition("ended"), true);
});
