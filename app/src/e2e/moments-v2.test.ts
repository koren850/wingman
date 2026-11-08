// The v2 moment engine in the real process (src/run.ts on the scripted STT and the policy fake): a direct question, a line the observer picks up,
// usage rows per role, a clean stop. Real clock: about 15 s. The detailed cases run in-process on the virtual clock (src/moments-engine.test.ts).
import "../test-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runGolden } from "./helpers.ts";
import { policyModel } from "../testkit/policy-model.ts";
import type { Golden } from "../testkit/golden-types.ts";

const meeting: Pick<Golden, "lines"> = {
  lines: [
    { id: "l1", t: 0, side: "me", text: "Hi, thanks for joining the call today." },
    { id: "l2", t: 2, side: "them", text: "Which kinds of databases can the reporting tool connect to?" },
    { id: "l3", t: 6, side: "them", text: "Honestly your offer is much heavier than the other vendor we looked at" },
  ],
};

test(
  "v2 engine in the real process: a direct question and an observer line both give cards, usage is booked per role, the call ends cleanly",
  { timeout: 90_000 },
  async () => {
    const pm = policyModel({ strict: false, fallback: "SKIP" });
    pm.reply({ role: "moment", lastLine: "databases" }, "ANS\nVALUE: 3\nAIM: me\nSAY: Postgres and MySQL are both supported\nWHY: direct question", {
      ms: 200,
    });
    pm.reply({ role: "observer", lastLine: "heavier" }, "REPLY\nVALUE: 3\nAIM: me\nSAY: Ask what they compared us with first\nWHY: price objection", {
      ms: 200,
    });
    const run = await runGolden(meeting, { policy: pm, tailSeconds: 6, args: ["--set", "moments.engine=v2", "--set", "reflex.stall=true"] });
    try {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /Help engine: New/);
      const cards = run.cards;
      const ans = cards.find((c) => /Postgres/.test(c.text));
      const rep = cards.find((c) => /compared us/.test(c.text));
      assert.ok(ans && ans.kind === "answer" && ans.afterLine === "l2", JSON.stringify(cards));
      assert.ok(rep && rep.kind === "prompt" && rep.afterLine === "l3", JSON.stringify(cards));
      assert.equal(run.modelCalls.filter((c) => c.role === "moment").length, 1);
      assert.equal(run.modelCalls.filter((c) => c.role === "observer").length, 1);
      assert.equal(run.modelCalls.filter((c) => c.role === "reflex").length, 0, "the old reflex call is not used");
      const usage = run.rows("usage.jsonl").filter((r) => r.role === "moment" || r.role === "observer");
      assert.deepEqual(usage.map((r) => r.role).sort(), ["moment", "observer"]);
      assert.ok(
        usage.every((r) => r.ctx && r.ctx.tokens > 100),
        "usage rows carry the context record",
      );
      const lat = run.rows("latency.jsonl").find((r) => r.source === "direct");
      assert.ok(lat && lat.tag === "ANS" && Number(lat.cardAt) > Number(lat.reqAt), JSON.stringify(lat));
    } finally {
      run.cleanup();
    }
  },
);
