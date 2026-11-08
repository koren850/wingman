// Fault-injection soak of the default (v2) engine. One 80 minute call on the VIRTUAL clock, through the real engine modules, with six faults injected one after
// the other while the call goes on and a direct question is asked inside every fault:
//   hung respawn     a microphone source that errors once and then hangs four times (the supervisor must rebuild it until frames flow)
//   display unplug   the chosen display is removed and plugged back (an injected screen: the answer window must hide, never move to the primary screen)
//   dead socket      the primary speech-to-text socket drops and never comes back (the channel must switch to the fallback by itself)
//   slow model       every moment and observer answer takes 3.5 s
//   529              the model is overloaded for five minutes
//   stray at Stop    a stray error while the call is closing (a real child process, so this one runs in real time at the end)
// What is asserted: no crash, no error that escaped a handler, every probe question ends in a card inside its budget (1.5 s when all is well, 1.8 s inside a
// fault), each fault is seen by the part that should see it (a bar, a hidden window, a provider switch), each fault ends and the bars clear, timers stay
// bounded, and the whole run stays under the cost gate. Nothing here touches the network, a key, audio hardware or a real screen.
import "../test-setup.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupEngine, type Engine } from "../testkit/engine-inproc.ts";
import { error, slow } from "../testkit/policy-model.ts";
import { registerRole } from "../testkit/prompt.ts";
import { loadSplit } from "../../qa/golden-load.ts";
import { SupervisedSource, writeWav, type Source } from "../audio.ts";
import { SttChannel } from "../providers/stt/channel.ts";
import { ProviderError } from "../providers/errors.ts";
import type { SttProvider, SttStreamLike } from "../providers/stt/types.ts";
import { sleep, until, scriptFile, readRows, callDir, runEngine, Q } from "./helpers.ts";

const W = createRequire(import.meta.url)("../../overlay/window.cjs");
registerRole("memory", "You keep the memory of a live call");
registerRole("compact", "You tidy the memory of a live call");

const MIN = 60_000;
export const SOAK_MINUTES = 80;
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
/** The health bars on screen now: raised and not cleared. */
const bars = () => {
  const by = new Map<string, Record<string, unknown>>();
  for (const r of e.rows) if (typeof r.id === "string" && r.id.startsWith("health-")) r.clear ? by.delete(r.id) : by.set(r.id, r);
  return [...by.values()];
};

// ---------------------------------------------------------------- the injected parts
class Hang extends EventEmitter implements Source {
  async start() {}
  async stop() {}
}
class Talk extends EventEmitter implements Source {
  t?: NodeJS.Timeout;
  async start() {
    this.t = setInterval(() => this.emit("pcm", Buffer.alloc(3200)), 100);
  }
  async stop() {
    clearInterval(this.t);
  }
}
/** A microphone that errors once, hangs for `hangs` rebuilds, and then talks. */
function micFault(hangs: number) {
  let built = 0;
  const sup = new SupervisedSource({
    name: "mic",
    stallMs: 8000,
    backoff: (n) => Math.min(10_000, 1000 * 2 ** n),
    make: () => {
      built++;
      if (built === 1) {
        const s = new Hang();
        s.start = async () => void setTimeout(() => s.emit("error", new Error("device lost")), 10);
        return s;
      }
      return built <= hangs + 1 ? new Hang() : new Talk();
    },
  });
  const log = { downs: 0, ups: 0 };
  sup.on("down", () => log.downs++);
  sup.on("up", () => log.ups++);
  return { sup, log, built: () => built };
}

type Disp = { id: number; workArea: { x: number; y: number; width: number; height: number } };
const PRIMARY: Disp = { id: 1, workArea: { x: 0, y: 25, width: 1440, height: 875 } };
const SECOND: Disp = { id: 2, workArea: { x: 1440, y: 0, width: 1920, height: 1080 } };
/** The answer window with an injected screen and window object (overlay/window.cjs is pure logic; main.cjs wires the real ones). */
function screenRig() {
  const handlers: Record<string, (...a: unknown[]) => void> = {};
  const state = { displays: [PRIMARY, SECOND] };
  const screen = {
    getAllDisplays: () => state.displays,
    getPrimaryDisplay: () => PRIMARY,
    on: (n: string, f: (...a: unknown[]) => void) => (handlers[n] = f),
  };
  const calls: string[] = [];
  let bounds = { x: 0, y: 0, width: 760, height: 300 };
  let visible = true;
  const win = {
    isDestroyed: () => false,
    hide: () => (calls.push("hide"), (visible = false)),
    showInactive: () => (calls.push("showInactive"), (visible = true)),
    setBounds: (b: typeof bounds) => (calls.push("setBounds"), (bounds = b)),
    getBounds: () => bounds,
    isVisible: () => visible,
  };
  const notes: string[] = [];
  const follow = W.createDisplayFollow({ screen, win, cfg: { display: "secondary", allowPrimary: false }, note: (k: string) => notes.push(k) });
  follow.start();
  follow.attach();
  follow.fit(300);
  return {
    unplug() {
      state.displays = [PRIMARY];
      handlers["display-removed"]!({}, SECOND);
    },
    replug() {
      state.displays = [PRIMARY, SECOND];
      handlers["display-added"]!({}, SECOND);
    },
    fit: (h: number) => follow.fit(h),
    calls,
    notes,
    get visible() {
      return visible;
    },
    get bounds() {
      return bounds;
    },
  };
}

class FakeStream extends EventEmitter implements SttStreamLike {
  dropped = 0;
  isOpen = false;
  sent = 0;
  async open() {
    this.isOpen = true;
  }
  send(b: Buffer) {
    this.sent += b.length;
    return this.isOpen;
  }
  async close() {
    this.isOpen = false;
  }
  get audioSeconds() {
    return this.sent / 32000;
  }
}
const sttProvider = (id: string, made: FakeStream[]): SttProvider => ({
  id: id as never,
  experimental: false,
  capabilities: { keyterms: true, diarize: false, interim: true, maxKeyterms: 100 },
  create: () => {
    const s = new FakeStream();
    made.push(s);
    return s;
  },
  probe: async () => ({ ok: true }),
});

const reply = (tag: string, say: string) => `${tag}\nVALUE: 3\nAIM: me\nSAY: ${say}\nWHY: probe`;

// ---------------------------------------------------------------- the soak
test(
  "fault soak on default v2 (80 virtual minutes): hung respawn, display unplug, dead socket, slow model and 529; every probe gets a card, every fault is seen and ends",
  { timeout: 280_000 },
  async () => {
    const coach = await import("../engine/coach.ts");
    await e.reset(0);
    const meetings = loadSplit("dev").filter((g) => g.type !== "interview");
    const lines = meetings.flatMap((m) => m.lines.map((l) => ({ side: l.side, text: l.text })));
    // Fault switches. A rule that is declared first wins, so the faults sit in front of the scripted replies.
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

    // the parts that are not the engine
    const mic = micFault(4);
    const screen = screenRig();
    const primary: FakeStream[] = [],
      fallback: FakeStream[] = [];
    const stt = new SttChannel({
      channel: "them",
      chain: [sttProvider("deepgram", primary), sttProvider("soniox", fallback)],
      keyOf: () => "k",
      base: {},
      circuit: { failures: 99, windowMs: 10_000 }, // the circuit never trips: only the dead-socket timer can move the channel
      deadAfterMs: 45_000,
    });
    const switched: { at: number; to: string }[] = [];
    stt.on("switched", (d) => switched.push({ at: e.vc.elapsed(), to: d.to }));
    await stt.open();

    const start = e.vc.elapsed();
    const at = (min: number) => e.vc.elapsed() - start >= min * MIN;
    const done = new Set<string>();
    const once = (key: string, min: number, fn: () => void | Promise<void>) => {
      if (!done.has(key) && at(min)) {
        done.add(key);
        return fn();
      }
    };
    const probes: { atMin: number; fault: string; ms: number | undefined }[] = [];
    let n = 0;
    const probe = async (fault: string) => {
      const i = ++n;
      const q = `Which kinds of storage engine number ${i} does the reporting tool connect to?`;
      e.pm.reply({ role: "moment", lastLine: `engine number ${i}` }, reply("ANS", `Engine ${i} is supported through the standard driver`), { ms: 900 });
      const i0 = e.rows.length;
      const t = e.say("them", q);
      await e.vc.advance(2200);
      const row =
        e.rows.slice(i0).find((r) => r.type === "card" && !r.health && !r.hidden && !r.withdraw && r.question === q) ??
        e.rows.slice(i0).find((r) => r.type === "card" && !r.health && !r.hidden && !r.withdraw);
      probes.push({ atMin: Math.round((e.vc.elapsed() - start) / MIN), fault, ms: row ? row.t - t : undefined });
    };

    const marks: Record<string, unknown> = {};
    const heap: number[] = [];
    let li = 0;
    const probeTimes: [number, () => string][] = [
      [3, () => "none"],
      [8, () => "hung respawn"],
      [16, () => "display unplugged"],
      [28, () => "dead socket"],
      [40, () => "slow model"],
      [58, () => "529"],
      [75, () => "none"],
    ];
    let pi = 0;
    while (e.vc.elapsed() - start < SOAK_MINUTES * MIN) {
      const l = lines[li++ % lines.length];
      e.say(l.side, l.text);
      await e.vc.advance(8000 + ((li * 37) % 3000));

      // ---- hung respawn: minutes 5 to 12
      await once("mic-start", 5, async () => {
        await mic.sup.start();
      });
      // ---- display unplug: minutes 14 to 20
      await once("unplug", 14, () => {
        screen.unplug();
        marks.hiddenAfterUnplug = !screen.visible;
        const moves = screen.calls.filter((c) => c === "setBounds").length;
        screen.fit(500); // the page keeps reporting heights: nothing may move while the window is hidden
        marks.noMoveWhileHidden = screen.calls.filter((c) => c === "setBounds").length === moves;
        marks.noteRaised = screen.notes.includes("removed");
      });
      await once("replug", 20, () => {
        screen.replug();
        marks.backAfterReplug = screen.visible && W.inside(screen.bounds, SECOND.workArea);
        marks.noteCleared = screen.notes.at(-1) === "";
        marks.shownWithoutFocus = screen.calls.at(-1) === "showInactive" && !screen.calls.includes("show");
      });
      // ---- dead socket: minutes 25 to 30 (the switch comes 45 s after the drop)
      await once("socket-dies", 25, () => {
        marks.socketDiedAt = e.vc.elapsed();
        primary[0].isOpen = false;
        primary[0].emit("disconnected", { channel: "them", error: new ProviderError("network", "deepgram" as never, "socket closed") });
      });
      // ---- slow model: minutes 36 to 46
      await once("slow-on", 36, () => {
        slowModel = true;
      });
      await once("slow-off", 46, () => {
        slowModel = false;
      });
      // ---- 529: minutes 55 to 61
      await once("529-on", 55, () => {
        overloaded = true;
      });
      await once("529-off", 61, () => {
        overloaded = false;
      });
      await once("barsClear", 78, () => void (marks.barsAt78 = bars().map((b) => b.id)));

      if (pi < probeTimes.length && at(probeTimes[pi][0])) {
        const [, f] = probeTimes[pi++];
        await probe(f());
        heap.push(process.memoryUsage().heapUsed);
      }
    }
    await e.vc.advance(2 * MIN);
    await mic.sup.stop();
    await stt.close();

    // ---- no crash, nothing escaped a handler
    const ev = readJsonl("events.jsonl");
    assert.equal(e.st.call.crashed ?? false, false);
    assert.equal(ev.filter((x) => x.type === "error.survived").length, 0, JSON.stringify(ev.filter((x) => x.type === "error.survived").slice(0, 3)));
    assert.equal(e.st.call.shuttingDown ?? false, false, "the call is still running");

    // ---- every probe got a card in time
    console.log("R2 SOAK probes:", JSON.stringify(probes));
    assert.equal(probes.length, probeTimes.length, "all probes ran");
    for (const p of probes) {
      assert.ok(p.ms !== undefined, `minute ${p.atMin} (${p.fault}): no card for the question`);
      assert.ok(p.ms! <= (p.fault === "none" ? 1500 : 1800), `minute ${p.atMin} (${p.fault}): first card after ${p.ms} ms`);
    }

    // ---- each fault was seen by the part that should see it, and ended
    assert.ok(mic.log.downs >= 1 && mic.log.ups === 1, `hung respawn: ${JSON.stringify(mic.log)}`);
    assert.ok(mic.built() >= 6, `the source was rebuilt until frames flowed (${mic.built()} builds)`);
    assert.equal(mic.log.downs >= 1 && !mic.sup.down, true, "the microphone is up at the end");
    assert.equal(marks.hiddenAfterUnplug, true, "the window hides when its display goes");
    assert.equal(marks.noMoveWhileHidden, true, "the hidden window never moves to the primary screen");
    assert.equal(marks.noteRaised, true);
    assert.equal(marks.backAfterReplug, true, "the window returns to its display");
    assert.equal(marks.noteCleared, true);
    assert.equal(marks.shownWithoutFocus, true, "shown without taking focus");
    assert.equal(switched.length, 1, "the dead socket moved the channel once");
    assert.equal(switched[0].to, "soniox");
    const lag = switched[0].at - (marks.socketDiedAt as number);
    assert.ok(lag >= 44_000 && lag <= 46_000, `the dead-socket timer fired after ${lag} ms (45 s)`);
    assert.ok(
      ev.some((x) => x.type === "health" && /^ai/.test(String(x.id))),
      "529 raised an AI bar",
    );
    assert.ok(e.boot.sup.rung >= 0);
    assert.deepEqual(
      marks.barsAt78,
      [],
      "all bars were cleared seventeen minutes after the last fault (the ladder steps back up after about nine): " +
        JSON.stringify(marks.barsAt78) +
        JSON.stringify(ev.filter((x) => x.type === "ladder").map((x) => [Math.round((Number(x.t) || 0) / 1000), x.from, x.to, x.reasons])),
    );

    // ---- bounded state, cost
    assert.ok(e.vc.pending() < 200, `${e.vc.pending()} timers pending`);
    assert.ok(heap.at(-1)! - heap[0] < 200 * 1024 * 1024, `heap grew ${((heap.at(-1)! - heap[0]) / 1048576).toFixed(0)} MB`);
    const usd = readJsonl("usage.jsonl").reduce((a, r) => a + Number(r.usd ?? 0), 0);
    const perHour = usd / (SOAK_MINUTES / 60);
    console.log(`R2 SOAK cost: $${usd.toFixed(3)} in ${SOAK_MINUTES} min = $${perHour.toFixed(3)} per hour (scripted, with faults)`);
    assert.ok(perHour <= 0.25, `$${perHour.toFixed(3)} per hour is over the $0.25 release gate`);
  },
);

// ---------------------------------------------------------------- stray at Stop, the real process on the v2 engine (real time)
test(
  "fault soak: a stray error while the v2 call is stopping (fast close) ends cleanly: exit 0, phase ended, the stray logged, no crash row",
  { timeout: 90_000 },
  async () => {
    e.vc.uninstall(); // the soak above is over; this case waits for a real process in real time
    const tmp = mkdtempSync(join(tmpdir(), "wm-r2-soak-"));
    const calls = join(tmp, "calls");
    mkdirSync(calls);
    const wav = join(tmp, "s.wav");
    await writeWav(wav, Buffer.alloc(16000 * 2 * 2 * 30), 2);
    const script = scriptFile(tmp, [Q("them", "Which kinds of databases can the reporting tool connect to?", 1500)]);
    // runEngine pins the classic engine for the older tests; the later --set wins
    const run = runEngine(["--file", wav, "--set", "moments.engine=v2", "--set", "reflex.stall=true"], {
      WINGMAN_CALLS_DIR: calls,
      WINGMAN_STT_SCRIPT: script,
      WINGMAN_TEST_STRAY_AT_STOP: "1",
      WINGMAN_TEST_SLOW_STOPS: "1x300",
    });
    try {
      await until(() => !!callDir(calls) && readRows(callDir(calls), "events.jsonl").length > 0, 30_000);
      await sleep(3500);
      run.p.kill("SIGINT");
      assert.equal(await run.done, 0, run.out());
      assert.match(run.out(), /Help engine: New/, "the child ran the v2 engine");
      const dir = callDir(calls);
      const meta = JSON.parse(readFileSync(join(dir, "call.json"), "utf8"));
      assert.equal(meta.phase, "ended");
      assert.equal(meta.crashed, false);
      const rows = readRows(dir, "events.jsonl");
      assert.ok(rows.some((r) => r.type === "error.survived" && /stray at stop/.test(r.error ?? "")));
      assert.ok(!rows.some((r) => r.type === "crash"));
    } finally {
      run.p.kill("SIGKILL");
      rmSync(tmp, { recursive: true, force: true });
    }
  },
);
