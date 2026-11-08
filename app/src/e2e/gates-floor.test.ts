// r3 gate: the AI-paused floor, through the real engine. The model is marked down for the whole run (the same state the ladder reaches after repeated
// failures), then golden dev meetings are replayed line by line on the virtual clock. What must hold: no model call is made, every call keeps running
// without a crash, question lines that the floor catches get their card (prepared bank card or buy-time line) inside the latency budget, and a
// statement-only stretch stays quiet. The numbers are printed and quoted in the report as SCRIPTED (golden dev is the tuning set, so they are in-sample).
import "../test-setup.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupEngine, type Engine } from "../testkit/engine-inproc.ts";
import { loadSplit } from "../../qa/golden-load.ts";

let e: Engine;
before(async () => {
  e = await setupEngine();
});
after(() => e?.stop());

const events = () =>
  readFileSync(e.boot.log.dir + "/events.jsonl", "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
const pauseAi = () => {
  for (const m of e.boot.REFLEX_MODELS) e.boot.downUntil.set(m, Date.now() + 6 * 3600_000);
};

test(
  "AI paused: golden dev replay through the engine makes no model call, loses no call to an error and answers most question lines",
  { timeout: 240_000 },
  async () => {
    const dev = loadSplit("dev").filter((g) => g.type !== "interview");
    assert.ok(dev.length >= 20, `${dev.length} meetings`);
    let answers = 0,
      caught = 0,
      cards = 0,
      lines = 0;
    const lat: number[] = [];
    let quietCards = 0,
      quietLines = 0;
    for (const g of dev) {
      await e.reset();
      pauseAi();
      const start = Date.now();
      const at = new Map<string, number>();
      const answerLines = new Set(g.moments.filter((m) => m.kind === "answer").map((m) => m.afterLine));
      const quiet = new Set<string>();
      for (const w of g.silent) {
        const a = g.lines.findIndex((l) => l.id === w.fromLine);
        const b = g.lines.findIndex((l) => l.id === w.toLine);
        for (let i = a; i <= b; i++) quiet.add(g.lines[i].id);
      }
      for (const l of g.lines) {
        const wait = start + l.t - Date.now();
        if (wait > 0) await e.vc.advance(wait);
        at.set(l.id, e.say(l.side, l.text));
        lines++;
      }
      await e.vc.advance(5000);
      const shown = e.screen().length;
      cards += shown;
      const rows = e.rows.filter((r) => r.type === "card" && !r.health && !r.hidden && !r.withdraw);
      for (const l of g.lines) {
        const t = at.get(l.id)!;
        const first = rows.find((r) => r.t >= t && r.t - t <= 3000);
        if (answerLines.has(l.id)) {
          answers++;
          if (first) {
            caught++;
            lat.push(first.t - t);
          }
        }
        if (quiet.has(l.id)) {
          quietLines++;
          if (first) quietCards++;
        }
      }
      assert.equal(e.pm.calls.length, 0, `${g.id}: a model call was made while the AI was paused`);
    }
    const sorted = [...lat].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
    const ev = events();
    console.log(
      `AI-PAUSED FLOOR (scripted, in-sample, ${dev.length} meetings, ${lines} lines): answer moments ${caught}/${answers} got a card (${((100 * caught) / answers).toFixed(1)} percent), ` +
        `card latency p95 ${p95} ms, cards left on screen ${cards}, cards in quiet stretches ${quietCards}/${quietLines} lines`,
    );
    assert.equal(e.st.call.crashed ?? false, false);
    assert.equal(ev.filter((x) => x.type === "error.survived").length, 0, JSON.stringify(ev.filter((x) => x.type === "error.survived").slice(0, 3)));
    assert.ok(caught / answers >= 0.5, `floor recall with the AI paused ${caught}/${answers}`);
    assert.ok(p95 <= 1500, `p95 ${p95} ms`);
    assert.ok(quietCards / quietLines <= 0.35, `quiet stretches: ${quietCards}/${quietLines}`);
    assert.ok(cards > 0, "something stayed on screen");
  },
);
