// Child process of the v2 gate tests: one golden meeting through the real engine modules (in-process engine, virtual clock, policy fake with the
// meeting's own scripted replies, memory loop on its 1 s timer). Result goes to the file in V2_OUT as JSON. See v2-kit.ts (runMeeting).
// The engine is a per-process singleton, so one process plays one meeting. No network, no keys.
import "../test-setup.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setupEngine } from "../testkit/engine-inproc.ts";
import { loadSplit } from "../../qa/golden-load.ts";
import { observeModel, timelineOf, type MeetingRun, type WorkerOptions } from "./v2-kit.ts";
import { registerRole } from "../testkit/prompt.ts";
import { Cassette, CassetteMiss, CassetteStale, wrapCassette } from "../providers/cassette.ts";
import { ModelRegistry } from "../providers/llm.ts";
import { controlReplies } from "../../qa/controls.ts";

const realSetTimeout = globalThis.setTimeout; // the virtual clock replaces setTimeout; the paced record mode sleeps in real time

const id = process.env.V2_MEETING!;
const out = process.env.V2_OUT!;
const opts: WorkerOptions = JSON.parse(process.env.V2_OPTS || "{}");

/** Same text as the meeting, as a speech-to-text engine with no punctuation would give it. */
const roughen = (s: string) =>
  s
    .replace(/[?.,!;:"]/g, "")
    .replace(/\s+/g, " ")
    .trim();

async function main() {
  registerRole("memory", "You keep the memory of a live call");
  registerRole("compact", "You tidy the memory of a live call");
  const split = opts.split ?? "dev";
  const g = loadSplit(split, { final: split !== "dev", ship: split === "test-c" }).find((x) => x.id === id);
  if (!g) throw new Error(`no ${split} meeting ${id}`);
  const e = await setupEngine({ "llm.reflex.model": "anthropic:claude-haiku-5-5", ...(opts.sets ?? {}) });
  if (opts.tailChunk) {
    // Simulator study (context-modes): cache the raw tail in chunks for these roles. CACHE_POLICY is read for every call, so a change here is in force.
    const { CACHE_POLICY } = await import("../context/cache.ts");
    for (const [role, n] of Object.entries(opts.tailChunk)) (CACHE_POLICY as Record<string, { tailChunk: number }>)[role].tailChunk = n ?? 0;
  }
  const obs = observeModel(e, { legacyLayout: opts.legacyLayout });
  if (opts.record) {
    // Record mode: every model call goes through the cassette recorder. The inner model is the observed policy fake ("mock" transport, used by the
    // tests) or the real provider ("real", the maintainer's command only: needs ANTHROPIC_API_KEY in the environment and WINGMAN_LLM_MODE unset).
    const cassette = new Cassette(opts.record.cassette);
    const observed = e.boot.registry.resolve as unknown as (ref: string, role?: string) => Promise<unknown>;
    const real = opts.record.transport === "real" ? new ModelRegistry({ anthropic: process.env.ANTHROPIC_API_KEY } as never) : undefined;
    e.boot.registry.resolve = (async (ref: string, role?: string) =>
      wrapCassette({ mode: "record", cassette, ref, role, inner: (real ? await real.resolve(ref, role) : await observed(ref, role)) as never })) as never;
  }
  let cassetteMisses = 0;
  let cassetteStale = 0; // a miss whose entry exists but was recorded with another prompt text or model (counted in cassetteMisses too)
  const replayCalls: Record<string, number> = {};
  if (opts.replay) {
    // Replay mode: every model reply is read from the cassette. The recorded delays run on the virtual clock. A miss is a model error for the engine.
    // "a.json,b.json": several cassettes are merged (the held-out run plays test and test-b together)
    const cassette = new Cassette();
    for (const f of opts.replay.cassette.split(",")) for (const en of new Cassette(f).entries()) cassette.put(en);
    e.boot.registry.resolve = (async (ref: string, role?: string) => {
      const m = wrapCassette({ mode: "replay", cassette, ref, role, timing: "recorded" }) as unknown as Record<string, (c: unknown) => Promise<unknown>>;
      for (const k of ["doGenerate", "doStream"]) {
        const f = m[k];
        m[k] = async (c: unknown) => {
          replayCalls[role ?? "unknown"] = (replayCalls[role ?? "unknown"] ?? 0) + 1;
          try {
            return await f.call(m, c);
          } catch (err) {
            if (err instanceof CassetteMiss) cassetteMisses++;
            if (err instanceof CassetteStale) cassetteStale++;
            throw err;
          }
        };
      }
      return m;
    }) as never;
  }
  const coach = await import("../engine/coach.ts");
  const ask = await import("../engine/askcall.ts");
  await e.reset(0);
  e.pm.setUsage({ input: 3000, output: 60 });

  const lines = g.lines.map((l) => ({ ...l, text: opts.noisy ? roughen(l.text) : l.text }));
  const rawOf = new Map(g.lines.map((l, i) => [l.id, lines[i].text]));
  const idx = new Map(g.lines.map((l, i) => [l.id, i]));
  // moment + observer replies are keyed by the line the call is about (the last line of its transcript block)
  // A control (null, noise, shuffled, always-ANS) replaces the scripted moment replies with a deliberately bad model; everything else stays the same.
  const momentReplies = controlReplies(g, opts.control, rawOf);
  for (const r of momentReplies) {
    if (r.lastLine) e.pm.reply({ role: ["moment", "observer"], lastLine: r.lastLine }, r.reply, { ms: r.ms });
    else e.pm.reply({ role: ["moment", "observer"] }, r.reply, { ms: r.ms });
  }
  // memory patches: patch k is served by the first memory call whose newest line is at or after the line it was written for
  let lastSeen = -1;
  const lineIndex = (text: string) => lines.findIndex((l) => text.includes(l.text.slice(0, 40)));
  const memEntries = (g.script ?? []).filter((s) => s.role === "memory");
  for (const s of memEntries) {
    const at = idx.get(s.whenLastLine) ?? 0;
    e.pm.reply(
      (v) => {
        if (v.role !== "memory") return false;
        const i = lineIndex(v.lastLine.text);
        if (i >= 0) lastSeen = Math.max(lastSeen, i);
        return i >= at || lastSeen >= at;
      },
      s.reply,
      { ms: s.ms ?? 700, times: 1 },
    );
  }
  // "Nothing to change", padded with spaces to the size of a typical answer (a patch of about 100 tokens, a compaction of about 330), so the cost rows
  // do not understate the output. JSON ignores the spaces; the memory stays as the scripted patches leave it.
  e.pm.reply({ role: "memory" }, "{}" + " ".repeat(400), { ms: 600 });
  e.pm.reply({ role: "compact" }, "{}" + " ".repeat(1300), { ms: 900 });
  for (const s of g.script ?? []) if (s.role === "ask") e.pm.reply({ role: "ask" }, s.reply, { ms: s.ms ?? 1200 });
  e.pm.reply({ role: "ask" }, "Not in the call.", { ms: 800 });

  // Paced record mode: the virtual clock moves at `pace` times real time so a real network answer can arrive before its virtual timeout.
  const pace = opts.record?.pace ?? 0;
  const advance = async (ms: number) => {
    if (!pace) return e.vc.advance(ms);
    for (let left = ms; left > 0; left -= 200) {
      await new Promise((r) => realSetTimeout(r, Math.min(200, left) / pace));
      await e.vc.advance(Math.min(200, left));
    }
  };
  const spent = () => {
    try {
      return readFileSync(e.boot.log.dir + "/usage.jsonl", "utf8")
        .split("\n")
        .filter(Boolean)
        .reduce((a, l) => a + (JSON.parse(l).usd ?? 0), 0);
    } catch {
      return 0;
    }
  };
  let capped = false;
  const capHit = () => {
    if (opts.record?.capUsd !== undefined && spent() > opts.record.capUsd) capped = true;
    return capped;
  };
  coach.tipsTick(); // starts the v2 timer (memory loop, open loops) like run.ts does every 5 s
  const t0 = Date.now();
  const snapshots: MeetingRun["snapshots"] = [];
  const lag = opts.lagMs ?? 35_000;
  for (const c of g.memoryChecks ?? []) {
    const at = g.lines.find((l) => l.id === c.atLine)?.t ?? 0;
    e.vc.setTimeout(() => snapshots.push({ atLine: c.atLine, memory: structuredClone(coach.memoryLoop()?.memory ?? {}) }), at + lag);
  }
  const askCards: MeetingRun["askCards"] = [];
  const asks = opts.asks === false ? [] : (g.script ?? []).filter((s) => s.role === "ask" && (s as { q?: string }).q);
  let prev = 0;
  for (const l of lines.map((x, i) => ({ ...x, t: g.lines[i].t }))) {
    await advance(Math.max(0, l.t - prev));
    prev = l.t;
    if (capHit()) break;
    e.say(l.side, l.text);
    for (const a of asks.filter((x) => x.whenLastLine === l.id)) {
      const before = e.rows.length;
      const at = Date.now();
      await e.vc.advance(300);
      void ask.askTheCall((a as { q: string }).q);
      await e.vc.advance(4000);
      prev += 4300;
      const card = e.rows
        .slice(before)
        .filter((r) => r.type === "card" && r.badge === "me" && r.say)
        .at(-1);
      askCards.push({ q: (a as { q: string }).q, say: String(card?.say ?? ""), ms: card ? card.t - at : undefined });
    }
  }
  await advance(40_000); // the last memory checks, a compaction and the open-loop prompts
  const lengthMs = g.lines.at(-1)?.t ?? 0;
  const flushed = coach.flushMemory(1000);
  await e.vc.advance(1500); // its timeout is on the virtual clock
  await flushed;
  const events = readFileSync(e.boot.log.dir + "/events.jsonl", "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  // no usage file at all: a replay against a cassette that knew none of the calls
  const usage = (existsSync(e.boot.log.dir + "/usage.jsonl") ? readFileSync(e.boot.log.dir + "/usage.jsonl", "utf8") : "")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const roleCalls: Record<string, number> = {};
  for (const c of obs.calls) roleCalls[c.role] = (roleCalls[c.role] ?? 0) + 1;
  if (opts.replay) Object.assign(roleCalls, replayCalls);
  const mem = coach.memoryLoop()?.memory;
  const res: MeetingRun = {
    id,
    cards: timelineOf(e, t0),
    screen: e.screen().map((c) => ({ id: c.id, turnId: c.turnId, badge: c.badge, kind: c.kind, source: c.source, say: c.say, more: c.more, at: c.t - t0 })),
    calls: obs.calls,
    usage,
    snapshots,
    events: events.filter((x) => /memory|moment\.|error|ai\.|compact/.test(String(x.type))).slice(-400),
    askCards,
    lengthMs,
    memoryVer: mem?.ver ?? 0,
    memory: mem,
    tail: g.lines.slice(-40).map((l) => ({ ch: l.side, text: l.text })),
    sessionFile: (await import("node:fs")).existsSync(e.boot.log.dir + "/session.json"),
    cacheRead: obs.cacheReadRatio(),
    roleCalls,
    ...(opts.replay ? { cassetteMisses, cassetteStale } : {}),
    ...(capped ? { error: "cost cap reached: the meeting was cut short" } : {}),
  };
  writeFileSync(out, JSON.stringify(res));
  e.stop();
  process.exit(0);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
