// Release gate: a 3 hour call on the VIRTUAL clock with the full fault set, through the real engine modules:
//   reconnect storm   the other side's socket drops and comes back every 4 s for 8 minutes, and people keep talking (speaker epochs move, the ring fills)
//   provider switch   the socket dies for good and the channel moves to the fallback provider (and tries the primary again later)
//   slow model        every moment and observer answer takes 3.5 s for ten minutes
//   529               the model is overloaded for five minutes
//   dialog stall      a confirmation dialog in the menu-bar app that nobody answers (the app must keep reading the engine's status lines)
//   quit while wedged the engine is asked to stop and never answers; the app quits; the process group must get a synchronous SIGKILL (a fake child)
// Asserted: no crash, no error that escaped a handler, a direct question gets its card inside the budget in every phase (1.5 s calm, 1.8 s in a fault), the
// screen is never empty after the first card (a probe never ends with nothing to show), bars clear, state stays bounded, cost stays under the gate.
// SCRIPTED: model replies and delays are fixtures; nothing here touches the network, a key, audio hardware or a real screen.
import "../test-setup.ts";
import { settledHeap } from "../testkit/heap.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupEngine, type Engine } from "../testkit/engine-inproc.ts";
import { error, slow } from "../testkit/policy-model.ts";
import { registerRole } from "../testkit/prompt.ts";
import { loadSplit } from "../../qa/golden-load.ts";
import { SttChannel } from "../providers/stt/channel.ts";
import { ProviderError } from "../providers/errors.ts";
import { ROOT } from "../env.ts";
import { FakeStream, fakeProvider, said, type Row } from "./gates-kit.ts";

const req = createRequire(import.meta.url);
const { createController } = req("../../tray/controller.cjs");
const lib = req("../../tray/lib.cjs");
registerRole("memory", "You keep the memory of a live call");
registerRole("compact", "You tidy the memory of a live call");

const MIN = 60_000;
export const SOAK_MINUTES = 180;
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
    .map((l) => JSON.parse(l) as Row);
const bars = () => {
  const by = new Map<string, Row>();
  for (const r of e.rows) if (typeof r.id === "string" && r.id.startsWith("health-")) r.clear ? by.delete(r.id) : by.set(r.id, r);
  return [...by.values()];
};
const reply = (tag: string, say: string) => `${tag}\nVALUE: 3\nAIM: me\nSAY: ${say}\nWHY: probe`;

/** The menu-bar controller with a fake child process and the virtual clock. */
function trayRig() {
  const kills: unknown[][] = [];
  const spawned: any[] = [];
  const spawn = () => {
    const c: any = new EventEmitter();
    c.pid = 4242;
    c.written = [] as string[];
    c.stdin = Object.assign(new EventEmitter(), {
      writable: true,
      write: (s: string) => (c.written.push(s), true),
    });
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.kill = (sig: string) => kills.push(["child", sig]);
    c.say = (ev: string, data: object = {}) => c.stdout.emit("data", Buffer.from(`\n@@wingman ${JSON.stringify({ ev, ...data })}\n`));
    spawned.push(c);
    return c;
  };
  const ctl = createController({
    spawn,
    root: ROOT,
    tmpDir: mkdtempSync(join(tmpdir(), "wm-r3-soak-")),
    setTimeout: () => {},
    kill: (pid: number, sig: string) => kills.push([pid, sig]),
    now: () => Date.now(),
    env: {},
  });
  return { ctl, kills, child: () => spawned[0] };
}

test(
  "3 hour soak with the full fault set: reconnect storm, provider switch, slow model, 529, a stalled dialog and a quit while the engine is wedged",
  { timeout: 540_000 },
  async () => {
    const coach = await import("../engine/coach.ts");
    const { chans } = await import("../engine/state.ts");
    const stt = await import("../engine/stt.ts");
    await e.reset(0);
    const meetings = loadSplit("dev").filter((g) => g.type !== "interview");
    const lines = meetings.flatMap((m) => m.lines.map((l) => ({ side: l.side, text: l.text, who: m.id.length % 3 })));
    let overloaded = false;
    let slowModel = false;
    e.pm.on((v) => overloaded && v.role !== "unknown", error(529));
    e.pm.on((v) => slowModel && (v.role === "moment" || v.role === "observer"), slow(3500, reply("ANS", "Slow but right")));
    for (const m of meetings)
      for (const s of m.script ?? []) {
        const t = m.lines.find((l) => l.id === s.whenLastLine)?.text;
        if (s.role === "moment" && t) e.pm.reply({ role: ["moment", "observer"], lastLine: t }, s.reply, { ms: s.ms ?? 800 });
      }
    e.pm.reply({ role: "memory" }, "{}" + " ".repeat(400), { ms: 600 });
    e.pm.reply({ role: "compact" }, "{}" + " ".repeat(1300), { ms: 900 });
    coach.tipsTick();

    // the speech channels: real SttChannel over fake streams, wired into the engine like a real call
    const made = { dg: [] as FakeStream[], sx: [] as FakeStream[], me: [] as FakeStream[] };
    const mk = (channel: "me" | "them", chain: ReturnType<typeof fakeProvider>[]) =>
      new SttChannel({
        channel,
        chain,
        keyOf: () => "k",
        base: {},
        circuit: { failures: 99, windowMs: 10_000 }, // only the dead-socket path moves the channel
        deadAfterMs: 45_000,
        failbackAfterMs: 60_000,
        ringMs: 2000,
      });
    const them = mk("them", [fakeProvider("deepgram", made.dg), fakeProvider("soniox", made.sx)]);
    chans.them = them;
    chans.me = mk("me", [fakeProvider("deepgram", made.me)]);
    stt.wireChannels((await import("../engine/ingest.ts")).onResult, (await import("../engine/degrade.ts")).tickHealth);
    await them.open();
    await chans.me.open();
    const switched: string[] = [];
    them.on("switched", (d) => switched.push(d.to));

    const tray = trayRig();
    tray.ctl.start({});
    tray.child().say("consented", { id: "soak" });

    const start = e.vc.elapsed();
    const at = (min: number) => e.vc.elapsed() - start >= min * MIN;
    const done = new Set<string>();
    const once = async (key: string, min: number, fn: () => void | Promise<void>) => {
      if (!done.has(key) && at(min)) {
        done.add(key);
        await fn();
      }
    };
    const cur = () => (them.provider === "deepgram" ? made.dg : made.sx).at(-1)!;
    const probes: { atMin: number; fault: string; ms: number | undefined; screen: number }[] = [];
    let n = 0;
    const probe = async (fault: string) => {
      const i = ++n;
      const q = `Which kinds of storage engine number ${i} does the reporting tool connect to?`;
      e.pm.reply({ role: "moment", lastLine: `engine number ${i}` }, reply("ANS", `Engine ${i} is supported through the standard driver`), { ms: 900 });
      const i0 = e.rows.length;
      const t = e.say("them", q);
      await e.vc.advance(2200);
      const row = e.rows.slice(i0).find((r) => r.type === "card" && !r.health && !r.hidden && !r.withdraw);
      if (row) tray.child().say("card", {}); // the controller sees the same card line the engine printed
      probes.push({ atMin: Math.round((e.vc.elapsed() - start) / MIN), fault, ms: row ? row.t - t : undefined, screen: e.screen().length });
    };
    const probeTimes: [number, string][] = [
      [5, "none"],
      [43, "reconnect storm"],
      [58, "none"],
      [66, "provider switch"],
      [100, "slow model"],
      [128, "529"],
      [140, "dialog stalled"],
      [165, "none"],
    ];

    const marks: Record<string, unknown> = {};
    const heap: number[] = [];
    let stormUntil = 0;
    let li = 0;
    let pi = 0;
    let lastStorm = 0;
    while (e.vc.elapsed() - start < SOAK_MINUTES * MIN) {
      const l = lines[li++ % lines.length];
      if (l.side === "them") cur().emit("result", said(l.text, l.who));
      else e.say("me", l.text);
      await e.vc.advance(9000 + ((li * 37) % 3000));
      if (li % 4 === 0) void them.send(Buffer.alloc(3200)); // a little audio so the ring has something to hold while the socket is down

      // ---- reconnect storm: minutes 40 to 48
      await once("storm-on", 40, () => {
        stormUntil = e.vc.elapsed() + 8 * MIN;
        marks.rebasesBefore = e.boot.speakers.rebases;
      });
      if (stormUntil && e.vc.elapsed() < stormUntil && e.vc.elapsed() - lastStorm >= 4000) {
        lastStorm = e.vc.elapsed();
        cur().drop();
        await e.vc.advance(400);
        cur().back();
      }
      await once("storm-off", 49, () => void (marks.rebasesAfter = e.boot.speakers.rebases));
      // ---- dead socket and provider switch: minute 62
      await once("dead", 62, () => {
        const s = made.dg.at(-1)!;
        s.isOpen = false;
        s.emit("disconnected", { channel: "them", error: new ProviderError("network", "deepgram" as never, "socket closed") });
      });
      // ---- slow model: minutes 95 to 105
      await once("slow-on", 95, () => void (slowModel = true));
      await once("slow-off", 105, () => void (slowModel = false));
      // ---- 529: minutes 125 to 130
      await once("529-on", 125, () => void (overloaded = true));
      await once("529-off", 130, () => void (overloaded = false));
      // ---- a dialog that nobody answers, from minute 135 on: the menu-bar app keeps reading the engine
      await once("dialog", 135, () => {
        const never = new Promise(() => {});
        const dialog = {
          showMessageBox: () => never,
          showMessageBoxSync: () => {
            throw new Error("a sync dialog blocks the main process");
          },
        };
        void lib.confirmStopDelete({ dialog, stopDelete: () => {} });
        void lib.requestQuit({ isRunning: () => true, dialog, stop: () => {}, quit: () => {}, whenStopped: async () => true });
        marks.dialogStalledAt = e.vc.elapsed();
      });
      if (marks.dialogStalledAt !== undefined && li % 20 === 0) {
        tray.child().say("card", {});
        marks.stateWhileStalled = tray.ctl.getState().phase;
      }
      if (pi < probeTimes.length && at(probeTimes[pi][0])) {
        const [, f] = probeTimes[pi++];
        await probe(f);
        heap.push(settledHeap());
      }
    }
    await e.vc.advance(2 * MIN);

    // ---- quit while the engine is wedged (the stalled dialog is still open)
    assert.equal(tray.ctl.stop(), true);
    assert.equal(tray.child().written.at(-1), "stop\n");
    await e.vc.advance(5000); // the engine never answers
    tray.kills.length = 0;
    tray.ctl.shutdown();
    assert.deepEqual(tray.kills, [[-4242, "SIGKILL"]], "a wedged engine is killed synchronously at quit");

    await them.close();
    await chans.me.close();

    // ---- no crash, nothing escaped a handler
    const ev = readJsonl("events.jsonl");
    assert.equal(e.st.call.crashed ?? false, false);
    assert.equal(ev.filter((x) => x.type === "error.survived").length, 0, JSON.stringify(ev.filter((x) => x.type === "error.survived").slice(0, 3)));
    assert.equal(e.st.call.shuttingDown ?? false, false, "the call is still running");

    // ---- every probe got a card in time, and the screen was never empty
    console.log("R3 SOAK probes:", JSON.stringify(probes));
    assert.equal(probes.length, probeTimes.length, "all probes ran");
    for (const p of probes) {
      assert.ok(p.ms !== undefined, `minute ${p.atMin} (${p.fault}): no card for the question`);
      assert.ok(p.ms! <= (p.fault === "none" ? 1500 : 1800), `minute ${p.atMin} (${p.fault}): first card after ${p.ms} ms`);
      assert.ok(p.screen >= 1, `minute ${p.atMin} (${p.fault}): the screen was empty`);
    }

    // ---- each fault was seen and ended
    const rebases = (marks.rebasesAfter as number) - (marks.rebasesBefore as number);
    assert.ok(rebases >= 1 && rebases <= 120, `the storm moved the speaker epoch ${rebases} times (a voice was heard between reconnects)`);
    assert.ok(e.boot.speakers.count < 600, `${e.boot.speakers.count} people counted: epochs must not make an unbounded list`);
    assert.ok(switched.includes("soniox"), "the dead socket moved the channel to the fallback");
    assert.ok(
      ev.some((x) => x.type === "health" && /^ai/.test(String(x.id))),
      "529 raised an AI bar",
    );
    assert.equal(marks.stateWhileStalled, "live", "the menu-bar app kept reading engine lines while a dialog was open");
    assert.ok(them.ringDroppedChunks >= 0 && them.ringedMs <= 2000, "the ring stays within its size");
    const lastStormBars = bars().filter((b) => /stt-/.test(String(b.id)) && !/switch/.test(String(b.id)));
    assert.deepEqual(lastStormBars, [], "no speech bar is left red after the storm: " + JSON.stringify(lastStormBars));

    // ---- bounded state, cost
    assert.ok(e.vc.pending() < 300, `${e.vc.pending()} timers pending`);
    assert.ok(heap.at(-1)! - heap[0] < 300 * 1024 * 1024, `heap grew ${((heap.at(-1)! - heap[0]) / 1048576).toFixed(0)} MB`);
    const usd = readJsonl("usage.jsonl").reduce((a, r) => a + Number(r.usd ?? 0), 0);
    const perHour = usd / (SOAK_MINUTES / 60);
    console.log(
      `R3 SOAK cost: $${usd.toFixed(3)} in ${SOAK_MINUTES} min = $${perHour.toFixed(3)} per hour (scripted, with faults), rebases in storm ${rebases}`,
    );
    assert.ok(perHour <= 0.25, `$${perHour.toFixed(3)} per hour is over the $0.25 release gate`);
  },
);
