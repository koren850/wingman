// Round 12 r3-moments-floor, end to end on the virtual clock and the policy fake model (no network, no real time):
//  1. The floor on the golden dev meetings with the AI paused: recall and precision with the legacy hint ON and OFF (printed, and held above a floor).
//  2. The paused engine: a line the floor calls a question gets the bank card with no model call; a statement gets nothing.
//  3. Early start (moments.earlyStart): stable partial with "?" starts the direct path; the same final is deduped; a different final aborts the early turn;
//     a flapping partial never starts twice; extra calls stay under 10 percent of the direct calls on the golden dev replay.
import "../test-setup.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupEngine, type Engine } from "../testkit/engine-inproc.ts";
import { loadSplit } from "../../qa/golden-load.ts";
import type { Golden } from "../../qa/golden-schema.ts";
import { loadBank, matchBankFor, matchBankSmart } from "../bank.ts";
import { detect } from "../detector.ts";
import { features } from "../moments/intake.ts";
import { hint } from "../moments/hint.ts";
import { floorQuestion, addressedElsewhere } from "../moments/floor.ts";
import type { SttResult } from "../providers/stt/types.ts";

// ---------------------------------------------------------------- 1. the floor on the golden dev meetings
type Score = { recall: number; precision: number; momentPrecision: number; quietFlagged: number; quiet: number; answers: number; flagged: number };
function replay(
  dev: Golden[],
  decide: (g: Golden, text: string, f: ReturnType<typeof features>, ctx: { addressed: boolean; elsewhere: boolean }) => boolean,
): Score {
  let answers = 0,
    caught = 0,
    flagged = 0,
    tp = 0,
    mp = 0,
    quiet = 0,
    quietFlagged = 0;
  for (const g of dev) {
    const name = g.profile?.userName?.toLowerCase();
    const voices = new Set(g.lines.filter((l) => l.side === "them").map((l) => l.speaker ?? "?"));
    const roster = g.lines.map((l) => l.speaker).filter((x): x is string => !!x);
    const answerLines = new Set(g.moments.filter((m) => m.kind === "answer").map((m) => m.afterLine));
    const momentLines = new Set([...g.moments.map((m) => m.afterLine), ...(g.allowedExtra ?? []).map((x) => x.afterLine)]);
    const quietLines = new Set<string>();
    for (const w of g.silent) {
      const a = g.lines.findIndex((l) => l.id === w.fromLine);
      const b = g.lines.findIndex((l) => l.id === w.toLine);
      for (let i = a; i <= b; i++) quietLines.add(g.lines[i].id);
    }
    let prev: number | undefined;
    for (const l of g.lines) {
      const f = features({ text: l.text, side: l.side, at: l.t }, prev);
      prev = l.t;
      if (l.side !== "them") continue;
      const addressed = (!!name && l.text.toLowerCase().includes(name)) || voices.size <= 1;
      const elsewhere = addressedElsewhere(l.text, roster, name ? [name] : []);
      const yes = decide(g, l.text, f, { addressed, elsewhere });
      if (answerLines.has(l.id)) {
        answers++;
        if (yes) caught++;
      }
      if (yes) {
        flagged++;
        if (answerLines.has(l.id)) tp++;
        if (momentLines.has(l.id)) mp++;
      }
      if (quietLines.has(l.id)) {
        quiet++;
        if (yes) quietFlagged++;
      }
    }
  }
  return { recall: caught / answers, precision: tp / flagged, momentPrecision: mp / flagged, quietFlagged, quiet, answers, flagged };
}

test("floor on golden dev with the AI paused: recall and precision with the legacy hint on and off", () => {
  const dev = loadSplit("dev");
  const bank = loadBank();
  const seen = new Map<string, { score: number; stall: boolean; scorer: boolean }>();
  const bankOf = (text: string) => {
    let r = seen.get(text);
    if (!r) {
      const h = matchBankFor(text, bank);
      r = { score: h?.score ?? 0, stall: !!h?.card.id.startsWith("stall-"), scorer: !h && !!matchBankSmart(text, bank).hit };
      seen.set(text, r);
    }
    return r;
  };
  const floor = (useHint: boolean) =>
    replay(dev, (_g, text, f, ctx) => {
      const b = bankOf(text);
      const level = useHint ? hint(text, { bankScore: b.score, stall: b.stall }).level : undefined;
      return floorQuestion(f, {
        addressed: ctx.addressed,
        elsewhere: ctx.elsewhere,
        bankScore: b.score,
        stall: b.stall,
        scorer: b.scorer,
        ...(level ? { hint: level } : {}),
      }).isQuestion;
    });
  const legacy = replay(dev, (_g, text) => {
    const b = bankOf(text);
    return detect(text, { bankScore: b.score, stall: b.stall }).isQuestion;
  });
  const off = floor(false);
  const on = floor(true);
  const row = (n: string, s: Score) =>
    `${n.padEnd(18)} recall ${(100 * s.recall).toFixed(1)}%  precision(answer lines) ${(100 * s.precision).toFixed(1)}%  precision(any labelled moment) ${(100 * s.momentPrecision).toFixed(1)}%  flagged ${s.flagged}  silent-window lines flagged ${s.quietFlagged}/${s.quiet}`;
  console.log(
    [
      "FLOOR (AI paused, golden dev, in-sample, " + dev.length + " meetings, " + on.answers + " answer moments)",
      row("floor, hint OFF", off),
      row("floor, hint ON", on),
      row("legacy detector", legacy),
    ].join("\n"),
  );
  // Floors, not targets: the numbers above are what the report quotes. A drop below these means the shape rules or the hint broke.
  assert.ok(off.recall >= 0.55, `hint off recall ${off.recall}`);
  assert.ok(on.recall >= 0.8, `hint on recall ${on.recall}`);
  assert.ok(on.recall >= off.recall, "the hint never lowers recall");
  assert.ok(off.momentPrecision >= 0.65 && on.momentPrecision >= 0.65, `moment precision ${off.momentPrecision} / ${on.momentPrecision}`);
  assert.ok(off.quietFlagged / off.quiet <= 0.35 && on.quietFlagged / on.quiet <= 0.35, "silent windows stay mostly quiet");
});

// ---------------------------------------------------------------- the engine
let e: Engine;
let ingest: typeof import("../engine/ingest.ts");
before(async () => {
  e = await setupEngine();
  ingest = await import("../engine/ingest.ts");
});
after(() => e?.stop());

const events = () =>
  readFileSync(e.boot.log.dir + "/events.jsonl", "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const moments = () => e.pm.callsFor("moment").length;
const partial = (text: string) => ingest.onResult({ channel: "them", text, isFinal: false, speechFinal: false, words: [], arrivedAt: Date.now() } as SttResult);
const pauseAi = () => {
  for (const m of e.boot.REFLEX_MODELS) e.boot.downUntil.set(m, Date.now() + 3600_000);
};
const S = () => e.boot.S as unknown as { moments: { earlyStart: boolean } };

test("paused AI: a question with a bank card shows the card with no model call; a plain statement shows nothing", async () => {
  await e.reset();
  pauseAi();
  const before = e.pm.calls.length;
  const at = e.say("them", "האתר שלי איטי מאוד, מה אפשר לעשות?");
  await e.vc.advance(3000);
  assert.ok(
    e.screen().some((c) => /תמונות|cache|שרת/.test(String(c.say ?? c.text ?? ""))),
    JSON.stringify(e.screen()),
  );
  assert.ok((e.firstCardMs(at) ?? 99999) < 1500);
  const n = e.screen().length;
  e.say("them", "okay thanks for the update, we will talk again next week.");
  await e.vc.advance(5000);
  assert.equal(e.screen().length, n, "a statement adds no card: " + JSON.stringify(e.screen().slice(n)));
  assert.equal(e.pm.calls.length, before, "no model call while paused");
  assert.ok(events().some((x) => x.type === "detect" && x.reason === "question-mark"));
  e.boot.downUntil.clear();
});

// ---------------------------------------------------------------- 3. early start
test("early start is off by default: a stable partial with a question mark starts nothing", async () => {
  await e.reset();
  assert.equal(S().moments.earlyStart, false);
  partial("Which databases can the reporting tool connect to?");
  await e.vc.advance(1000);
  assert.equal(moments(), 0);
});

test("early start on: a stable partial with '?' starts the direct path before the final; the same final is deduped", async () => {
  await e.reset();
  S().moments.earlyStart = true;
  try {
    const q = "Which databases can the reporting tool connect to?";
    e.pm.reply({ role: "moment" }, "ANS\nVALUE: 3\nAIM: me\nSAY: Postgres and MySQL\nWHY: test", { ms: 500 });
    const t0 = Date.now();
    partial("Which databases can the");
    await e.vc.advance(150);
    partial(q);
    await e.vc.advance(150);
    partial(q); // the same text again
    await e.vc.advance(250); // 400 ms after the first sight of the full text: stable for 300 ms
    assert.equal(moments(), 1, "the direct call started on the partial");
    await e.vc.advance(350); // the final comes 700 ms after the first partial
    e.say("them", q);
    await e.vc.advance(3000);
    assert.equal(moments(), 1, "the same final starts no second call");
    assert.ok(events().some((x) => x.type === "early.dedupe"));
    const ms = e.firstCardMs(t0)!;
    assert.ok(ms <= 1200, `card ${ms} ms after the first partial (final arrived at 800)`);
  } finally {
    S().moments.earlyStart = false;
  }
});

test("early start on: a different final aborts the early turn and runs normally", async () => {
  await e.reset();
  S().moments.earlyStart = true;
  try {
    e.pm.reply({ role: "moment" }, "ANS\nVALUE: 3\nAIM: me\nSAY: Postgres and MySQL\nWHY: test", { ms: 900 });
    partial("Which databases can the reporting tool connect to?");
    await e.vc.advance(400);
    assert.equal(moments(), 1);
    e.say("them", "Which databases can the reporting tool connect to and how long does the setup take?");
    await e.vc.advance(3000);
    assert.ok(events().some((x) => x.type === "detect" && x.via !== "early-start" && /setup take/.test(x.text)));
    assert.equal(moments(), 2, "the early call plus the call for the real final");
    const cards = e.screen().filter((c) => c.kind === "answer");
    assert.ok(cards.length <= 1, "the aborted early answer does not stay as a second card");
  } finally {
    S().moments.earlyStart = false;
  }
});

test("early start on: a final that is no longer a question aborts the early turn", async () => {
  await e.reset();
  S().moments.earlyStart = true;
  try {
    e.pm.reply({ role: "moment" }, "ANS\nVALUE: 3\nAIM: me\nSAY: too late\nWHY: test", { ms: 1500 });
    partial("Can you send me the contract?");
    await e.vc.advance(400);
    assert.equal(moments(), 1);
    e.say("them", "Can you send me the contract. Never mind, I found it myself and it is fine.");
    await e.vc.advance(4000);
    assert.ok(events().some((x) => x.type === "early.abort"));
    assert.equal(e.screen().filter((c) => /too late/.test(String(c.say ?? c.text ?? ""))).length, 0, "the early answer is not shown");
  } finally {
    S().moments.earlyStart = false;
  }
});

test("early start on: a flapping partial never starts twice, and never starts while it keeps changing", async () => {
  await e.reset();
  S().moments.earlyStart = true;
  try {
    e.pm.reply({ role: "moment" }, "SKIP", { ms: 200 });
    // changes every 200 ms: never stable for 300 ms
    for (let i = 0; i < 8; i++) {
      partial(i % 2 ? "Which plan includes backups?" : "Which plan includes the backups?");
      await e.vc.advance(200);
    }
    assert.equal(moments(), 0, "no start while it flaps faster than the stable time");
    // settles on A, then flaps A / B / A with stable stretches: one start only
    partial("Which plan includes backups?");
    await e.vc.advance(350);
    assert.equal(moments(), 1);
    partial("Which plan includes the backups?");
    await e.vc.advance(400);
    partial("Which plan includes backups?");
    await e.vc.advance(400);
    assert.equal(moments(), 1, "one early start per utterance");
    e.say("them", "Which plan includes backups?");
    await e.vc.advance(2000);
    assert.equal(moments(), 1);
  } finally {
    S().moments.earlyStart = false;
  }
});

test("early start on: an early turn whose final is dropped (foreign script) does not block the next utterance", async () => {
  await e.reset();
  S().moments.earlyStart = true;
  try {
    e.pm.reply({ role: "moment" }, "SKIP", { ms: 200 });
    partial("Can you send me the contract?");
    await e.vc.advance(400);
    assert.equal(moments(), 1);
    e.say("them", "తెలుగు తెలుగు తెలుగు తెలుగు"); // dropped by the script check
    await e.vc.advance(1500);
    partial("Which plan includes backups?");
    await e.vc.advance(500);
    assert.equal(moments(), 2, "the next utterance can start early again");
  } finally {
    S().moments.earlyStart = false;
  }
});

// A deterministic stand-in for speech-to-text: every question line is heard as growing partials, then a stable one, then the final. One final in twelve
// differs from the stable partial (the engine revised the last words). That rate is an assumption, stated here and in the report.
test("early start: extra model calls stay under 10 percent of the direct calls on the golden dev replay", { timeout: 240_000 }, async () => {
  const dev = loadSplit("dev").filter((g) => g.type !== "interview" && /^dev-(sales|pricing|support|kickoff|vendor)-/.test(g.id));
  assert.ok(dev.length >= 6);
  const run = async (early: boolean) => {
    let direct = 0;
    let n = 0;
    for (const g of dev) {
      await e.reset();
      S().moments.earlyStart = early;
      e.pm.reply({ role: "moment" }, "SKIP", { ms: 400 });
      const start = Date.now();
      for (const l of g.lines) {
        const wait = start + l.t - Date.now();
        if (wait > 0) await e.vc.advance(wait);
        if (l.side === "them" && early && /[?]\s*$/.test(l.text)) {
          const w = l.text.split(" ");
          partial(w.slice(0, Math.max(1, Math.floor(w.length / 2))).join(" "));
          await e.vc.advance(120);
          partial(l.text);
          await e.vc.advance(150);
          partial(l.text);
          await e.vc.advance(180);
          n++;
          e.say("them", n % 12 === 0 ? l.text.replace(/\?\s*$/, " and why?") : l.text);
        } else if (l.side === "them" && !early && /[?]\s*$/.test(l.text)) {
          n++;
          e.say("them", n % 12 === 0 ? l.text.replace(/\?\s*$/, " and why?") : l.text);
        } else e.say(l.side, l.text);
      }
      await e.vc.advance(6000);
      direct += moments();
    }
    S().moments.earlyStart = false;
    return direct;
  };
  const base = await run(false);
  const withEarly = await run(true);
  const extra = withEarly - base;
  console.log(
    `EARLY START cost: direct calls ${base} without, ${withEarly} with early start; extra ${extra} (${((100 * extra) / base).toFixed(1)} percent) over ${dev.length} dev meetings`,
  );
  assert.ok(base > 10, `base direct calls ${base}`);
  assert.ok(extra >= 0 && extra <= 0.1 * base, `extra calls ${extra} of ${base}`);
});
