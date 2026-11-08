// Child process of the v2 gate tests: one golden meeting through the real engine modules (in-process engine, virtual clock, policy fake with the
// meeting's own scripted replies, memory loop on its 1 s timer). Result goes to the file in V2_OUT as JSON. See v2-kit.ts (runMeeting).
// The engine is a per-process singleton, so one process plays one meeting. No network, no keys.
import "../test-setup.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { setupEngine } from "../testkit/engine-inproc.ts";
import { loadSplit } from "../../qa/golden-load.ts";
import { observeModel, timelineOf, type MeetingRun, type WorkerOptions } from "./v2-kit.ts";
import { registerRole } from "../testkit/prompt.ts";

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
  const g = loadSplit("dev").find((x) => x.id === id);
  if (!g) throw new Error(`no dev meeting ${id}`);
  const e = await setupEngine({ "llm.reflex.model": "anthropic:claude-haiku-5-5", ...(opts.sets ?? {}) });
  const obs = observeModel(e, { roleFirst: opts.roleFirst });
  const coach = await import("../engine/coach.ts");
  const ask = await import("../engine/askcall.ts");
  await e.reset(0);
  e.pm.setUsage({ input: 3000, output: 60 });

  const lines = g.lines.map((l) => ({ ...l, text: opts.noisy ? roughen(l.text) : l.text }));
  const rawOf = new Map(g.lines.map((l, i) => [l.id, lines[i].text]));
  const idx = new Map(g.lines.map((l, i) => [l.id, i]));
  // moment + observer replies are keyed by the line the call is about (the last line of its transcript block)
  for (const s of g.script ?? []) {
    const t = rawOf.get(s.whenLastLine);
    if (s.role === "moment" && t) e.pm.reply({ role: ["moment", "observer"], lastLine: t }, s.reply, { ms: s.ms ?? 800 });
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
    await e.vc.advance(Math.max(0, l.t - prev));
    prev = l.t;
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
  await e.vc.advance(40_000); // the last memory checks, a compaction and the open-loop prompts
  const lengthMs = g.lines.at(-1)?.t ?? 0;
  const flushed = coach.flushMemory(1000);
  await e.vc.advance(1500); // its timeout is on the virtual clock
  await flushed;
  const events = readFileSync(e.boot.log.dir + "/events.jsonl", "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const usage = readFileSync(e.boot.log.dir + "/usage.jsonl", "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const roleCalls: Record<string, number> = {};
  for (const c of obs.calls) roleCalls[c.role] = (roleCalls[c.role] ?? 0) + 1;
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
  };
  writeFileSync(out, JSON.stringify(res));
  e.stop();
  process.exit(0);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
