// r3 gate: early start latency on the virtual clock. Each question is "spoken" as growing partials; the speech ends at SPEECH_END_MS after the first partial
// and the final arrives FINAL_LAG_MS later. The measured time is from the end of speech to the first card on screen, with moments.earlyStart off and on, over
// QUESTIONS different questions, with the same scripted model delay (MODEL_MS) in both runs. SCRIPTED: the STT lag and the model delay are assumptions,
// not recordings; the real gain is measured by the maintainer's morning run. What this proves is the mechanism: the gain is positive, it is not larger than the
// time the call started early, nothing is asked twice, and every card is the same as without early start.
import "../test-setup.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupEngine, type Engine } from "../testkit/engine-inproc.ts";
import type { SttResult } from "../providers/stt/types.ts";

const QUESTIONS = 12;
const SPEECH_END_MS = 300; // speech ends this long after the first partial
const FINAL_LAG_MS = 700; // the final arrives this long after the speech ends (endpointing plus network): an assumption, stated in the docs
const MODEL_MS = 800; // scripted model delay of the direct call

let e: Engine;
let ingest: typeof import("../engine/ingest.ts");
before(async () => {
  e = await setupEngine();
  ingest = await import("../engine/ingest.ts");
});
after(() => e?.stop());

const S = () => e.boot.S as unknown as { moments: { earlyStart: boolean } };
const partial = (text: string) => ingest.onResult({ channel: "them", text, isFinal: false, speechFinal: false, words: [], arrivedAt: Date.now() } as SttResult);
const TOPICS = ["databases", "backups", "exports", "invoices", "dashboards", "alerts", "webhooks", "templates", "reports", "plugins", "imports", "roles"];

async function run(early: boolean) {
  const gaps: number[] = [];
  let calls = 0;
  const cards: string[] = [];
  for (let i = 0; i < QUESTIONS; i++) {
    await e.reset();
    S().moments.earlyStart = early;
    const q = `Which ${TOPICS[i]} can the reporting tool handle for a team of ${10 + i} people?`;
    e.pm.reply({ role: "moment" }, `ANS\nVALUE: 3\nAIM: me\nSAY: It handles ${TOPICS[i]} for a team of any size\nWHY: test`, { ms: MODEL_MS });
    const t0 = Date.now();
    partial(q.split(" ").slice(0, 5).join(" "));
    await e.vc.advance(SPEECH_END_MS - 100);
    partial(q);
    await e.vc.advance(100);
    const speechEnd = Date.now();
    await e.vc.advance(FINAL_LAG_MS);
    e.say("them", q);
    await e.vc.advance(4000);
    const ms = e.firstCardMs(t0);
    assert.ok(ms !== undefined, `question ${i}: no card (early ${early})`);
    gaps.push(t0 + ms - speechEnd);
    calls += e.pm.callsFor("moment").length;
    cards.push(String(e.screen().find((c) => c.kind === "answer")?.say ?? e.screen()[0]?.say ?? ""));
  }
  S().moments.earlyStart = false;
  return { gaps, calls, cards };
}
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const p95 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil(a.length * 0.95) - 1)];

test(
  "early start on the virtual clock: the card comes earlier after the end of speech, with no extra call and the same card",
  { timeout: 120_000 },
  async () => {
    const off = await run(false);
    const on = await run(true);
    const gain = median(off.gaps) - median(on.gaps);
    console.log(
      `EARLY START latency (scripted, ${QUESTIONS} questions, STT lag ${FINAL_LAG_MS} ms, model ${MODEL_MS} ms): ` +
        `off median ${median(off.gaps)} ms p95 ${p95(off.gaps)} ms; on median ${median(on.gaps)} ms p95 ${p95(on.gaps)} ms; gain ${gain} ms; calls ${off.calls} / ${on.calls}`,
    );
    assert.equal(on.calls, off.calls, "every final matched its partial: early start made no extra model call");
    assert.deepEqual(on.cards, off.cards, "the cards are the same with and without early start");
    assert.ok(gain >= 300, `median gain ${gain} ms (expected about ${FINAL_LAG_MS - 300} ms)`);
    assert.ok(gain <= FINAL_LAG_MS, `a gain of ${gain} ms is more than the time between the end of speech and the final`);
    assert.ok(p95(on.gaps) <= p95(off.gaps), "the slowest case is not slower with early start");
    assert.ok(p95(on.gaps) <= 1500, `p95 after the end of speech ${p95(on.gaps)} ms`);
  },
);
