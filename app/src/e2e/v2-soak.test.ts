// A 3-hour call on the virtual clock, through the real engine modules (in-process, health tick and memory loop running as in run.ts), with faults
// injected on the way: memory disk full (10 min), a corrupt session.json, a 5-minute model outage, a wall-clock jump forward and back.
// Asserts: no crash, a direct question every 30 minutes gets its card in time, calls per hour stay inside their caps, cost per hour stays under the
// release gate, memory lists stay at their caps, session.json stays small and valid, timers and memory do not grow.
import "../test-setup.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import v8 from "node:v8";
import vm from "node:vm";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { setupEngine, type Engine } from "../testkit/engine-inproc.ts";
import { error } from "../testkit/policy-model.ts";
import { registerRole } from "../testkit/prompt.ts";
import { setClockSource } from "../clock.ts";
import { checkMemory, SESSION_FILE } from "../session/store.ts";
import { CAPS } from "../session/caps.ts";
import { loadSplit } from "../../qa/golden-load.ts";

/** Heap in use after a full collection, so the number does not depend on when the collector last ran (the whole suite shares one process). */
function settledHeap(): number {
  try {
    v8.setFlagsFromString("--expose-gc");
    (vm.runInNewContext("gc") as () => void)();
  } catch {
    /* without a collector the raw number is used */
  }
  return process.memoryUsage().heapUsed;
}
import { observeModel } from "./v2-kit.ts";

registerRole("memory", "You keep the memory of a live call");
registerRole("compact", "You tidy the memory of a live call");

const MIN = 60_000;
let e: Engine;
before(async () => {
  e = await setupEngine({ "llm.reflex.model": "anthropic:claude-haiku-5-5", "budget.idleStopMin": 0 });
  (await import("../engine/degrade.ts")).startHealthTick();
});
after(() => e?.stop());

const readJsonl = (f: string) =>
  readFileSync(e.boot.log.dir + "/" + f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

test(
  "3-hour soak with faults: no crash, direct questions answered in time (also inside the faults), calls and cost inside their caps, memory and session.json bounded",
  { timeout: 280_000 },
  async () => {
    const coach = await import("../engine/coach.ts");
    const obs = observeModel(e);
    await e.reset(0);
    const g = loadSplit("dev").filter((x) => x.type !== "interview");
    // the call: the lines of all dev meetings, one after the other, a line every 8 to 11 s
    const lines = g.flatMap((m) => m.lines.map((l) => ({ side: l.side, text: l.text })));
    // scripted model replies: the meetings' own moment replies, and 500 memory patches that each add three new facts (so the caps are tested)
    for (const m of g)
      for (const s of m.script ?? []) {
        const t = m.lines.find((l) => l.id === s.whenLastLine)?.text;
        if (s.role === "moment" && t) e.pm.reply({ role: ["moment", "observer"], lastLine: t }, s.reply, { ms: s.ms ?? 800 });
      }
    let outage = false;
    e.pm.on((v) => outage && v.role !== "unknown", error(503)); // first declared rule wins: during the outage every call fails
    for (let i = 0; i < 500; i++)
      e.pm.reply(
        { role: "memory" },
        JSON.stringify({
          add: {
            facts: [1, 2, 3].map((k) => ({ text: `Soak fact ${i}.${k} about the rollout of region ${i}` })),
            numbers: [{ what: `count ${i}`, value: String(i * 7 + 1) }],
          },
        }),
        { ms: 700, times: 1 },
      );
    e.pm.reply({ role: "memory" }, "{}" + " ".repeat(400), { ms: 600 });
    e.pm.reply(
      { role: "compact" },
      JSON.stringify({ summary: "The call is a long rollout planning session. Many regions were discussed." }) + " ".repeat(600),
      { ms: 900 },
    );
    e.pm.reply({ role: "ask" }, "Not in the call.", { ms: 800 });

    coach.tipsTick(); // starts the memory loop's 1 s timer
    const sessionFile = e.boot.log.dir + "/" + SESSION_FILE;
    const base = e.vc.now;
    let off = 0;
    const jump = (ms: number) => {
      off += ms;
      (globalThis.Date as unknown as { now: () => number }).now = () => base() + off;
      setClockSource({ wall: () => base() + off, mono: e.vc.perf });
    };

    const heap: number[] = [];
    const probes: { atMin: number; ms: number | undefined; fault: string }[] = [];
    let fault = "none";
    let li = 0;
    const start = e.vc.elapsed();
    const probeAt = [29, 65, 121, 142, 162, 179].map((m) => m * MIN); // quiet, memory disk full, corrupt session.json, model outage, clock +1 h, quiet
    let nextProbe = probeAt[0];
    let saveErrorsAtDiskFull = 0;
    const events = () => readJsonl("events.jsonl");
    const minute = () => Math.round((e.vc.elapsed() - start) / MIN);

    // the timeline of faults, in minutes since the start
    const at = (min: number) => e.vc.elapsed() - start >= min * MIN;
    const done = new Set<string>();
    const once = (key: string, min: number, fn: () => void) => {
      if (!done.has(key) && at(min)) {
        done.add(key);
        fn();
      }
    };

    while (e.vc.elapsed() - start < 180 * MIN) {
      const l = lines[li++ % lines.length];
      e.say(l.side, l.text);
      await e.vc.advance(8000 + ((li * 37) % 3000));

      once("disk-full", 60, () => {
        fault = "memory disk full";
        saveErrorsAtDiskFull = events().filter((x) => x.type === "memory.save.error").length;
        rmSync(sessionFile, { force: true });
        mkdirSync(sessionFile); // a directory where the file should be: every save fails
      });
      once("disk-back", 70, () => {
        rmSync(sessionFile, { recursive: true, force: true });
        fault = "none";
      });
      once("corrupt", 120, () => {
        fault = "corrupt session.json";
        writeFileSync(sessionFile, '{"v":1,"updatedAt":');
      });
      once("corrupt-over", 122, () => (fault = "none"));
      once("outage", 140, () => {
        outage = true;
        fault = "model outage";
      });
      once("outage-over", 145, () => {
        outage = false;
        fault = "none";
      });
      once("jump-fwd", 160, () => {
        fault = "clock +1 h";
        jump(3_600_000);
      });
      once("jump-back", 165, () => {
        jump(-3_600_000);
        fault = "none";
      });

      if (e.vc.elapsed() - start >= nextProbe) {
        const q = `Which kinds of storage engine number ${li} does the reporting tool connect to?`;
        e.pm.reply(
          { role: "moment", lastLine: `engine number ${li}` },
          `ANS\nVALUE: 3\nAIM: me\nSAY: Engine ${li} is supported through the standard driver\nWHY: probe`,
          { ms: 900 },
        );
        const i0 = e.rows.length;
        const t = e.say("them", q);
        await e.vc.advance(2600);
        // rows stamped while the clock was set forward carry a later time, so look only at the rows of this probe
        const row = e.rows.slice(i0).find((r) => r.type === "card" && !r.health && r.question === q);
        probes.push({ atMin: minute(), ms: row ? row.t - t : undefined, fault });
        nextProbe = probeAt[probes.length] ?? Infinity;
        heap.push(settledHeap());
      }
    }
    await e.vc.advance(2 * MIN);

    // ---- no crash
    const ev = events();
    assert.equal(e.st.call.crashed ?? false, false);
    assert.equal(ev.filter((x) => x.type === "error.survived").length, 0, JSON.stringify(ev.filter((x) => x.type === "error.survived").slice(0, 3)));
    assert.equal(e.st.call.shuttingDown ?? false, false, "the call is still running");

    // ---- a direct question every 30 minutes gets a card in time (during a fault: a card by 1.8 s all the same)
    console.log("SOAK probes:", JSON.stringify(probes));
    assert.equal(probes.length, 6);
    for (const p of probes) {
      assert.ok(p.ms !== undefined, `minute ${p.atMin} (${p.fault}): no card for the question`);
      assert.ok(p.ms! <= (p.fault === "none" ? 1500 : 2600), `minute ${p.atMin} (${p.fault}): first card after ${p.ms} ms`);
    }

    // ---- faults were seen and survived
    const saveErrors = ev.filter((x) => x.type === "memory.save.error").length;
    assert.ok(saveErrors > saveErrorsAtDiskFull, `the disk-full window logged save errors (${saveErrors})`);
    assert.ok(
      ev.some((x) => x.type === "health" && /^ai/.test(String(x.id))),
      "the model outage raised an AI bar",
    );
    assert.ok(
      ev.some((x) => x.type === "wake.recover" || x.type === "clock.jump"),
      "the clock jump was noticed",
    );
    assert.ok(existsSync(sessionFile) && statSync(sessionFile).isFile(), "session.json is a file again");
    const mem = JSON.parse(readFileSync(sessionFile, "utf8"));
    assert.ok(checkMemory(mem).ok, "session.json is valid at the end");
    assert.ok(statSync(sessionFile).size < 100_000, `session.json is ${statSync(sessionFile).size} bytes`);

    // ---- bounded state
    const live = coach.memoryLoop()!.memory;
    assert.ok(live.facts.length <= CAPS.facts, `facts ${live.facts.length} (cap ${CAPS.facts})`);
    assert.ok(live.numbers.length <= CAPS.numbers, `numbers ${live.numbers.length}`);
    assert.ok(live.openQuestions.length <= CAPS.openQuestions && live.commitments.length <= CAPS.commitments);
    assert.ok(live.summary.split(/\s+/).length <= 260, "the summary stays under 250 words");
    assert.ok(e.vc.pending() < 200, `${e.vc.pending()} timers pending`);
    assert.ok(heap.at(-1)! - heap[0] < 200 * 1024 * 1024, `heap grew ${((heap.at(-1)! - heap[0]) / 1048576).toFixed(0)} MB between minute 30 and 180`);

    // ---- calls and cost per hour
    const t0 = obs.calls[0]?.at ?? 0;
    const calls = (role: string, h: number) => obs.calls.filter((c) => c.role === role && c.at - t0 >= h * 60 * MIN && c.at - t0 < (h + 1) * 60 * MIN).length;
    for (const h of [0, 1, 2]) {
      console.log(
        `SOAK hour ${h + 1}: moment ${calls("moment", h)}, observer ${calls("observer", h)}, memory ${calls("memory", h)}, compact ${calls("compact", h)}`,
      );
      assert.ok(calls("memory", h) <= 240, `hour ${h + 1}: memory updater ${calls("memory", h)} calls (cap 240)`);
      assert.ok(calls("observer", h) <= 360, `hour ${h + 1}: observer ${calls("observer", h)} calls (6 a minute)`);
      assert.ok(calls("compact", h) <= 20, `hour ${h + 1}: compaction ${calls("compact", h)} calls (cap 20)`);
    }
    const usd = readJsonl("usage.jsonl").reduce((a, r) => a + Number(r.usd ?? 0), 0);
    console.log(
      `SOAK cost: $${usd.toFixed(3)} in 3 hours = $${(usd / 3).toFixed(3)} per hour; cache read share ${(obs.cacheReadRatio() * 100).toFixed(0)}%; ${e.rows.filter((r) => r.type === "card" && !r.health).length} card rows`,
    );
    assert.ok(usd / 3 <= 0.25, `$${(usd / 3).toFixed(3)} per hour is over the $0.25 release gate`);
  },
);
