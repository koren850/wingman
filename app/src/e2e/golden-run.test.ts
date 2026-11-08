// The e2e golden helper: a tiny two-line meeting is played into the real engine (src/run.ts, scripted STT, policy fake model)
// and the helper returns the card timeline. Also: the same meeting shape on the virtual clock, in this process.
import "../test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runGolden, replayOnVClock, collectCards } from "./helpers.ts";
import { policyModel } from "../testkit/policy-model.ts";
import { createVClock } from "../testkit/vclock.ts";
import type { Golden } from "../testkit/golden-types.ts";

const tiny: Pick<Golden, "lines"> = {
  lines: [
    { id: "l1", t: 0, side: "me", text: "Hi, thanks for joining the call today." },
    { id: "l2", t: 2, side: "them", text: "Hello. Which kinds of databases can the reporting tool connect to?" },
  ],
};

test("golden helper: a two-line meeting goes through the real engine and the card timeline comes back", { timeout: 60_000 }, async () => {
  const pm = policyModel({ strict: false, fallback: "SKIP" });
  pm.reply({ role: "reflex", lastLine: "databases" }, "ANS\nIt connects to Postgres and MySQL, about ten minutes to set up.", { ms: 150 });
  const run = await runGolden(tiny, { policy: pm, tailSeconds: 4 });
  try {
    assert.equal(run.code, 0, run.out);
    const ai = run.cards.filter((c) => /ten minutes/.test(c.text));
    assert.equal(ai.length, 1, `one answer card, got ${JSON.stringify(run.cards)}`);
    assert.equal(ai[0].afterLine, "l2", "tied to the line that triggered it");
    assert.ok(ai[0].msAfterLine !== undefined && ai[0].msAfterLine >= 0 && ai[0].msAfterLine < 5000, `latency after the line: ${ai[0].msAfterLine}`);
    assert.equal(ai[0].kind, "answer");
    assert.equal(run.modelCalls.filter((c) => c.role === "reflex" && c.rule === 0).length, 1, "the engine asked the fake model once, and the rule served it");
  } finally {
    run.cleanup();
  }
});

test("golden helper: collectCards merges update rows, skips health and info rows, and ties a card to the last line before it", () => {
  const rows = [
    { t: 1000, type: "card", id: "a", badge: "ai", say: "first" },
    { t: 1100, type: "card", id: "a", badge: "ai", say: "first and more" },
    { t: 1200, type: "card", id: "h", badge: "ai", say: "x", health: true },
    { t: 1300, type: "card", id: "i", badge: "info", say: "x" },
    { t: 4200, type: "card", id: "b", badge: "fact", say: "fact" },
    { t: 4300, type: "capture", id: "c" },
  ];
  const got = collectCards(rows, 0, [
    { id: "l1", atMs: 500 },
    { id: "l2", atMs: 4000 },
  ]);
  assert.deepEqual(
    got.map((c) => [c.id, c.kind, c.afterLine, c.msAfterLine]),
    [
      ["a", "answer", "l1", 500],
      ["b", "fact", "l2", 200],
    ],
  );
});

test("golden helper: replayOnVClock plays the lines at their times on a virtual clock", async () => {
  const vc = createVClock({ start: 0 });
  const seen: [string, number][] = [];
  const t0 = Date.now();
  vc.install();
  try {
    await replayOnVClock(vc, { lines: [...tiny.lines, { id: "l3", t: 60, side: "them", text: "Anything else?" }] }, (l, at) => {
      seen.push([l.id, at]);
    });
    assert.deepEqual(seen, [
      ["l1", 0],
      ["l2", 2000],
      ["l3", 60000],
    ]);
    assert.ok(vc.elapsed() >= 65_000);
  } finally {
    vc.uninstall();
  }
  assert.ok(Date.now() - t0 < 1000, "a 65 s meeting in under a second of real time");
});
