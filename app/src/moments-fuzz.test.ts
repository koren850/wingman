// Scheduler fuzz and property tests (ship-gate). 500 fixed seeds, no clock, no network, under 20 s.
//   Part A: the pure scheduler (src/moments/scheduler.ts) on random streams of moments. Invariants: a Check is never held back by the per-minute cap; a
//           late observer moment is dropped; the same card ref is not shown twice in a row without new memory; the per-minute cap holds; the record
//           of shown cards stays bounded; a stale turn is dropped.
//   Part B: the real engine (engine/ingest, question, moments) in this process on the virtual clock with a faulty policy fake: random lines, random delays,
//           errors, garbage, hangs, duplicate replies. Invariants: never two cards for one line, no card older than its cap, queue bounds, a late observer
//           card is dropped, and in a silent stretch with a null model no card shows.
import "./test-setup.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { decide, recordShown, newSchedulerState, DEFAULT_SCHEDULER, isExempt, type ScheduledMoment, type SchedulerState } from "./moments/scheduler.ts";
import type { MomentTag } from "./moments/types.ts";
import { setupEngine, type Engine } from "./testkit/engine-inproc.ts";
import { setTimeout as realTimeout, clearTimeout as realClear } from "node:timers";
import { hang, error, garbage, truncate } from "./testkit/policy-model.ts";

/** The fixed seed list: 500 numbers that never change, so a failure always names a seed you can replay. */
export const SEEDS: readonly number[] = Array.from({ length: 500 }, (_, i) => (Math.imul(i + 1, 0x9e3779b1) ^ 0x5bd1e995) >>> 0);
export const rng = (seed: number) => {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
};
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

// ---------------------------------------------------------------- part A: the pure scheduler
const TAGS: readonly MomentTag[] = ["SKIP", "STALL", "REPLY", "ANS", "BANK", "CHECK", "PROMPT", "TERM", "NOTE"];
const randomMoment = (r: () => number, now: number, turn: number): ScheduledMoment => {
  const tag = pick(r, TAGS);
  const observer = r() < 0.6;
  return {
    tag,
    value: pick(r, [0, 1, 2, 3] as const),
    aim: pick(r, ["me", "all", "unclear", "other"] as const),
    say: "x",
    why: "",
    more: [],
    ...(tag === "BANK" ? { bankId: pick(r, ["a", "b", "stall-price"]) } : {}),
    ...(tag === "STALL" ? { stall: pick(r, ["price", "guarantee", "date", "promise"] as const) } : {}),
    ...(r() < 0.5 ? { ref: `q${int(r, 1, 6)}` } : {}),
    ...(r() < 0.4 ? { topic: pick(r, ["budget", "dates", "scope"]) } : {}),
    turnId: r() < 0.1 ? turn - 1 : turn,
    source: observer ? "observer" : "direct",
    lineAt: now - pick(r, [0, 500, 2000, 5000, 6500, 9000, 20_000]),
    hint: pick(r, ["strong", "weak", "none"] as const),
  } as ScheduledMoment;
};

test("scheduler properties, 500 seeds: a Check is never held back by the cap, a late observer moment is dropped, the cap and the record stay bounded", () => {
  const cfg = DEFAULT_SCHEDULER;
  let decisions = 0,
    checksShown = 0,
    lateDropped = 0,
    capChips = 0;
  for (const seed of SEEDS) {
    const r = rng(seed);
    let st: SchedulerState = newSchedulerState(1_000_000);
    const shownAt: { at: number; exempt: boolean }[] = [];
    let memVer = 0;
    for (let i = 0; i < 80; i++) {
      st = { ...st, now: st.now + pick(r, [200, 1000, 3000, 8000, 20_000, 70_000]), memVer: (memVer += r() < 0.3 ? 1 : 0), currentTurnId: i + 1 };
      if (r() < 0.05) st = { ...st, offline: !st.offline };
      const m = randomMoment(r, st.now, i + 1);
      const d = decide(m, st, cfg);
      decisions++;
      const tag = `seed ${seed} step ${i} ${m.tag}`;
      // a stale turn is always dropped
      if (m.turnId !== st.currentTurnId) assert.equal(d.action, "drop", `${tag}: stale turn`);
      // a late observer moment is never shown
      if (m.source === "observer" && m.lineAt !== undefined && st.now - m.lineAt > cfg.lateObserverMs && m.tag !== "SKIP") {
        assert.equal(d.action, "drop", `${tag}: late observer moment was ${d.action} (${d.reason})`);
        lateDropped++;
      }
      // a Check is never held back by the per-minute cap
      assert.ok(!(m.tag === "CHECK" && d.reason === "per-minute-cap"), `${tag}: a Check was held back by the cap`);
      if (d.reason === "per-minute-cap") capChips++;
      // a SKIP never shows, a moment aimed at someone else never shows
      if (m.tag === "SKIP" || m.aim === "other") assert.notEqual(d.action, "show", tag);
      // below its minimum value a moment is a chip or dropped, never a card
      if (d.action === "show") assert.ok(m.value >= d.threshold, `${tag}: shown under its threshold`);
      if (d.action === "show") {
        if (m.tag === "CHECK") checksShown++;
        st = recordShown(st, m, `c${i}`, d);
        shownAt.push({ at: st.now, exempt: isExempt(m) });
        // the per-minute cap holds for cards that are not exempt (profile cap may be lower, never higher)
        const inMinute = shownAt.filter((x) => st.now - x.at < 60_000 && !x.exempt).length;
        assert.ok(inMinute <= cfg.maxPerMinute, `${tag}: ${inMinute} cards in a minute`);
        // the record of shown cards is bounded
        assert.ok(st.shown.length <= 50, `${tag}: record has ${st.shown.length} entries`);
      }
    }
  }
  // the streams were rich enough to reach the interesting branches
  assert.ok(decisions === SEEDS.length * 80);
  assert.ok(checksShown > 100, `checks shown ${checksShown}`);
  assert.ok(lateDropped > 100, `late observers dropped ${lateDropped}`);
  assert.ok(capChips > 10, `cap reached ${capChips}`);
});

test("scheduler: the same ref is not shown twice within the novelty window unless the memory changed", () => {
  for (const seed of SEEDS.slice(0, 200)) {
    const r = rng(seed);
    let st = newSchedulerState(5_000_000);
    const seen = new Map<string, { at: number; memVer: number }>();
    for (let i = 0; i < 40; i++) {
      st = { ...st, now: st.now + pick(r, [500, 4000, 15_000, 50_000]), memVer: st.memVer + (r() < 0.25 ? 1 : 0), currentTurnId: i + 1 };
      const m = { ...randomMoment(r, st.now, i + 1), turnId: i + 1, lineAt: st.now, ref: `q${int(r, 1, 3)}`, value: 3 as const, aim: "me" as const };
      if (m.tag === "SKIP") continue;
      const d = decide(m, st);
      if (d.action !== "show") continue;
      const prev = seen.get(m.ref!);
      if (prev && st.now - prev.at < DEFAULT_SCHEDULER.noveltyMs)
        assert.ok(st.memVer > prev.memVer, `seed ${seed} step ${i}: ref ${m.ref} shown twice with no new memory`);
      seen.set(m.ref!, { at: st.now, memVer: st.memVer });
      st = recordShown(st, m, `c${i}`, d);
    }
  }
});

// ---------------------------------------------------------------- part B: the engine with a faulty model
let e: Engine;
before(async () => {
  e = await setupEngine();
});
after(() => e?.stop());

const reply = (tag: string, say: string, value: number, aim: string) => `${tag}\nVALUE: ${value}\nAIM: ${aim}\nSAY: ${say}\nWHY: fuzz`;
const QUESTIONS = [
  "Which databases does the reporting tool connect to",
  "How long would the whole migration take for a team like ours",
  "What does the support plan cover on weekends",
  "Who owns the budget for the second phase",
];
const STATEMENTS = [
  "The contract ends in march and the price went up again",
  "Honestly your offer is much heavier than the other vendor",
  "We have a problem with the export, it fails every night",
  "The team agreed to move the launch by two weeks",
];
const CHAT = ["Nice weather this week", "I watched the game last night", "The coffee machine is broken again", "Did you see the new cafe on the corner"];

type Line = { token: string; text: string; side: "me" | "them"; at: number };

/** Plays one seed. Returns the lines (with the time each was fed) and what the engine did. */
async function playSeed(seed: number) {
  const r = rng(seed);
  await e.reset(70_000);
  const lines: Line[] = [];
  const n = int(r, 3, 6);
  for (let i = 0; i < n; i++) {
    const token = `zq${i}x`;
    const q = r() < 0.4;
    const base = q ? pick(r, QUESTIONS) : pick(r, STATEMENTS);
    const text = `${base} ${token}${q ? "?" : "."}`;
    // the faulty model: a rule for this line
    const kind = int(r, 0, 9);
    const tag = pick(r, ["ANS", "REPLY", "CHECK", "PROMPT", "TERM", "NOTE", "STALL", "SKIP"] as const);
    const ms = pick(r, [100, 400, 900, 1500, 3000, 4800, 7000]);
    const body = tag === "SKIP" ? "SKIP" : reply(tag, `A short useful line about ${token}`, int(r, 1, 3), pick(r, ["me", "all", "unclear", "other"]));
    const match = { role: ["moment", "observer"], lastLine: token };
    if (kind <= 4) e.pm.reply(match, body, { ms });
    else if (kind === 5) e.pm.on(match, error(500));
    else if (kind === 6) e.pm.on(match, garbage({ seed: int(r, 1, 99) }));
    else if (kind === 7) e.pm.on(match, truncate(int(r, 1, 30)));
    else if (kind === 8) e.pm.on(match, hang());
    else e.pm.reply(match, reply("ANS", "The same duplicate line every time", 3, "me"), { ms }); // duplicate reply for different lines
    const side = r() < 0.15 ? "me" : "them";
    lines.push({ token, text, side, at: e.say(side, text) });
    await e.vc.advance(pick(r, [300, 1500, 3000, 6000, 10_000]));
  }
  await e.vc.advance(12_000);
  return lines;
}

/** A silent stretch after the faulty part: chat with no question, number or promise, and the null model (the policy fallback is SKIP, no rule matches).
 *  Returns the full cards that showed in it. */
async function silentStretch(seed: number): Promise<string[]> {
  const r = rng(seed ^ 0xa5a5a5a5);
  await e.reset(70_000); // a fresh call: the hung and failed calls of the faulty part must not leak into the silence
  const from = e.rows.length;
  const n = int(r, 2, 3);
  for (let i = 0; i < n; i++) {
    e.say(r() < 0.3 ? "me" : "them", pick(r, CHAT) + ".");
    await e.vc.advance(pick(r, [500, 3000, 8000, 20_000]));
  }
  await e.vc.advance(6000);
  return e.rows
    .slice(from)
    .filter((x) => x.type === "card" && !x.health && !x.hidden && !x.withdraw && !x.chip && !x.dim)
    .map((x) => String(x.say));
}

// Full cards only. A chip is a small dimmed row; two chips for one line can still happen (seed 2788871314: the direct and the observer path both chip one line).
/** Fails a seed that never finishes (a pending promise) instead of hanging the whole run. Uses the real timers, not the virtual clock. */
async function withWatchdog<T>(seed: number, work: Promise<T>, ms = 15_000): Promise<T> {
  let t: ReturnType<typeof realTimeout> | undefined;
  const dog = new Promise<never>(
    (_, rej) => (t = realTimeout(() => rej(new Error(`seed ${seed}: the engine run did not finish in ${ms} ms of real time`)), ms)),
  );
  try {
    return await Promise.race([work, dog]);
  } finally {
    realClear(t);
  }
}

const cardRows = () =>
  e.screen().filter((c) => !c.health && !c.chip && !c.dim && (c.kind === "answer" || c.kind === "prompt" || c.kind === "check" || c.kind === "fact"));
const firstSeen = (id: string) => e.rows.find((x) => x.type === "card" && x.id === id)!.t;

test("engine fuzz, 500 seeds: never two cards for one line, no card past its age cap, queues stay bounded, a late observer card is dropped", async () => {
  const cap = Math.max(e.boot.S.llm.reflex.timeoutMs, 6000) + 4000; // a moment call is cut at its timeout; the observer drops past 6 s
  let cards = 0,
    withCard = 0,
    maxAge = 0;
  for (const seed of SEEDS) {
    const lines = await withWatchdog(seed, playSeed(seed));
    const tag = `seed ${seed}`;
    const shown = cardRows();
    cards += shown.length;
    // 1. never two cards for one line (a card is tied to its line by the line text it quotes)
    const perLine = new Map<string, string[]>();
    for (const c of shown) {
      const l = lines.find((x) => String(c.question ?? "").includes(x.token));
      if (!l) continue; // a card for a window of lines, or a note: no single line
      perLine.set(l.token, [...(perLine.get(l.token) ?? []), c.id]);
    }
    for (const [token, ids] of perLine) assert.ok(ids.length <= 1, `${tag}: ${ids.length} cards for line ${token}: ${ids.join(",")}`);
    if (perLine.size) withCard++;
    // 2. card age cap, and 5. a late observer card is dropped
    for (const c of shown) {
      const l = lines.find((x) => String(c.question ?? "").includes(x.token));
      if (!l) continue;
      const age = firstSeen(c.id) - l.at;
      maxAge = Math.max(maxAge, age);
      assert.ok(age <= cap, `${tag}: card ${c.id} appeared ${age} ms after its line (cap ${cap})`);
      if (/^o\d+$/.test(String(c.turnId)))
        assert.ok(age <= 6000 + 50, `${tag}: observer card ${c.id} appeared ${age} ms after its line; late observer cards are dropped`);
    }
    // 3. queue bounds
    assert.ok(e.st.m.sched.shown.length <= 50, `${tag}: scheduler record ${e.st.m.sched.shown.length}`);
    assert.ok(shown.length <= lines.length + 2, `${tag}: ${shown.length} cards for ${lines.length} lines`);
    assert.ok(
      e.pm.callsFor("moment").length + e.pm.callsFor("observer").length <= lines.length * 2 + 2,
      `${tag}: ${e.pm.callsFor("moment").length + e.pm.callsFor("observer").length} moment calls for ${lines.length} lines`,
    );
  }
  const cpu = process.cpuUsage();
  console.log(
    `FUZZ engine cpu ${((cpu.user + cpu.system) / 1e6).toFixed(1)} s (whole process, with start-up): ${SEEDS.length} seeds, ${cards} cards, ${withCard} seeds with a card tied to a line, max card age ${maxAge} ms (cap ${cap} ms)`,
  );
  assert.ok(
    (cpu.user + cpu.system) / 1e6 < 40,
    "500 seeds finish well inside the time budget (about 20 s on a quiet machine; the limit here allows a loaded one)",
  );
  assert.ok(cards > 200 && withCard > 100, "the faults still let cards through, so the invariants were exercised");
});

test("engine fuzz: a silent stretch with a null model shows no card, 500 seeds", async () => {
  for (const seed of SEEDS) assert.deepEqual(await withWatchdog(seed, silentStretch(seed)), [], `seed ${seed}: card(s) in silence`);
});

test("engine: a Check is not held back by the per-minute cap, even after the cap is full", async () => {
  await e.reset(70_000);
  // fill the cap with three observer cards, then a Check on a fresh line
  for (let i = 0; i < 4; i++) {
    const token = `cap${i}x`;
    e.pm.reply({ role: ["moment", "observer"], lastLine: token }, reply("PROMPT", `Useful prompt number ${i} ${token}`, 3, "me"), { ms: 200 });
    e.say("them", `We keep running into trouble with the export job ${token}.`);
    await e.vc.advance(7000);
  }
  e.pm.reply({ role: ["moment", "observer"], lastLine: "chkx" }, reply("CHECK", "Earlier they said the contract ends in June chkx", 3, "me"), { ms: 200 });
  e.say("them", "The contract ends in march chkx.");
  await e.vc.advance(8000);
  const kinds = cardRows().map((c) => c.kind);
  assert.ok(kinds.includes("check"), `cards: ${JSON.stringify(kinds)}`);
  assert.ok(kinds.filter((k) => k === "prompt").length <= 3, "the cap held for ordinary cards");
});
